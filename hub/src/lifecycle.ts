/**
 * PENDING-COMMAND LIFECYCLE — arch §12, implemented as a pure state machine.
 *
 * OSC is fire-and-forget UDP; nothing ACKs. So we confirm by EXPECTATION-
 * MATCHING: on send, register "this echo should arrive within window W"; the
 * matching listener event satisfies it. This class owns:
 *   intent → sent → (queued) → confirmed | failed
 * plus the two §12 policies:
 *   - idempotent  → blind-retry on timeout (absolute commands are safe), max 3
 *   - stateful    → reconcile-then-decide (NEVER blind-retry; ask for truth)
 * and per-target supersession (fire A then B on one track → A superseded).
 *
 * Pure logic: time comes in via tick(now), sends go out via callbacks. That is
 * what makes it fully testable offline with a fake clock — and exactly why it
 * can be prebuilt: every input/output is a frozen contract shape.
 */
import type { CommandSemantics } from '../../contracts/types/command-rule.ts';
import type { OscUpEvent } from '../../contracts/types/osc.ts';
import type { CommandPhase, CommandStatus } from '../../contracts/types/ws.ts';

export interface PendingCommand {
  readonly commandId: string;
  readonly semantics: CommandSemantics;
  /** does this up-event satisfy the expectation? */
  readonly expect: (ev: OscUpEvent) => boolean;
  /** re-send the wire message (idempotent retry path). */
  readonly send: () => void;
  /**
   * confirmation window in ms. For quantized ops the CALLER computes
   * time-to-next-quant-boundary + margin (it knows tempo + global quant);
   * for immediate ops ~300 ms (arch §12). isQueued=true renders the distinct
   * countdown treatment, never confused with lag.
   */
  readonly windowMs: number;
  readonly isQueued: boolean;
  /** commands to the same target supersede each other (last write wins). */
  readonly targetKey: string;
}

export interface LifecycleEvents {
  onStatus: (status: CommandStatus) => void;
  /** stateful op timed out → the caller must re-query truth, then call
   *  resolveReconcile(commandId, happened). */
  onReconcileNeeded: (commandId: string) => void;
}

interface Entry {
  cmd: PendingCommand;
  phase: CommandPhase;
  deadline: number;
  attempts: number;
}

export const MAX_IDEMPOTENT_ATTEMPTS = 3;

export class CommandLifecycle {
  private pending = new Map<string, Entry>();
  private byTarget = new Map<string, string>(); // targetKey -> commandId

  private readonly events: LifecycleEvents;

  constructor(events: LifecycleEvents) {
    this.events = events;
  }

  /** Register + send. Emits intent immediately ("heard you"), then sent. */
  submit(cmd: PendingCommand, now: number): void {
    // supersede any in-flight command on the same target (arch §12 backpressure)
    const prevId = this.byTarget.get(cmd.targetKey);
    if (prevId !== undefined) {
      const prev = this.pending.get(prevId);
      if (prev) {
        this.pending.delete(prevId);
        this.emit(prevId, 'failed', { reason: 'superseded' });
      }
    }
    this.byTarget.set(cmd.targetKey, cmd.commandId);

    const entry: Entry = { cmd, phase: 'intent', deadline: now + cmd.windowMs, attempts: 1 };
    this.pending.set(cmd.commandId, entry);
    this.emit(cmd.commandId, 'intent');
    cmd.send();
    entry.phase = cmd.isQueued ? 'queued' : 'sent';
    this.emit(cmd.commandId, entry.phase, cmd.isQueued ? { queuedForMs: cmd.windowMs } : {});
  }

  /** Feed every engine up-event through here. */
  onEcho(ev: OscUpEvent): void {
    for (const [id, entry] of this.pending) {
      if (entry.cmd.expect(ev)) {
        this.finish(id, 'confirmed');
        return; // one echo satisfies one expectation
      }
    }
  }

  /** Call regularly (or before rendering) with the current time. */
  tick(now: number): void {
    for (const [id, entry] of [...this.pending]) {
      if (now < entry.deadline) continue;
      const { cmd } = entry;
      if (cmd.semantics.mutation === 'idempotent' && entry.attempts < MAX_IDEMPOTENT_ATTEMPTS) {
        entry.attempts += 1;
        entry.deadline = now + cmd.windowMs;
        cmd.send(); // absolute ⇒ safe to blind-retry (Contract 8)
      } else if (cmd.semantics.mutation === 'stateful') {
        // NEVER blind-retry a stateful op — ask for truth first (arch §12).
        this.events.onReconcileNeeded(id);
        entry.deadline = now + cmd.windowMs; // hold while reconciling
        entry.phase = 'sent';
      } else {
        this.finish(id, 'failed', { reason: "didn't take — retry?" });
      }
    }
  }

  /** Answer to onReconcileNeeded: did the stateful op actually happen? */
  resolveReconcile(commandId: string, happened: boolean): void {
    if (!this.pending.has(commandId)) return;
    this.finish(commandId, happened ? 'confirmed' : 'failed',
      happened ? {} : { reason: "didn't take — retry?" });
  }

  /** On websocket reconnect the tablet rebuilds from a snapshot; all
   *  optimistic state is discarded (arch §12 safety net). */
  clearAll(): void {
    this.pending.clear();
    this.byTarget.clear();
  }

  get inFlight(): number {
    return this.pending.size;
  }

  private finish(id: string, phase: 'confirmed' | 'failed', extra: Partial<CommandStatus> = {}): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (this.byTarget.get(entry.cmd.targetKey) === id) this.byTarget.delete(entry.cmd.targetKey);
    this.emit(id, phase, extra);
  }

  private emit(id: string, phase: CommandPhase, extra: Partial<CommandStatus> = {}): void {
    this.events.onStatus({ commandId: id, phase, ...extra });
  }
}
