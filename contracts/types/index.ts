/**
 * ============================================================================
 * NAM A2 RIG — FROZEN CONTRACTS  (barrel export)
 * ----------------------------------------------------------------------------
 * One import point for every inter-component contract. The TypeScript types in
 * this folder are the SOURCE OF TRUTH for the Node/TS side of the system; the
 * JSON schemas under contracts/schemas mirror the cross-language WIRE formats
 * for the Python engine, the native sidecar, and the tablet.
 *
 * Contract index:
 *   1  ids.ts           Stable-ID scheme .................... FREEZE-NOW
 *   2  osc.ts           OSC vocab (down) + echo events (up) . mostly FREEZE-NOW
 *   3  ws.ts            Hub <-> tablet WS protocol .......... FREEZE-NOW
 *   4  ai-tools.ts      AI assistant tool schema ........... verbs FREEZE-NOW
 *   5  audio-sidecar.ts Sidecar -> hub PCM audio ............ FREEZE-NOW
 *   6  spectral.ts      M4L spectral telemetry ............. FREEZE-NOW
 *   7  template.ts      Live template structure ............ FREEZE-NOW
 *   8  command-rule.ts  Absolute/idempotent command rule ... FREEZE-NOW
 *
 * See contracts/CONTRACTS.md for the human-readable spec, reports/API-REALITY.md
 * for the source audit, and reports/PROVISIONAL-SEAMS.md for every unfrozen bit.
 * ============================================================================
 */

export * from './ids.ts';
export * from './command-rule.ts';
export * from './osc.ts';
export * from './ws.ts';
export * from './ai-tools.ts';
export * from './audio-sidecar.ts';
export * from './spectral.ts';
export * from './template.ts';
