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
import { readFileSync, existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';

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
import { parseSentinelVersion, SENTINEL } from '../../../contracts/types/template.ts';
import { LiveTrackIndex, LiveClipSlotIndex, type ChainID } from '../../../contracts/types/ids.ts';

const PORT = Number(process.env.PORT ?? 8420);
const OSC_HOST = process.env.OSC_HOST ?? '127.0.0.1';
const SLOTS = 6; // tablet skeleton renders exactly 6 (tablet/app.js SLOTS)
const ASK_TIMEOUT = Number(process.env.ASK_TIMEOUT_MS ?? 2500);
const LOOPER_WINDOW_MS = 800; // v2.3 settles <=80 ms; generous for retries
const CONFIRM_GET_DELAY_MS = 120; // device state readable ~100 ms post-set (harness 04 finding)

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
  return { live: { tracks, numScenes }, trackNames };
}

async function buildMirror(osc: Osc, resolver: Resolver, live: LiveSnapshot): Promise<MirrorSnapshot> {
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
    const track = resolver.resolveChain(chainId)! as number;
    const info = live.tracks[track];
    const volume01 = await num('/live/track/get/volume', [track], 0.85);
    const panMinus1to1 = await num('/live/track/get/panning', [track], 0);
    const muted = (await num('/live/track/get/mute', [track], 0)) !== 0;
    const armed = (await num('/live/track/get/arm', [track], 0)) !== 0;
    const colorInt = await num('/live/track/get/color', [track], 0xc9a227);
    const routing = await osc.tryAsk('/live/track/get/input_routing_channel', [track]);
    const inputName = routing ? String(routing.args[routing.args.length - 1]) : null; // observed display name, or honest null

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

    chains.push({
      id: chainId,
      name: info.name.replace(/\s*\[\[.*\]\]\s*/, ''),
      color: `#${(colorInt >>> 0).toString(16).padStart(6, '0')}`,
      toneId: null,
      volume01, panMinus1to1,
      sendA01: 0, sendB01: 0, // not read at boot (skeleton note above)
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
  const { live } = await bootScan(osc);
  resolver.rebuildFromSnapshot(live);
  log(`resolver: chains = ${resolver.chainIds().map((c) => resolver.tagFor(c)).join(', ')}`);

  const store = new MirrorStore(await buildMirror(osc, resolver, live));
  log(`mirror built (rev ${store.revision})`);

  // --- WS plumbing ---------------------------------------------------------
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: StateMessage | TelemetryMessage) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s);
  };
  const pushDelta = (msg: StateMessage) => broadcast(msg);
  const status = (commandId: string, phase: CommandStatus['phase'], extra: Partial<CommandStatus> = {}) =>
    broadcast({ channel: 'state', type: 'command_status', rev: store.revision, payload: { commandId, phase, ...extra } });

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

  async function refresh(): Promise<void> {
    const next = await buildMirror(osc, resolver, live);
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
  for (const chainId of resolver.chainIds()) {
    const t = resolver.resolveChain(chainId)! as number;
    osc.client.send('/live/track/start_listen/playing_slot_index', [t]);
  }
  log('listeners armed (tempo, is_playing, beat, playing_slot per chain)');

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
      case '/live/track/get/playing_slot_index': {
        const [t, slot] = [Number(m.args[0]), Number(m.args[1])];
        const chain = chainOf(t);
        if (!chain) return;
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
        if (c && (c as Record<string, unknown>)[field] !== value) pushDelta(store.setChainField(chain as string, field as keyof ChainMirror, value));
        return;
      }
      case '/live/error':
        log(`LIVE ERROR: ${m.args.join(' ')}`); // golden rule: verbatim, visible
        return;
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
    }) => {
      const fire = () => {
        for (const msg of opts.sendMsgs) osc.client.send(msg.address, msg.args);
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

    switch (cmd.kind) {
      case 'looper_state': {
        const dev = resolver.resolveDevice(cmd.chain, 'looper');
        if (!dev) return fail('no looper on chain');
        const [t, d] = [dev.track as number, dev.device as number];
        const set = DOWN.looperSetState.build(dev.track, dev.device, cmd.state);
        confirmed({
          targetKey: `looper:${cmd.chain}`,
          sendMsgs: [{ address: set.address, args: set.args as (number | string)[] }],
          confirmGet: { address: DOWN.looperGetState.address, args: [t, d] }, // covers idempotent no-transition re-sends
          expect: (m) =>
            (m.address === '/live/looper/state' || m.address === DOWN.looperGetState.address) &&
            Number(m.args[0]) === t && Number(m.args[1]) === d && Number(m.args[2]) === cmd.state,
          windowMs: LOOPER_WINDOW_MS,
        });
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
      case 'go_live': {
        // ARM_POLICY: arm+monitor target; disarm others on the SAME input.
        const track = resolver.resolveChain(cmd.chain);
        if (track === undefined) return fail('unknown chain');
        const t = track as number;
        const target = store.snapshot.chains.find((c) => c.id === cmd.chain);
        const msgs: { address: string; args: (number | string)[] }[] = [
          DOWN.setTrackArm.build(track, true) as { address: string; args: (number | string)[] },
          DOWN.setTrackMonitoring.build(track, MonitoringState.In) as { address: string; args: (number | string)[] },
        ];
        for (const c of store.snapshot.chains) {
          if (c.id !== cmd.chain && c.inputName === target?.inputName && c.armed) {
            const ot = resolver.resolveChain(c.id);
            if (ot !== undefined) msgs.push(DOWN.setTrackArm.build(ot, false) as { address: string; args: (number | string)[] });
          }
        }
        confirmed({
          targetKey: `go_live`,
          sendMsgs: msgs,
          confirmGet: { address: '/live/track/get/arm', args: [t] },
          expect: (m) => m.address === '/live/track/get/arm' && Number(m.args[0]) === t && Number(m.args[1]) === 1,
        });
        // hub-owned 'live' flag flows as deltas immediately (hub abstraction, not Live state)
        for (const c of store.snapshot.chains) {
          const should = c.id === cmd.chain ? true : c.inputName === target?.inputName ? false : c.live;
          if (c.live !== should) pushDelta(store.setChainField(c.id as string, 'live', should));
        }
        return;
      }
      case 'fire_clip': case 'stop_clip': {
        const cell = resolver.resolveCell(cmd.cell);
        if (!cell) return fail('unknown cell');
        const [t, s] = [cell.track as number, cell.clipSlot as number];
        const q = QUANT_BEATS[store.snapshot.globalQuantization] ?? 4;
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
        return confirmed({
          targetKey: `scene`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          // any chain reporting the fired slot as playing confirms the launch
          expect: (m) => m.address === '/live/track/get/playing_slot_index' && Number(m.args[1]) === (scene as number),
          windowMs: quantWindowMs(positionBeats(), q, store.snapshot.tempoBpm),
          queuedForMs: Math.round(msToNextBoundary(positionBeats(), q, store.snapshot.tempoBpm)),
        });
      }
      case 'set_param': {
        const ref = resolver.resolveParam({ chain: cmd.chain, device: cmd.device, param: cmd.param });
        if (!ref) return fail('unknown param');
        const [t, d, p] = [ref.track as number, ref.device as number, ref.parameter as number];
        const msg = DOWN.setDeviceParameter.build(ref.track, ref.device, ref.parameter, cmd.value);
        return confirmed({
          targetKey: `param:${cmd.chain}:${cmd.device}:${cmd.param}`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/device/get/parameter/value', args: [t, d, p] },
          expect: (m) => m.address.endsWith('/parameter/value') && Number(m.args[0]) === t && Number(m.args[1]) === d && Number(m.args[2]) === p && near(Number(m.args[3]), cmd.value),
        });
      }
      case 'duplicate_clip_to': {
        // SKELETON: plain pass-through (empty target assumed); occupied-target
        // delete-then-duplicate policy = Phase 3. Stateful -> reconcile on miss.
        const from = resolver.resolveCell(cmd.from);
        const to = resolver.resolveCell(cmd.to);
        if (!from || !to) return fail('unknown cell');
        const msg = DOWN.duplicateClipTo.build(from.track, from.clipSlot, to.track, to.clipSlot);
        return confirmed({
          targetKey: `dup:${cmd.to.chain}:${cmd.to.slot}`,
          sendMsgs: [msg as { address: string; args: (number | string)[] }],
          confirmGet: { address: '/live/clip_slot/get/has_clip', args: [to.track as number, to.clipSlot as number] },
          expect: (m) => m.address === '/live/clip_slot/get/has_clip' && Number(m.args[0]) === (to.track as number) && Number(m.args[1]) === (to.clipSlot as number) && Number(m.args[2]) === 1,
          windowMs: 1000,
        });
      }
    }
  }

  // --- HTTP + WS (same seat as sim/server.ts) --------------------------------
  const http = createServer((req, res) => {
    const path = req.url === '/' || req.url === undefined ? '/index.html' : req.url.split('?')[0];
    const file = TABLET_DIR + path.replace(/^\//, '');
    if (!existsSync(file) || path.includes('..')) return void res.writeHead(404).end('not found');
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
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
          log(`command: ${msg.payload.kind} (${msg.payload.commandId})`);
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
