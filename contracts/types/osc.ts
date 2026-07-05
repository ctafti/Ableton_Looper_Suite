/**
 * ============================================================================
 * CONTRACT 2 — OSC VOCABULARY (down) + LISTENER/ECHO EVENTS (up)
 *                                              (arch §2, §4 · BUILD-PLAN Phase 1)
 * TAG: mostly FREEZE-NOW; PROVISIONAL items marked inline.
 * ----------------------------------------------------------------------------
 * This is the wire between our engine (an extended AbletonOSC MIDI Remote
 * Script) and the hub. It is GROUNDED in AbletonOSC's real, current address
 * space — see contracts/README + reports/API-REALITY.md for the exact source.
 *
 * TRANSPORT FACTS (from AbletonOSC README, verified 2026-07-01):
 *   - Engine LISTENS for OSC on UDP port 11000.
 *   - Engine SENDS replies/echoes on UDP port 11001, to the sender's IP.
 *   - Property change listeners are change-only (delta) and are armed with
 *     /live/<obj>/start_listen/<prop>; replies arrive at /live/<obj>/get/<prop>.
 *   - Wildcards work for gets, e.g. /live/clip/get/* 0 0.
 *
 * ADDRESS ORIGIN LEGEND (see API-REALITY.md for the audit):
 *   [OSC]  = address exists verbatim in AbletonOSC today (FREEZE-NOW).
 *   [EXT]  = address we ADD to the engine. Its LOM basis is noted; tag varies.
 *
 * IDS RULE: the *hub* speaks CellRef/ChainID; the resolver converts to indices
 * (Contract 1) and only THEN are these OSC messages built. Raw indices appear
 * here (this IS the index layer) and nowhere above it.
 * ============================================================================
 */

import type {
  LiveTrackIndex,
  LiveClipSlotIndex,
  LiveDeviceIndex,
  LiveParameterIndex,
  LiveSceneIndex,
  LiveSendIndex,
} from './ids.ts';
import { IDEMPOTENT, STATEFUL, type CommandSemantics } from './command-rule.ts';

/** An OSC argument as accepted by AbletonOSC (ints, floats, strings, bools). */
export type OscArg = number | string | boolean;

/** A concrete OSC message ready to serialise onto the wire. */
export interface OscMessage {
  readonly address: string;
  readonly args: readonly OscArg[];
}

/** A down-command descriptor: how to build it + its Contract-8 semantics. */
export interface OscCommandDef<A extends readonly unknown[]> {
  readonly address: string;
  readonly origin: 'OSC' | 'EXT';
  readonly tag: 'FREEZE-NOW' | 'PROVISIONAL';
  readonly semantics: CommandSemantics;
  /** Builds the wire message from typed, already-resolved arguments. */
  readonly build: (...args: A) => OscMessage;
}

// ===========================================================================
// PORTS
// ===========================================================================
export const OSC_PORTS = {
  /** Hub -> engine (commands). */
  toEngine: 11000,
  /** Engine -> hub (echoes, replies, listener deltas). */
  fromEngine: 11001,
} as const;

// ===========================================================================
// DOWN — COMMAND VOCABULARY (hub -> engine)
// ===========================================================================
// Each entry is grounded. Args are ALREADY-RESOLVED Live indices (Contract 1).
// ---------------------------------------------------------------------------

