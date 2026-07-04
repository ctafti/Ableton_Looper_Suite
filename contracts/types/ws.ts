/**
 * ============================================================================
 * CONTRACT 3 — HUB <-> TABLET WEBSOCKET PROTOCOL
 *                                          (arch §4, §12 · BUILD-PLAN Phase 1)
 * TAG: FREEZE-NOW
 * ----------------------------------------------------------------------------
 * ONE LINE (arch §4): commands down, truth up, tablet renders, hub reconciles.
 *
 * TWO CHANNELS over the connection (arch §4, §12):
 *   - STATE      : reliable, VERSIONED with a monotonic revision counter so the
 *                  tablet can detect a gap and ask for a fresh snapshot.
 *   - TELEMETRY  : ephemeral, lossy-OK, NEVER persisted (spectra + beat/pos).
 *
 * The tablet holds NO authority. It renders the mirror and issues intents.
 * Everything it sends/receives is in stable IDs (Contract 1) — never indices,
 * never OSC. The hub is the only thing that translates to OSC (Contract 2).
 *
 * WEBRTC SIGNALLING NOTE (arch §8): the roaming-audio WebRTC offer/answer/ICE
 * is relayed over THIS websocket (no separate signalling server). Those message
 * types are included so the seam is frozen now even though roaming audio is
 * built in Phase 8.
 * ============================================================================
 */

import type { CellRef, ChainID, SceneID, Slot, ToneID, DeviceRole } from './ids.ts';
import { IDEMPOTENT, STATEFUL, type CommandSemantics } from './command-rule.ts';
import type { LooperState } from './osc.ts';
import type { SpectralFrame, BeatTelemetry } from './spectral.ts';

/** Bump on any breaking change to this protocol. Sent in `hello`. */
export const WS_PROTOCOL_VERSION = 1;

// ===========================================================================
// ENVELOPE — every message names its channel so multiplexing is explicit.
// ===========================================================================
export type WsMessage = StateMessage | TelemetryMessage | ControlMessage;

// ---------------------------------------------------------------------------
// STATE CHANNEL (reliable, versioned)
// ---------------------------------------------------------------------------

/**
 * Every state message carries `rev`, the hub's monotonic revision counter.
 * - `snapshot` sets the baseline rev.
 * - each `delta` increments rev by exactly 1.
 * If the tablet sees rev jump by more than 1, it knows it missed a delta and
 * sends `resync_request`; the hub replies with a fresh `snapshot`.
 */
export type StateMessage =
  | { readonly channel: 'state'; readonly type: 'snapshot'; readonly rev: number; readonly payload: MirrorSnapshot }
  | { readonly channel: 'state'; readonly type: 'delta'; readonly rev: number; readonly payload: MirrorDelta }
  | { readonly channel: 'state'; readonly type: 'command_status'; readonly rev: number; readonly payload: CommandStatus };

/**
 * The full mirror the tablet renders (arch §4 "split source of truth").
 * Live owns playback reality; the hub owns the abstractions Live doesn't model.
 * All identity here is stable-ID based.
 */
export interface MirrorSnapshot {
  readonly tempoBpm: number;
  readonly isPlaying: boolean;
  readonly metronome: boolean;
  readonly globalQuantization: number; // clip-trigger quant index
  readonly linkEnabled: boolean;
  readonly chains: readonly ChainMirror[];
  readonly scenes: readonly SceneMirror[];
}

export interface ChainMirror {
  readonly id: ChainID;
  readonly name: string;
  readonly color: string;                 // hex, e.g. "#C77D4A" (arch §1 chain colors)
  readonly toneId: ToneID | null;         // arch §4 tone_id -> chain
  readonly volume01: number;
  readonly panMinus1to1: number;
  readonly sendA01: number;               // shared reverb send (arch §2)
  readonly sendB01: number;               // shared delay send
  readonly muted: boolean;
  readonly armed: boolean;
  /** arm-follows-record (Contract 7 ARM_POLICY): is this the live chain for
   *  its physical input right now? The glowing-row display state. */
  readonly live: boolean;
  /** the chain's baked physical input, by name ('guitar' | 'mic' | 'synth'),
   *  read back from the track's input routing at boot; null if unroutable. */
  readonly inputName: string | null;
  readonly cells: readonly CellMirror[];  // one per slot in this row
  readonly looper: LooperMirror | null;   // present if a cell is promoted to looper
  readonly devices: readonly DeviceMirror[]; // roles present on the chain (arch §11)
}

