/**
 * ============================================================================
 * CONTRACT 7 — LIVE TEMPLATE STRUCTURE
 *                              (arch §3, §7, §11, §12, §15 · BUILD-PLAN Phase 1)
 * TAG: FREEZE-NOW.
 * ----------------------------------------------------------------------------
 * WHAT THIS IS, IN PLAIN LANGUAGE
 *   Everything else in the system assumes a KNOWN Live Set layout: which tracks
 *   exist, in what order, what devices sit on each chain and in what order, and
 *   how we recognise "our" template when it opens. This file freezes that
 *   layout as data so the resolver (Contract 1), the OSC layer (Contract 2), and
 *   the boot detector (arch §12) all agree without re-reading the .als by eye.
 *
 *   You (the builder) will actually BUILD the .als by hand in Live later; this
 *   contract is the SPEC that build must satisfy, and the thing the boot code
 *   checks against. Freezing it now means the resolver and probes can be written
 *   before the .als exists.
 *
 * GROUNDING (see API-REALITY.md)
 *   - Return A = reverb, Return B = delay, sends surfaced as params, sends are
 *     PARALLEL and downstream of the looper's record tap so overdubs stay dry
 *     (arch §3).
 *   - Per-chain device order and the "inline FX after the looper" rule (arch §3,
 *     §15): before the looper, an inline effect's tail would print into the loop.
 *   - Track names + cue points are BOTH reliably readable from stock AbletonOSC
 *     (`/live/song/get/track_names`, `/live/song/get/cue_points`), so both the
 *     chainTag (in the track name) and the boot sentinel (a named cue point) are
 *     detectable with no engine extension. FREEZE-NOW.
 * ============================================================================
 */

import type { DeviceRole } from './ids.ts';

// ---------------------------------------------------------------------------
// BOOT SENTINEL — "is OUR template open?"  (arch §12)
// ---------------------------------------------------------------------------

/**
 * The template is recognised by a specially-named CUE POINT (locator) placed in
 * the Set. Cue points are listable via stock AbletonOSC `/live/song/get/
 * cue_points` (returns name + time), so detection needs no engine extension and
 * costs no track slot. The name encodes a version so the hub can refuse a
 * template that's too old/new.
 *
 * Detection rule: read cue_points at boot; template is present iff some cue
 * point's name starts with SENTINEL.prefix. Parse the trailing integer as the
 * template version and compare to SENTINEL.version.
 */
export const SENTINEL = {
  /** cue-point name prefix the boot detector looks for. */
  prefix: 'NAM_A2_TEMPLATE',
  /** full canonical name to place in the shipped .als (prefix + space + v#). */
  name: 'NAM_A2_TEMPLATE v1',
  /** template structural version this contract describes. */
  version: 1,
  /**
   * SECONDARY signal (belt-and-suspenders, optional): a marker/return track may
   * also carry this exact name. The cue point is the PRIMARY, authoritative
   * check; a build that also names a track this way is fine but not required.
   */
  altTrackName: 'NAM_A2_TEMPLATE',
} as const;

