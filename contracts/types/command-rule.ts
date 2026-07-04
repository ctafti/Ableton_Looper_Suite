/**
 * ============================================================================
 * CONTRACT 8 — COMMAND PROTOCOL RULE          (arch §12 · BUILD-PLAN Phase 1)
 * TAG: FREEZE-NOW
 * ----------------------------------------------------------------------------
 * THE RULE (one sentence)
 *
 *   Every command in the whole system is ABSOLUTE and IDEMPOTENT:
 *   it states the desired end value, never a relative change.
 *
 *   YES:  "set looper = OVERDUB",  "set param Gain = 0.7",  "fire slot 3"
 *   NO:   "advance looper",  "nudge gain up",  "toggle",  "next slot"
 *
 * WHY (plain language)
 *
 * OSC is fire-and-forget UDP — a packet can be silently dropped, and there is
 * no built-in "message received" acknowledgement (see Contract 2 and arch §12).
 * If commands were relative ("advance"), a lost-then-retried command could be
 * applied twice ("advance" x2) and land in the wrong state. Absolute commands
 * are safe to send again and again: re-sending "set = OVERDUB" ten times still
 * ends in OVERDUB. That single property is what lets the pending-command
 * lifecycle auto-retry without corrupting state.
 *
 * TWO MUTATION CLASSES (this decides the retry strategy)
 *
 *  - 'idempotent'  : re-applying yields the same result. Safe to blindly
 *                    auto-retry on a lost echo. (set param, set state, mute,
 *                    volume, fire a specific slot, launch a specific scene.)
 *  - 'stateful'    : the operation *creates or consumes* something, so blind
 *                    retry could duplicate it (duplicate_clip_to, record,
 *                    add_device). These use RECONCILE-THEN-DECIDE: re-query
 *                    Live to see whether it already happened, then retry or
 *                    stop. (arch §12)
 *
 * This file is the machine-readable form of the rule. Every command type in
 * Contracts 2, 3 and 4 carries a `mutation` tag, and `retryPolicyFor()` turns
 * that tag into the correct behaviour so the rule can't be violated silently.
 * ============================================================================
 */

/** How a command mutates Live — drives the retry strategy. */
export type MutationClass = 'idempotent' | 'stateful';

/**
 * Every command/tool descriptor carries this so the lifecycle engine (Phase 3)
 * knows how to treat a lost echo without re-reading the vocabulary.
 */
export interface CommandSemantics {
  /** Absolute means the payload is the desired END value, not a delta. */
  readonly absolute: true; // structurally enforced: there is no `false` case.
  readonly mutation: MutationClass;
}

/** The retry behaviour the lifecycle applies when an echo does not arrive. */
export type RetryPolicy =
  | { readonly kind: 'retry'; readonly maxAttempts: number }
  | { readonly kind: 'reconcile_then_decide' };

export function retryPolicyFor(s: CommandSemantics): RetryPolicy {
  return s.mutation === 'idempotent'
    ? { kind: 'retry', maxAttempts: 3 }
    : { kind: 'reconcile_then_decide' };
}

/**
 * Convenience constructors so command definitions read cleanly and the
 * `absolute: true` invariant is never forgotten.
 */
export const IDEMPOTENT: CommandSemantics = { absolute: true, mutation: 'idempotent' };
export const STATEFUL: CommandSemantics = { absolute: true, mutation: 'stateful' };

/**
 * A design-time guard. There is deliberately no way to express a relative
 * command in these types. If you ever find yourself wanting one, the answer is
 * to compute the absolute target on the *client* (which knows current state
 * from the mirror) and send that instead. This function documents that intent
 * and can be used in tests to assert a value is a legal command class.
 */
export function assertAbsolute(s: CommandSemantics): void {
  if ((s as { absolute: boolean }).absolute !== true) {
    throw new Error(
      'Command protocol violation: only absolute/idempotent commands are allowed (Contract 8).',
    );
  }
}