export interface CellMirror {
  readonly slot: Slot;
  readonly hasClip: boolean;
  readonly name: string | null;
  readonly lengthBeats: number | null;
  /** Live-owned playback reality for this cell. */
  readonly playing: boolean;
  readonly recording: boolean;
  /** Hub-owned: is this cell promoted to the custom looper? (arch §1, §15) */
  readonly isLooper: boolean;
}

export interface LooperMirror {
  readonly state: LooperState;            // arch §15 owned settable state
  readonly layers: number;                // layer count (hub-owned abstraction)
  readonly speed: number;                 // playback-rate param (half/double etc.)
}

export interface DeviceMirror {
  readonly role: DeviceRole;
  readonly name: string;
  /** Parameter *name keys* the AI/tablet may target (values resolved via mirror). */
  readonly params: readonly { readonly name: string; readonly value: number; readonly min: number; readonly max: number; readonly quantized: boolean }[];
}

export interface SceneMirror {
  readonly id: SceneID;
  readonly name: string;
  readonly triggered: boolean;
}

/**
 * A minimal change to the mirror (arch §4 "deltas for speed").
 *
 * PATH GRAMMAR (frozen 2026-07-02 — was "JSON-Pointer-ish", too loose for a
 * frozen seam). A path is '/'-joined segments, and every collection segment is
 * keyed by STABLE ID, never by array position (Contract 1 applies to deltas
 * too — a positional index here is the raw-index trap sneaking back in):
 *   chains/<ChainID>/<field>
 *   chains/<ChainID>/cells/<Slot>/<field>       (Slot = the logical slot NUMBER)
 *   chains/<ChainID>/looper/<field>
 *   chains/<ChainID>/devices/<DeviceRole>/params/<paramName>/value
 *   scenes/<SceneID>/<field>
 *   <topLevelField>                              (tempoBpm, isPlaying, ...)
 * The tablet resolves ChainID/SceneID/Slot against its snapshot; an unknown
 * key means it missed a structural change -> resync_request.
 */
export interface MirrorDelta {
  readonly changes: readonly {
    readonly path: string; // e.g. "chains/chain_7Kq2/cells/3/playing" (3 = Slot value)
    readonly value: unknown;
  }[];
}

// ---------------------------------------------------------------------------
// COMMAND LIFECYCLE (arch §12) — status the hub pushes back to the tablet
// ---------------------------------------------------------------------------

/**
 * The pending-command lifecycle states (arch §12). The tablet renders these
 * as: intent = faint "heard you"; queued = a distinct countdown to the bar
 * line (never confused with lag); confirmed = solid; failed = revert to the
 * real prior state + calm "didn't take".
 */
export type CommandPhase = 'intent' | 'sent' | 'queued' | 'confirmed' | 'failed';

export interface CommandStatus {
  readonly commandId: string;         // echoes the id the tablet sent
  readonly phase: CommandPhase;
  /** For 'queued': ms until the quant boundary, for the countdown treatment. */
  readonly queuedForMs?: number;
  /** For 'failed': short, calm, user-facing reason. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// TELEMETRY CHANNEL (ephemeral, lossy-OK, never persisted)
// ---------------------------------------------------------------------------

export type TelemetryMessage =
  | { readonly channel: 'telemetry'; readonly type: 'spectra'; readonly payload: SpectralFrame }
  | { readonly channel: 'telemetry'; readonly type: 'beat'; readonly payload: BeatTelemetry };
// NOTE: the playhead SWEEP is derived locally on the tablet (tempo + clip start
// + loop length, arch §4/§67) and is deliberately NOT streamed, to avoid
// flooding position updates.

// ---------------------------------------------------------------------------
// CONTROL CHANNEL — commands up (tablet -> hub) + connection lifecycle + WebRTC
// ---------------------------------------------------------------------------

export type ControlMessage =
  | { readonly channel: 'control'; readonly type: 'hello'; readonly payload: HelloPayload }
  | { readonly channel: 'control'; readonly type: 'resync_request'; readonly payload: { readonly haveRev: number } }
  | { readonly channel: 'control'; readonly type: 'command'; readonly payload: TabletCommand }
  // WebRTC signalling relayed over the WS (arch §8) — Phase 8, frozen now:
  | { readonly channel: 'control'; readonly type: 'rtc_offer'; readonly payload: { readonly sdp: string } }
  | { readonly channel: 'control'; readonly type: 'rtc_answer'; readonly payload: { readonly sdp: string } }
  | { readonly channel: 'control'; readonly type: 'rtc_ice'; readonly payload: { readonly candidate: string; readonly sdpMid: string | null; readonly sdpMLineIndex: number | null } };

export interface HelloPayload {
  readonly protocol: number; // must equal WS_PROTOCOL_VERSION
  readonly client: 'tablet';
  /** On (re)connect the tablet discards optimistic hints and awaits a snapshot. */
  readonly resumeFromRev: number | null;
}

