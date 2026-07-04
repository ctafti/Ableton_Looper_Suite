/**
 * ============================================================================
 * CONTRACT 1 — STABLE-ID SCHEME              (arch §4 · BUILD-PLAN Phase 1)
 * TAG: FREEZE-NOW
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS (plain language)
 *
 * Ableton addresses everything by *index*: "track 3", "clip slot 2",
 * "device 1", "parameter 7". Those numbers shift the instant a track is
 * added, removed, or reordered. If the tablet or the AI ever holds a raw
 * index, everything silently points at the wrong thing after any edit.
 *
 * So we NEVER let a raw Live index leave one small place: the RESOLVER.
 * Everything above the resolver (the tablet, the AI brain, the websocket,
 * the state mirror) speaks only in *stable IDs* that we mint and that never
 * change for the life of a chain. The resolver is the single translator
 * between "stable ID" and "whatever index Live is using right now".
 *
 * HOW THE TYPES ENFORCE IT
 *
 * We use "branded" types. A ChainID is really just a string and a
 * LiveTrackIndex is really just a number, but TypeScript treats them as
 * different types, so the compiler will REJECT any code that tries to pass a
 * raw Live index where a stable ID belongs (or vice-versa). The only code
 * allowed to *create* a LiveTrackIndex is the resolver/OSC layer.
 * ============================================================================
 */

// --- Branding helper -------------------------------------------------------
// A "brand" is an invisible tag that makes two structurally-identical types
// (e.g. two strings) incompatible. `Brand<string, 'ChainID'>` is still a
// string at runtime, but the compiler won't let you mix it up with a plain
// string or a differently-branded string.
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// STABLE IDS  (these are the ONLY spatial identifiers allowed above the
// resolver — in websocket messages, AI tool calls, and the state mirror)
// ---------------------------------------------------------------------------

/**
 * ChainID — a stable, opaque identifier for one effect-chain row.
 * Minted by the backend (e.g. "chain_7Kq2"). It is associated with a Live
 * track once (at template load) and then tracks that track object for life,
 * regardless of how the track is reordered. Treat it as opaque: never parse
 * it, never derive a Live index from it.
 */
export type ChainID = Brand<string, 'ChainID'>;

/**
 * Slot — a 0-based *logical* column in the horizontal looper grid.
 * This is OUR grid coordinate, not a Live clip-slot index. The resolver maps
 * (ChainID, Slot) -> (Live track index, Live clip-slot index). Slots are
 * stable: slot 0 is always the leftmost column of the grid.
 */
export type Slot = Brand<number, 'Slot'>;

/**
 * CellRef — the only spatial address the tablet and the AI ever speak.
 * "Do X to (this chain, this slot)". The hub/resolver turns it into indices.
 */
export interface CellRef {
  readonly chain: ChainID;
  readonly slot: Slot;
}

/** SceneID — stable identifier for a column-launch scene (bottom bar). */
export type SceneID = Brand<string, 'SceneID'>;

/**
 * ToneID — a TONE3000 tone id associated with a chain (arch §4 "tone_id->chain").
 * It is a *number* in the TONE3000 API; we brand it so it can't be confused
 * with a Slot or any other number. Owned by the backend's abstraction state.
 */
export type ToneID = Brand<number, 'ToneID'>;

/**
 * ParamRef — a stable reference to one automatable parameter on a chain.
 * We reference parameters by a stable *name key* (resolved against the
 * device's parameter list by the resolver), NOT by raw parameter index,
 * for the same reason we avoid track indices: parameter order can differ
 * across device versions. `device` selects which device on the chain
 * (by role, see Contract 7 template roles), `param` is the parameter's
 * name key.
 */
export interface ParamRef {
  readonly chain: ChainID;
  readonly device: DeviceRole;
  readonly param: string; // e.g. "Gain", "Frequency", "State", "Speed"
}

/**
 * DeviceRole — the *role* a device plays on a chain, from the template
 * (Contract 7). Roles are stable; the resolver maps a role to the current
 * device index on the track. This is how the AI says "the looper" or
 * "the amp" without knowing device indices.
 */
