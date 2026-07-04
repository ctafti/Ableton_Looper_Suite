/**
 * PENDING-COMMAND LIFECYCLE — arch §12 as a pure, clock-injected state
 * machine. No sockets, no Live: commands go in, expectations are registered,
 * echo events + clock ticks come in, CommandStatus phases come out. The real
 * hub wires its OSC listeners to onEcho() and a timer to tick(); the tests
 * (and the simulator) drive it synthetically. Because it is pure it is fully
 * provable off-rig — nothing in here assumes anything about Live beyond the
 * frozen contracts.
 *
 * Phases (Contract 3): intent -> sent -> [queued] -> confirmed | failed.
 * Retry rule (Contract 8): idempotent -> blind re-send (max 3);
 *                          stateful  -> reconcile-then-decide (emit a
 *                          reconcile request, never blind-retry).
 * Supersession (arch §12 backpressure): a new command on the same TARGET KEY
 * supersedes the old expectation (fire A then B on one track -> A superseded).
 */
import type { CommandPhase } from '../../../contracts/types/ws.ts';
import type { CommandSemantics } from '../../../contracts/types/command-rule.ts';

export interface LifecycleEvents {
  status(commandId: string, phase: CommandPhase, extra?: { queuedForMs?: number; reason?: string }): void;
  /** re-send the wire message for an idempotent command (attempt = 2..3). */
  resend(commandId: string, attempt: number): void;
  /** stateful command timed out: ask the caller to re-query truth and decide. */
  reconcile(commandId: string): void;
}

export interface RegisterOpts {
  commandId: string;
  /** same-key commands supersede each other, e.g. `playing_slot:track2`. */
  targetKey: string;
  semantics: CommandSemantics;
  /** predicate over up-events: does this echo satisfy the expectation? */
  expect: (event: unknown) => boolean;
  /** confirmation window in ms (use quantWindowMs for quantized ops). */
  windowMs: number;
  /** if >0, report 'queued' with a countdown (quantized launches). */
  queuedForMs?: number;
}

interface Pending extends RegisterOpts {
  deadline: number;
  attempt: number;
  superseded: boolean;
}

export const MAX_ATTEMPTS = 3;

export class CommandLifecycle {
  private pending = new Map<string, Pending>();
  private byTarget = new Map<string, string>(); // targetKey -> commandId

  private readonly events: LifecycleEvents;
  private readonly now: () => number;
  constructor(events: LifecycleEvents, now: () => number) {
    this.events = events;
    this.now = now;
  }

  register(opts: RegisterOpts): void {
    // Supersede any in-flight command on the same target (arch §12).
    const prevId = this.byTarget.get(opts.targetKey);
    if (prevId !== undefined) {
      const prev = this.pending.get(prevId);
      if (prev) {
        prev.superseded = true;
        this.pending.delete(prevId);
        this.events.status(prevId, 'failed', { reason: 'superseded' });
      }
    }
    const p: Pending = { ...opts, deadline: this.now() + opts.windowMs, attempt: 1, superseded: false };
    this.pending.set(opts.commandId, p);
    this.byTarget.set(opts.targetKey, opts.commandId);
    this.events.status(opts.commandId, 'sent');
    if (opts.queuedForMs && opts.queuedForMs > 0) {
      this.events.status(opts.commandId, 'queued', { queuedForMs: opts.queuedForMs });
    }
  }

  /** Feed every upstream event here; matching expectations confirm. */
  onEcho(event: unknown): void {
    for (const p of [...this.pending.values()]) {
      if (p.expect(event)) {
        this.pending.delete(p.commandId);
        if (this.byTarget.get(p.targetKey) === p.commandId) this.byTarget.delete(p.targetKey);
        this.events.status(p.commandId, 'confirmed');
      }
    }
  }

  /** Call on a timer (e.g. every 50 ms). Applies timeouts + retry policy. */
  tick(): void {
    const t = this.now();
    for (const p of [...this.pending.values()]) {
      if (t < p.deadline) continue;
      if (p.semantics.mutation === 'idempotent' && p.attempt < MAX_ATTEMPTS) {
        // Contract 8: absolute commands are safe to blind-retry on a lost echo.
        p.attempt += 1;
        p.deadline = t + p.windowMs;
        this.events.resend(p.commandId, p.attempt);
        continue;
      }
      this.pending.delete(p.commandId);
      if (this.byTarget.get(p.targetKey) === p.commandId) this.byTarget.delete(p.targetKey);
      if (p.semantics.mutation === 'stateful') {
        // Contract 8: NEVER blind-retry a stateful op — reconcile-then-decide.
        this.events.reconcile(p.commandId);
      } else {
        this.events.status(p.commandId, 'failed', { reason: 'no echo within window' });
      }
    }
  }

  /** WS reconnect: discard everything; the fresh snapshot is the truth (§12). */
  reset(): void {
    this.pending.clear();
    this.byTarget.clear();
  }

  get inFlight(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Quantization-window math (arch §12 "W is per-op, not fixed") — pure.
// ---------------------------------------------------------------------------

export const IMMEDIATE_WINDOW_MS = 300; // param/mute/volume class

/**
 * ms until the next quantization boundary, given the CURRENT song position.
 * Pure beats->ms math; feed it beatsPerBoundary from QUANT_BEATS.
 */
export function msToNextBoundary(positionBeats: number, beatsPerBoundary: number, tempoBpm: number): number {
  if (beatsPerBoundary <= 0) return 0; // quantization off -> immediate
  const msPerBeat = 60000 / tempoBpm;
  const into = positionBeats % beatsPerBoundary;
  const remaining = into === 0 ? 0 : beatsPerBoundary - into;
  return remaining * msPerBeat;
}

/** Window for a quantized launch = time-to-boundary + margin (arch §12). */
export function quantWindowMs(positionBeats: number, beatsPerBoundary: number, tempoBpm: number, marginMs = 400): number {
  return msToNextBoundary(positionBeats, beatsPerBoundary, tempoBpm) + marginMs;
}

/**
 * clip_trigger_quantization index -> beats per boundary.
 * ✅ VERIFIED ON RIG 2026-07-04 (Live 12.4.2): three fixed points read back via
 * /live/song/get/clip_trigger_quantization matched this table exactly —
 * None->0, "1 Bar"->4, "1/4"->7. Live's enum is monotonic, so those points pin
 * the whole ordering (0=None, 1=8 Bars ... 13=1/32). The MATH above was already
 * frozen; this lookup table is now confirmed data, no longer provisional.
 */
export const QUANT_BEATS: readonly number[] = [
  0, // 0 None
  32, // 1: 8 bars (4/4)
  16, // 2: 4 bars
  8, // 3: 2 bars
  4, // 4: 1 bar
  2, // 5: 1/2
  4 / 3, // 6: 1/2T
  1, // 7: 1/4
  2 / 3, // 8: 1/4T
  0.5, // 9: 1/8
  1 / 3, // 10: 1/8T
  0.25, // 11: 1/16
  1 / 6, // 12: 1/16T
  0.125, // 13: 1/32
];