// ---------------------------------------------------------------------------
// TABLET COMMANDS (up) — mirror the AI tool vocabulary (arch §4 "same paths").
// These are stable-ID intents. The hub assigns a `commandId`, applies the
// Contract-8 semantics, translates to OSC, and reports back via CommandStatus.
// Each carries its own semantics so the lifecycle needs no lookup table.
// ---------------------------------------------------------------------------

export type TabletCommand =
  | ({ readonly kind: 'fire_clip'; readonly commandId: string; readonly cell: CellRef } & Sem)
  | ({ readonly kind: 'stop_clip'; readonly commandId: string; readonly cell: CellRef } & Sem)
  | ({ readonly kind: 'launch_scene'; readonly commandId: string; readonly scene: SceneID } & Sem)
  | ({ readonly kind: 'duplicate_clip_to'; readonly commandId: string; readonly from: CellRef; readonly to: CellRef } & Sem)
  | ({ readonly kind: 'set_param'; readonly commandId: string; readonly chain: ChainID; readonly device: DeviceRole; readonly param: string; readonly value: number } & Sem)
  | ({ readonly kind: 'set_send'; readonly commandId: string; readonly chain: ChainID; readonly send: 'A' | 'B'; readonly value01: number } & Sem)
  | ({ readonly kind: 'set_mute'; readonly commandId: string; readonly chain: ChainID; readonly muted: boolean } & Sem)
  | ({ readonly kind: 'set_volume'; readonly commandId: string; readonly chain: ChainID; readonly value01: number } & Sem)
  | ({ readonly kind: 'set_pan'; readonly commandId: string; readonly chain: ChainID; readonly valueMinus1to1: number } & Sem)
  /** arm-follows-record: make this chain the live chain for its input (row-
   *  header tap / "play through this"). Hub arms+monitors it and disarms the
   *  previous live chain on the same physical input (Contract 7 ARM_POLICY). */
  | ({ readonly kind: 'go_live'; readonly commandId: string; readonly chain: ChainID } & Sem)
  | ({ readonly kind: 'looper_state'; readonly commandId: string; readonly chain: ChainID; readonly state: LooperState } & Sem)
  | ({ readonly kind: 'set_tempo'; readonly commandId: string; readonly bpm: number } & Sem)
  | ({ readonly kind: 'set_metronome'; readonly commandId: string; readonly on: boolean } & Sem);

/** Attaches the frozen Contract-8 semantics to each command variant. */
interface Sem {
  readonly semantics: CommandSemantics;
}

/**
 * The canonical semantics for each tablet command kind.
 *
 * AUTHORITY RULE (2026-07-02): THIS TABLE IS AUTHORITATIVE. The `semantics`
 * field a command carries on the wire is a convenience mirror for the tablet's
 * own rendering; the HUB derives retry behaviour from `kind` via this table
 * and never trusts the client-sent field (a malformed/hostile client must not
 * be able to turn a stateful op into a blind-retried one).
 */
export const TABLET_COMMAND_SEMANTICS: Record<TabletCommand['kind'], CommandSemantics> = {
  fire_clip: IDEMPOTENT,          // fires a specific slot
  stop_clip: IDEMPOTENT,
  launch_scene: IDEMPOTENT,       // fires a specific scene
  duplicate_clip_to: STATEFUL,    // creates a clip (hub deletes an occupied target first — Contract 2 caveat)
  set_param: IDEMPOTENT,          // absolute value
  set_send: IDEMPOTENT,
  set_mute: IDEMPOTENT,
  set_volume: IDEMPOTENT,         // absolute mixer volume (was missing — mirror exposed it, nothing could set it)
  set_pan: IDEMPOTENT,            // absolute mixer pan (same fix)
  go_live: IDEMPOTENT,            // absolute target ("this chain is live"), safe to re-send
  looper_state: IDEMPOTENT,       // absolute state (arch §15)
  set_tempo: IDEMPOTENT,
  set_metronome: IDEMPOTENT,
};
