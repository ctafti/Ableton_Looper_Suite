/**
 * DISPLAY-BAND MATH — arch §3's tablet side: collapse 256 LINEAR bins into 48
 * LOG-SPACED display bands, plus the falling peak-hold caps. Pure math, frozen
 * here and mirrored verbatim in the tablet skeleton's plain JS (tablet/app.js)
 * — this TS version is the tested reference.
 */
import { SPECTRAL } from '../../../contracts/types/spectral.ts';

export interface BandMap {
  /** for each display band, the [startBin, endBin) range it averages. */
  readonly ranges: readonly (readonly [number, number])[];
}

/**
 * Build the log band map. Bins are linear 0..fHigh; bands are log-spaced from
 * fLow floor (log needs a nonzero floor; 40 Hz ≈ low E's fundamental region).
 * Every band covers at least one bin and ranges are contiguous+monotonic.
 */
export function makeBandMap(
  bands = 48,
  binCount = SPECTRAL.binCount,
  fHighHz = SPECTRAL.freqHighHz,
  fLowHz = 40,
): BandMap {
  const binHz = fHighHz / binCount;
  const ranges: [number, number][] = [];
  let prevEnd = Math.max(0, Math.floor(fLowHz / binHz));
  for (let b = 0; b < bands; b++) {
    const fEnd = fLowHz * Math.pow(fHighHz / fLowHz, (b + 1) / bands);
    let end = Math.ceil(fEnd / binHz);
    if (end <= prevEnd) end = prevEnd + 1; // every band gets >= 1 bin
    if (end > binCount) end = binCount;
    ranges.push([prevEnd, end]);
    prevEnd = end;
  }
  ranges[ranges.length - 1][1] = binCount; // last band absorbs the remainder
  return { ranges };
}

/** Collapse one 256-bin frame into 48 band magnitudes (mean per band). */
export function collapse(magnitudes: readonly number[], map: BandMap): number[] {
  return map.ranges.map(([a, b]) => {
    let sum = 0;
    for (let i = a; i < b; i++) sum += magnitudes[i];
    return b > a ? sum / (b - a) : 0;
  });
}

/**
 * Peak-hold caps with falling decay (§1 "falling peak-hold caps"): each band's
 * cap jumps to any new maximum and otherwise falls by `decayPerSecond`.
 */
export class PeakHold {
  private caps: number[];
  private readonly decayPerSecond: number;
  constructor(bands: number, decayPerSecond = 0.6) {
    this.caps = new Array(bands).fill(0);
    this.decayPerSecond = decayPerSecond;
  }
  update(bandValues: readonly number[], dtSeconds: number): readonly number[] {
    const fall = this.decayPerSecond * dtSeconds;
    for (let i = 0; i < this.caps.length; i++) {
      this.caps[i] = Math.max(bandValues[i], this.caps[i] - fall);
    }
    return this.caps;
  }
}

/** Additive master sum (§1 MIX thumbnail): sum per band, clamped to 1. */
export function additiveSum(frames: readonly (readonly number[])[]): number[] {
  if (frames.length === 0) return [];
  const out = new Array(frames[0].length).fill(0);
  for (const f of frames) for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] + f[i]);
  return out;
}
