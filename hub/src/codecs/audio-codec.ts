/**
 * APC1 codec + reslicer — Contract 5's frozen sidecar→hub PCM record format
 * (contracts/types/audio-sidecar.ts) and the hub-side reslicer that turns
 * arbitrary Link-buffer-sized packets into the exact 10 ms frames
 * @roamhq/wrtc's RTCAudioSource.onData wants (arch §8/§9).
 *
 * The ENCODER here doubles as the executable spec the C++ sidecar is written
 * against (sidecar/ is tested by comparing its bytes to these goldens).
 */
import {
  AUDIO_SIDECAR,
  AUDIO_HEADER,
  AUDIO_FLAGS,
  framesPerChannel10ms,
  payloadBytes,
  type AudioPacketHeader,
  type AudioPacket,
} from '../../../contracts/types/audio-sidecar.ts';

export function encodeAudioPacket(pkt: AudioPacket): Buffer {
  const h = pkt.header;
  const expectSamples = h.numChannels * h.numFrames;
  if (pkt.samples.length !== expectSamples) {
    throw new Error(`samples length ${pkt.samples.length} != numChannels*numFrames ${expectSamples}`);
  }
  const buf = Buffer.alloc(AUDIO_HEADER.BYTES + payloadBytes(h));
  const o = AUDIO_HEADER.offsets;
  buf.writeUInt32LE(h.magic, o.magic);
  buf.writeUInt16LE(h.version, o.version);
  buf.writeUInt16LE(h.numChannels, o.numChannels);
  buf.writeUInt32LE(h.sampleRate, o.sampleRate);
  buf.writeUInt32LE(h.numFrames, o.numFrames);
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
  if (buf.length < AUDIO_HEADER.BYTES) throw new Error('short header');
  const o = AUDIO_HEADER.offsets;
  const h: AudioPacketHeader = {
    magic: buf.readUInt32LE(o.magic),
    version: buf.readUInt16LE(o.version),
    numChannels: buf.readUInt16LE(o.numChannels),
    sampleRate: buf.readUInt32LE(o.sampleRate),
    numFrames: buf.readUInt32LE(o.numFrames),
    sequence: buf.readUInt32LE(o.sequence),
    sessionBeatTime: buf.readDoubleLE(o.sessionBeatTime),
    tempo: buf.readDoubleLE(o.tempo),
    flags: buf.readUInt16LE(o.flags),
  };
  if (h.magic !== AUDIO_SIDECAR.magic) throw new Error('bad magic (not APC1)');
  if (h.version !== AUDIO_SIDECAR.version) throw new Error(`unsupported APC1 version ${h.version}`);
  return h;
}

/**
 * Incremental TCP-stream parser: feed arbitrary chunks, get whole packets out.
 * (TCP gives no message boundaries; the header's numFrames tells us how much
 * payload to wait for — Contract 5 payloadBytes.)
 */
export class AudioStreamParser {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer, onPacket: (pkt: AudioPacket) => void): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < AUDIO_HEADER.BYTES) return;
      const header = decodeAudioHeader(this.buf);
      const total = AUDIO_HEADER.BYTES + payloadBytes(header);
      if (this.buf.length < total) return;
      const payload = this.buf.subarray(AUDIO_HEADER.BYTES, total);
      const samples = new Int16Array(header.numChannels * header.numFrames);
      for (let i = 0; i < samples.length; i++) samples[i] = payload.readInt16LE(i * 2);
      onPacket({ header, samples });
      this.buf = this.buf.subarray(total);
    }
  }
}

/** A single 10 ms frame ready for RTCAudioSource.onData. */
export interface WebRtcFrame {
  samples: Int16Array; // interleaved, framesPerChannel * channelCount
  sampleRate: number;
  channelCount: number;
  framesPerChannel: number; // == sampleRate / 100
}

/**
 * Reslices incoming packets (natural Link buffer sizes) into EXACT 10 ms
 * frames. The sidecar is NOT required to send 10 ms chunks — this is the hub's
 * job (Contract 5 "the hub reslices"). Carries leftovers across packets;
 * flushes them on a DISCONTINUITY flag or a format change (stale audio must
 * not be glued across a gap).
 */
export class TenMsReslicer {
  private leftover: Int16Array = new Int16Array(0);
  private rate = 0;
  private channels = 0;

  push(pkt: AudioPacket, onFrame: (f: WebRtcFrame) => void): void {
    const h = pkt.header;
    const formatChanged = h.sampleRate !== this.rate || h.numChannels !== this.channels;
    const discontinuity = (h.flags & AUDIO_FLAGS.DISCONTINUITY) !== 0;
    if (formatChanged || discontinuity) {
      this.leftover = new Int16Array(0); // drop partial frame — never bridge a gap
      this.rate = h.sampleRate;
      this.channels = h.numChannels;
    }
    const perChannel = framesPerChannel10ms(this.rate);
    const frameLen = perChannel * this.channels;

    let all: Int16Array;
    if (this.leftover.length === 0) {
      all = pkt.samples;
    } else {
      all = new Int16Array(this.leftover.length + pkt.samples.length);
      all.set(this.leftover, 0);
      all.set(pkt.samples, this.leftover.length);
    }

    let off = 0;
    while (all.length - off >= frameLen) {
      onFrame({
        samples: all.subarray(off, off + frameLen),
        sampleRate: this.rate,
        channelCount: this.channels,
        framesPerChannel: perChannel,
      });
      off += frameLen;
    }
    this.leftover = all.subarray(off).slice(); // copy: don't pin the big buffer
  }
}
