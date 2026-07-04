/**
 * ============================================================================
 * CONTRACT 4 — AI ASSISTANT TOOL SCHEMA
 *                                        (arch §5, §9, §12 · BUILD-PLAN Phase 1)
 * TAG: tool VOCABULARY is FREEZE-NOW; specific RETURNS/receipts for
 *      add_device, write_movement, looper_state are PROVISIONAL (inline).
 * ----------------------------------------------------------------------------
 * WHAT THIS IS, IN PLAIN LANGUAGE
 *   The voice AI ("the brain") never touches Live directly. It can only call a
 *   FROZEN, small set of tools listed here. Each tool is a verb the AI is
 *   allowed to say ("fire this clip", "set this knob"), plus the exact shape of
 *   the arguments it must provide, plus the exact shape of the RECEIPT it gets
 *   back. Freezing this list is what lets us build the AI layer and the hub
 *   independently: they only have to agree on these shapes.
 *
 * THREE HARD RULES BAKED INTO THE SHAPES BELOW
 *   1. SPATIAL LANGUAGE ONLY. The AI addresses things by CellRef (chain+slot),
 *      ChainID, SceneID, or DeviceRole — NEVER by raw Live track/clip/device
 *      indices. Those don't even appear in this file. (Contract 1.)
 *   2. ABSOLUTE / IDEMPOTENT. Every tool sets a target state, not a relative
 *      nudge. "set gain to 0.4", never "turn gain up a bit". Each tool carries
 *      its Contract-8 semantics so the executor knows its retry behaviour.
 *   3. CONFIRMED RECEIPTS. A tool call does not "succeed" when the OSC packet
 *      is sent; it succeeds when the engine ECHOES the resulting state back
 *      (Contract 2 up-events / Contract 12 confirmed-echo). So every receipt
 *      describes *observed* state, and can come back `unconfirmed` on timeout.
 *
 * SOURCE GROUNDING
 *   The tool VERBS map 1:1 onto frozen Contract-2 OSC/EXT commands and
 *   Contract-3 tablet commands — the AI can't do anything the tablet can't.
 *   The tone-load tool maps onto the TONE3000 OAuth flow proven by the
 *   spike in spikes/tone3000 (deliverable D). Fields that depend on an
 *   unproven engine capability (automation write, device add, looper echo)
 *   are marked PROVISIONAL and point at the resolving spike.
 * ============================================================================
 */

import type {
  CellRef,
  ChainID,
  SceneID,
  DeviceRole,
  ToneID,
} from './ids.ts';
import { LooperState } from './osc.ts';
import {
  IDEMPOTENT,
  STATEFUL,
  type CommandSemantics,
} from './command-rule.ts';

// ---------------------------------------------------------------------------
// TOOL-CALL PLUMBING
// ---------------------------------------------------------------------------

/**
 * Every tool call the brain makes gets a correlation id so its receipt can be
 * matched back to it (and so a retry re-uses the same id — see Contract 8).
 * This is the AI-side twin of Contract 3's `commandId`.
 */
export type ToolCallId = string;

/**
 * The JSON-schema-ish parameter description we hand to the model. We keep our
 * own tiny type here (rather than importing a vendor SDK type) so this contract
 * stays dependency-free and portable across whichever model runtime we use.
 * `enumValues` lets us pin e.g. send names to 'A' | 'B'.
 */
export interface ToolParam {
  readonly name: string;
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object';
  readonly description: string;
  readonly required: boolean;
  readonly enumValues?: readonly (string | number)[];
}

/**
 * A frozen tool definition. `receiptKind` names the receipt shape the caller
 * should expect (see the ToolReceipt union). `stability` tags the RETURN, not
 * the verb: the verb is always frozen, but some receipts can only be finalised
 * once the matching spike confirms the engine echoes what we need.
 */
export interface ToolDef {
  readonly name: ToolName;
  readonly summary: string;
  readonly params: readonly ToolParam[];
  readonly semantics: CommandSemantics;
  readonly receiptKind: ReceiptKind;
  readonly stability: 'FREEZE-NOW' | 'PROVISIONAL';
  /** If PROVISIONAL, which deliverable-C seam / spike finalises the receipt. */
  readonly resolvedBy?: string;
}

