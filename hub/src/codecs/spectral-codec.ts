/**
 * SPC1 codec — Contract 6's frozen binary wire format for spectral frames
 * (contracts/types/spectral.ts). One datagram = one chain's frame.
 * Both directions live here so the M4L device (encoder side, later) and the
 * hub relay (decoder) are tested against the SAME golden bytes.
 */
import {
  SPECTRAL,
  SPECTRAL_BINARY,
  magToU16,
  magFromU16,
  type SpectralFrame,
} from '../../../contracts/types/spectral.ts';

export function encodeSpectralFrame(frame: SpectralFrame): Buffer {
  if (frame.magnitudes.length !== SPECTRAL.binCount) {
    throw new Error(`magnitudes must be exactly ${SPECTRAL.binCount} bins`);
  }
  const tag = Buffer.from(frame.chainTag, 'utf8');
  const buf = Buffer.alloc(SPECTRAL_BINARY.headerFixedBytes + tag.length + SPECTRAL.binCount * 2);
  buf.writeUInt32LE(SPECTRAL_BINARY.magic, 0);
  buf.writeUInt8(SPECTRAL_BINARY.version, 4);
  buf.writeUInt8(0, 5); // flags, reserved
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
  if (buf.length < SPECTRAL_BINARY.headerFixedBytes) throw new Error('datagram too short');
  if (buf.readUInt32LE(0) !== SPECTRAL_BINARY.magic) throw new Error('bad magic (not SPC1)');
  const version = buf.readUInt8(4);
  if (version !== SPECTRAL_BINARY.version) throw new Error(`unsupported SPC1 version ${version}`);
  const binCount = buf.readUInt16LE(6);
  if (binCount !== SPECTRAL.binCount) throw new Error(`binCount ${binCount} != ${SPECTRAL.binCount}`);
  const seq = buf.readUInt32LE(8);
  const tMs = buf.readDoubleLE(12);
  const tagLen = buf.readUInt16LE(20);
  const expect = 22 + tagLen + binCount * 2;
  if (buf.length !== expect) throw new Error(`length ${buf.length} != expected ${expect}`);
  const chainTag = buf.subarray(22, 22 + tagLen).toString('utf8');
  const magnitudes: number[] = new Array(binCount);
  let off = 22 + tagLen;
  for (let i = 0; i < binCount; i++) {
    magnitudes[i] = magFromU16(buf.readUInt16LE(off));
    off += 2;
  }
  return { chainTag, seq, tMs, magnitudes };
}