export type DeviceRole =
  | 'amp'          // NAM rack / Gateway host + chain selector
  | 'looper'       // our custom M4L creative looper (arch §15)
  | 'inline_fx'    // the per-row inline FX escape hatch (after the looper)
  | 'eq'           // per-chain stock EQ Eight fixture, BEFORE the spectral tap
                    //   so the viz shows the post-EQ spectrum (arch §16 / rev 07-01b)
  | 'spectral'     // the M4L FFT tap device (arch §3)
  | (string & {}); // open: any device the AI adds via add_device keeps its
                    // resolved name as a role key. `(string & {})` keeps
                    // editor autocomplete for the known roles above.

// ---------------------------------------------------------------------------
// RAW LIVE INDICES  (these types may ONLY be produced/consumed inside the
// resolver and the OSC layer — never placed in a websocket or AI message)
// ---------------------------------------------------------------------------

export type LiveTrackIndex = Brand<number, 'LiveTrackIndex'>;
export type LiveClipSlotIndex = Brand<number, 'LiveClipSlotIndex'>;
export type LiveDeviceIndex = Brand<number, 'LiveDeviceIndex'>;
export type LiveParameterIndex = Brand<number, 'LiveParameterIndex'>;
export type LiveSceneIndex = Brand<number, 'LiveSceneIndex'>;
export type LiveSendIndex = Brand<number, 'LiveSendIndex'>;

/** The concrete Live coordinates the resolver hands to the OSC layer. */
export interface ResolvedCell {
  readonly track: LiveTrackIndex;
  readonly clipSlot: LiveClipSlotIndex;
}
export interface ResolvedDevice {
  readonly track: LiveTrackIndex;
  readonly device: LiveDeviceIndex;
}
export interface ResolvedParameter extends ResolvedDevice {
  readonly parameter: LiveParameterIndex;
}

// ---------------------------------------------------------------------------
// THE RESOLVER INTERFACE  (the ONLY legal bridge between the two worlds)
// ---------------------------------------------------------------------------

/**
 * IdResolver — the backend component that owns ID<->index translation.
 * Implemented in Phase 2 (walking skeleton). Frozen here so every later
 * component is written against this seam and never touches indices directly.
 *
 * All lookups can fail (e.g. a chain was deleted); they return `undefined`
 * so callers must handle "that thing no longer exists" explicitly rather
 * than crashing on a stale index.
 */
export interface IdResolver {
  resolveChain(chain: ChainID): LiveTrackIndex | undefined;
  resolveCell(ref: CellRef): ResolvedCell | undefined;
  resolveDevice(chain: ChainID, role: DeviceRole): ResolvedDevice | undefined;
  resolveParam(ref: ParamRef): ResolvedParameter | undefined;
  resolveScene(scene: SceneID): LiveSceneIndex | undefined;

  /** Reverse lookups, used when a Live listener echo arrives with indices. */
  chainForTrack(track: LiveTrackIndex): ChainID | undefined;
  cellForTrackSlot(
    track: LiveTrackIndex,
    clipSlot: LiveClipSlotIndex,
  ): CellRef | undefined;

  /** Rebuild the whole map from a fresh Live snapshot (boot / structural change). */
  rebuildFromSnapshot(snapshot: unknown): void;
}

// ---------------------------------------------------------------------------
// Constructors — the sanctioned way to *make* these values. Using these (and
// only these) keeps a grep-able audit trail of every place an index or ID is
// created. Above the resolver you should never call the Live* ones.
// ---------------------------------------------------------------------------

export const ChainID = (s: string): ChainID => s as ChainID;
export const Slot = (n: number): Slot => n as Slot;
export const SceneID = (s: string): SceneID => s as SceneID;
export const ToneID = (n: number): ToneID => n as ToneID;

/** @internal resolver/OSC-layer only */
export const LiveTrackIndex = (n: number): LiveTrackIndex => n as LiveTrackIndex;
/** @internal resolver/OSC-layer only */
export const LiveClipSlotIndex = (n: number): LiveClipSlotIndex =>
  n as LiveClipSlotIndex;
/** @internal resolver/OSC-layer only */
export const LiveDeviceIndex = (n: number): LiveDeviceIndex =>
  n as LiveDeviceIndex;
/** @internal resolver/OSC-layer only */
export const LiveParameterIndex = (n: number): LiveParameterIndex =>
  n as LiveParameterIndex;
/** @internal resolver/OSC-layer only */
export const LiveSceneIndex = (n: number): LiveSceneIndex => n as LiveSceneIndex;
/** @internal resolver/OSC-layer only */
export const LiveSendIndex = (n: number): LiveSendIndex => n as LiveSendIndex;