// ---------------------------------------------------------------------------
// THE FROZEN TOOL VOCABULARY  (verbs are FREEZE-NOW)
// ---------------------------------------------------------------------------

export type ToolName =
  | 'fire_clip'
  | 'stop_clip'
  | 'launch_scene'
  | 'duplicate_clip_to'
  | 'set_param'
  | 'set_send'
  | 'set_mute'
  | 'set_volume'
  | 'set_pan'
  | 'go_live'
  | 'set_tempo'
  | 'set_metronome'
  | 'looper_state'
  | 'write_movement'
  | 'add_device'
  | 'load_tone';

export type ReceiptKind =
  | 'clip_state'
  | 'scene_state'
  | 'param_state'
  | 'mixer_state'
  | 'transport_state'
  | 'looper_receipt'
  | 'movement_receipt'
  | 'device_add_receipt'
  | 'tone_load_receipt';

/**
 * THE TOOLS. Argument fields use CellRef / ChainID / DeviceRole / SceneID only.
 * `value` fields are ABSOLUTE targets. Ordering here is the order we register
 * them with the model.
 */
export const AI_TOOLS: Record<ToolName, ToolDef> = {
  // --- transport / clips / scenes : all frozen, all idempotent ------------
  fire_clip: {
    name: 'fire_clip',
    summary: 'Launch the performance clip in a specific grid cell (chain+slot).',
    params: [cellParam('cell', 'The grid cell to fire.')],
    semantics: IDEMPOTENT,
    receiptKind: 'clip_state',
    stability: 'FREEZE-NOW',
  },
  stop_clip: {
    name: 'stop_clip',
    summary: 'Stop the clip playing in a specific grid cell.',
    params: [cellParam('cell', 'The grid cell to stop.')],
    semantics: IDEMPOTENT,
    receiptKind: 'clip_state',
    stability: 'FREEZE-NOW',
  },
  launch_scene: {
    name: 'launch_scene',
    summary: 'Launch a whole scene (a column of the grid) by its stable id.',
    params: [
      { name: 'scene', type: 'string', description: 'Stable SceneID.', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'scene_state',
    stability: 'FREEZE-NOW',
  },
  duplicate_clip_to: {
    name: 'duplicate_clip_to',
    summary:
      'Copy the clip in one cell into another cell. This is the hero move: ' +
      'drop a performance onto a different tone. Maps to the REAL AbletonOSC ' +
      '/live/clip_slot/duplicate_clip_to (it already exists — see API-REALITY).',
    params: [
      cellParam('from', 'Source cell (the clip to copy).'),
      cellParam('to', 'Destination cell (chain+slot to copy it onto).'),
    ],
    semantics: STATEFUL, // creates a clip → reconcile, do not blind-retry
    receiptKind: 'clip_state',
    stability: 'FREEZE-NOW',
  },

  // --- absolute mixer / param sets : frozen, idempotent -------------------
  set_param: {
    name: 'set_param',
    summary:
      'Set one device parameter on a chain to an ABSOLUTE value. Parameter is ' +
      'named by (chain, device-role, param-name); the resolver maps it to an ' +
      'index. Never a relative change.',
    params: [
      chainParam('chain', 'Chain whose device to change.'),
      deviceRoleParam('device', 'Which device on the chain (role, e.g. "amp").'),
      { name: 'param', type: 'string', description: 'Parameter name key, e.g. "Gain".', required: true },
      { name: 'value', type: 'number', description: 'Absolute target value (device-native units).', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'param_state',
    stability: 'FREEZE-NOW',
  },
  set_send: {
    name: 'set_send',
    summary: 'Set a chain’s send level (A=reverb, B=delay) to an absolute 0..1.',
    params: [
      chainParam('chain', 'Chain whose send to change.'),
      { name: 'send', type: 'string', description: 'Send bus.', required: true, enumValues: ['A', 'B'] },
      { name: 'value01', type: 'number', description: 'Absolute level 0..1.', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'mixer_state',
    stability: 'FREEZE-NOW',
  },
  set_mute: {
    name: 'set_mute',
    summary: 'Mute or unmute a chain (absolute boolean).',
    params: [
      chainParam('chain', 'Chain to mute/unmute.'),
      { name: 'muted', type: 'boolean', description: 'true = muted.', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'mixer_state',
    stability: 'FREEZE-NOW',
  },
  set_tempo: {
    name: 'set_tempo',
    summary: 'Set the global tempo in BPM (absolute).',
    params: [
      { name: 'bpm', type: 'number', description: 'Absolute tempo in beats per minute.', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'transport_state',
    stability: 'FREEZE-NOW',
  },
  set_metronome: {
    name: 'set_metronome',
    summary: 'Turn the metronome on or off (absolute).',
    params: [
      { name: 'on', type: 'boolean', description: 'true = metronome on.', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'transport_state',
    stability: 'FREEZE-NOW',
  },

  set_volume: {
    name: 'set_volume',
    summary: 'Set a chain\u2019s mixer volume to an absolute level (0..1).',
    params: [
      chainParam('chain', 'Chain whose volume to set.'),
      { name: 'value01', type: 'number', description: 'Absolute level 0..1 (0.85 \u2248 0 dB).', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'mixer_state',
    stability: 'FREEZE-NOW',
  },

  set_pan: {
    name: 'set_pan',
    summary: 'Set a chain\u2019s stereo pan to an absolute position (-1..1).',
    params: [
      chainParam('chain', 'Chain whose pan to set.'),
      { name: 'valueMinus1to1', type: 'number', description: 'Absolute pan, -1 = hard left, 0 = center, 1 = hard right.', required: true },
    ],
    semantics: IDEMPOTENT,
    receiptKind: 'mixer_state',
    stability: 'FREEZE-NOW',
  },

  go_live: {
    name: 'go_live',
    summary:
      'Make a chain the LIVE chain for its physical input \u2014 the player\u2019s ' +
      'instrument now sounds through this chain\u2019s tone ("put my guitar on the ' +
      'shimmer chain"). Absolute target; the hub arms/monitors this chain and ' +
      'disarms the previous live chain on the same input (Contract 7 ARM_POLICY). ' +
      'Uses stock arm/monitoring/routing OSC \u2014 FREEZE-NOW.',
    params: [chainParam('chain', 'Chain to go live on.')],
    semantics: IDEMPOTENT,
    receiptKind: 'mixer_state', // receipt reports live=true + armed observed
    stability: 'FREEZE-NOW',
  },

  // --- looper : verb frozen, ECHO/receipt PROVISIONAL ---------------------
  looper_state: {
    name: 'looper_state',
    summary:
      'Set the custom looper on a chain to an ABSOLUTE transport state ' +
      '(Stop/Play/Record/Overdub). Absolute, so a dropped packet is safe to ' +
      're-send. The verb and enum are frozen; the confirmation echo is not yet ' +
      'proven because the looper is our own M4L device (arch §15).',
    params: [
      chainParam('chain', 'Chain whose looper to drive.'),
      {
        name: 'state',
        type: 'integer',
        description: 'Absolute looper state.',
        required: true,
        enumValues: [
          LooperState.Stop,
          LooperState.Play,
          LooperState.Record,
          LooperState.Overdub,
        ],
      },
    ],
    semantics: IDEMPOTENT, // absolute target state (Contract 8)
    receiptKind: 'looper_receipt',
    stability: 'PROVISIONAL',
    resolvedBy:
      'PROVISIONAL-SEAMS: looper-state echo. Spike 04 (looper-state round-trip) ' +
      'must show the M4L device reports its state back over Contract-2 looper_state.',
  },

  // --- automation write : verb frozen, WHOLE receipt PROVISIONAL ----------
  write_movement: {
    name: 'write_movement',
    summary:
      'Write an automation "movement" for one parameter over a clip — e.g. a ' +
      'filter sweep across a loop. Expressed as absolute breakpoints (time→value). ' +
      'PROVISIONAL: the insert_step / value_at_time write path DOES exist in the ' +
      'Python Remote-Script Live API our engine uses (confirmed Live 9-11; it is ' +
      'only absent from the M4L apiref — see API-REALITY item #2); this stays ' +
      'PROVISIONAL only to confirm the Live-12 / Python-3.11 signature on-rig.',
    params: [
      cellParam('cell', 'The clip (grid cell) to write automation into.'),
      deviceRoleParam('device', 'Device whose parameter to automate.'),
      { name: 'param', type: 'string', description: 'Parameter name key.', required: true },
      {
        name: 'breakpoints',
        type: 'object',
        description:
          'Absolute automation shape: array of {timeBeats:number, value:number} ' +
          'sorted by time. Replaces any existing envelope for this param (absolute, ' +
          'not additive).',
        required: true,
      },
    ],
    semantics: STATEFUL, // writes/overwrites an envelope → reconcile, verify readback
    receiptKind: 'movement_receipt',
    stability: 'PROVISIONAL',
    resolvedBy:
      'PROVISIONAL-SEAMS seam 1: automation write. The write path is confirmed in ' +
      'the Python Live API (Live 9-11); spike 03 (insert-step automation) confirms ' +
      'the Live-12 / Python-3.11 signature holds (write + read back an envelope). ' +
      'Low-probability fallback: clip-based movement.',
  },

  // --- device add : verb frozen, receipt PROVISIONAL ----------------------
  add_device: {
    name: 'add_device',
    summary:
      'Add a device (by browser item) onto a chain in the inline-FX slot. Uses ' +
      'the engine browser load_item path. PROVISIONAL: browser load_item is an ' +
      'engine EXTENSION (not stock AbletonOSC) and browser URIs vary by Live ' +
      'version, so what comes back (and how we name the new role) is not final.',
    params: [
      chainParam('chain', 'Chain to add the device onto.'),
      {
        name: 'itemUri',
        type: 'string',
        description:
          'Browser item URI to load (resolved from a boot-time browser index, ' +
          'never hard-coded — URIs differ across Live versions).',
        required: true,
      },
      {
        name: 'asRole',
        type: 'string',
        description: 'Optional stable role name to assign the new device.',
        required: false,
      },
    ],
    semantics: STATEFUL, // inserts a device → reconcile, verify device list
    receiptKind: 'device_add_receipt',
    stability: 'PROVISIONAL',
    resolvedBy:
      'PROVISIONAL-SEAMS: browser load_item. Spike 02 (load-item verify) must ' +
      'show load-and-verify works and confirm the post-load device readback.',
  },

  // --- tone load : verb frozen; grounded by the TONE3000 spike ------------
  load_tone: {
    name: 'load_tone',
    summary:
      'Load a TONE3000 tone/model onto a chain’s amp. The tone is chosen via the ' +
      'TONE3000 API (A2 architecture) proven by the OAuth spike; the model file ' +
      'is fetched and handed to the amp device. Absolute: sets the chain’s tone.',
    params: [
      chainParam('chain', 'Chain whose amp gets the tone.'),
      { name: 'toneId', type: 'integer', description: 'TONE3000 tone id (A2).', required: true },
    ],
    semantics: STATEFUL, // swaps the model file behind the amp → reconcile
    receiptKind: 'tone_load_receipt',
    stability: 'FREEZE-NOW', // the *tool* is frozen; the fetch path is proven by spike D
    resolvedBy:
      'Grounded by spikes/tone3000 (OAuth PKCE + fetch one A2 model). The engine-' +
      'side "apply model to amp" step is a rig task, but the tool shape is stable.',
  },
};

// ---------------------------------------------------------------------------
// RECEIPTS  (what the brain gets back — all describe OBSERVED state)
// ---------------------------------------------------------------------------

/** Common envelope. `confirmed:false` means we timed out waiting for the echo. */
export interface ToolReceiptBase {
  readonly toolCallId: ToolCallId;
  readonly tool: ToolName;
  /** true only when the engine echoed the resulting state (Contract 12). */
  readonly confirmed: boolean;
  /** filled when confirmed:false, e.g. 'timeout' | 'rejected' | 'not_supported'. */
  readonly error?: string;
}

/** FREEZE-NOW receipts (state we already know AbletonOSC echoes). */
export interface ClipStateReceipt extends ToolReceiptBase {
  readonly kind: 'clip_state';
  readonly cell: CellRef;
  readonly isPlaying: boolean;
  readonly isRecording: boolean;
}
export interface SceneStateReceipt extends ToolReceiptBase {
  readonly kind: 'scene_state';
  readonly scene: SceneID;
  readonly firedSlotIndexObserved: boolean;
}
export interface ParamStateReceipt extends ToolReceiptBase {
  readonly kind: 'param_state';
  readonly chain: ChainID;
  readonly device: DeviceRole;
  readonly param: string;
  readonly valueObserved: number; // read back from the device
}
export interface MixerStateReceipt extends ToolReceiptBase {
  readonly kind: 'mixer_state';
  readonly chain: ChainID;
  readonly sendA?: number;
  readonly sendB?: number;
  readonly muted?: boolean;
  readonly volume01?: number;       // set_volume readback
  readonly panMinus1to1?: number;   // set_pan readback
  readonly live?: boolean;          // go_live: observed arm-follows-record state
}
export interface TransportStateReceipt extends ToolReceiptBase {
  readonly kind: 'transport_state';
  readonly bpm?: number;
  readonly metronome?: boolean;
}
export interface ToneLoadReceipt extends ToolReceiptBase {
  readonly kind: 'tone_load_receipt';
  readonly chain: ChainID;
  readonly toneId: ToneID;
  /** the model file we actually fetched/attached (from the TONE3000 spike). */
  readonly modelAttached: boolean;
}

/**
 * PROVISIONAL receipts — shapes are our best current design but the exact
 * observable fields are pending the noted spike. Marked with `__provisional`
 * so a grep finds every unfinished seam.
 */
export interface LooperReceipt extends ToolReceiptBase {
  readonly kind: 'looper_receipt';
  readonly chain: ChainID;
  /** PROVISIONAL: assumes the M4L looper echoes its state. See spike 04. */
  readonly stateObserved?: LooperState;
  readonly __provisional: 'looper echo unproven — spike 04';
}
export interface MovementReceipt extends ToolReceiptBase {
  readonly kind: 'movement_receipt';
  readonly cell: CellRef;
  readonly device: DeviceRole;
  readonly param: string;
  /** PROVISIONAL: write path confirmed in the Python Live API (Live 9-11);
   * pending only the Live-12/3.11 signature confirmation. See spike 03. */
  readonly breakpointsReadBack?: number;
  readonly __provisional: 'confirm Live-12 signature of insert_step/value_at_time — spike 03';
}
export interface DeviceAddReceipt extends ToolReceiptBase {
  readonly kind: 'device_add_receipt';
  readonly chain: ChainID;
  /** PROVISIONAL: assumes device list readback + stable role naming. See spike 02. */
  readonly roleAssigned?: DeviceRole;
  readonly deviceCountAfter?: number;
  readonly __provisional: 'browser load_item readback unproven — spike 02';
}

export type ToolReceipt =
  | ClipStateReceipt
  | SceneStateReceipt
  | ParamStateReceipt
  | MixerStateReceipt
  | TransportStateReceipt
  | ToneLoadReceipt
  | LooperReceipt // PROVISIONAL
  | MovementReceipt // PROVISIONAL
  | DeviceAddReceipt; // PROVISIONAL

// ---------------------------------------------------------------------------
// small helpers to keep the param table readable (not part of the wire)
// ---------------------------------------------------------------------------

function cellParam(name: string, description: string): ToolParam {
  return { name, type: 'object', description: description + ' Shape: {chain, slot}.', required: true };
}
function chainParam(name: string, description: string): ToolParam {
  return { name, type: 'string', description: description + ' (stable ChainID)', required: true };
}
function deviceRoleParam(name: string, description: string): ToolParam {
  return {
    name,
    type: 'string',
    description: description + ' Known roles: amp | looper | inline_fx | eq | spectral.',
    required: true,
  };
}

/**
 * Type-only anchors so the compiler proves our receipts reference the real
 * id/looper types (and so unused-import checkers stay quiet). Not wire data.
 */
export type _AiToolTypeAnchors = [CellRef, ChainID, SceneID, DeviceRole, ToneID, LooperState];
