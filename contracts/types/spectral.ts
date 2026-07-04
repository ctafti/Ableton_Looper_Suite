/**
 * ============================================================================
 * CONTRACT 6 — M4L -> HUB SPECTRAL TELEMETRY FORMAT
 *                                               (arch §3 · BUILD-PLAN Phase 1)
 * TAG: FREEZE-NOW
 * ----------------------------------------------------------------------------
 * WHAT (arch §3): each per-chain Max-for-Live FFT device emits ~256 LINEAR
 * magnitude bins, ~0-16 kHz, normalized 0-1, at ~30 fps. NO binning to 48, NO
 * smoothing, NO peak-hold, NO color — all of that "look" lives on the tablet.
 * The Mac only does the raw FFT; the tablet does the visual processing.
 *
 * WHY FREEZE IT (arch §5.3 order): the M4L device (Phase 4) and the tablet
 * renderer (Phase 4) are built on opposite sides of this seam. Pin it and both
 * are written once.
 *
 * TRANSPORT: from the M4L device to the hub via Node for Max / udpsend, then
 * the hub forwards it on the TELEMETRY websocket channel (Contract 3). It is
 * ephemeral and lossy-OK: a dropped frame just means one skipped visual update.
 *
 * WIRE FORMAT — two equivalent encodings, both frozen:
 *   (a) BINARY (preferred on the M4L->hub UDP hop, for the ~90 KB/s budget):
 *       a fixed header + uint16 magnitudes. See SPECTRAL_BINARY below.
 *   (b) JSON (the logical shape, used on the hub->tablet WS hop and for tests):
 *       the `SpectralFrame` interface below.
 *
 * BANDWIDTH CHECK (arch §3): ~6 chains x 256 bins x 2 bytes x 30 fps ~= 90 KB/s.
 * Trivial. This is why bins are uint16 (2 bytes), not float32.
 * ============================================================================
 */

/**
 * chainTag — how the M4L device identifies WHICH chain it is on. The device
 * does NOT know the backend's ChainID. Instead the template (Contract 7) gives
 * each chain a stable `chainTag` string, baked into the M4L device instance.
 * The hub maps chainTag -> ChainID at snapshot time. This keeps the M4L side
 * free of backend concepts.
 */
export type ChainTag = string;

/** Fixed parameters of the spectral stream — frozen. */
export const SPECTRAL = {
  /** Number of linear magnitude bins per frame. */
  binCount: 256,
  /** Approximate covered band, informational (bins are linear across it). */
  freqLowHz: 0,
  freqHighHz: 16000,
  /** Nominal frame rate. Consumers must tolerate jitter; frames are timestamped. */
  fps: 30,
  /** FFT size the M4L device uses upstream (arch §3: 4096 -> ~12 Hz bins @ 48k). */
  fftSize: 4096,
  /** Magnitudes are normalized 0..1 then quantized to uint16 (0..65535). */
  magScaleMax: 65535,
} as const;

/**
 * The logical per-chain spectral frame (JSON form / hub-side type).
 * `magnitudes` are already normalized 0..1 (floats) in this logical view; the
 * binary wire form stores them as uint16. Exactly `SPECTRAL.binCount` values.
 */
export interface SpectralFrame {
  readonly chainTag: ChainTag;
  /** Monotonic per-chain sequence number; lets the tablet drop stale frames. */
  readonly seq: number;
  /** Sender timestamp in ms (M4L transport time) for jitter-aware rendering. */
  readonly tMs: number;
  /** Exactly SPECTRAL.binCount normalized magnitudes, 0..1, linear-spaced. */
  readonly magnitudes: readonly number[];
}

/**
 * Beat / clock telemetry (arch §4). Ephemeral. The tablet derives the smooth
 * playhead sweep locally from tempo + clip start + loop length; this just
 * anchors it and lets the sweep re-sync each beat.
 */
export interface BeatTelemetry {
  readonly beat: number;    // current beat number (from Live's beat listener)
  readonly tempoBpm: number;
  readonly tMs: number;     // sender timestamp
}

// ---------------------------------------------------------------------------
// BINARY WIRE FORMAT (M4L -> hub UDP hop)
// ---------------------------------------------------------------------------
// Little-endian. One datagram = one chain's frame.
//
//   offset  size  field
//   ------  ----  -----------------------------------------------------------
//   0       4     magic = 0x53504331  ("SPC1")           uint32
//   4       1     version = 1                              uint8
//   5       1     flags (reserved, 0)                      uint8
//   6       2     binCount (== 256)                        uint16
//   8       4     seq                                      uint32
//   12      8     tMs (sender time, ms)                    float64
//   20      2     chainTagLen (bytes, UTF-8)               uint16
//   22      N     chainTag (UTF-8, no null terminator)     bytes
//   22+N    512   magnitudes: binCount x uint16 (0..65535) uint16[256]
//
// Total = 22 + chainTagLen + 2*binCount bytes.
// A uint16 value v maps to normalized magnitude v / SPECTRAL.magScaleMax.
// ---------------------------------------------------------------------------

export const SPECTRAL_BINARY = {
  magic: 0x53504331,
  version: 1,
  headerFixedBytes: 22,        // bytes before the variable-length chainTag
  bytesPerBin: 2,              // uint16
} as const;

/** Decode a normalized magnitude (0..1) from its uint16 wire value. */
export function magFromU16(v: number): number {
  return v / SPECTRAL.magScaleMax;
}
/** Encode a normalized magnitude (0..1) to its uint16 wire value (clamped). */
export function magToU16(m: number): number {
  const v = Math.round(Math.max(0, Math.min(1, m)) * SPECTRAL.magScaleMax);
  return v;
}
