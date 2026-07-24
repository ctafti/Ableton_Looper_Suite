/**
 * RIG SERVER — the walking skeleton's spine (BUILD-PLAN Phase 2).
 *
 *   node --experimental-strip-types src/rig/server.ts        # from hub/
 *   OSC_HOST=<ip> PORT=8421 …                                # overrides
 *
 * Same seat as sim/server.ts (serves tablet/ over HTTP + speaks Contract 3
 * over WS on one port) but behind the seam sits REAL LIVE, not FakeLive:
 *   boot: ping engine -> scan template (sentinel + tags, Contract 7) ->
 *         resolver.rebuildFromSnapshot -> read state -> MirrorStore
 *   down: TabletCommand -> resolver (stable IDs -> indices, Contract 1) ->
 *         Contract 2 OSC -> engine
 *   up:   listener echoes + /live/looper/state pushes -> mirror deltas ->
 *         tablet; every command confirmed by OBSERVED truth (a listener echo
 *         or an explicit GET readback — the frozen confirmed-echo primitive),
 *         retries/timeouts via the prebuilt CommandLifecycle.
 *
 * PREBUILT modules are wired, not rewritten: MirrorStore, Resolver,
 * CommandLifecycle, and the harness OSC codec (rig-proven since 07-04).
 *
 * SKELETON-SCOPE NOTES (recorded, not hidden):
 *  - LooperMirror.layers/speed are PROVISIONAL (seam 3): the device does not
 *    yet report layers, and speed is not read at boot. Shipped as 0 / 1 with
 *    state being the only live field — what flows vs what's missing is the
 *    sprint's job to record, not to fix.
 *  - sendA01/sendB01 are not read at boot (fresh template ships them at 0);
 *    set_send is wired down but confirmed only if /live/track/get/send
 *    answers — observe on rig.
 *  - Return tracks are invisible to /live/song/get/track_names (scan finding
 *    2026-07-11): boot validates sentinel + chain tags, and TRUSTS the
 *    template for returns. hasReturnA/B probe = post-skeleton item.
 *  - duplicate_clip_to is a plain pass-through here; the delete-then-duplicate
 *    occupied-target policy is Phase 3 transport/lifecycle thickening.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import dgram from 'node:dgram';
import { WebSocketServer, type WebSocket } from 'ws';

import { decodeSpectralFrame } from '../codec/spectral-codec.ts';
import { SPECTRAL_UDP_PORT } from '../../../contracts/types/spectral.ts';

import { MirrorStore } from '../mirror/mirror.ts';
import { Resolver, type LiveSnapshot, type LiveTrackInfo } from '../resolver/resolver.ts';
import {
  CommandLifecycle,
  IMMEDIATE_WINDOW_MS,
  quantWindowMs,
  msToNextBoundary,
  QUANT_BEATS,
} from '../lifecycle/lifecycle.ts';
import { OscClient, type OscMessage } from '../../../harnesses/src/osc-helper.ts';
import {
  WS_PROTOCOL_VERSION,
  TABLET_COMMAND_SEMANTICS,
  type ControlMessage,
  type StateMessage,
  type TelemetryMessage,
  type TabletCommand,
  type MirrorSnapshot,
  type ChainMirror,
  type CellMirror,
  type CommandStatus,
} from '../../../contracts/types/ws.ts';
import { DOWN, LISTEN, LooperState, MonitoringState } from '../../../contracts/types/osc.ts';
import { parseSentinelVersion, SENTINEL, DEFAULT_INPUTS } from '../../../contracts/types/template.ts';
import { LiveTrackIndex, LiveClipSlotIndex, type ChainID } from '../../../contracts/types/ids.ts';

const PORT = Number(process.env.PORT ?? 8420);
const OSC_HOST = process.env.OSC_HOST ?? '127.0.0.1';
const SLOTS = 6; // tablet skeleton renders exactly 6 (tablet/app.js SLOTS)
const ASK_TIMEOUT = Number(process.env.ASK_TIMEOUT_MS ?? 2500);
const LOOPER_WINDOW_MS = 800; // v2.3 settles <=80 ms; generous for retries
const CONFIRM_GET_DELAY_MS = 120; // device state readable ~100 ms post-set (harness 04 finding)
const ARM_SETTLE_MS = 60; // promotion: arm lands before fire (loopback UDP is in-order in practice — OBSERVE; raise if a promoted fire ever stops-instead-of-records)

const TABLET_DIR = new URL('../../../tablet/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const log = (...a: unknown[]) => console.log('[rig]', ...a);

// ---------------------------------------------------------------------------
// OSC ask/try helpers — every boot read is observed or honestly null.
// ---------------------------------------------------------------------------
class Osc {
  readonly client = new OscClient({ host: OSC_HOST });

  async ask(address: string, args: (number | string)[] = [], timeout = ASK_TIMEOUT): Promise<OscMessage> {
    this.client.send(address, args);
    return this.client.waitFor((m) => m.address === address, timeout);
  }
  /** ask, but a timeout is a logged null, not a crash (boot resilience). */
  async tryAsk(address: string, args: (number | string)[] = []): Promise<OscMessage | null> {
    try {
      return await this.ask(address, args);
    } catch {
      log(`  (no reply: ${address} ${JSON.stringify(args)})`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// BOOT — ping, scan, validate, populate (arch §12/§13; Contract 7)
// ---------------------------------------------------------------------------
async function bootScan(osc: Osc): Promise<{ live: LiveSnapshot; trackNames: string[] }> {
  // 1) engine alive (retry forever — boot order is owner-controlled)
  for (let attempt = 1; ; attempt++) {
    try {
      osc.client.send(DOWN.enginePing.address, []);
      const hello = await osc.client.waitFor((m) => m.address.includes('/live/engine/'), 2000);
      log(`engine alive: version ${hello.args[0]}, protocol ${hello.args[1]}`);
      break;
    } catch {
      log(`waiting for engine (attempt ${attempt}) — is Live open with the template?`);
    }
  }

  // 2) sentinel (Contract 7: refuse to arm without it)
  const cues = await osc.ask('/live/song/get/cue_points');
  const versions = cues.args.filter((a): a is string => typeof a === 'string').map(parseSentinelVersion).filter((v): v is number => v !== null);
  if (versions[0] !== SENTINEL.version) {
    log(`FATAL: sentinel "${SENTINEL.name}" not found in cue points ${JSON.stringify(cues.args)} — refusing to arm (Contract 7). Open the template set.`);
    process.exit(1);
  }
  log(`sentinel OK (template v${versions[0]})`);

  // 3) tracks -> devices -> param names (the resolver's LiveSnapshot)
  const namesReply = await osc.ask('/live/song/get/track_names');
  const trackNames = namesReply.args.map(String);
  const live = await scanTracks(osc, trackNames);
  return { live, trackNames };
}

/** The track/device/param structure scan — shared by boot AND the Phase-5a
 *  structural re-scan (add_chain/delete_chain). Always reads fresh truth. */
async function scanTracks(osc: Osc, knownNames?: string[]): Promise<LiveSnapshot> {
  const trackNames = knownNames ?? (await osc.ask('/live/song/get/track_names')).args.map(String);
  const tracks: LiveTrackInfo[] = [];
  for (let t = 0; t < trackNames.length; t++) {
    const devReply = await osc.ask('/live/track/get/devices/name', [t]);
    const devNames = devReply.args.slice(1).map(String);
    const devices = [];
    for (let d = 0; d < devNames.length; d++) {
      const pReply = await osc.ask('/live/device/get/parameters/name', [t, d]);
      devices.push({ name: devNames[d], paramNames: pReply.args.slice(2).map(String) });
    }
    tracks.push({ name: trackNames[t], devices });
  }
  const scenesReply = await osc.tryAsk('/live/song/get/num_scenes');
  const numScenes = scenesReply ? Number(scenesReply.args[0]) : SLOTS;
  log(`scanned ${tracks.length} tracks, ${numScenes} scenes`);
  return { tracks, numScenes };
}

async function buildMirror(osc: Osc, resolver: Resolver, live: LiveSnapshot, reuse?: ReadonlyMap<string, ChainMirror>): Promise<MirrorSnapshot> {
  /** Map an OBSERVED input-routing display name (e.g. "In 1", "1", "3/4",
   *  "Ext. In 3/4") to the Contract-7 physical-input NAME ('guitar' | 'mic' |
   *  'synth') via DEFAULT_INPUTS channel numbers. Honest fallback = the raw
   *  display string — ARM_POLICY grouping still works, since equal displays
   *  mean the same physical input. (Phase 3, arch §17.) */
  const physicalInputName = (display: string | null): string | null => {
    if (display === null) return null;
    const nums = (display.match(/\d+/g) ?? []).map(Number);
    if (nums.length > 0) {
      for (const inp of DEFAULT_INPUTS) {
        if (inp.channels.length === nums.length && inp.channels.every((c, i) => c === nums[i])) return inp.name;
      }
    }
    return display;
  };

  const num = async (addr: string, args: number[] = [], fallback = 0, pick = -1): Promise<number> => {
    const r = await osc.tryAsk(addr, args);
    if (!r) return fallback;
    const v = pick >= 0 ? r.args[pick] : r.args[r.args.length - 1];
    return Number(v);
  };

  const tempoBpm = await num('/live/song/get/tempo', [], 120);
  const isPlaying = (await num('/live/song/get/is_playing', [], 0)) !== 0;
  const metronome = (await num('/live/song/get/metronome', [], 0)) !== 0;
  const globalQuantization = await num('/live/song/get/clip_trigger_quantization', [], 4);

  const chains: ChainMirror[] = [];
  for (const chainId of resolver.chainIds()) {
    // INCREMENTAL (perf, owner report 2026-07-24: adds took seconds to show):
    // surviving chains' mirrors are delta-maintained truth — reuse them and
    // only ASK Live about chains we don't already know (the new one).
    const cached = reuse?.get(chainId as string);
    if (cached) { chains.push(cached); continue; }
    const track = resolver.resolveChain(chainId)! as number;
    const info = live.tracks[track];
    const volume01 = await num('/live/track/get/volume', [track], 0.85);
    const panMinus1to1 = await num('/live/track/get/panning', [track], 0);
    const muted = (await num('/live/track/get/mute', [track], 0)) !== 0;
    const armed = (await num('/live/track/get/arm', [track], 0)) !== 0;
    const colorInt = await num('/live/track/get/color', [track], 0xc9a227);
    const routing = await osc.tryAsk('/live/track/get/input_routing_channel', [track]);
    const rawInput = routing ? String(routing.args[routing.args.length - 1]) : null;
    const inputName = physicalInputName(rawInput); // observed -> Contract-7 name, or honest raw/null
    const mon = await num('/live/track/get/current_monitoring_state', [track], -1);
    log(`  ${chainId}: input "${rawInput ?? '?'}" -> ${inputName ?? 'null'} · armed=${armed} · monitor=${mon === 0 ? 'IN' : mon === 1 ? 'AUTO' : mon === 2 ? 'OFF' : '?'}`);

    const cells: CellMirror[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const hasClip = (await num('/live/clip_slot/get/has_clip', [track, s], 0)) !== 0;
      let name: string | null = null;
      let lengthBeats: number | null = null;
      if (hasClip) {
        const n = await osc.tryAsk('/live/clip/get/name', [track, s]);
        name = n ? String(n.args[n.args.length - 1]) : null;
        lengthBeats = await num('/live/clip/get/length', [track, s], 0);
      }
      cells.push({ slot: s as CellMirror['slot'], hasClip, name, lengthBeats, playing: false, recording: false, isLooper: false });
    }

    // devices for the mirror: names + params with observed value/min/max
    const devices: ChainMirror['devices'][number][] = [];
    for (const [role] of ['amp', 'looper', 'eq', 'spectral', 'inline_fx'].map((r) => [r] as const)) {
      const dev = resolver.resolveDevice(chainId, role);
      if (!dev) continue;
      const d = dev.device as number;
      const names = info.devices[d].paramNames;
      const vals = await osc.tryAsk('/live/device/get/parameters/value', [track, d]);
      const mins = await osc.tryAsk('/live/device/get/parameters/min', [track, d]);
      const maxs = await osc.tryAsk('/live/device/get/parameters/max', [track, d]);
      const pick = (m: OscMessage | null, i: number, fb: number) => (m ? Number(m.args[2 + i] ?? fb) : fb);
      devices.push({
        role,
        name: info.devices[d].name,
        // quantized: not read over stock OSC — false everywhere (skeleton note)
        params: names.map((n, i) => ({ name: n, value: pick(vals, i, 0), min: pick(mins, i, 0), max: pick(maxs, i, 1), quantized: false })),
      });
    }

    // Looper mirror (seam 3, provisional fields' first real exercise):
    // state = OBSERVED via looperGetState; layers/speed NOT yet flowing.
    let looper: ChainMirror['looper'] = null;
    const looperDev = resolver.resolveDevice(chainId, 'looper');
    if (looperDev) {
      const st = await osc.tryAsk(DOWN.looperGetState.address, [track, looperDev.device as number]);
      const observed = st ? Number(st.args[2]) : -1;
      looper = { state: (observed >= 0 ? observed : LooperState.Stop) as ChainMirror['looper'] extends null ? never : NonNullable<ChainMirror['looper']>['state'], layers: 0, speed: 1 };
      log(`  looper on ${resolver.tagFor(chainId)}: observed state ${observed}`);
    }

    // SENDS PROBE (Phase 3 item 6 — '/live/track/get/send' recorded UNVERIFIED
    // 07-11). Observe: does it answer? Log verbatim either way; if it answers,
    // the mirror boots from OBSERVED send values instead of assumed zeros.
    const sendA = await osc.tryAsk('/live/track/get/send', [track, 0]);
    const sendB = await osc.tryAsk('/live/track/get/send', [track, 1]);
    log(`  SENDS PROBE ${chainId}: A=${sendA ? JSON.stringify(sendA.args) : 'NO ANSWER (timeout)'} B=${sendB ? JSON.stringify(sendB.args) : 'NO ANSWER (timeout)'}`);
    const sendA01 = sendA ? Number(sendA.args[sendA.args.length - 1]) : 0;
    const sendB01 = sendB ? Number(sendB.args[sendB.args.length - 1]) : 0;

    chains.push({
      id: chainId,
      name: info.name.replace(/\s*(?:\[\[.*\]\]|\[T\d+\])\s*/, ''),
      color: `#${(colorInt >>> 0).toString(16).padStart(6, '0')}`,
      toneId: null,
      volume01, panMinus1to1,
      sendA01, sendB01, // OBSERVED at boot via the sends probe (or honest 0 on no-answer)
      muted, armed,
      live: armed, // best observable proxy at boot; go_live maintains it after
      inputName,
      cells, looper, devices,
    });
  }

  return {
    tempoBpm, isPlaying, metronome, globalQuantization,
    linkEnabled: false,
    chains,
    scenes: resolver.sceneIdList().slice(0, SLOTS).map((id, s) => ({ id, name: `Scene ${s + 1}`, triggered: false })),
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const osc = new Osc();
  await osc.client.bind(); // binds 11001 — harnesses can't run while this does
  log(`OSC bound (send ${OSC_HOST}:11000, recv 11001)`);

  const resolver = new Resolver();
  let live = (await bootScan(osc)).live; // MUTABLE: structural ops re-scan and replace it
  resolver.rebuildFromSnapshot(live);
  log(`resolver: chains = ${resolver.chainIds().map((c) => resolver.tagFor(c)).join(', ')}`);

  // RETURNS PROBE (Phase 3 item 7, opportunistic — track_names excludes returns,
  // finding 07-11; TemplateScan.hasReturnA/B needs a real detection path).
  // Candidate stock addresses, results logged VERBATIM; unknown addresses will
  // show as LIVE ERROR lines or timeouts — that's the data. No behavior change
  // this sprint; findings inform the wiring.
  {
    const p1 = await osc.tryAsk('/live/song/get/num_tracks');
    log(`RETURNS PROBE num_tracks: ${p1 ? JSON.stringify(p1.args) : 'NO ANSWER (timeout)'}`);
    const p2 = await osc.tryAsk('/live/song/get/return_track_names');
    log(`RETURNS PROBE return_track_names: ${p2 ? JSON.stringify(p2.args) : 'NO ANSWER (timeout)'}`);
    const p3 = await osc.tryAsk('/live/return_track/get/name', [0]);
    log(`RETURNS PROBE return_track/get/name [0]: ${p3 ? JSON.stringify(p3.args) : 'NO ANSWER (timeout)'}`);
    const n = p1 ? Number(p1.args[p1.args.length - 1]) : -1;
    if (n >= 0) {
      const p4 = await osc.tryAsk('/live/track/get/name', [n]); // one PAST the regular tracks — do track indices reach returns?
      log(`RETURNS PROBE track/get/name [${n}]: ${p4 ? JSON.stringify(p4.args) : 'NO ANSWER (timeout)'}`);
    }
  }

  const store = new MirrorStore(await buildMirror(osc, resolver, live));
  log(`mirror built (rev ${store.revision})`);

  // --- WS plumbing ---------------------------------------------------------
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: StateMessage | TelemetryMessage) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s);
  };
  const pushDelta = (msg: StateMessage) => broadcast(msg);
  /** Poll an observed predicate until true or deadline (structural ops). */
  async function pollFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }
  const status = (commandId: string, phase: CommandStatus['phase'], extra: Partial<CommandStatus> = {}) => {
    log(`  status ${commandId}: ${phase}${extra.queuedForMs !== undefined ? ` (queued ${extra.queuedForMs}ms)` : ''}${extra.reason ? ` — ${extra.reason}` : ''}`);
    broadcast({ channel: 'state', type: 'command_status', rev: store.revision, payload: { commandId, phase, ...extra } });
  };

  // --- lifecycle (prebuilt) --------------------------------------------------
  const resendFns = new Map<string, () => void>();
  const lifecycle = new CommandLifecycle(
    {
      status: (id, phase, extra) => {
        status(id, phase, extra);
        if (phase === 'confirmed' || phase === 'failed') resendFns.delete(id);
      },
      resend: (id, attempt) => {
        log(`resend ${id} (attempt ${attempt})`);
        resendFns.get(id)?.();
      },
      reconcile: (id) => {
        // stateful op timed out: re-read truth, push a fresh snapshot (arch §12)
        log(`reconcile ${id}: stateful op unconfirmed — pushing fresh snapshot`);
        status(id, 'failed', { reason: 'unconfirmed — state refreshed' });
        void refresh();
      },
    },
    () => Date.now(),
  );
  setInterval(() => lifecycle.tick(), 50);

  async function refresh(reuse?: ReadonlyMap<string, ChainMirror>): Promise<void> {
    const next = await buildMirror(osc, resolver, live, reuse);
    store.replace(next);
    broadcast(store.snapshotMessage());
  }

  // --- beat/position tracking for quant math -------------------------------
  let lastBeat = 0;
  let lastBeatAt = Date.now();
  const positionBeats = () => lastBeat + ((Date.now() - lastBeatAt) / 60000) * store.snapshot.tempoBpm;

  // --- arm listeners (idempotent; change-only echoes) -----------------------
  osc.client.send(LISTEN.tempo().address, []);
  osc.client.send(LISTEN.isPlaying().address, []);
  osc.client.send(LISTEN.beat().address, []);
  /** Arm the per-chain clip/track listeners. Idempotent (change-only echoes)
   *  — safe to re-run for every chain after a structural re-scan. */
  const armChainListeners = (chainId: ReturnType<Resolver['chainIds']>[number]) => {
    const t = resolver.resolveChain(chainId)! as number;
    osc.client.send('/live/track/start_listen/playing_slot_index', [t]);
    // Phase 3 (work item 3): clip/recording truth as change-only deltas.
    // fired_slot = the "Live accepted the fire" echo (queued confirms).
    osc.client.send('/live/track/start_listen/fired_slot_index', [t]);
    for (let s = 0; s < SLOTS; s++) {
      // has_clip is a stock clip_slot property (same class as the boot reads).
      osc.client.send('/live/clip_slot/start_listen/has_clip', [t, s]);
      // OBSERVE (2026-07-12): arming clip listeners on EMPTY slots may error
      // (/live/error, logged verbatim below) — harmless either way, because
      // the has_clip->true handler re-arms per clip as clips appear.
      osc.client.send('/live/clip/start_listen/is_recording', [t, s]);
      // NOT armed: /live/clip/start_listen/is_playing — DEAD on the rig
      // (finding 2026-07-12: Live's Clip has no add_is_playing_listener;
      // Contract 2 LISTEN.clipIsPlaying gets a ⚠️ REALITY note at merge).
      // Playing truth flows via playing_slot_index instead.
    }
  };
  for (const chainId of resolver.chainIds()) armChainListeners(chainId);
  log('listeners armed (tempo, is_playing, beat; per chain: playing_slot, fired_slot; per cell: has_clip, is_recording, is_playing)');

  // --- EQ param listeners (Phase 4 session 2 — the 40-param mirror) ---------
  // Owner scope (2026-07-21): per chain, the A-channel surface of EQ Eight =
  // 8x Filter On / Filter Type / Frequency / Gain / Q ("N <part> A").
  // OBSERVED names from probe 06/07 (2026-07-22): the Q param is literally
  // "N Q A" (arch §16b's "Resonance" example was the LOM display name, not the
  // OSC name). /live/device/start_listen/parameter/value is SUPPORTED in our
  // AbletonOSC build (probe 07: echo on arm + unsolicited echo on set), so EQ
  // truth is listener-driven — Live-side dot drags flow up like any other
  // listener echo, and set_param confirms ride the same address.
  const EQ_A_PARAM_NAMES: string[] = [];
  for (let b = 1; b <= 8; b++)
    for (const part of ['Filter On', 'Filter Type', 'Frequency', 'Gain', 'Q'])
      EQ_A_PARAM_NAMES.push(`${b} ${part} A`);
  // (track:device:param) -> route for the echo handler. REBUILT WHOLE on every
  // structural re-scan — track indices shift on add/delete, so append-only
  // routes would go stale (the raw-index trap sneaking back in).
  const eqParamRoute = new Map<string, { chain: string; param: string }>();
  const armEqListeners = async (affected?: (t: number) => boolean) => {
    // REV 2026-07-24c: the route MAP is always rebuilt whole (cheap, truth),
    // but start_listen SENDS are TRIMMED to affected tracks and PACED — an
    // unpaced 200-send arm burst clogs AbletonOSC's queue exactly like the
    // teardown burst did, starving the next command's asks.
    eqParamRoute.clear();
    const sends: { t: number; d: number; p: number }[] = [];
    for (const chainId of resolver.chainIds()) {
      const dev = resolver.resolveDevice(chainId, 'eq');
      if (!dev) { log(`eq listeners: no eq device on ${resolver.tagFor(chainId)} — skipped`); continue; }
      const [t, d] = [dev.track as number, dev.device as number];
      const names = live.tracks[t].devices[d].paramNames;
      let armed = 0;
      for (const want of EQ_A_PARAM_NAMES) {
        const p = names.findIndex((n) => n.toLowerCase() === want.toLowerCase());
        if (p < 0) { log(`eq listeners: "${want}" NOT FOUND on ${resolver.tagFor(chainId)} — recorded, skipped`); continue; }
        eqParamRoute.set(`${t}:${d}:${p}`, { chain: chainId as string, param: names[p] });
        if (!affected || affected(t)) sends.push({ t, d, p });
        armed++;
      }
      log(`eq listeners: ${armed}/40 routed on ${resolver.tagFor(chainId)} (track ${t} device ${d})${affected && !affected(t) ? ' — already armed, no re-send' : ''}`);
    }
    for (let i = 0; i < sends.length; i += 25) {
      for (const x of sends.slice(i, i + 25)) osc.client.send('/live/device/start_listen/parameter/value', [x.t, x.d, x.p]);
      if (i + 25 < sends.length) await new Promise((r) => setTimeout(r, 60));
    }
  };
  await armEqListeners();

  // --- SELF-HEALING [TN] MARKERS (P5-e sub-item; owner GO 2026-07-23) -------
  // The FIRST hub-initiated write of a track name, which is why it needed an
  // explicit owner go. Scope is strictly: a tracked chain track whose observed
  // name has LOST its [TN] marker (casual rename in Live) gets the SAME name
  // back with the marker restored — change-only, logged loudly, rate-limited
  // against anything fighting the name. Name listeners are stock (probe 08).
  const armNameListeners = () => {
    for (const chainId of resolver.chainIds()) {
      osc.client.send('/live/track/start_listen/name', [resolver.resolveChain(chainId) as number]);
    }
    log(`name listeners armed on ${resolver.chainIds().length} chain tracks (self-healing [TN] markers)`);
  };
  armNameListeners();

  // --- STRUCTURAL RE-SCAN (Phase 5a: add_chain / delete_chain) --------------
  // One logical stateful op = mutate Live -> re-scan fresh truth -> resolver
  // rebuild (same tag => same ChainID) -> mirror rebuild + snapshot broadcast
  // -> re-arm everything (idempotent; index-keyed routes rebuilt whole).
  let restructuring = false; // structural-op mutex — one at a time, ever
  /** Tags claimed by MORE THAN ONE track (poisoned Set — resolver behavior is
   *  undefined). Detected at every scan; structural ops refuse until clean. */
  let tagConflicts: string[] = [];
  const detectTagConflicts = () => {
    const seen = new Map<string, number[]>();
    live.tracks.forEach((tr, i) => {
      const m = tr.name.match(/\[(T\d+)\]/);
      if (m) seen.set(m[1], [...(seen.get(m[1]) ?? []), i]);
    });
    tagConflicts = [...seen.entries()].filter(([, idxs]) => idxs.length > 1).map(([tg]) => tg);
    for (const [tg, idxs] of seen) {
      if (idxs.length > 1)
        log(`⚠️ TAG CONFLICT: [${tg}] claimed by tracks ${idxs.join(', ')} (${idxs.map((i) => `"${live.tracks[i].name}"`).join(', ')}) — resolver behavior UNDEFINED; add/delete BLOCKED until you delete the extras in Live and re-scan (restart or add/delete after cleanup)`);
    }
  };
  detectTagConflicts();
  async function restructure(hint?: { kind: 'add' | 'delete' | 'devices'; track: number }): Promise<void> {
    // REV 2026-07-24c (rig receipts: every structural op "failed" while Live
    // succeeded). Root cause: ~275 stop_listen messages fired in one burst —
    // 200 of them EQ stops — many at just-deleted indices; AbletonOSC works
    // the queue serially, so our OWN scan asks queued behind the flood and
    // timed out, leaving a stale mirror and cascading misfires. Order is now
    // SCAN FIRST (quiet wire), then a TRIMMED, PACED teardown (only indices
    // that actually shifted), then rebuild, then trimmed re-arm. Any error
    // triggers one settle-and-full-rescan retry so the hub can never stay
    // poisoned.
    const oldCount = live.tracks.length;
    const pacedSend = async (msgs: { address: string; args: (number | string)[] }[]) => {
      for (let i = 0; i < msgs.length; i += 25) {
        for (const m of msgs.slice(i, i + 25)) osc.client.send(m.address, m.args);
        if (i + 25 < msgs.length) await new Promise((r) => setTimeout(r, 60));
      }
    };
    const attempt = async (useHint: typeof hint): Promise<void> => {
      // ---- 1) SCAN FIRST, on a quiet wire ----
      let next: LiveSnapshot | null = null;
      if (useHint?.kind === 'devices') {
        const devReply = await osc.ask('/live/track/get/devices/name', [useHint.track]);
        const devNames = devReply.args.slice(1).map(String);
        const devices = [];
        for (let d = 0; d < devNames.length; d++) {
          const pReply = await osc.ask('/live/device/get/parameters/name', [useHint.track, d]);
          devices.push({ name: devNames[d], paramNames: pReply.args.slice(2).map(String) });
        }
        const tracks = [...live.tracks];
        tracks[useHint.track] = { ...tracks[useHint.track], devices };
        next = { tracks, numScenes: live.numScenes };
        log(`devices-scan: track ${useHint.track} now [${devNames.join(' | ')}]`);
      } else if (useHint) {
        const names = (await osc.ask('/live/song/get/track_names')).args.map(String);
        const expected = useHint.kind === 'add' ? oldCount + 1 : oldCount - 1;
        if (names.length === expected) {
          const tracks = [...live.tracks];
          if (useHint.kind === 'add') {
            const devReply = await osc.ask('/live/track/get/devices/name', [useHint.track]);
            const devNames = devReply.args.slice(1).map(String);
            const devices = [];
            for (let d = 0; d < devNames.length; d++) {
              const pReply = await osc.ask('/live/device/get/parameters/name', [useHint.track, d]);
              devices.push({ name: devNames[d], paramNames: pReply.args.slice(2).map(String) });
            }
            tracks.splice(useHint.track, 0, { name: names[useHint.track], devices });
          } else tracks.splice(useHint.track, 1);
          for (let i = 0; i < tracks.length; i++) tracks[i] = { ...tracks[i], name: names[i] };
          next = { tracks, numScenes: live.numScenes };
          log(`splice-scan: ${useHint.kind} at track ${useHint.track} (${names.length} tracks)`);
        } else log(`splice-scan expectation missed (${names.length} names vs ${expected}) — full scan`);
      }
      const fresh = next ?? await scanTracks(osc);

      // ---- 2) TRIMMED, PACED teardown (only what shifted or vanished) ----
      const firstShifted = useHint && useHint.kind !== 'devices' ? useHint.track : 0;
      const teardown: { address: string; args: (number | string)[] }[] = [];
      if (!useHint || useHint.kind !== 'devices') {
        for (let t = firstShifted; t < oldCount; t++) {
          teardown.push({ address: '/live/track/stop_listen/name', args: [t] });
          teardown.push({ address: '/live/track/stop_listen/playing_slot_index', args: [t] });
          teardown.push({ address: '/live/track/stop_listen/fired_slot_index', args: [t] });
          for (let sl = 0; sl < SLOTS; sl++) {
            teardown.push({ address: '/live/clip_slot/stop_listen/has_clip', args: [t, sl] });
            teardown.push({ address: '/live/clip/stop_listen/is_recording', args: [t, sl] });
          }
        }
      }
      const affectedEq = (t: number) => (useHint?.kind === 'devices' ? t === useHint.track : t >= firstShifted);
      for (const key of eqParamRoute.keys()) {
        const [t, d, pp] = key.split(':').map(Number);
        if (affectedEq(t)) teardown.push({ address: '/live/device/stop_listen/parameter/value', args: [t, d, pp] });
      }
      await pacedSend(teardown);
      log(`restructure: ${teardown.length} stale listeners stopped (paced; tracks ${firstShifted}..${oldCount - 1})`);

      // ---- 3) rebuild from the fresh truth ----
      live = fresh;
      resolver.rebuildFromSnapshot(live);
      lastRepairAt.clear();
      detectTagConflicts();
      log(`resolver (re-scan): chains = ${resolver.chainIds().map((c) => resolver.tagFor(c)).join(', ')}`);
      const reuse = new Map(store.snapshot.chains.map((c) => [c.id as string, c]));
      if (useHint?.kind === 'devices') {
        const changed = resolver.chainIds().find((cid) => (resolver.resolveChain(cid) as number) === useHint.track);
        if (changed) reuse.delete(changed as string); // rebuild ONLY the changed chain's mirror
      }
      await refresh(reuse); // survivors reused; only unknown chains are asked

      // ---- 4) re-arm, TRIMMED to affected tracks (unaffected listeners are
      // still valid Live-side — their indices never moved) ----
      const armAffected = (t: number) => !useHint || (useHint.kind === 'devices' ? t === useHint.track : t >= firstShifted);
      for (const chainId of resolver.chainIds()) {
        const t = resolver.resolveChain(chainId)! as number;
        if (armAffected(t)) armChainListeners(chainId);
      }
      await armEqListeners(armAffected);
      armNameListeners();
    };
    try {
      await attempt(hint);
    } catch (e) {
      log(`RESTRUCTURE HICCUP: ${e instanceof Error ? e.message : e} — settling 2.5s, then FULL rescan (the hub must never stay stale)`);
      await new Promise((r) => setTimeout(r, 2500));
      await attempt(undefined); // full scan, full teardown, full re-arm
    }
  }
  const lastRepairAt = new Map<number, number>(); // track -> ts of last repair (runaway guard)
  // CORROBORATION (2026-07-24b — rig receipts show echoes attributed to WRONG
  // indices after restructures): a marker-less echo is only a SUGGESTION; the
  // hub re-reads that index's name directly and repairs only when the fresh
  // read matches the claim. Mis-attributed echoes fail corroboration cold.
  const pendingCorrob = new Map<number, { claimed: string; at: number }>();
  let lastLiveError: { text: string; count: number; timer?: ReturnType<typeof setTimeout> } = { text: '', count: 0 };
  const ANY_TAG_TOKEN = /\s*(?:\[\[[^\]]*\]\]|\[T\d+\])\s*/g; // old + new schemes
  const repairName = (current: string, tag: string): string =>
    `${current.replace(ANY_TAG_TOKEN, ' ').replace(/\s+/g, ' ').trim()} [${tag}]`;

  // --- UP: every OSC arrival -> lifecycle echo + mirror delta ---------------
  osc.client.onMessage((m) => {
    lifecycle.onEcho(m);
    const chainOf = (t: number) => resolver.chainForTrack(LiveTrackIndex(t));

    switch (m.address) {
      case '/live/song/get/tempo': {
        const bpm = Number(m.args[0]);
        if (bpm !== store.snapshot.tempoBpm) pushDelta(store.setTop('tempoBpm', bpm));
        return;
      }
      case '/live/song/get/is_playing': {
        const p = Number(m.args[0]) !== 0;
        if (p !== store.snapshot.isPlaying) pushDelta(store.setTop('isPlaying', p));
        return;
      }
      case '/live/song/get/metronome': {
        const on = Number(m.args[0]) !== 0;
        if (on !== store.snapshot.metronome) pushDelta(store.setTop('metronome', on));
        return;
      }
      case '/live/song/get/beat': {
        lastBeat = Number(m.args[0]);
        lastBeatAt = Date.now();
        broadcast({ channel: 'telemetry', type: 'beat', payload: { beat: lastBeat, tempoBpm: store.snapshot.tempoBpm, tMs: lastBeatAt } });
        return;
      }
      case '/live/device/get/parameter/value': {
        // Listener echo OR explicit GET readback (both ride this address).
        // Route by (t, d, p) through the EQ map; change-only into the mirror.
        const [t, d, p, v] = [Number(m.args[0]), Number(m.args[1]), Number(m.args[2]), Number(m.args[3])];
        const route = eqParamRoute.get(`${t}:${d}:${p}`);
        if (!route) return; // not a mirrored param (e.g. an ad-hoc GET confirm elsewhere)
        const c = store.snapshot.chains.find((x) => (x.id as string) === route.chain);
        const dev = c?.devices.find((x) => (x.role as string) === 'eq');
        const pm = dev?.params.find((x) => x.name === route.param);
        if (!pm || pm.value === v) return; // change-only (arm echoes re-assert boot values)
        log(`← eq ${route.chain} "${route.param}" = ${v}`);
        pushDelta(store.setParamValue(route.chain, 'eq', route.param, v));
        return;
      }
      case '/live/track/get/playing_slot_index': {
        const [t, slot] = [Number(m.args[0]), Number(m.args[1])];
        const chain = chainOf(t);
        if (!chain) return;
        log(`← playing_slot ${chain} = ${slot}`);
        const c = store.snapshot.chains.find((x) => x.id === chain);
        for (const cell of c?.cells ?? []) {
          const should = (cell.slot as number) === slot;
          if (cell.playing !== should) pushDelta(store.setCell(chain as string, cell.slot as number, 'playing', should));
        }
        return;
      }
      case '/live/looper/state': // device push (event-driven truth)
      case '/live/looper/get/state': { // explicit readback
        const [t, d, state] = [Number(m.args[0]), Number(m.args[1]), Number(m.args[2])];
        if (state < 0) return; // honest "no looper here"
        const chain = chainOf(t);
        if (!chain) return;
        const c = store.snapshot.chains.find((x) => x.id === chain);
        if (c?.looper && c.looper.state !== state) {
          log(`← looper ${chain} state = ${state} (${['Stop', 'Play', 'Record', 'Overdub'][state] ?? '?'})`);
          pushDelta(store.apply([
            { path: `chains/${chain}/looper/state`, value: state },
            { path: `chains/${chain}/devices/looper/params/State/value`, value: state },
          ]));
        }
        return;
      }
      case '/live/track/get/volume':
      case '/live/track/get/panning':
      case '/live/track/get/mute':
      case '/live/track/get/arm': {
        const t = Number(m.args[0]);
        const v = Number(m.args[1]);
        const chain = chainOf(t);
        if (!chain) return;
        const field = m.address.endsWith('volume') ? 'volume01' : m.address.endsWith('panning') ? 'panMinus1to1' : m.address.endsWith('mute') ? 'muted' : 'armed';
        const value = field === 'muted' || field === 'armed' ? v !== 0 : v;
        const c = store.snapshot.chains.find((x) => x.id === chain);
        if (c && (c as Record<string, unknown>)[field] !== value) {
          if (field === 'armed') log(`← arm ${chain} = ${value}`);
          pushDelta(store.setChainField(chain as string, field as keyof ChainMirror, value));
        }
        return;
      }
      case '/live/track/get/fired_slot_index':
        // lifecycle echo only (confirms "Live accepted the fire" before the
        // quant boundary); the mirror has no "fired" cell field by design.
        log(`← fired_slot t${Number(m.args[0])} = ${Number(m.args[1])}`);
        return;
      case '/live/clip/get/is_recording':
      case '/live/clip/get/is_playing': {
        const [t, s, v] = [Number(m.args[0]), Number(m.args[1]), Number(m.args[2]) !== 0];
        const chain = chainOf(t);
        if (!chain) return;
        const field = m.address.endsWith('is_recording') ? 'recording' : 'playing';
        const c = store.snapshot.chains.find((x) => x.id === chain);
        const cell = c?.cells.find((cl) => (cl.slot as number) === s);
        if (!cell || (cell as Record<string, unknown>)[field] === v) return;
        log(`← ${field} ${chain} slot ${s} = ${v}`);
        pushDelta(store.setCell(chain as string, s, field, v));
        // record finished -> read the clip's final identity (event-driven; the
        // '/live/clip/get/name'/'length' cases below route the replies by args)
        if (field === 'recording' && !v && cell.hasClip !== false) {
          osc.client.send('/live/clip/get/name', [t, s]);
          osc.client.send('/live/clip/get/length', [t, s]);
        }
        return;
      }
      case '/live/clip_slot/get/has_clip': {
        const [t, s, v] = [Number(m.args[0]), Number(m.args[1]), Number(m.args[2]) !== 0];
        const chain = chainOf(t);
        if (!chain) return;
        const c = store.snapshot.chains.find((x) => x.id === chain);
        const cell = c?.cells.find((cl) => (cl.slot as number) === s);
        if (!cell || cell.hasClip === v) return;
        log(`← has_clip ${chain} slot ${s} = ${v}`);
        pushDelta(store.setCell(chain as string, s, 'hasClip', v));
        if (v) {
          // new clip appeared (recording started / duplicate landed): arm its
          // per-clip listeners (covers any empty-slot arm failures at boot)
          // and read its identity. (is_playing listener is DEAD — see boot.)
          osc.client.send('/live/clip/start_listen/is_recording', [t, s]);
          osc.client.send('/live/clip/get/name', [t, s]);
          osc.client.send('/live/clip/get/length', [t, s]);
        } else {
          // clip gone: clear identity + playback truth for the cell.
          if (cell.name !== null) pushDelta(store.setCell(chain as string, s, 'name', null));
          if (cell.lengthBeats !== null) pushDelta(store.setCell(chain as string, s, 'lengthBeats', null));
          if (cell.playing) pushDelta(store.setCell(chain as string, s, 'playing', false));
          if (cell.recording) pushDelta(store.setCell(chain as string, s, 'recording', false));
        }
        return;
      }
      case '/live/clip/get/name':
      case '/live/clip/get/length': {
        // replies routed by args (race-free, event-driven) — also seen during
        // boot reads, where they harmlessly re-assert the same values.
        const [t, s] = [Number(m.args[0]), Number(m.args[1])];
        const chain = chainOf(t);
        if (!chain) return;
        const c = store.snapshot.chains.find((x) => x.id === chain);
        const cell = c?.cells.find((cl) => (cl.slot as number) === s);
        if (!cell) return;
        if (m.address.endsWith('name')) {
          const name = String(m.args[m.args.length - 1]);
          if (cell.name !== name) pushDelta(store.setCell(chain as string, s, 'name', name));
        } else {
          const len = Number(m.args[m.args.length - 1]);
          if (cell.lengthBeats !== len) pushDelta(store.setCell(chain as string, s, 'lengthBeats', len));
        }
        return;
      }
      case '/live/track/get/send': {
        const [t, sendId, v] = [Number(m.args[0]), Number(m.args[1]), Number(m.args[m.args.length - 1])];
        const chain = chainOf(t);
        if (!chain || (sendId !== 0 && sendId !== 1)) return;
        const field = sendId === 0 ? 'sendA01' : 'sendB01';
        const c = store.snapshot.chains.find((x) => x.id === chain);
        if (c && Math.abs((c as Record<string, number>)[field] as number - v) > 1e-4) {
          pushDelta(store.setChainField(chain as string, field, v));
        }
        return;
      }
      case '/live/track/get/name': {
        // Listener echo (self-healing markers, P5-e sub-item). Two cases:
        const t = Number(m.args[0]);
        const name = String(m.args[1] ?? '');
        // BUGFIX 2026-07-24b (rig log receipt: self-heal stomped a fresh [T4]
        // to [T2] MID-ADD): during a structural op the resolver is stale by
        // definition — echo attribution is untrustworthy. Self-healing SLEEPS
        // until the re-scan lands.
        if (restructuring) return;
        const chain = chainOf(t);
        if (!chain) return; // not a tracked chain track
        const tag = resolver.tagFor(chain)!;
        if (name.includes(`[${tag}]`)) {
          // (a) marker intact -> benign rename: mirror the display name only
          const display = name.replace(/\s*(?:\[\[.*\]\]|\[T\d+\])\s*/, '');
          const c = store.snapshot.chains.find((x) => x.id === chain);
          if (c && c.name !== display) {
            log(`rename observed on [${tag}]: "${name}" -> display "${display}"`);
            pushDelta(store.setChainField(chain as string, 'name', display));
          }
          return;
        }
        // (b') CASCADE BREAKER (bugfix 2026-07-24): if the observed name carries
        // SOME OTHER live chain's marker, this echo is almost certainly
        // mis-attributed (stale listener / shifted index) — repairing would
        // rename the WRONG track and cascade. Never repair; log loudly.
        const foreign = name.match(/\[(T\d+)\]/);
        if (foreign) {
          // GENERALIZED (2026-07-24b): a name carrying ANY [TN] marker never
          // needs marker RESTORATION — a wrong marker is re-tagging territory,
          // and the hub never rewrites tags on its own. Refuse + loud log.
          log(`SELF-HEAL REFUSED on track ${t}: name "${name}" carries marker [${foreign[1]}] but this track resolves as [${tag}] — mis-attributed echo or manual re-tag; NOT touching it (investigate)`);
          return;
        }
        // (b) marker LOST. Corroborate before repairing (see pendingCorrob).
        const pend = pendingCorrob.get(t);
        if (!pend || Date.now() - pend.at > 2500) {
          pendingCorrob.set(t, { claimed: name, at: Date.now() });
          osc.client.send('/live/track/get/name', [t]); // fresh read re-enters here
          return;
        }
        pendingCorrob.delete(t);
        if (pend.claimed !== name) {
          log(`SELF-HEAL REFUSED on track ${t}: echo claimed "${pend.claimed}" but a direct read says "${name}" — mis-attributed echo; NOT touching it`);
          return;
        }
        // corroborated marker loss -> repair (change-only, loud, guarded)
        const now = Date.now();
        if (now - (lastRepairAt.get(t) ?? 0) < 1500) {
          log(`SELF-HEAL SUPPRESSED on track ${t}: repaired <1.5s ago and the marker is gone again ("${name}") — something is fighting the name; investigate before it loops`);
          return;
        }
        lastRepairAt.set(t, now);
        const repaired = repairName(name, tag);
        log(`SELF-HEAL: track ${t} lost its [${tag}] marker (renamed to "${name}") — restoring: "${repaired}"`);
        osc.client.send('/live/track/set/name', [t, repaired]);
        // The set triggers its own listener echo -> case (a) mirrors the name.
        return;
      }
      case '/live/error': {
        // Golden rule: verbatim + visible — but DEDUPED (owner: boot spammed
        // 80+ identical lines). Repeats collapse into a count line.
        const text = m.args.join(' ');
        if (text === lastLiveError.text) { lastLiveError.count++; }
        else {
          if (lastLiveError.count > 1) log(`LIVE ERROR: (previous line x${lastLiveError.count})`);
          lastLiveError = { text, count: 1 };
          log(`LIVE ERROR: ${text}`);
        }
        clearTimeout(lastLiveError.timer);
        lastLiveError.timer = setTimeout(() => {
          if (lastLiveError.count > 1) log(`LIVE ERROR: (previous line x${lastLiveError.count})`);
          lastLiveError = { text: '', count: 0 };
        }, 2000);
        return;
      }
    }
  });

  // --- DOWN: TabletCommand -> resolver -> OSC + confirmed-echo expectation --
  function handleCommand(cmd: TabletCommand): void {
    // AUTHORITY RULE (Contract 3): semantics derive from kind, never the wire.
    const semantics = TABLET_COMMAND_SEMANTICS[cmd.kind];
    const fail = (reason: string) => status(cmd.commandId, 'failed', { reason });

    /** register expectation + send now + schedule a confirm-GET; resend does all again. */
    const confirmed = (opts: {
      targetKey: string;
      sendMsgs: { address: string; args: (number | string)[] }[];
      confirmGet?: { address: string; args: (number | string)[] };
      expect: (m: OscMessage) => boolean;
      windowMs?: number;
      queuedForMs?: number;
      /** If provided and false at fire time, the SET is skipped (observed truth
       *  already matches) but the confirm-GET still runs. Guards ops whose OSC
       *  is NOT idempotent in effect (start_playing restarts from 1.1.1 —
       *  finding 2026-07-12) against double-press AND blind-retry re-fires. */
      sendIf?: () => boolean;
    }) => {
      const fire = () => {
        if (!opts.sendIf || opts.sendIf()) {
          for (const msg of opts.sendMsgs) {
            log(`→ ${msg.address} ${JSON.stringify(msg.args)}`);
            osc.client.send(msg.address, msg.args);
          }
        } else {
          log(`  (send suppressed by truth guard: ${opts.targetKey})`);
        }
        if (opts.confirmGet) setTimeout(() => osc.client.send(opts.confirmGet!.address, opts.confirmGet!.args), CONFIRM_GET_DELAY_MS);
      };
      resendFns.set(cmd.commandId, fire);
      lifecycle.register({
        commandId: cmd.commandId,
        targetKey: opts.targetKey,
        semantics,
        expect: (e) => opts.expect(e as OscMessage),
        windowMs: opts.windowMs ?? IMMEDIATE_WINDOW_MS + CONFIRM_GET_DELAY_MS,
        queuedForMs: opts.queuedForMs,
      });
      fire();
    };

    const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

    /** ARM_POLICY (Contract 7, arch §17) as one reusable move: arm+monitor the
     *  target chain, disarm other ARMED chains on the SAME physical input, and
     *  flow the hub-owned 'live' flags as deltas. Used by go_live AND by
     *  empty-cell record promotion — tone follows attention, one code path. */
    const armPolicy = (chainId: ChainID): { t: number; msgs: { address: string; args: (number | string)[] }[]; applyLiveDeltas: () => void } | null => {
      const track = resolver.resolveChain(chainId);
      if (track === undefined) return null;
      const t = track as number;
      const target = store.snapshot.chains.find((c) => c.id === chainId);
      const msgs: { address: string; args: (number | string)[] }[] = [
        DOWN.setTrackArm.build(track, true) as { address: string; args: (number | string)[] },
        // FINDING 2026-07-12: Monitor IN forces the track to output its INPUT
        // always -> the live chain's grid clips become INAUDIBLE, and every
        // go_live/promotion kept re-asserting it. AUTO is the correct live-
        // chain mode: input heard when armed+idle, clip heard when playing,
        // looper still receives input. (ARM_POLICY says "arms+monitors"
        // without pinning the mode — now pinned by observation.)
        DOWN.setTrackMonitoring.build(track, MonitoringState.Auto) as { address: string; args: (number | string)[] },
      ];
      const disarmed: string[] = [];
      for (const c of store.snapshot.chains) {
        if (c.id !== chainId && c.inputName === target?.inputName && c.armed) {
          const ot = resolver.resolveChain(c.id);
          if (ot !== undefined) {
            msgs.push(DOWN.setTrackArm.build(ot, false) as { address: string; args: (number | string)[] });
            disarmed.push(c.id as string);
          }
        }
      }
      log(`ARM_POLICY -> ${chainId}: arm t${t} + monitor AUTO; disarm same-input [${disarmed.join(', ') || 'none'}]`);
      const applyLiveDeltas = () => {
        // hub-owned 'live' flag flows immediately (hub abstraction, not Live state)
        for (const c of store.snapshot.chains) {
          const should = c.id === chainId ? true : c.inputName === target?.inputName ? false : c.live;
          if (c.live !== should) pushDelta(store.setChainField(c.id as string, 'live', should));
        }
      };
      return { t, msgs, applyLiveDeltas };
    };

    switch (cmd.kind) {
      case 'looper_state': {
        const dev = resolver.resolveDevice(cmd.chain, 'looper');
        if (!dev) return fail('no looper on chain');
        const [t, d] = [dev.track as number, dev.device as number];
        const set = DOWN.looperSetState.build(dev.track, dev.device, cmd.state);
        const register = () => confirmed({
          targetKey: `looper:${cmd.chain}`,
          sendMsgs: [{ address: set.address, args: set.args as (number | string)[] }],
          confirmGet: { address: DOWN.looperGetState.address, args: [t, d] }, // covers idempotent no-transition re-sends
          expect: (m) =>
            (m.address === '/live/looper/state' || m.address === DOWN.looperGetState.address) &&
            Number(m.args[0]) === t && Number(m.args[1]) === d && Number(m.args[2]) === cmd.state,
          windowMs: LOOPER_WINDOW_MS,
        });

        // LOOPER GUARD (Contract 7 looperRecordStopsChainClips, arch §15/§17):
        // Record/Overdub must never let grid-clip audio imprint into the take.
        // Stop this chain's playing clips FIRST and enter the looper state only
        // once the stop is OBSERVED (clip stops land on the quant boundary), with
        // an honest queued countdown; deadline fallback = proceed + log finding.
        const guard = cmd.state === LooperState.Record || cmd.state === LooperState.Overdub;
        const playingCells = guard
          ? (store.snapshot.chains.find((c) => c.id === cmd.chain)?.cells ?? []).filter((cl) => cl.playing)
          : [];
        if (playingCells.length === 0) { register(); return; }
        log(`LOOPER GUARD: ${cmd.chain} entering ${cmd.state === LooperState.Record ? 'Record' : 'Overdub'} — stopping ${playingCells.length} playing clip(s) first, waiting for OBSERVED stop`);
        const guardStart = Date.now();

        for (const cl of playingCells) {
          const ref = resolver.resolveCell({ chain: cmd.chain, slot: cl.slot });
          if (!ref) continue;
          const stop = DOWN.stopClip.build(ref.track, ref.clipSlot);
          log(`→ ${stop.address} ${JSON.stringify(stop.args)}`);
          osc.client.send(stop.address, stop.args as (number | string)[]);
        }
        const q = QUANT_BEATS[store.snapshot.globalQuantization] ?? 4;
        status(cmd.commandId, 'queued', { queuedForMs: Math.round(msToNextBoundary(positionBeats(), q, store.snapshot.tempoBpm)) });
        const deadline = Date.now() + quantWindowMs(positionBeats(), q, store.snapshot.tempoBpm);
        const poll = setInterval(() => {
          const c = store.snapshot.chains.find((x) => x.id === cmd.chain);
          const stillPlaying = (c?.cells ?? []).some((cl) => cl.playing);
          if (!stillPlaying || Date.now() > deadline) {
            clearInterval(poll);
            if (stillPlaying) log(`looper guard: clip stop NOT observed before deadline on ${cmd.chain} — proceeding anyway (FINDING, record it)`);
            else log(`looper guard: stop observed after ${Date.now() - guardStart}ms — entering looper state now`);
            register();
          }
        }, 50);
        return;
      }
      case 'set_tempo':
        return confirmed({
          targetKey: 'tempo',
          sendMsgs: [DOWN.setTempo.build(cmd.bpm) as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/song/get/tempo', args: [] },
          expect: (m) => m.address === '/live/song/get/tempo' && near(Number(m.args[0]), cmd.bpm, 0.05),
        });
      case 'set_metronome':
        return confirmed({
          targetKey: 'metronome',
          sendMsgs: [DOWN.setMetronome.build(cmd.on) as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/song/get/metronome', args: [] },
          expect: (m) => m.address === '/live/song/get/metronome' && (Number(m.args[0]) !== 0) === cmd.on,
        });
      case 'set_playing': {
        // Phase 3 transport (arch §5.2): ABSOLUTE play state. Confirm = the
        // already-armed is_playing listener echo; the GET covers idempotent
        // re-sends of an already-true state (change-only listeners don't fire).
        // sendIf guard: start_playing RESTARTS from 1.1.1 if already playing
        // (rig finding 2026-07-12) — never re-fire when truth already matches.
        // OWNER DECISION 2026-07-19: the main STOP stops every looper. This is
        // INDEPENDENT of the transport truth-guard — the loopers run on their
        // own device clock, so ■ must silence them whether or not Live's song
        // transport itself needed stopping. Per-looper: skip those already
        // Stopped so an idempotent re-stop is still a quiet no-op.
        // OWNER POLICY REV 2026-07-24: the main ■ ALSO stops every clip (stock
        // stop_all_clips), so the slate is clean — the next fired clip plays
        // alone. Clip-stop truth flows up via the playing_slot listeners; the
        // command's own confirm stays the is_playing echo. Sent regardless of
        // the transport truth-guard, same rationale as the looper sweep.
        if (!cmd.playing) {
          log('STOP-ALL: stop_all_clips (main stop — owner policy 2026-07-24)');
          osc.client.send(DOWN.stopAllClips.build().address, []);
          for (const chainId of resolver.chainIds()) {
            const l = store.snapshot.chains.find((c) => c.id === chainId)?.looper;
            if (!l || l.state === LooperState.Stop) continue;
            const dev = resolver.resolveDevice(chainId, 'looper');
            if (!dev) continue;
            const s = DOWN.looperSetState.build(dev.track, dev.device, LooperState.Stop);
            log(`STOP-ALL: looper ${chainId} -> Stop (main stop)`);
            log(`→ ${s.address} ${JSON.stringify(s.args)}`);
            osc.client.send(s.address, s.args as (number | string)[]);
          }
        }
        return confirmed({
          targetKey: 'transport',
          sendMsgs: [(cmd.playing ? DOWN.startPlaying.build() : DOWN.stopPlaying.build()) as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/song/get/is_playing', args: [] },
          expect: (m) => m.address === '/live/song/get/is_playing' && (Number(m.args[0]) !== 0) === cmd.playing,
          sendIf: () => store.snapshot.isPlaying !== cmd.playing,
        });
      }
      case 'set_volume': case 'set_pan': case 'set_mute': {
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const t = track as number;
        const [setMsg, getAddr, want] =
          cmd.kind === 'set_volume' ? [DOWN.setTrackVolume.build(track, cmd.value01), '/live/track/get/volume', cmd.value01] :
          cmd.kind === 'set_pan' ? [DOWN.setTrackPanning.build(track, cmd.valueMinus1to1), '/live/track/get/panning', cmd.valueMinus1to1] :
          [DOWN.setTrackMute.build(track, cmd.muted), '/live/track/get/mute', cmd.muted ? 1 : 0];
        return confirmed({
          targetKey: `${cmd.kind}:${cmd.chain}`,
          sendMsgs: [setMsg as { address: string; args: (number | string)[] }],
          confirmGet: { address: getAddr as string, args: [t] },
          expect: (m) => m.address === getAddr && Number(m.args[0]) === t && near(Number(m.args[1]), want as number),
        });
      }
      case 'add_chain': {
        // __provisional STATEFUL structural op (Phase 5a work item 1; owner
        // decisions P5-a/b). One LOGICAL command: duplicate the template chain
        // -> rename with the next fresh [TN] -> strip carried clips -> re-scan
        // -> devices adopt -> snapshot. Confirmed ONLY by observed scan truth.
        if (restructuring) return fail('a structural change is already in flight');
        if (tagConflicts.length > 0) return fail(`tag conflict on [${tagConflicts.join(', ')}] — delete the duplicate-tagged tracks in Live first`);
        restructuring = true;
        status(cmd.commandId, 'sent');
        (async () => {
          try {
            const srcChain = resolver.chainIds()[0]; // the template chain (first row)
            const srcTrack = resolver.resolveChain(srcChain)! as number;
            const names0 = (await osc.ask('/live/song/get/track_names')).args.map(String);
            let maxN = 0;
            for (const n of names0) { const m = n.match(/\[T(\d+)\]/); if (m) maxN = Math.max(maxN, Number(m[1])); }
            const newTag = `T${maxN + 1}`;
            // P5-b auto-name, REV 2026-07-24 (owner): tone adds carry a NAME
            // HINT from the picker (pack name if the pack had one capture,
            // else the capture name). Sanitized like rename_chain — the [TN]
            // marker stays hub-owned. No hint (DI) -> generic "Track N".
            const hinted = (cmd.name ?? '').replace(/\s*(?:\[\[[^\]]*\]\]|\[T\d+\])\s*/g, ' ').replace(/\s+/g, ' ').trim();
            const newName = `${hinted || `Track ${maxN + 1}`} [${newTag}]`;
            log(`ADD_CHAIN: duplicating track ${srcTrack} ("${names0[srcTrack]}") -> "${newName}"`);

            osc.client.send('/live/song/duplicate_track', [srcTrack]);
            const grew = await pollFor(async () => {
              const r = await osc.tryAsk('/live/song/get/num_tracks');
              return r !== null && Number(r.args[0]) === names0.length + 1;
            }, 6000);
            if (!grew) throw new Error('duplicate_track not observed (num_tracks unchanged) — nothing renamed, reconcile in Live');

            // Landing check (probe 08, 2026-07-23: duplicate lands at src+1 with
            // the IDENTICAL name). Verify by readback before renaming ANYTHING.
            const dupIdx = srcTrack + 1;
            const landed = await osc.tryAsk('/live/track/get/name', [dupIdx]);
            const landedName = landed ? String(landed.args[1]) : null;
            if (landedName !== names0[srcTrack])
              throw new Error(`duplicate landing mismatch: track ${dupIdx} reads "${landedName}" (expected "${names0[srcTrack]}") — NOT renaming; delete the duplicate by hand and report`);

            osc.client.send('/live/track/set/name', [dupIdx, newName]);
            const named = await pollFor(async () => {
              const r = await osc.tryAsk('/live/track/get/name', [dupIdx]);
              return r !== null && String(r.args[1]) === newName;
            }, 3000);
            if (!named) throw new Error('rename readback failed');
            log(`ADD_CHAIN: renamed -> "${newName}" (readback ok)`);

            // Carried clips: a NEW chain starts EMPTY (the duplicate clones the
            // source's clips — probe 08). Delete observed-occupied slots, verified.
            for (let sl = 0; sl < SLOTS; sl++) {
              const hc = await osc.tryAsk('/live/clip_slot/get/has_clip', [dupIdx, sl]);
              if (hc && Number(hc.args[2]) !== 0) {
                const del = DOWN.deleteClip.build(dupIdx as never, sl as never);
                osc.client.send(del.address, del.args as (number | string)[]);
                log(`ADD_CHAIN: cleared carried clip at slot ${sl}`);
              }
            }

            // Input routing (picker mono/stereo, arch §17). OBSERVE-FIRST: pick
            // from Live's OWN advertised routing list, set, readback-confirm.
            // Any miss is logged honestly and the inherited routing stands.
            if (cmd.input) {
              const av = await osc.tryAsk('/live/track/get/available_input_routing_channels', [dupIdx]);
              if (!av) log(`ADD_CHAIN: available_input_routing_channels did not answer — routing left inherited (recorded)`);
              else {
                const options = av.args.slice(1).map(String);
                log(`ADD_CHAIN: available input routings: ${JSON.stringify(options)}`);
                const isPair = (o: string) => /\d+\s*\/\s*\d+/.test(o);
                const pick = cmd.input === 'stereo' ? options.find(isPair) : options.find((o) => /\b1\b/.test(o) && !isPair(o)) ?? options.find((o) => !isPair(o));
                if (!pick) log(`ADD_CHAIN: no ${cmd.input} routing among options — left inherited (recorded)`);
                else {
                  osc.client.send('/live/track/set/input_routing_channel', [dupIdx, pick]);
                  const routed = await pollFor(async () => {
                    const r = await osc.tryAsk('/live/track/get/input_routing_channel', [dupIdx]);
                    return r !== null && String(r.args[r.args.length - 1]) === pick;
                  }, 3000);
                  log(`ADD_CHAIN: input routing "${pick}" (${cmd.input}) ${routed ? 'readback ok' : 'NOT confirmed by readback (recorded)'}`);
                }
              }
            }

            await restructure({ kind: 'add', track: dupIdx });
            const newChain = resolver.chainForTag(newTag);
            if (!newChain) throw new Error(`re-scan did not resolve [${newTag}] — investigate before retrying`);
            log(`ADD_CHAIN: [${newTag}] resolved as ${newChain} — confirmed by scan truth`);

            // Amp option (P5-a): the device is ALWAYS present (it rode the
            // duplicate). 'tone' -> Model param + Load OK receipt, logged.
            if (cmd.amp?.kind === 'tone') {
              const ref = resolver.resolveParam({ chain: newChain, device: 'amp', param: 'Model' });
              if (ref) {
                const msg = DOWN.setDeviceParameter.build(ref.track, ref.device, ref.parameter, cmd.amp.model);
                osc.client.send(msg.address, msg.args as (number | string)[]);
                const okRef = resolver.resolveParam({ chain: newChain, device: 'amp', param: 'Load OK' });
                if (okRef) {
                  const loaded = await pollFor(async () => {
                    const r = await osc.tryAsk('/live/device/get/parameter/value', [okRef.track as number, okRef.device as number, okRef.parameter as number]);
                    return r !== null && Number(r.args[3]) === 1;
                  }, 5000);
                  log(`ADD_CHAIN: tone ${cmd.amp.model} -> Load OK ${loaded ? 'OBSERVED' : 'NOT observed in 5s (recorded)'}`);
                } else log('ADD_CHAIN: no Load OK param resolved — tone receipt unavailable (recorded)');
              } else log('ADD_CHAIN: no Model param resolved on the new amp — tone NOT loaded (recorded)');
            } else if (cmd.amp?.kind === 'di') {
              // P5-a "no amp" = DI, REAL since the 2026-07-24 amp rev: set the
              // DI param and read the device's receipt back. On a pre-rev
              // device the param won't resolve — logged honestly.
              const diRef = resolver.resolveParam({ chain: newChain, device: 'amp', param: 'DI' });
              if (!diRef) log('ADD_CHAIN: DI requested but no DI param on this amp (pre-rev device? rebuild via devgen/build_amp.sh) — left at device default');
              else {
                const msg = DOWN.setDeviceParameter.build(diRef.track, diRef.device, diRef.parameter, 1);
                osc.client.send(msg.address, msg.args as (number | string)[]);
                const engaged = await pollFor(async () => {
                  const r = await osc.tryAsk('/live/device/get/parameter/value', [diRef.track as number, diRef.device as number, diRef.parameter as number]);
                  return r !== null && Number(r.args[3]) === 1;
                }, 4000);
                log(`ADD_CHAIN: DI ${engaged ? 'engaged (receipt readback ok)' : 'NOT confirmed by receipt in 4s (recorded — check the device)'}`);
              }
            }
            status(cmd.commandId, 'confirmed');
          } catch (e) {
            log(`ADD_CHAIN FAILED: ${e instanceof Error ? e.message : e}`);
            status(cmd.commandId, 'failed', { reason: e instanceof Error ? e.message : 'add_chain failed' });
          } finally { restructuring = false; }
        })();
        return;
      }
      case 'delete_chain': {
        // __provisional STATEFUL structural op (Phase 5a work item 3).
        // GUARDS (brief): never the last remaining chain; never one recording.
        if (restructuring) return fail('a structural change is already in flight');
        if (tagConflicts.length > 0) return fail(`tag conflict on [${tagConflicts.join(', ')}] — delete the duplicate-tagged tracks in Live first`);
        const chainMirror = store.snapshot.chains.find((c) => c.id === cmd.chain);
        if (!chainMirror) return fail('unknown chain');
        if (store.snapshot.chains.length <= 1) return fail('cannot delete the last chain');
        if (chainMirror.cells.some((cl) => cl.recording)) return fail('chain is recording — stop it first');
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const tag = resolver.tagFor(cmd.chain)!;
        restructuring = true;
        status(cmd.commandId, 'sent');
        (async () => {
          try {
            const t = track as number;
            // NEVER delete blind: the track at this index must still carry OUR tag.
            let nm = await osc.tryAsk('/live/track/get/name', [t]);
            if (!nm) { await new Promise((r) => setTimeout(r, 900)); nm = await osc.tryAsk('/live/track/get/name', [t]); } // busy-wire retry
            const nmS = nm ? String(nm.args[1]) : '';
            if (!nmS.includes(`[${tag}]`))
              throw new Error(`track ${t} reads "${nmS}" (expected marker [${tag}]) — refusing to delete`);
            const count0 = Number((await osc.ask('/live/song/get/num_tracks')).args[0]);
            log(`DELETE_CHAIN: deleting track ${t} ("${nmS}", [${tag}])`);
            osc.client.send('/live/song/delete_track', [t]);
            const shrank = await pollFor(async () => {
              const r = await osc.tryAsk('/live/song/get/num_tracks');
              return r !== null && Number(r.args[0]) === count0 - 1;
            }, 6000);
            if (!shrank) throw new Error('delete_track not observed (num_tracks unchanged) — reconcile in Live');
            await restructure({ kind: 'delete', track: t });
            if (resolver.chainForTag(tag)) throw new Error(`[${tag}] still resolves after delete — investigate`);
            log(`DELETE_CHAIN: [${tag}] gone — confirmed by scan truth`);
            status(cmd.commandId, 'confirmed');
          } catch (e) {
            log(`DELETE_CHAIN FAILED: ${e instanceof Error ? e.message : e}`);
            status(cmd.commandId, 'failed', { reason: e instanceof Error ? e.message : 'delete_chain failed' });
          } finally { restructuring = false; }
        })();
        return;
      }
      case 'add_fx': {
        // __provisional STATEFUL (owner 2026-07-24): curated stock FX via the
        // FROZEN Phase-1 browser path. Confirmed by observed device-list truth
        // (count +1, name matches). Position is wherever load_item puts it —
        // recorded verbatim; probe 10 refines placement later.
        if (restructuring) return fail('a structural change is already in flight');
        const fx = FX_CATALOG.find((f) => f.id === cmd.fx);
        if (!fx) return fail('unknown fx id');
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        restructuring = true;
        status(cmd.commandId, 'sent');
        (async () => {
          try {
            const t = track as number;
            const before = live.tracks[t].devices.map((d) => d.name);
            // FINDING 2026-07-24: the reply ADDRESS was never pinned in Phase 1 —
            // get-uri matched ANY browser* address on purpose. Do the same, and
            // pull the URI out of the flat [name, uri, ...] args by shape.
            const browserQueryOnce = async (query: string, timeoutMs: number): Promise<string | undefined> => {
              const q = DOWN.browserQuery.build(query, 3);
              osc.client.send(q.address, q.args as (number | string)[]);
              try {
                const r = await osc.client.waitFor((m) => m.address.includes('browser') && !m.address.includes('rescan'), timeoutMs);
                const strings = r.args.filter((a): a is string => typeof a === 'string');
                const found = strings.find((x) => x.includes('#') || x.startsWith('query:'));
                if (!found) log(`ADD_FX: browser reply on ${r.address} had no URI-shaped arg: [${r.args.join(', ')}]`);
                return found;
              } catch { return undefined; }
            };
            let uri = fxUriCache.get(fx.id) ?? await browserQueryOnce(fx.query, 5000);
            if (!uri) {
              // cold index self-heal: rescan, WAIT FOR ITS REPLY (first build
              // walks the whole browser — several seconds), retry ONCE.
              log(`ADD_FX: query "${fx.query}" empty — browser index cold; rescanning (can take a while) + retrying`);
              const rs = DOWN.browserRescan.build();
              osc.client.send(rs.address, rs.args as (number | string)[]);
              try { await osc.client.waitFor((m) => m.address.includes('browser') && m.address.includes('rescan'), 20000); } catch { /* proceed to retry anyway */ }
              uri = await browserQueryOnce(fx.query, 8000);
            }
            if (uri) fxUriCache.set(fx.id, uri);
            if (!uri) throw new Error(`browser query "${fx.query}" returned no URI even after a rescan — paste the rig log lines around this`);
            log(`ADD_FX: ${fx.label} -> ${cmd.chain} (uri ${uri})`);
            const loadMsg = DOWN.browserLoadItem.build(t as never, uri);
            osc.client.send(loadMsg.address, loadMsg.args as (number | string)[]);
            const grew = await pollFor(async () => {
              const r = await osc.tryAsk('/live/track/get/devices/name', [t]);
              return r !== null && r.args.slice(1).length === before.length + 1;
            }, 8000);
            if (!grew) throw new Error('load_item not observed (device count unchanged)');
            // SPECTRAL RECYCLE (probe 10, 2026-07-24: load_item APPENDS — after
            // the spectral tap, so the new FX would be invisible to the
            // spectrum/cymatics). The spectral device is OURS and STATELESS
            // (zero params, reads the track name), so: delete it, reload it —
            // it returns to the true end and the FX sits in the post-EQ slot.
            // Stateful fixtures (amp/looper/EQ) are NEVER recycled.
            const namesNow = (await osc.ask('/live/track/get/devices/name', [t])).args.slice(1).map(String);
            const specIdx = namesNow.findIndex((n) => /nam_a2_spectral/i.test(n));
            if (specIdx >= 0 && specIdx < namesNow.length - 1) {
              const specUri = fxUriCache.get('__spectral') ?? await browserQueryOnce('NAM_A2_Spectral', 6000);
              if (!specUri) log('ADD_FX: spectral URI not in the browser index — FX stays appended AFTER the analyzer (audible, invisible to the spectrum; recorded)');
              else {
                fxUriCache.set('__spectral', specUri);
                log(`ADD_FX: recycling spectral (idx ${specIdx}) so the FX sits before the analyzer`);
                osc.client.send('/live/track/delete_device', [t, specIdx]);
                const shrank = await pollFor(async () => {
                  const r = await osc.tryAsk('/live/track/get/devices/name', [t]);
                  return r !== null && r.args.slice(1).length === namesNow.length - 1;
                }, 6000);
                if (!shrank) log('ADD_FX: spectral delete not observed — FX stays appended (recorded)');
                else {
                  const lm = DOWN.browserLoadItem.build(t as never, specUri);
                  osc.client.send(lm.address, lm.args as (number | string)[]);
                  const back = await pollFor(async () => {
                    const r = await osc.tryAsk('/live/track/get/devices/name', [t]);
                    const ns = r ? r.args.slice(1).map(String) : [];
                    return ns.length === namesNow.length && /nam_a2_spectral/i.test(ns[ns.length - 1] ?? '');
                  }, 8000);
                  if (!back) throw new Error('SPECTRAL RECYCLE FAILED — the analyzer may be missing from this chain; re-add NAM_A2_Spectral at the end of the track in Live and report');
                  log('ADD_FX: spectral back at the end (readback ok)');
                }
              }
            }
            await restructure({ kind: 'devices', track: t });
            const after = live.tracks[t].devices.map((d) => d.name);
            const landed = after.findIndex((n, i) => n !== before[i]);
            const at = landed < 0 ? after.length - 1 : landed;
            log(`ADD_FX: "${after[at]}" landed at device index ${at} — confirmed by scan truth`);
            status(cmd.commandId, 'confirmed');
          } catch (e) {
            log(`ADD_FX FAILED: ${e instanceof Error ? e.message : e}`);
            status(cmd.commandId, 'failed', { reason: e instanceof Error ? e.message : 'add_fx failed' });
          } finally { restructuring = false; }
        })();
        return;
      }
      case 'set_device_on': {
        // __provisional IDEMPOTENT: absolute "Device On" (parameter 0) by
        // device index within the chain's current scanned list.
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const t = track as number;
        if (!live.tracks[t]?.devices[cmd.device]) return fail('unknown device index');
        const v = cmd.on ? 1 : 0;
        const msg = DOWN.setDeviceParameter.build(t as never, cmd.device as never, 0 as never, v);
        return confirmed({
          targetKey: `devon:${cmd.chain}:${cmd.device}`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/device/get/parameter/value', args: [t, cmd.device, 0] },
          expect: (m) => m.address.endsWith('/parameter/value') && Number(m.args[0]) === t && Number(m.args[1]) === cmd.device && Number(m.args[2]) === 0 && Number(m.args[3]) === v,
        });
      }
      case 'rename_chain': {
        // __provisional vocabulary (owner-requested 2026-07-23). The tablet
        // sends the HUMAN label; the hub owns the [TN] marker and re-appends
        // it (self-healing keeps it intact afterwards). Absolute + idempotent.
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const t = track as number;
        const tag = resolver.tagFor(cmd.chain)!;
        const label = cmd.name.replace(/\s*(?:\[\[[^\]]*\]\]|\[T\d+\])\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!label) return fail('empty name');
        const full = `${label} [${tag}]`;
        return confirmed({
          targetKey: `rename_chain:${cmd.chain}`,
          sendMsgs: [{ address: '/live/track/set/name', args: [t, full] }],
          confirmGet: { address: '/live/track/get/name', args: [t] },
          expect: (m) => m.address === '/live/track/get/name' && Number(m.args[0]) === t && String(m.args[1]) === full,
        });
      }
      case 'set_send': {
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const sendId = cmd.send === 'A' ? 0 : 1;
        const t = track as number;
        return confirmed({
          targetKey: `send:${cmd.chain}:${cmd.send}`,
          sendMsgs: [{ address: DOWN.setTrackSend.address, args: [t, sendId, cmd.value01] }],
          confirmGet: { address: '/live/track/get/send', args: [t, sendId] }, // UNVERIFIED get — observe; timeout = failed
          expect: (m) => m.address === '/live/track/get/send' && Number(m.args[0]) === t && near(Number(m.args[m.args.length - 1]), cmd.value01),
        });
      }
      case 'stand_down': {
        // Absolute inverse of go_live (owner decision 2026-07-19): disarm the
        // chain; monitoring stays Auto (silent once disarmed). Hub-owned 'live'
        // flag clears immediately; Live's arm truth confirms via the echo/GET.
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const t = track as number;
        confirmed({
          targetKey: `go_live`, // same target key: live-ness commands supersede each other
          sendMsgs: [DOWN.setTrackArm.build(track, false) as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/track/get/arm', args: [t] },
          expect: (m) => m.address === '/live/track/get/arm' && Number(m.args[0]) === t && Number(m.args[1]) === 0,
        });
        const c = store.snapshot.chains.find((x) => x.id === cmd.chain);
        if (c?.live) pushDelta(store.setChainField(cmd.chain as string, 'live', false));
        return;
      }
      case 'go_live': {
        const policy = armPolicy(cmd.chain);
        if (!policy) return fail('unknown chain');
        confirmed({
          targetKey: `go_live`,
          sendMsgs: policy.msgs,
          confirmGet: { address: '/live/track/get/arm', args: [policy.t] },
          expect: (m) => m.address === '/live/track/get/arm' && Number(m.args[0]) === policy.t && Number(m.args[1]) === 1,
        });
        policy.applyLiveDeltas();
        return;
      }
      case 'fire_clip': case 'stop_clip': {
        const cell = resolver.resolveCell(cmd.cell);
        if (!cell) return fail('unknown cell');
        const [t, s] = [cell.track as number, cell.clipSlot as number];
        const q = QUANT_BEATS[store.snapshot.globalQuantization] ?? 4;
        const chainMirror = store.snapshot.chains.find((c) => c.id === cmd.cell.chain);
        const cellMirror = chainMirror?.cells.find((cl) => (cl.slot as number) === (cmd.cell.slot as number));

        // RECORD PROMOTION (Phase 3, arch §17; FakeLive = behavioral spec):
        // firing an EMPTY cell is a record intent. Arm+monitor per ARM_POLICY
        // (tone follows attention), settle, fire — Live records into the slot.
        // Recording/clip truth then flows via the armed is_recording/has_clip
        // listeners; the mirror's `recording` goes true from OBSERVED echoes.
        if (cmd.kind === 'fire_clip' && cellMirror && !cellMirror.hasClip) {
          const policy = armPolicy(cmd.cell.chain);
          if (!policy) return fail('unknown chain');
          log(`PROMOTION: empty-cell fire on ${cmd.cell.chain} slot ${cmd.cell.slot} -> RECORD (arm, settle ${ARM_SETTLE_MS}ms, fire)`);
          for (const msg of policy.msgs) {
            log(`→ ${msg.address} ${JSON.stringify(msg.args)}`);
            osc.client.send(msg.address, msg.args);
          }
          policy.applyLiveDeltas();
          const fireMsg = DOWN.fireClipSlot.build(cell.track, cell.clipSlot);
          setTimeout(() => {
            confirmed({
              targetKey: `playing_slot:${t}`,
              sendMsgs: [fireMsg as { address: string; args: (number | string)[] }],
              // fired_slot echoes the moment Live ACCEPTS the fire (pre-boundary);
              // is_recording covers the boundary itself. Either confirms.
              expect: (m) =>
                (m.address === '/live/track/get/fired_slot_index' && Number(m.args[0]) === t && Number(m.args[1]) === s) ||
                (m.address === '/live/clip/get/is_recording' && Number(m.args[0]) === t && Number(m.args[1]) === s && Number(m.args[2]) === 1),
              windowMs: quantWindowMs(positionBeats(), q, store.snapshot.tempoBpm),
              queuedForMs: Math.round(msToNextBoundary(positionBeats(), q, store.snapshot.tempoBpm)),
              // NEVER blind re-fire into a slot that is now recording — a second
              // fire FINISHES the take at the next boundary (real Live behavior).
              sendIf: () => {
                const c = store.snapshot.chains.find((x) => x.id === cmd.cell.chain);
                const cl = c?.cells.find((x) => (x.slot as number) === (cmd.cell.slot as number));
                return !!cl && !cl.recording && !cl.hasClip;
              },
            });
          }, ARM_SETTLE_MS);
          return;
        }

        const queuedForMs = cmd.kind === 'fire_clip' ? Math.round(msToNextBoundary(positionBeats(), q, store.snapshot.tempoBpm)) : undefined;
        const msg = cmd.kind === 'fire_clip' ? DOWN.fireClipSlot.build(cell.track, cell.clipSlot) : DOWN.stopClip.build(cell.track, cell.clipSlot);
        return confirmed({
          targetKey: `playing_slot:${t}`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          expect: (m) => m.address === '/live/track/get/playing_slot_index' && Number(m.args[0]) === t &&
            (cmd.kind === 'fire_clip' ? Number(m.args[1]) === s : Number(m.args[1]) !== s),
          windowMs: quantWindowMs(positionBeats(), q, store.snapshot.tempoBpm),
          queuedForMs,
        });
      }
      case 'launch_scene': {
        const scene = resolver.resolveScene(cmd.scene);
        if (scene === undefined) return fail('unknown scene');
        const msg = DOWN.fireScene.build(scene);
        const q = QUANT_BEATS[store.snapshot.globalQuantization] ?? 4;
        // FINDING 2026-07-21 (scene-launch re-verify): a scene fire triggers
        // EVERY slot in its column, and an EMPTY slot acts as that track's
        // stop button — observed: playing chains with no clip in the fired
        // column echo playing_slot = -2. The old predicate only accepted
        // playing_slot === scene, so an empty-column launch "failed" (and
        // blind-resent the fire) while reality succeeded. Fix: predict the
        // outcome per chain from mirror truth; any chain reaching its
        // predicted state confirms. Chains that will not change (idle with an
        // empty column, or already playing the fired column) are excluded —
        // change-only listeners stay silent for them.
        const predicted = new Map<number, number>(); // track -> expected playing_slot
        for (const ch of store.snapshot.chains) {
          const trk = resolver.resolveChain(ch.id);
          if (trk === undefined) continue;
          const hasClipInCol = ch.cells.some((cl) => (cl.slot as number) === (scene as number) && cl.hasClip);
          const playingSlot = ch.cells.find((cl) => cl.playing)?.slot as number | undefined;
          if (hasClipInCol && playingSlot !== (scene as number)) predicted.set(trk as number, scene as number);
          else if (!hasClipInCol && playingSlot !== undefined) predicted.set(trk as number, -2);
        }
        if (predicted.size === 0) {
          // No observable change is coming; mirror truth already matches the
          // outcome. Send once (re-firing a scene is Live's native retrigger)
          // and confirm on mirror truth — never wait for an echo that cannot
          // arrive, and never blind-resend a fire.
          osc.client.send(msg.address, msg.args);
          log(`launch_scene ${scene}: no observable change predicted — confirmed on mirror truth`);
          status(cmd.commandId, 'confirmed');
          return;
        }
        return confirmed({
          targetKey: `scene`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          // any chain reaching its PREDICTED outcome confirms the launch
          expect: (m) => m.address === '/live/track/get/playing_slot_index' &&
            predicted.get(Number(m.args[0])) === Number(m.args[1]),
          windowMs: quantWindowMs(positionBeats(), q, store.snapshot.tempoBpm),
          queuedForMs: Math.round(msToNextBoundary(positionBeats(), q, store.snapshot.tempoBpm)),
        });
      }
      case 'set_param': {
        const ref = resolver.resolveParam({ chain: cmd.chain, device: cmd.device, param: cmd.param });
        if (!ref) return fail('unknown param');
        const [t, d, p] = [ref.track as number, ref.device as number, ref.parameter as number];
        // TONE-RENAME (owner rule 2026-07-24): changing the amp capture on a
        // BARE track (nothing beyond the four fixture devices — checked from
        // scan truth) renames the track after the tone. Customized tracks
        // (extra devices) keep their names. Marker stays hub-owned; the rename
        // confirms via the name-listener echo like any other.
        if (cmd.device === 'amp' && cmd.param === 'Model' && live.tracks[t]?.devices.length === 4) {
          const tone = readTonesManifest().find((e) => e.index === cmd.value);
          const tag = resolver.tagFor(cmd.chain);
          if (tone && tag) {
            const label = tone.name.replace(/\.nam$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
            log(`TONE-RENAME: bare track ${t} -> "${label} [${tag}]" (capture change)`);
            osc.client.send('/live/track/set/name', [t, `${label} [${tag}]`]);
          }
        }
        const msg = DOWN.setDeviceParameter.build(ref.track, ref.device, ref.parameter, cmd.value);
        return confirmed({
          targetKey: `param:${cmd.chain}:${cmd.device}:${cmd.param}`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/device/get/parameter/value', args: [t, d, p] },
          expect: (m) => m.address.endsWith('/parameter/value') && Number(m.args[0]) === t && Number(m.args[1]) === d && Number(m.args[2]) === p && near(Number(m.args[3]), cmd.value),
        });
      }
      case 'duplicate_clip_to': {
        const from = resolver.resolveCell(cmd.from);
        const to = resolver.resolveCell(cmd.to);
        if (!from || !to) return fail('unknown cell');
        const srcMirror = store.snapshot.chains.find((c) => c.id === cmd.from.chain)?.cells.find((cl) => (cl.slot as number) === (cmd.from.slot as number));
        if (!srcMirror?.hasClip) return fail('source cell is empty');
        // SELF-DUP GUARD (finding 2026-07-19): from===to on an occupied cell
        // would delete the source then duplicate from the now-empty slot —
        // destroying the clip. The clip is already exactly where it'd land, so
        // this is a no-op (confirm immediately, touch nothing).
        if ((from.track as number) === (to.track as number) && (from.clipSlot as number) === (to.clipSlot as number)) {
          log(`duplicate: from===to (${cmd.to.chain} slot ${cmd.to.slot}) — no-op`);
          status(cmd.commandId, 'confirmed');
          return;
        }
        const msg = DOWN.duplicateClipTo.build(from.track, from.clipSlot, to.track, to.clipSlot);
        const registerDup = () => confirmed({
          targetKey: `dup:${cmd.to.chain}:${cmd.to.slot}`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/clip_slot/get/has_clip', args: [to.track as number, to.clipSlot as number] },
          expect: (m) => m.address === '/live/clip_slot/get/has_clip' && Number(m.args[0]) === (to.track as number) && Number(m.args[1]) === (to.clipSlot as number) && Number(m.args[2]) === 1,
          windowMs: 1000,
        });

        const targetMirror = store.snapshot.chains.find((c) => c.id === cmd.to.chain)?.cells.find((cl) => (cl.slot as number) === (cmd.to.slot as number));
        if (!targetMirror?.hasClip) { registerDup(); return; }

        // OCCUPIED TARGET (Contract 2 caveat, Phase 3): delete-then-duplicate
        // as ONE logical stateful command. The delete is VERIFIED by the
        // has_clip listener echo (observed truth, not hope) before the
        // duplicate fires; on a miss we reconcile-then-decide — re-check truth
        // and fail calmly. NEVER blind-retry any part of a stateful op.
        log(`DUPLICATE: target ${cmd.to.chain} slot ${cmd.to.slot} occupied — delete-then-duplicate as one logical command`);
        const del = DOWN.deleteClip.build(to.track, to.clipSlot);
        log(`→ ${del.address} ${JSON.stringify(del.args)}`);
        osc.client.send(del.address, del.args as (number | string)[]);
        const deadline = Date.now() + 1000;
        const poll = setInterval(() => {
          const tm = store.snapshot.chains.find((c) => c.id === cmd.to.chain)?.cells.find((cl) => (cl.slot as number) === (cmd.to.slot as number));
          if (tm && !tm.hasClip) {
            clearInterval(poll);
            log(`duplicate: delete echo observed — proceeding with duplicate`);
            registerDup();
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            // reconcile-then-decide: one explicit truth re-check, then decide.
            osc.client.send('/live/clip_slot/get/has_clip', [to.track as number, to.clipSlot as number]);
            setTimeout(() => {
              const tm2 = store.snapshot.chains.find((c) => c.id === cmd.to.chain)?.cells.find((cl) => (cl.slot as number) === (cmd.to.slot as number));
              if (tm2 && !tm2.hasClip) { log(`duplicate: delete confirmed on reconcile — proceeding`); registerDup(); }
              else {
                log(`duplicate: target delete NOT confirmed on reconcile — REFUSING to duplicate (stateful, no blind retry)`);
                status(cmd.commandId, 'failed', { reason: "couldn't clear target — nothing duplicated" });
              }
            }, 300);
          }
        }, 50);
        return;
      }
    }
  }

  /** Curated FX smart defaults (owner decision 2026-07-24). `query` feeds the
   *  frozen /live/browser/query; intended position is recorded but POSITION
   *  CONTROL IS UNOBSERVED (probe 10) — v1 loads land where load_item puts
   *  them, logged honestly. Editing beyond on/off deferred (owner). */
  const FX_CATALOG: { id: string; label: string; query: string; pos: 'pre' | 'post' }[] = [
    { id: 'compressor', label: 'Compressor', query: 'Compressor', pos: 'pre' },
    { id: 'pedal', label: 'Drive', query: 'Pedal', pos: 'pre' },
    { id: 'delay', label: 'Delay', query: 'Delay', pos: 'post' },
    { id: 'reverb', label: 'Reverb', query: 'Reverb', pos: 'post' },
    { id: 'chorus', label: 'Chorus', query: 'Chorus-Ensemble', pos: 'post' },
  ];
  const fxUriCache = new Map<string, string>();

  /** models.json, read fresh from disk; tombstones (file:null) skipped. */
  function readTonesManifest(): { index: number; name: string; file: string }[] {
    const dir = process.env.MODELS_DIR ?? '/Users/cyrustafti/Aibleton/Aibleton/models';
    try {
      const mf = JSON.parse(readFileSync(dir + '/models.json', 'utf8'));
      return (mf.entries ?? []).filter((e: { file: string | null }) => e.file !== null)
        .map((e: { index: number; name: string; file: string }) => ({ index: e.index, name: e.name, file: e.file }));
    } catch { log('tones manifest unreadable — empty list served'); return []; }
  }

  // Warm the engine's browser index at boot (FINDING 2026-07-24: queries
  // return nothing until a rescan builds it — Phase 1 always rescanned first;
  // the index is per-engine-session). Fire-and-forget; idempotent; the engine
  // logs completion on its side.
  {
    const r = DOWN.browserRescan.build();
    osc.client.send(r.address, r.args as (number | string)[]);
    log('browser index rescan issued (warms /live/browser/query for the FX panel)');
  }

  // --- TONE3000 BRIDGE (owner finding 2026-07-24: 7333 was dead because the
  // bridge is a separate server nobody started). The hub now spawns it at boot
  // — same machine, stdlib-only python — and logs its lines. BRIDGE=off skips.
  if (process.env.BRIDGE !== 'off') {
    const bridgePath = new URL('../../../devgen/tone3000_bridge.py', import.meta.url).pathname;
    if (existsSync(bridgePath)) {
      const modelsDir = process.env.MODELS_DIR ?? '/Users/cyrustafti/Aibleton/Aibleton/models';
      const bridge = spawn('python3', [bridgePath, '--models-dir', modelsDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      bridge.stdout.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => log(`[bridge] ${l}`)));
      bridge.stderr.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => log(`[bridge!] ${l}`)));
      bridge.on('exit', (code) => log(`[bridge] exited (${code}) — TONE3000 browsing down until rig restart (port 7333 already taken is fine if you run it yourself)`));
      process.on('exit', () => bridge.kill());
      log('TONE3000 bridge spawned (port 7333; BRIDGE=off to disable)');
    } else log(`TONE3000 bridge not found at ${bridgePath} — browsing unavailable`);
  }

  // --- MANIFEST WATCHER (owner rev 2026-07-24: downloads should JUST LAND) ---
  // The bridge can't do post-download OSC (the rig owns 11001 — the Errno 48
  // finding). The HUB owns OSC, so the hub watches models.json: on change,
  // EVERY amp instance gets a Rescan pulse; if a tablet declared browse intent
  // recently, that chain also auto-selects the newest capture (tone-rename
  // rule applies via the same bare-track check).
  let browseIntent: { chain: string; at: number } | null = null;
  let manifestMtime = 0;
  const modelsDirW = process.env.MODELS_DIR ?? '/Users/cyrustafti/Aibleton/Aibleton/models';
  setInterval(async () => {
    let mt = 0;
    try { mt = statSync(modelsDirW + '/models.json').mtimeMs; } catch { return; }
    if (manifestMtime === 0) { manifestMtime = mt; return; } // baseline, not an event
    if (mt === manifestMtime || restructuring) return;
    manifestMtime = mt;
    const entries = readTonesManifest();
    log(`MANIFEST CHANGED: ${entries.length} live captures — Rescan pulse to every amp`);
    for (const chainId of resolver.chainIds()) {
      const ref = resolver.resolveParam({ chain: chainId, device: 'amp', param: 'Rescan' });
      if (!ref) continue;
      const on = DOWN.setDeviceParameter.build(ref.track, ref.device, ref.parameter, 1);
      osc.client.send(on.address, on.args as (number | string)[]);
      setTimeout(() => {
        const off = DOWN.setDeviceParameter.build(ref.track, ref.device, ref.parameter, 0);
        osc.client.send(off.address, off.args as (number | string)[]);
      }, 400);
    }
    if (browseIntent && Date.now() - browseIntent.at < 10 * 60_000 && entries.length > 0) {
      const newest = entries.reduce((a, b) => (b.index > a.index ? b : a));
      const chain = browseIntent.chain;
      const ref = resolver.resolveParam({ chain: chain as never, device: 'amp', param: 'Model' });
      if (ref) {
        const t = ref.track as number;
        log(`MANIFEST: auto-selecting newest capture "${newest.name}" (index ${newest.index}) on ${chain} (browse intent)`);
        setTimeout(() => {
          const msg = DOWN.setDeviceParameter.build(ref.track, ref.device, ref.parameter, newest.index);
          osc.client.send(msg.address, msg.args as (number | string)[]);
          if (live.tracks[t]?.devices.length === 4) {
            const tg = resolver.tagFor(chain as never);
            const label = newest.name.replace(/\.nam$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (tg) { log(`TONE-RENAME: bare track ${t} -> "${label} [${tg}]" (auto-select)`); osc.client.send('/live/track/set/name', [t, `${label} [${tg}]`]); }
          }
        }, 900); // after the Rescan pulse settles
      }
    }
  }, 2000);

  // --- HTTP + WS (same seat as sim/server.ts) --------------------------------
  const http = createServer((req, res) => {
    const path = req.url === '/' || req.url === undefined ? '/index.html' : req.url.split('?')[0];
    if (path === '/tones.json') {
      // Amp-picker data (P5-a): manifest read fresh (path pinned in amp.js).
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(readTonesManifest()));
    }
    if (path.startsWith('/fx.json')) {
      // FX side-panel data: the chain's FULL scanned device list + each
      // device's live "Device On" (param 0) value, asked fresh. Served over
      // HTTP like /tones.json — the frozen mirror shape doesn't move.
      const chain = new URL(req.url ?? '', 'http://x').searchParams.get('chain');
      const track = chain ? resolver.resolveChain(chain as never) : undefined;
      if (track === undefined) { res.writeHead(404); return void res.end('{}'); }
      (async () => {
        const t = track as number;
        const devs = live.tracks[t]?.devices ?? [];
        const out = [];
        for (let d = 0; d < devs.length; d++) {
          const r = await osc.tryAsk('/live/device/get/parameter/value', [t, d, 0]);
          out.push({ index: d, name: devs[d].name, on: r ? Number(r.args[3]) !== 0 : null });
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ devices: out, catalog: FX_CATALOG.map(({ id, label, pos }) => ({ id, label, pos })) }));
      })().catch(() => { res.writeHead(500); res.end('{}'); });
      return;
    }
    if (path === '/browse-intent') {
      // The tablet declares WHICH chain the TONE3000 browse is for, so the
      // manifest watcher can auto-select the fresh download onto it.
      const chain = new URL(req.url ?? '', 'http://x').searchParams.get('chain');
      if (chain) { browseIntent = { chain, at: Date.now() }; log(`browse intent: ${chain}`); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end('{}');
    }
    const file = TABLET_DIR + path.replace(/^\//, '');
    if (!existsSync(file) || path.includes('..')) return void res.writeHead(404).end('not found');
    const ext = path.slice(path.lastIndexOf('.'));
    // FINDING 2026-07-12: the browser cached a stale app.js across an iteration
    // (every "wrong" looper tap matched the OLD toggle code verbatim). Dev rig
    // serves no-store so the tablet always runs the code on disk.
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  // --- SPECTRAL RELAY (Phase 4, Contract 6) --------------------------------
  // Every chain's NAM_A2_Spectral device sends raw SPC1 datagrams to this one
  // socket; the in-datagram chainTag tells frames apart. The hub's job is
  // decode-validate + fan out on the telemetry channel — the SAME message
  // shape the sim emits, so the tablet renderer is transport-agnostic.
  // Drop-stale stays the TABLET's job per contract (seq in the payload);
  // telemetry is lossy-OK, so decode failures are counted, not fatal.
  const spectralSock = dgram.createSocket('udp4');
  const spectraSeen = new Set<string>();
  let spectralBad = 0;
  spectralSock.on('message', (buf) => {
    let frame;
    try {
      frame = decodeSpectralFrame(buf);
    } catch (e) {
      spectralBad++;
      if (spectralBad === 1 || spectralBad % 100 === 0) log(`spectral: ${spectralBad} undecodable datagram(s) — latest: ${(e as Error).message}`);
      return;
    }
    if (!spectraSeen.has(frame.chainTag)) {
      spectraSeen.add(frame.chainTag);
      log(`spectral: first frame from "${frame.chainTag}" (seq ${frame.seq}, ${buf.length} bytes)`);
    }
    broadcast({ channel: 'telemetry', type: 'spectra', payload: frame });
  });
  spectralSock.on('error', (e) => log(`spectral: socket error: ${e.message}`));
  spectralSock.bind(SPECTRAL_UDP_PORT, '127.0.0.1', () => log(`spectral relay bound (udp ${SPECTRAL_UDP_PORT})`));

  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    log('tablet connected');
    ws.on('message', (raw) => {
      let msg: ControlMessage;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.channel !== 'control') return;
      switch (msg.type) {
        case 'hello':
          if (msg.payload.protocol !== WS_PROTOCOL_VERSION) log(`protocol mismatch: tablet=${msg.payload.protocol} hub=${WS_PROTOCOL_VERSION}`);
          ws.send(JSON.stringify(store.snapshotMessage())); // reconnect => fresh snapshot (Contract 3)
          return;
        case 'resync_request':
          log(`resync requested (tablet at rev ${msg.payload.haveRev})`);
          ws.send(JSON.stringify(store.snapshotMessage()));
          return;
        case 'command':
          log(`command: ${msg.payload.kind} (${msg.payload.commandId}) ${JSON.stringify({ ...msg.payload, kind: undefined, commandId: undefined, semantics: undefined })}`);
          handleCommand(msg.payload);
          return;
      }
    });
    ws.on('close', () => { sockets.delete(ws); log('tablet disconnected'); });
  });

  http.listen(PORT, () => {
    log(`REAL LIVE hub up — open http://localhost:${PORT}  (tablet on the LAN: http://<this-ip>:${PORT})`);
  });
}

main().catch((e) => {
  console.error('[rig] fatal:', e);
  process.exit(1);
});
