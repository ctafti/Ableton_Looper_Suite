/**
 * MOVEMENT MATH — arch §10's worked grid, as a pure function.
 * write_movement(pattern) → the (time, duration, value) TRIPLES that Contract
 * 2's insertSteps sends (and the engine extension writes in one atomic undo).
 * Values are ABSOLUTE (Contract 8): depth maps into [min, max] device-native.
 */
export interface Step {
  time: number;
  duration: number;
  value: number;
}

export interface MovementPattern {
  readonly kind: 'every_other' | 'ramp' | 'square' | 'saw_down';
  readonly loopStart: number; // clip-local beats
  readonly loopEnd: number;
  /** grid size in beats (eighth = 0.5, quarter = 1, ...) */
  readonly grid: number;
  /** 0..1 movement depth into the param range */
  readonly depth: number;
  /** param range, device-native units */
  readonly min: number;
  readonly max: number;
}

export function movementSteps(p: MovementPattern): Step[] {
  const L = p.loopEnd - p.loopStart;
  if (L <= 0 || p.grid <= 0) return [];
  const n = Math.floor(L / p.grid + 1e-9);
  const lo = p.min;
  const hi = p.min + p.depth * (p.max - p.min);
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) {
    const t = p.loopStart + i * p.grid;
    let value: number;
    switch (p.kind) {
      case 'every_other': // §10's worked example: on/off gate every other cell
        value = i % 2 === 0 ? hi : lo;
        break;
      case 'square': // half period high, half low (per 2 cells)
        value = i % 4 < 2 ? hi : lo;
        break;
      case 'ramp': // rise across the loop
        value = n === 1 ? hi : lo + ((hi - lo) * i) / (n - 1);
        break;
      case 'saw_down': // fall across the loop
        value = n === 1 ? lo : hi - ((hi - lo) * i) / (n - 1);
        break;
    }
    steps.push({ time: t, duration: p.grid, value });
  }
  return steps;
}

/**
 * SPECTRAL DISPLAY BANDS — arch §3's tablet side: collapse 256 linear bins
 * (0..~16 kHz) into 48 log-spaced display bands, plus peak-hold with falling
 * caps. Pure math so the renderer, the simulator, and tests all agree.
 */
export const DISPLAY_BANDS = 48;

/** Log-spaced band edges as BIN indices (0..binCount), low anchored so the
 *  bottom octaves get real resolution (first bin ≈ 62 Hz at 4096-FFT/48k). */
export function logBandEdges(binCount = 256, bands = DISPLAY_BANDS): number[] {
  const loBin = 1; // skip DC
  const edges: number[] = [];
  const ratio = binCount / loBin;
  for (let b = 0; b <= bands; b++) {
    edges.push(Math.min(binCount, Math.round(loBin * Math.pow(ratio, b / bands))));
  }
  // guarantee monotonic, at least 1 bin per band
  for (let b = 1; b <= bands; b++) {
    if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
  }
  edges[bands] = binCount;
  return edges;
}

/** Collapse one frame of linear magnitudes into display bands (max-in-band —
 *  peaks are what you're mixing against, arch §1 "see masking"). */
export function collapseToBands(magnitudes: readonly number[], edges: readonly number[]): number[] {
  const out = new Array(edges.length - 1).fill(0);
  for (let b = 0; b < out.length; b++) {
    let m = 0;
    for (let i = edges[b]; i < edges[b + 1] && i < magnitudes.length; i++) {
      if (magnitudes[i] > m) m = magnitudes[i];
    }
    out[b] = m;
  }
  return out;
}

/** Falling peak-hold caps (arch §1): cap jumps to a new peak instantly, then
 *  decays at `decayPerSecond` (normalized units/s). */
export class PeakHold {
  private caps: number[];
  private readonly decayPerSecond: number;
  constructor(bands = DISPLAY_BANDS, decayPerSecond = 0.4) {
    this.caps = new Array(bands).fill(0);
    this.decayPerSecond = decayPerSecond;
  }
  update(bandValues: readonly number[], dtSeconds: number): number[] {
    const fall = this.decayPerSecond * dtSeconds;
    for (let i = 0; i < this.caps.length; i++) {
      const decayed = Math.max(0, this.caps[i] - fall);
      this.caps[i] = Math.max(decayed, bandValues[i] ?? 0);
    }
    return [...this.caps];
  }
}
