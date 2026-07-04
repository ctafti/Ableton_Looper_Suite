/**
 * SPC1 codec — Contract 6's frozen binary spectral datagram, both directions.
 * The M4L device will ENCODE this (in Max/Node-for-Max); the hub DECODES it.
 * We implement both here so the two sides can be tested against each other and
 * against the golden fixtures in hub/golden/ (byte-exact — if the M4L side
 * produces these bytes, the hub will read it, no debugging inside Max).
 *
 * Layout (little-endian, from contracts/types/spectral.ts):
 *   0   u32  magic 0x53504331 "SPC1"
 *   4   u8   version = 1
 *   5   u8   flags (reserved 0)
 *   6   u16  binCount (== 256)
 *   8   u32  seq
 *   12  f64  tMs
 *   20  u16  chainTagLen (UTF-8 bytes)
 *   22  ..   chainTag (UTF-8, no null)
 *   +N  512  magnitudes: binCount x u16
 */
import {
  SPECTRAL,
  SPECTRAL_BINARY,
  magFromU16,
  magToU16,
  type SpectralFrame,
} from '../../../contracts/types/spectral.ts';

export function encodeSpectralFrame(frame: SpectralFrame): Buffer {
  if (frame.magnitudes.length !== SPECTRAL.binCount) {
    throw new Error(
      `magnitudes must have exactly ${SPECTRAL.binCount} bins, got ${frame.magnitudes.length}`,
    );
  }
  const tag = Buffer.from(frame.chainTag, 'utf8');
  const buf = Buffer.alloc(
    SPECTRAL_BINARY.headerFixedBytes + tag.length + SPECTRAL.binCount * SPECTRAL_BINARY.bytesPerBin,
  );
  buf.writeUInt32LE(SPECTRAL_BINARY.magic, 0);
  buf.writeUInt8(SPECTRAL_BINARY.version, 4);
  buf.writeUInt8(0, 5);
  buf.writeUInt16LE(SPECTRAL.binCount, 6);
  buf.writeUInt32LE(frame.seq >>> 0, 8);
  buf.writeDoubleLE(frame.tMs, 12);
  buf.writeUInt16LE(tag.length, 20);
  tag.copy(buf, 22);
  let off = 22 + tag.length;
  for (const m of frame.magnitudes) {
    buf.writeUInt16LE(magToU16(m), off);
    off += 2;
  }
  return buf;
}

export function decodeSpectralFrame(buf: Buffer): SpectralFrame {
  if (buf.length < SPECTRAL_BINARY.headerFixedBytes) throw new Error('SPC1: too short');
  if (buf.readUInt32LE(0) !== SPECTRAL_BINARY.magic) throw new Error('SPC1: bad magic');
  const version = buf.readUInt8(4);
  if (version !== SPECTRAL_BINARY.version) throw new Error(`SPC1: unknown version ${version}`);
  const binCount = buf.readUInt16LE(6);
  if (binCount !== SPECTRAL.binCount) throw new Error(`SPC1: binCount ${binCount} != ${SPECTRAL.binCount}`);
  const seq = buf.readUInt32LE(8);
  const tMs = buf.readDoubleLE(12);
  const tagLen = buf.readUInt16LE(20);
  const expected = SPECTRAL_BINARY.headerFixedBytes + tagLen + binCount * SPECTRAL_BINARY.bytesPerBin;
  if (buf.length !== expected) throw new Error(`SPC1: length ${buf.length} != expected ${expected}`);
  const chainTag = buf.toString('utf8', 22, 22 + tagLen);
  const magnitudes: number[] = new Array(binCount);
  let off = 22 + tagLen;
  for (let i = 0; i < binCount; i++) {
    magnitudes[i] = magFromU16(buf.readUInt16LE(off));
    off += 2;
  }
  return { chainTag, seq, tMs, magnitudes };
}
