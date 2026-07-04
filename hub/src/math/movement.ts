/**
 * MOVEMENT MATH — arch §10's worked grid, generalised. Pure functions:
 * pattern description in, Contract-2 insertSteps TRIPLES out. The engine
 * extension writes exactly these; getEnvelope reads them back as the receipt.
 */
export interface Step {
  readonly time: number; // clip-local beats
  readonly duration: number; // beats
  readonly value: number; // absolute, device-native units
}

/** §10 worked example: alternate on/off every `intervalBeats` across the loop. */
export function gatePattern(
  loopStart: number,
  loopEnd: number,
  intervalBeats: number,
  onValue: number,
  offValue: number,
): Step[] {
  const out: Step[] = [];
  const n = Math.floor((loopEnd - loopStart) / intervalBeats);
  for (let i = 0; i < n; i++) {
    out.push({
      time: loopStart + i * intervalBeats,
      duration: intervalBeats,
      value: i % 2 === 0 ? onValue : offValue,
    });
  }
  return out;
}

/** Linear ramp approximated by `segments` held micro-steps (no breakpoint API — §10). */
export function rampPattern(
  loopStart: number,
  loopEnd: number,
  fromValue: number,
  toValue: number,
  segments: number,
): Step[] {
  const out: Step[] = [];
  const dur = (loopEnd - loopStart) / segments;
  for (let i = 0; i < segments; i++) {
    const f = segments === 1 ? 0 : i / (segments - 1);
    out.push({ time: loopStart + i * dur, duration: dur, value: fromValue + f * (toValue - fromValue) });
  }
  return out;
}

/** Sine LFO baked as held micro-steps: `cycles` over the loop, `segments` steps. */
export function sinePattern(
  loopStart: number,
  loopEnd: number,
  center: number,
  depth: number,
  cycles: number,
  segments: number,
): Step[] {
  const out: Step[] = [];
  const dur = (loopEnd - loopStart) / segments;
  for (let i = 0; i < segments; i++) {
    const phase = (i / segments) * cycles * 2 * Math.PI;
    out.push({ time: loopStart + i * dur, duration: dur, value: center + depth * Math.sin(phase) });
  }
  return out;
}

/** Map a 0..1 depth into a parameter's native range (§10 on_val = min + depth*(max-min)). */
export function depthToValue(min: number, max: number, depth01: number): number {
  return min + Math.max(0, Math.min(1, depth01)) * (max - min);
}

/** Flatten steps to the Contract-2 insertSteps wire args (after the 4 indices). */
export function stepsToArgs(steps: readonly Step[]): number[] {
  return steps.flatMap((s) => [s.time, s.duration, s.value]);
}
