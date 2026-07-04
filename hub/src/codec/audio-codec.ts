/**
 * APC1 codec — Contract 5's frozen sidecar→hub PCM record, both directions —
 * plus the 10 ms RESLICER: the piece of hub logic Contract 5 explicitly
 * assigns to us ("the HUB reslices whatever chunk sizes the sidecar sends into
 * exact 10 ms frames before onData"). The sidecar (C++, Phase 8) will ENCODE
 * these records; goldens in hub/golden/ pin the byte layout so the C++ side
 * has a byte-exact target.
 *
 * Header layout (40 bytes LE, from contracts/types/audio-sidecar.ts):
 *   0  u32 magic "APC1" · 4 u16 version · 6 u16 numChannels · 8 u32 sampleRate
 *   12 u32 numFrames · 16 u32 sequence · 20 f64 sessionBeatTime · 28 f64 tempo
 *   36 u16 flags · 38 u16 reserved — then numChannels*numFrames int16 LE.
 */
import {
  AUDIO_SIDECAR,
  AUDIO_HEADER,
  payloadBytes,
  framesPerChannel10ms,
  type AudioPacket,
  type AudioPacketHeader,
} from '../../../contracts/types/audio-sidecar.ts';

export function encodeAudioPacket(pkt: AudioPacket): Buffer {
  const h = pkt.header;
  const expectSamples = h.numChannels * h.numFrames;
  if (pkt.samples.length !== expectSamples) {
    throw new Error(`APC1: samples ${pkt.samples.length} != numChannels*numFrames ${expectSamples}`);
  }
  const buf = Buffer.alloc(AUDIO_HEADER.BYTES + payloadBytes(h));
  const o = AUDIO_HEADER.offsets;
  buf.writeUInt32LE(h.magic >>> 0, o.magic);
  buf.writeUInt16LE(h.version, o.version);
  buf.writeUInt16LE(h.numChannels, o.numChannels);
  buf.writeUInt32LE(h.sampleRate >>> 0, o.sampleRate);
  buf.writeUInt32LE(h.numFrames >>> 0, o.numFrames);
  buf.writeUInt32LE(h.sequence >>> 0, o.sequence);
  buf.writeDoubleLE(h.sessionBeatTime, o.sessionBeatTime);
  buf.writeDoubleLE(h.tempo, o.tempo);
  buf.writeUInt16LE(h.flags, o.flags);
  buf.writeUInt16LE(0, o.reserved);
  for (let i = 0; i < pkt.samples.length; i++) {
    buf.writeInt16LE(pkt.samples[i], AUDIO_HEADER.BYTES + i * 2);
  }
  return buf;
}

export function decodeAudioHeader(buf: Buffer): AudioPacketHeader {
  if (buf.length < AUDIO_HEADER.BYTES) throw new Error('APC1: header too short');
  const o = AUDIO_HEADER.offsets;
  const magic = buf.readUInt32LE(o.magic);
  if (magic !== AUDIO_SIDECAR.magic) throw new Error('APC1: bad magic');
  const version = buf.readUInt16LE(o.version);
  if (version !== AUDIO_SIDECAR.version) throw new Error(`APC1: unknown version ${version}`);
  return {
    magic,
    version,
    numChannels: buf.readUInt16LE(o.numChannels),
    sampleRate: buf.readUInt32LE(o.sampleRate),
    numFrames: buf.readUInt32LE(o.numFrames),
    sequence: buf.readUInt32LE(o.sequence),
    sessionBeatTime: buf.readDoubleLE(o.sessionBeatTime),
    tempo: buf.readDoubleLE(o.tempo),
    flags: buf.readUInt16LE(o.flags),
  };
}

export function decodeAudioPacket(buf: Buffer): AudioPacket {
  const header = decodeAudioHeader(buf);
  const need = AUDIO_HEADER.BYTES + payloadBytes(header);
  if (buf.length !== need) throw new Error(`APC1: length ${buf.length} != expected ${need}`);
  const samples = new Int16Array(header.numChannels * header.numFrames);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(AUDIO_HEADER.BYTES + i * 2);
  return { header, samples };
}

/**
 * StreamFramer — TCP is a byte stream, not packets; feed it arbitrary chunks
 * and it yields complete APC1 packets. This is the hub's socket-reading loop.
 */
export class StreamFramer {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): AudioPacket[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: AudioPacket[] = [];
    for (;;) {
      if (this.pending.length < AUDIO_HEADER.BYTES) break;
      const header = decodeAudioHeader(this.pending);
      const total = AUDIO_HEADER.BYTES + payloadBytes(header);
      if (this.pending.length < total) break;
      out.push(decodeAudioPacket(this.pending.subarray(0, total)));
      this.pending = this.pending.subarray(total);
    }
    return out;
  }
}

/**
 * TenMsReslicer — Contract 5's hub-side duty: accept packets of ANY natural
 * Link buffer size and emit exact 10 ms interleaved frames for
 * RTCAudioSource.onData (480 samples/channel at 48 kHz). Trusts the HEADER's
 * sampleRate/numChannels per packet (per the contract), and flushes its
 * remainder on a format change or a DISCONTINUITY flag rather than gluing
 * unrelated audio together.
 */
export interface TenMsFrame {
  readonly sampleRate: number;
  readonly channelCount: number;
  /** interleaved int16, length = channelCount * (sampleRate/100) */
  readonly samples: Int16Array;
}

export class TenMsReslicer {
  private rate = 0;
  private channels = 0;
  private buf: number[] = [];

  push(pkt: AudioPacket): TenMsFrame[] {
    const { sampleRate, numChannels, flags } = pkt.header;
    if (sampleRate !== this.rate || numChannels !== this.channels || flags & 1) {
      this.buf = []; // format change / xrun: drop the partial frame (never glue)
      this.rate = sampleRate;
      this.channels = numChannels;
    }
    for (let i = 0; i < pkt.samples.length; i++) this.buf.push(pkt.samples[i]);

    const perFrame = framesPerChannel10ms(this.rate) * this.channels;
    const out: TenMsFrame[] = [];
    while (this.buf.length >= perFrame) {
      out.push({
        sampleRate: this.rate,
        channelCount: this.channels,
        samples: Int16Array.from(this.buf.slice(0, perFrame)),
      });
      this.buf = this.buf.slice(perFrame);
    }
    return out;
  }
}