/** Parse a cue-point name into a version, or null if it isn't our sentinel. */
export function parseSentinelVersion(cueName: string): number | null {
  if (!cueName.startsWith(SENTINEL.prefix)) return null;
  const m = cueName.match(/v(\d+)\s*$/i);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// CHAIN TAG — how a track announces which logical chain it is
// ---------------------------------------------------------------------------

/**
 * Each chain (row) track's NAME embeds a machine-readable tag, read ONCE at load
 * to mint the stable ChainID (Contract 1) and to key spectral telemetry
 * (Contract 6 chainTag). Track names are read via `/live/song/get/track_names`.
 *
 * Naming convention (FROZEN): a track is a chain track iff its name contains a
 * tag of the form `[[tag]]`, e.g. "Clean [[chain.clean]]". Everything outside
 * the brackets is a human-friendly label you can style freely; the bracketed
 * tag is the stable machine key. This keeps display names editable without
 * breaking identity.
 */
export const CHAIN_TAG = {
  /** regex capturing the tag inside double brackets. */
  pattern: /\[\[([a-zA-Z0-9._-]+)\]\]/,
  /** example of a well-formed chain track name. */
  example: 'Clean [[chain.clean]]',
} as const;

/** Extract the chain tag from a track name, or null if it isn't a chain track. */
export function chainTagFromTrackName(trackName: string): string | null {
  const m = trackName.match(CHAIN_TAG.pattern);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// PER-CHAIN DEVICE ORDER  (arch §3, §11, §15)
// ---------------------------------------------------------------------------

/**
 * The FROZEN device order on every chain track, front to back. The resolver maps
 * a DeviceRole to the current device index by walking the track's device list
 * and matching this order/identity — so the AI/tablet never speak indices.
 *
 * Order rationale:
 *   amp        — our M4L amp host `NAM_A2_Amp.amxd` wrapping the MIT `neural~`
 *                external (the tone). First. Model choice = the integer `Model`
 *                parameter indexing TONE_MANIFEST (rev 2026-07-03 — replaces the
 *                Gateway-VST-in-a-rack plan; Gateway's model load is GUI-only).
 *   looper     — our custom M4L looper (§15). It taps the signal for recording
 *                HERE, dry of downstream inline FX and of the parallel sends, so
 *                overdubs stay clean (§3, §15).
 *   inline_fx  — the per-row escape-hatch slot for a bespoke effect. MUST come
 *                AFTER the looper: before it, the effect's tail would print into
 *                the loop (§3). May be empty in the shipped template.
 *   eq         — a stock EQ Eight fixture on EVERY chain (§16b), placed BEFORE
 *                the spectral tap so the visualization shows the POST-EQ
 *                spectrum: cut a resonant peak and the curve flattens in the
 *                same view. Stereo global_mode. Permanent fixture, never
 *                AI-added. (arch rev 2026-07-01b — this role was previously
 *                missing from this contract; fixed 2026-07-02.)
 *   spectral   — the M4L FFT tap (§3) LAST, so its ~256-bin readout reflects the
 *                whole processed chain the listener hears. Emits Contract-6
 *                telemetry keyed by this track's chain tag.

 * STRUCTURE HEDGE (2026-07-02): this contract describes each chain by device
 * ROLES and routing guarantees, deliberately NOT by "one chain == one Live
 * track". v1 builds each chain as a single track; if the same-chain
 * live-over-clip bench test (arch §6 item 9) demands it, a chain may become a
 * clip-track + FX-track PAIR (summing bus) in a later TEMPLATE version. The
 * resolver maps ChainID -> whatever track(s) implement the chain; consumers of
 * this contract must not assume a 1:1 chain:track shape beyond the resolver.
 *
 * Sends A/B are NOT devices — they are the track's native mixer sends, parallel
 * and downstream of the looper tap (so send level never bleeds into overdubs),
 * surfaced as params (Contract 2 setTrackSend / Contract 4 set_send).
 */
export const CHAIN_DEVICE_ORDER: readonly DeviceRole[] = [
  'amp',
  'looper',
  'inline_fx',
  'eq',
  'spectral',
] as const;

/** Which roles are guaranteed present in the shipped template vs. may be empty. */
export const CHAIN_DEVICE_PRESENCE: Record<'amp' | 'looper' | 'inline_fx' | 'eq' | 'spectral', 'required' | 'optional'> = {
  amp: 'required',
  looper: 'required',
  eq: 'required',        // permanent fixture, arch §16b — NOT AI-added
  spectral: 'required',
  inline_fx: 'optional', // empty slot by default; AI/user fills it (Contract 4 add_device)
} as const;

// ---------------------------------------------------------------------------
// TRACK LAYOUT  (order + naming)
// ---------------------------------------------------------------------------

/**
 * Return tracks are FROZEN: Return A = shared reverb, Return B = shared delay
 * (arch §3). Send A / Send B on each chain feed these. Per-clip reverb/delay
 * "movement" is done by automating the chain's SEND level, never the return
 * device (the return is a different track → unreachable by a clip envelope;
 * arch §10 routing constraint).
 */
export const RETURNS = {
  A: { slot: 'A', role: 'reverb' },
  B: { slot: 'B', role: 'delay' },
} as const;

/** Send bus identifiers, matching Contract 2/4 send params. */
export type SendBus = 'A' | 'B';

// ---------------------------------------------------------------------------
// PHYSICAL INPUTS + ARM-FOLLOWS-RECORD  (added 2026-07-02; arch §17)
// ---------------------------------------------------------------------------

/**
 * A physical audio-interface input a chain records from. Baked into the .als
 * per chain (Live's input routing on the chain track); the hub reads the
 * routing back at boot and never guesses. Channel numbers are 1-based
 * interface inputs; a stereo source names a pair.
 *
 * The interface is a MOTU M4 (4 inputs). Default source plan:
 *   guitar = in 1 (mono), mic = in 2 (mono), synth = ins 3/4 (stereo).
 * Most chains are guitar chains; the template may also ship a mic chain and a
 * synth chain. This constant documents the plan; the .als is authoritative.
 */
export interface PhysicalInput {
  readonly name: string;                 // 'guitar' | 'mic' | 'synth' | ...
  readonly channels: readonly [number] | readonly [number, number];
}

export const DEFAULT_INPUTS: readonly PhysicalInput[] = [
  { name: 'guitar', channels: [1] },
  { name: 'mic', channels: [2] },
  { name: 'synth', channels: [3, 4] },
] as const;

/**
 * ARM-FOLLOWS-RECORD (hub policy, frozen here so tablet + hub agree):
 *   - Every chain has a defaultInput (from its baked routing).
 *   - At most ONE chain per physical input is "live" (armed + monitoring) at a
 *     time. Chains on DIFFERENT inputs are independently live (guitar on one
 *     row, mic on another, simultaneously).
 *   - Tapping record on a cell, or go_live on a chain, makes that chain the
 *     live chain for its input; the hub arms/monitors it and quietly disarms
 *     the previous live chain on the SAME input. Tone follows attention; there
 *     is no input-assignment UI.
 *   - All of this uses STOCK AbletonOSC track properties (arm,
 *     current_monitoring_state, input_routing_*) — see Contract 2. No engine
 *     extension involved.
 *   - LOOPER GUARD: entering looper Record/Overdub on a chain stops/mutes that
 *     chain's grid-clip playback first, so clip audio never imprints into an
 *     overdub (arch §15/§17).
 *   - Onboarding note: Live's "exclusive arm" preference must be OFF so
 *     multiple chains (on different inputs) can be armed at once.
 */
export const ARM_POLICY = {
  oneLiveChainPerInput: true,
  armFollowsRecord: true,
  looperRecordStopsChainClips: true,
  requiresExclusiveArmOff: true,
} as const;

/**
 * Overall track order in the Set (FROZEN top-to-bottom). Chain tracks come
 * first in template order (their count is set by how many rows you build), then
 * the return tracks, then master. The boot code reads track_names and expects:
 *   [ chain tracks (>=1, each with a [[tag]]) ...,  Return A, Return B,  Master ]
 */
export const TRACK_LAYOUT = {
  /** chain tracks appear first, identified by their [[tag]] (not by position). */
  chainsFirst: true,
  returns: ['A', 'B'] as const,
  /** master is directly publishable to Link Audio (arch §14) — no extra track. */
  masterPublishable: true,
} as const;

/**
 * A parsed view of the template after boot: the ordered chain tags found, keyed
 * for the resolver. Produced by reading track_names + cue_points once at load.
 */
export interface TemplateScan {
  readonly sentinelVersion: number | null; // null => not our template
  readonly chainTags: readonly string[]; // in track order
  readonly hasReturnA: boolean;
  readonly hasReturnB: boolean;
}

/**
 * Whether a scan satisfies this contract enough to run. The hub refuses to arm
 * if the sentinel is missing/mismatched or a required return is absent.
 */
export function templateScanIsValid(scan: TemplateScan): boolean {
  return (
    scan.sentinelVersion === SENTINEL.version &&
    scan.chainTags.length >= 1 &&
    scan.hasReturnA &&
    scan.hasReturnB
  );
}

// ---------------------------------------------------------------------------
// AMP DEVICE SURFACE + TONE MANIFEST  (arch rev 2026-07-03)
// ---------------------------------------------------------------------------

/**
 * The parameter surface of `NAM_A2_Amp.amxd` — the ONLY things the hub/AI need
 * from the amp device, all reachable via the frozen stock set/get param path.
 * Exact display names are pinned here; the M4L build must use them verbatim.
 */
export const AMP_PARAMS = {
  /** integer index into the tone manifest (0-based). Quantized. THE tone knob. */
  model: 'Model',
  /** bump to make the device re-read models.json (quantized 0/1 toggle;
   *  device acts on any change). */
  rescan: 'Rescan',
  inputTrimDb: 'Input Trim',
  outputTrimDb: 'Output Trim',
  /** NeuralAudio A2 quality scaling 0..1 (1 = A2-Full). Per-chain CPU knob. */
  quality: 'Quality',
} as const;

/**
 * models.json — written ONLY by the hub into the models folder; read ONLY by
 * the amp device. APPEND-ONLY ordering: an entry's index NEVER changes once
 * assigned (deletions tombstone via file:null), so a saved `Model` parameter
 * value or a persisted ToneID→index mapping can never silently point at a
 * different amp. ToneID→index lives in the HUB (source of truth); the device
 * only maps index→file.
 */
export interface ToneManifestEntry {
  readonly index: number;
  /** path relative to the manifest's folder, or null = tombstoned. */
  readonly file: string | null;
  readonly name: string;
  /** TONE3000 id when the hub fetched it; null for hand-dropped files. */
  readonly toneId: number | null;
}
export interface ToneManifest {
  readonly version: 1;
  readonly entries: readonly ToneManifestEntry[];
}
export const TONE_MANIFEST_FILENAME = 'models.json';

/**
 * Receipt path for tone changes: hub sets `Model` → the M4L patch sends
 * `load <path>` to neural~ → neural~ answers `loaded <path>` or `error <msg>`
 * on its info outlet → the patch mirrors that into the quantized `Load OK`
 * param (1/0) which the hub reads back. Loaded truth is OBSERVED, never assumed.
 */
export const AMP_LOAD_RECEIPT_PARAM = 'Load OK';