export const DOWN = {
  // --- Transport (arch §1, §5.2) -----------------------------------------
  // [OSC] All present in AbletonOSC Song API.
  startPlaying: {
    address: '/live/song/start_playing',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: () => ({ address: '/live/song/start_playing', args: [] }),
  } satisfies OscCommandDef<[]>,

  stopPlaying: {
    address: '/live/song/stop_playing',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: () => ({ address: '/live/song/stop_playing', args: [] }),
  } satisfies OscCommandDef<[]>,

  stopAllClips: {
    address: '/live/song/stop_all_clips',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: () => ({ address: '/live/song/stop_all_clips', args: [] }),
  } satisfies OscCommandDef<[]>,

  // Absolute tempo/metronome (never "faster"/"toggle" — Contract 8). [OSC]
  setTempo: {
    address: '/live/song/set/tempo',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (bpm: number) => ({ address: '/live/song/set/tempo', args: [bpm] }),
  } satisfies OscCommandDef<[bpm: number]>,

  setMetronome: {
    address: '/live/song/set/metronome',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (on: boolean) => ({ address: '/live/song/set/metronome', args: [on ? 1 : 0] }),
  } satisfies OscCommandDef<[on: boolean]>,

  // Absolute clip-trigger quantization (global launch quant). [OSC]
  setClipTriggerQuantization: {
    address: '/live/song/set/clip_trigger_quantization',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (q: number) => ({ address: '/live/song/set/clip_trigger_quantization', args: [q] }),
  } satisfies OscCommandDef<[quantIndex: number]>,

  // --- Clip / clip-slot launch (arch §1 hero grid) -----------------------
  // [OSC] clip_slot/fire, clip/fire, clip/stop, clip_slot/create/delete.
  fireClipSlot: {
    address: '/live/clip_slot/fire',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // fires a SPECIFIC slot
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex) =>
      ({ address: '/live/clip_slot/fire', args: [t as number, c as number] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, clip: LiveClipSlotIndex]>,

  stopClip: {
    address: '/live/clip/stop',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex) =>
      ({ address: '/live/clip/stop', args: [t as number, c as number] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, clip: LiveClipSlotIndex]>,

  createClip: {
    address: '/live/clip_slot/create_clip',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: STATEFUL, // creates a clip
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex, lengthBeats: number) =>
      ({ address: '/live/clip_slot/create_clip', args: [t as number, c as number, lengthBeats] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, clip: LiveClipSlotIndex, lengthBeats: number]>,

  deleteClip: {
    address: '/live/clip_slot/delete_clip',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: STATEFUL,
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex) =>
      ({ address: '/live/clip_slot/delete_clip', args: [t as number, c as number] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, clip: LiveClipSlotIndex]>,

  /**
   * THE HERO INTERACTION — drag clip to another chain (arch §1, §5.4).
   * [OSC] IMPORTANT AUDIT FINDING: this already exists in AbletonOSC as
   * /live/clip_slot/duplicate_clip_to (track, clip, target_track, target_clip).
   * The architecture (§2) assumed we'd need a "minor OSC extension" for this —
   * we do NOT. It ships today. (See API-REALITY.md.)
   * Stateful: it creates a clip in the target slot -> reconcile-then-decide.
   *
   * CAVEAT (verified in the AbletonOSC README, 2026-07-02): it duplicates to an
   * EMPTY target clip slot. The hero drag WILL hit occupied targets, so the HUB
   * owns this policy: if the target cell has a clip, send deleteClip(target)
   * then duplicateClipTo, serialized as one logical stateful command (verify
   * the delete echo before duplicating; reconcile-then-decide on failure).
   * Never surface two commands to the tablet — it sees one drag.
   */
  duplicateClipTo: {
    address: '/live/clip_slot/duplicate_clip_to',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: STATEFUL,
    build: (
      t: LiveTrackIndex, c: LiveClipSlotIndex,
      tt: LiveTrackIndex, tc: LiveClipSlotIndex,
    ) => ({
      address: '/live/clip_slot/duplicate_clip_to',
      args: [t as number, c as number, tt as number, tc as number],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex,
     targetTrack: LiveTrackIndex, targetClip: LiveClipSlotIndex]
  >,

  // --- Scene / column launch (bottom bar, arch §1) -----------------------
  fireScene: {
    address: '/live/scene/fire',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // fires a SPECIFIC scene
    build: (s: LiveSceneIndex) => ({ address: '/live/scene/fire', args: [s as number] }),
  } satisfies OscCommandDef<[scene: LiveSceneIndex]>,

  // --- Track mixer: volume / pan / send / mute / arm (arch §2 FX sends) ---
  // [OSC] All present. Sends A/B surfaced as params live here.
  setTrackVolume: {
    address: '/live/track/set/volume',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, v: number) =>
      ({ address: '/live/track/set/volume', args: [t as number, v] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, value01: number]>,

  setTrackPanning: {
    address: '/live/track/set/panning',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, v: number) =>
      ({ address: '/live/track/set/panning', args: [t as number, v] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, valueMinus1to1: number]>,

  setTrackSend: {
    address: '/live/track/set/send',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, sendId: LiveSendIndex, v: number) =>
      ({ address: '/live/track/set/send', args: [t as number, sendId as number, v] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, send: LiveSendIndex, value01: number]>,

  setTrackMute: {
    address: '/live/track/set/mute',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, on: boolean) =>
      ({ address: '/live/track/set/mute', args: [t as number, on ? 1 : 0] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, muted: boolean]>,

  setTrackArm: {
    address: '/live/track/set/arm',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, on: boolean) =>
      ({ address: '/live/track/set/arm', args: [t as number, on ? 1 : 0] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, armed: boolean]>,

  // --- Monitoring + input routing (arch §17 arm-follows-record) ----------
  // [OSC] ALL STOCK (verified in AbletonOSC track.py, 2026-07-02):
  // current_monitoring_state is a normal rw property; input routing get/set
  // works by DISPLAY NAME against available_input_routing_types/channels.
  // These four are everything the arm-follows-record policy needs — the
  // policy itself lives in the hub, no engine extension involved.
  setTrackMonitoring: {
    address: '/live/track/set/current_monitoring_state',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, state: MonitoringState) =>
      ({ address: '/live/track/set/current_monitoring_state', args: [t as number, state as number] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, state: MonitoringState]>,

  setTrackInputRoutingType: {
    address: '/live/track/set/input_routing_type',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    // displayName must be one of /live/track/get/available_input_routing_types
    build: (t: LiveTrackIndex, displayName: string) =>
      ({ address: '/live/track/set/input_routing_type', args: [t as number, displayName] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, displayName: string]>,

  setTrackInputRoutingChannel: {
    address: '/live/track/set/input_routing_channel',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, displayName: string) =>
      ({ address: '/live/track/set/input_routing_channel', args: [t as number, displayName] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, displayName: string]>,

  // --- Device parameters (arch §2 amp/character, §10 targets) ------------
  // [OSC] /live/device/set/parameter/value (track, device, param, value).
  // This is the generic "set any knob to an absolute value" primitive.
  setDeviceParameter: {
    address: '/live/device/set/parameter/value',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, d: LiveDeviceIndex, p: LiveParameterIndex, v: number) => ({
      address: '/live/device/set/parameter/value',
      args: [t as number, d as number, p as number, v],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, device: LiveDeviceIndex, param: LiveParameterIndex, value: number]
  >,

  // --- View selection (needed for §11 device load: select-then-load) -----
  // [OSC] /live/view/set/selected_track.
  selectTrack: {
    address: '/live/view/set/selected_track',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex) =>
      ({ address: '/live/view/set/selected_track', args: [t as number] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex]>,

  // =========================================================================
  // EXTENSIONS WE MUST ADD TO THE ENGINE (not in AbletonOSC today)
  // =========================================================================

  // --- Warp markers (arch §2) --------------------------------------------
  // [EXT] LOM CONFIRMED: Clip.add_warp_marker / move_warp_marker /
  // remove_warp_marker exist (Cycling '74 LOM). AbletonOSC only wraps the
  // warp on/off toggle, so we expose these three. FREEZE-NOW (LOM-backed).
  addWarpMarker: {
    address: '/live/clip/add_warp_marker',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: STATEFUL, // adds a marker
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex, beatTime: number, sampleTime?: number) => ({
      address: '/live/clip/add_warp_marker',
      args: sampleTime === undefined
        ? [t as number, c as number, beatTime]
        : [t as number, c as number, beatTime, sampleTime],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex, beatTime: number, sampleTime?: number]
  >,

  moveWarpMarker: {
    address: '/live/clip/move_warp_marker',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // move to absolute delta
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex, beatTime: number, distance: number) => ({
      address: '/live/clip/move_warp_marker',
      args: [t as number, c as number, beatTime, distance],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex, beatTime: number, distance: number]
  >,

  removeWarpMarker: {
    address: '/live/clip/remove_warp_marker',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: STATEFUL,
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex, beatTime: number) => ({
      address: '/live/clip/remove_warp_marker',
      args: [t as number, c as number, beatTime],
    }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, clip: LiveClipSlotIndex, beatTime: number]>,

  setWarpMode: {
    address: '/live/clip/set/warp_mode',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // [OSC] exists
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex, mode: number) =>
      ({ address: '/live/clip/set/warp_mode', args: [t as number, c as number, mode] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, clip: LiveClipSlotIndex, mode: number]>,

  // --- Automation write (arch §10) ---------------------------------------
  // [EXT] *** PROVISIONAL ***  insert_step / value_at_time DO exist in the
  // Python Remote-Script Live API our engine uses (AutomationEnvelope; confirmed
  // in the API dumps across Live 9-11, used by ClyphX). They are absent only
  // from the M4L JS-LOM apiref, which is a different surface. The CLEAR side
  // (clear_envelope / clear_all_envelopes / has_envelopes) is also present.
  // PROVISIONAL only to confirm the Live-12 / Python-3.11 signature on-rig:
  // the §10 spike must verify the WRITE path signature holds before app code
  // relies on it. See API-REALITY.md item #2 + PROVISIONAL-SEAMS.md seam 1.
  insertStep: {
    address: '/live/clip/insert_step',
    origin: 'EXT', tag: 'PROVISIONAL', semantics: IDEMPOTENT, // absolute value at a fixed (time,dur)
    build: (
      t: LiveTrackIndex, c: LiveClipSlotIndex, d: LiveDeviceIndex, p: LiveParameterIndex,
      time: number, duration: number, value: number,
    ) => ({
      address: '/live/clip/insert_step',
      args: [t as number, c as number, d as number, p as number, time, duration, value],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex, device: LiveDeviceIndex,
     param: LiveParameterIndex, time: number, duration: number, value: number]
  >,

  /**
   * BATCHED automation write — the unit write_movement actually uses.
   * One message = one atomic undo: the engine wraps the whole loop in
   * song.begin_undo_step()/end_undo_step() so a voice command is ONE Cmd-Z
   * (arch §10 "wrap the insert loop as one atomic undo"). Args after the four
   * indices are repeated (time, duration, value) TRIPLES.
   * Same PROVISIONAL status + spike as insertStep (they share the primitive).
   */
  insertSteps: {
    address: '/live/clip/insert_steps',
    origin: 'EXT', tag: 'PROVISIONAL', semantics: IDEMPOTENT, // absolute steps, clear-before-write at hub level
    build: (
      t: LiveTrackIndex, c: LiveClipSlotIndex, d: LiveDeviceIndex, p: LiveParameterIndex,
      steps: readonly { readonly time: number; readonly duration: number; readonly value: number }[],
    ) => ({
      address: '/live/clip/insert_steps',
      args: [t as number, c as number, d as number, p as number,
             ...steps.flatMap((s) => [s.time, s.duration, s.value])],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex, device: LiveDeviceIndex,
     param: LiveParameterIndex,
     steps: readonly { readonly time: number; readonly duration: number; readonly value: number }[]]
  >,

  /**
   * Envelope READBACK request (the write_movement receipt, arch §10). Args
   * after the indices are the sample TIMES to evaluate via value_at_time.
   * Engine replies on the SAME address (AbletonOSC convention) with
   * (track, clip, device, param, time0, value0, time1, value1, ...) — parsed
   * into the automation_readback up-event.
   */
  getEnvelope: {
    address: '/live/clip/get/envelope',
    origin: 'EXT', tag: 'PROVISIONAL', semantics: IDEMPOTENT, // pure read
    build: (
      t: LiveTrackIndex, c: LiveClipSlotIndex, d: LiveDeviceIndex, p: LiveParameterIndex,
      times: readonly number[],
    ) => ({
      address: '/live/clip/get/envelope',
      args: [t as number, c as number, d as number, p as number, ...times],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex, device: LiveDeviceIndex,
     param: LiveParameterIndex, times: readonly number[]]
  >,

  clearEnvelope: {
    address: '/live/clip/clear_envelope',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // LOM clear_envelope is official
    build: (t: LiveTrackIndex, c: LiveClipSlotIndex, d: LiveDeviceIndex, p: LiveParameterIndex) => ({
      address: '/live/clip/clear_envelope',
      args: [t as number, c as number, d as number, p as number],
    }),
  } satisfies OscCommandDef<
    [track: LiveTrackIndex, clip: LiveClipSlotIndex, device: LiveDeviceIndex, param: LiveParameterIndex]
  >,

  // --- Device instantiation via browser (arch §11) -----------------------
  // [EXT] *** load_item PROVISIONAL (reliability) ***  The control-surface
  // Python API (which our engine runs on) DOES expose Browser.load_item(item)
  // — confirmed. What's provisional is reliability/verification across Live
  // point releases (arch §6 item 7). The engine indexes the browser at boot
  // and loads by a resolved URI. Receipt = device-list readback (see UP).
  browserLoadItem: {
    address: '/live/browser/load_item',
    origin: 'EXT', tag: 'PROVISIONAL', semantics: STATEFUL, // adds a device
    build: (t: LiveTrackIndex, uri: string) =>
      ({ address: '/live/browser/load_item', args: [t as number, uri] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, uri: string]>,

  /** Ask the engine to (re)build its browser name->uri index (arch §11 stage 1). */
  browserRescan: {
    address: '/live/browser/rescan',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: () => ({ address: '/live/browser/rescan', args: [] }),
  } satisfies OscCommandDef<[]>,

  /**
   * Query the engine's boot-time browser index (arch §11 stage 2). Reply on
   * the same address: (query, name0, uri0, name1, uri1, ...) -> the
   * browser_matches up-event. This is how the hub gets a REAL itemUri for
   * add_device / harness 02 instead of hard-coding version-varying URIs.
   */
  browserQuery: {
    address: '/live/browser/query',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // pure read of our own index
    build: (query: string, maxResults: number) =>
      ({ address: '/live/browser/query', args: [query, maxResults] }),
  } satisfies OscCommandDef<[query: string, maxResults: number]>,

  // --- Custom M4L looper state (arch §15) --------------------------------
  // [EXT] FREEZE-NOW (spike 04 CLOSED on the rig 2026-07-05). Semantic wrapper.
  // The looper is our custom M4L device whose State is a *normal settable device
  // parameter*. This semantic address exists so callers say "set looper = OVERDUB"
  // without knowing the param index; the engine maps state->paramValue using the
  // template (Contract 7). The state enum + receipt shape are now proven:
  // NAM_A2_Looper reports its resulting state back and the round-trip passes (see
  // API-REALITY RIG RESULTS 2026-07-05 / PROVISIONAL-SEAMS seam 3).
  looperSetState: {
    address: '/live/looper/set_state',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT, // absolute target state
    build: (t: LiveTrackIndex, d: LiveDeviceIndex, state: LooperState) =>
      ({ address: '/live/looper/set_state', args: [t as number, d as number, state] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, device: LiveDeviceIndex, state: LooperState]>,

  /** Read the looper's current state; replies on the same address. */
  looperGetState: {
    address: '/live/looper/get/state',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (t: LiveTrackIndex, d: LiveDeviceIndex) =>
      ({ address: '/live/looper/get/state', args: [t as number, d as number] }),
  } satisfies OscCommandDef<[track: LiveTrackIndex, device: LiveDeviceIndex]>,

  /** Liveness probe: engine replies with the same hello it sends on init. */
  enginePing: {
    address: '/live/engine/ping',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: () => ({ address: '/live/engine/ping', args: [] }),
  } satisfies OscCommandDef<[]>,

  // --- Ableton Link enable (arch §14) ------------------------------------
  // [EXT] LOM CONFIRMED: Song.is_ableton_link_enabled is settable (caveat:
  // the Link transport-bar toggle must be visible). AbletonOSC doesn't expose
  // it in its explicit song setter list, so we add it. FREEZE-NOW for the
  // *enable* itself; the separate "does 12.4 expose a Link-AUDIO-enable LOM
  // property?" question is ASSUMED and gated on a bench check (see reports).
  setLinkEnabled: {
    address: '/live/song/set/is_ableton_link_enabled',
    origin: 'EXT', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (on: boolean) =>
      ({ address: '/live/song/set/is_ableton_link_enabled', args: [on ? 1 : 0] }),
  } satisfies OscCommandDef<[on: boolean]>,

  // --- Snapshot request (arch §4 boot/reconnect) -------------------------
  // [OSC] Implemented via /live/song/get/track_data bulk query; we wrap it as
  // a single logical request the hub issues on boot/reconnect/structural change.
  requestSnapshot: {
    address: '/live/song/get/track_data',
    origin: 'OSC', tag: 'FREEZE-NOW', semantics: IDEMPOTENT,
    build: (fromTrack: number, toTrack: number, props: readonly string[]) =>
      ({ address: '/live/song/get/track_data', args: [fromTrack, toTrack, ...props] }),
  } satisfies OscCommandDef<[fromTrack: number, toTrack: number, props: readonly string[]]>,
} as const;

// ===========================================================================
// LISTENERS — arming change-only echoes (arch §4 "truth up")
// ===========================================================================
// These tell Live to start pushing deltas to /live/<obj>/get/<prop>. They are
// idempotent (re-arming is harmless). [OSC] all present.
// ---------------------------------------------------------------------------

export const LISTEN = {
  /** Per-track: which slot is *playing* now (the confirmed-launch echo). */
  trackPlayingSlot: (t: LiveTrackIndex): OscMessage =>
    ({ address: '/live/track/start_listen/playing_slot_index', args: [t as number] }),
  /** Per-track: which slot is *fired* (queued) now. */
  trackFiredSlot: (t: LiveTrackIndex): OscMessage =>
    ({ address: '/live/track/start_listen/fired_slot_index', args: [t as number] }),
  /** Global beat pulse (arch §4 telemetry / clock). */
  beat: (): OscMessage => ({ address: '/live/song/start_listen/beat', args: [] }),
  /** Transport play state. */
  isPlaying: (): OscMessage => ({ address: '/live/song/start_listen/is_playing', args: [] }),
  /** Tempo changes (so we follow Live / a Link session — arch §14). */
  tempo: (): OscMessage => ({ address: '/live/song/start_listen/tempo', args: [] }),
  /** Per-clip recording/overdub state (looper + record confirms). */
  clipIsRecording: (t: LiveTrackIndex, c: LiveClipSlotIndex): OscMessage =>
    ({ address: '/live/clip/start_listen/is_recording', args: [t as number, c as number] }),
  clipIsPlaying: (t: LiveTrackIndex, c: LiveClipSlotIndex): OscMessage =>
    ({ address: '/live/clip/start_listen/is_playing', args: [t as number, c as number] }),
  /** Per-parameter value (confirm set_param + read looper state param). */
  deviceParam: (t: LiveTrackIndex, d: LiveDeviceIndex, p: LiveParameterIndex): OscMessage => ({
    address: '/live/device/start_listen/parameter/value',
    args: [t as number, d as number, p as number],
  }),
} as const;

// ===========================================================================
// UP — LISTENER / ECHO / REPLY EVENTS (engine -> hub)
// ===========================================================================
// Typed shapes for what arrives on port 11001. The hub parses the raw OSC
// address+args into one of these, then the RESOLVER maps indices back to
// ChainID/CellRef (Contract 1) before anything goes to the tablet.
// ---------------------------------------------------------------------------

/** Discriminated union of every upstream event we consume. */
export type OscUpEvent =
  | { readonly kind: 'startup' }                                              // [OSC] /live/startup
  | { readonly kind: 'error'; readonly message: string }                      // [OSC] /live/error
  | { readonly kind: 'test_ok' }                                              // [OSC] /live/test
  | { readonly kind: 'playing_slot'; readonly track: LiveTrackIndex; readonly slot: number }   // [OSC]
  | { readonly kind: 'fired_slot';   readonly track: LiveTrackIndex; readonly slot: number }   // [OSC]
  | { readonly kind: 'beat';         readonly beat: number }                  // [OSC]
  | { readonly kind: 'is_playing';   readonly isPlaying: boolean }            // [OSC]
  | { readonly kind: 'tempo';        readonly bpm: number }                   // [OSC]
  | { readonly kind: 'clip_recording'; readonly track: LiveTrackIndex; readonly clip: LiveClipSlotIndex; readonly isRecording: boolean } // [OSC]
  | { readonly kind: 'clip_playing';   readonly track: LiveTrackIndex; readonly clip: LiveClipSlotIndex; readonly isPlaying: boolean }   // [OSC]
  | { readonly kind: 'param_value';  readonly track: LiveTrackIndex; readonly device: LiveDeviceIndex; readonly parameter: LiveParameterIndex; readonly value: number } // [OSC]
  // --- Extension echoes ---
  | { readonly kind: 'engine_hello'; readonly version: string; readonly protocol: number } // [EXT] arch §13 "hello on init" — sent unsolicited on /live/engine/hello, and as the reply to enginePing
  | {
      // [EXT] reply to browserQuery: matches from the engine's browser index.
      readonly kind: 'browser_matches';
      readonly query: string;
      readonly matches: readonly { readonly name: string; readonly uri: string }[];
    }
  | {
      // [EXT] PROVISIONAL — the load-and-verify RECEIPT (arch §11 stage 3).
      // The engine reads the target track's device list AFTER a load and
      // reports the diff. Success = exactly one new device matching the item.
      readonly kind: 'device_load_result';
      readonly track: LiveTrackIndex;
      readonly ok: boolean;
      readonly addedDeviceIndex?: LiveDeviceIndex;
      readonly addedDeviceName?: string;
      readonly reason?: string; // present when ok === false
    }
  | {
      // [EXT] FREEZE-NOW — looper state readback echo (arch §15; spike 04 closed
      // 2026-07-05). The device reports its resulting state; hub reads observed truth.
      readonly kind: 'looper_state';
      readonly track: LiveTrackIndex;
      readonly device: LiveDeviceIndex;
      readonly state: LooperState;
      readonly layers?: number;
    }
  | {
      // [EXT] PROVISIONAL — automation readback (value_at_time), the
      // write_movement receipt (arch §10). Confirms sampled envelope values.
      readonly kind: 'automation_readback';
      readonly track: LiveTrackIndex;
      readonly clip: LiveClipSlotIndex;
      readonly device: LiveDeviceIndex;
      readonly parameter: LiveParameterIndex;
      readonly samples: readonly { readonly time: number; readonly value: number }[];
    };

// ===========================================================================
// SHARED ENUMS
// ===========================================================================

/**
 * Looper state — the custom M4L looper's settable State parameter (arch §15).
 * Values are ABSOLUTE targets (Contract 8). The numeric mapping to the M4L
 * device's parameter value is defined by the template (Contract 7); confirmed
 * on the rig (spike 04, 2026-07-05) — 0=Stop 1=Play 2=Record 3=Overdub.
 */
export const LooperState = {
  Stop: 0,
  Play: 1,
  Record: 2,
  Overdub: 3,
} as const;
export type LooperState = (typeof LooperState)[keyof typeof LooperState];
// NOTE (2026-07-02): was a TS `enum`; converted to an erasable const object so
// runtime code (harnesses under node --experimental-strip-types) can import
// this contract file directly instead of duplicating addresses/values.

/**
 * Warp mode indices — CONFIRMED from the LOM Clip.warp_mode enum.
 * 0=Beats 1=Tones 2=Texture 3=Re-Pitch 4=Complex 5=REX 6=Complex Pro.
 */
export const WarpMode = {
  Beats: 0, Tones: 1, Texture: 2, RePitch: 3, Complex: 4, REX: 5, ComplexPro: 6,
} as const;
export type WarpMode = (typeof WarpMode)[keyof typeof WarpMode];

/**
 * Track monitoring state — values of the STOCK track property
 * `current_monitoring_state` (0 = In, 1 = Auto, 2 = Off). Used by the
 * arm-follows-record policy (Contract 7 ARM_POLICY / arch §17).
 */
export const MonitoringState = {
  In: 0, Auto: 1, Off: 2,
} as const;
export type MonitoringState = (typeof MonitoringState)[keyof typeof MonitoringState];

/** Default snapshot property set for requestSnapshot (arch §4). [OSC] format. */
export const SNAPSHOT_PROPS = [
  'track.name',
  'track.color',
  'track.mute',
  'track.arm',
  'clip.name',
  'clip.length',
  'clip.is_playing',
  'clip.is_recording',
] as const;
