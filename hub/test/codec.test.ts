import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { encodeSpectralFrame, decodeSpectralFrame } from '../src/codec/spectral-codec.ts';
import {
  encodeAudioPacket,
  decodeAudioPacket,
  StreamFramer,
  TenMsReslicer,
} from '../src/codec/audio-codec.ts';
import { SPECTRAL } from '../../contracts/types/spectral.ts';
import { AUDIO_SIDECAR } from '../../contracts/types/audio-sidecar.ts';

const GOLDEN = new URL('../golden/', import.meta.url).pathname;

// Deterministic fixture data
const mags = Array.from({ length: SPECTRAL.binCount }, (_, i) => (i % 100) / 100);
const spectralFixture = { chainTag: 'chain.clean', seq: 42, tMs: 1234.5, magnitudes: mags };

const audioSamples = Int16Array.from({ length: 2 * 240 }, (_, i) => ((i * 37) % 65536) - 32768);
const audioFixture = {
  header: {
    magic: AUDIO_SIDECAR.magic, version: 1, numChannels: 2, sampleRate: 48000,
    numFrames: 240, sequence: 7, sessionBeatTime: 16.25, tempo: 92.5, flags: 0,
  },
  samples: audioSamples,
};

test('golden vectors exist and are byte-stable', () => {
  mkdirSync(GOLDEN, { recursive: true });
  const spc = encodeSpectralFrame(spectralFixture);
  const apc = encodeAudioPacket(audioFixture);
  const spcPath = GOLDEN + 'spectral-frame.spc1.bin';
  const apcPath = GOLDEN + 'audio-packet.apc1.bin';
  if (!existsSync(spcPath)) writeFileSync(spcPath, spc);
  if (!existsSync(apcPath)) writeFileSync(apcPath, apc);
  // If either of these ever fails, the codec CHANGED — that is a frozen-
  // contract break and must be a deliberate versioned change, never a drift.
  assert.deepEqual(spc, readFileSync(spcPath), 'SPC1 bytes drifted from golden');
  assert.deepEqual(apc, readFileSync(apcPath), 'APC1 bytes drifted from golden');
});

test('SPC1 round-trips exactly (u16 quantization aside)', () => {
  const decoded = decodeSpectralFrame(encodeSpectralFrame(spectralFixture));
  assert.equal(decoded.chainTag, 'chain.clean');
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.tMs, 1234.5);
  for (let i = 0; i < SPECTRAL.binCount; i++) {
    assert.ok(Math.abs(decoded.magnitudes[i] - mags[i]) < 1 / 65535 + 1e-9, `bin ${i}`);
  }
});

test('SPC1 rejects malformed datagrams', () => {
  const good = encodeSpectralFrame(spectralFixture);
  assert.throws(() => decodeSpectralFrame(good.subarray(0, 10)));
  const badMagic = Buffer.from(good);
  badMagic.writeUInt32LE(0xdeadbeef, 0);
  assert.throws(() => decodeSpectralFrame(badMagic));
  assert.throws(() => decodeSpectralFrame(good.subarray(0, good.length - 2)));
});

test('APC1 round-trips exactly', () => {
  const decoded = decodeAudioPacket(encodeAudioPacket(audioFixture));
  assert.deepEqual(decoded.header, audioFixture.header);
  assert.deepEqual([...decoded.samples], [...audioSamples]);
});

test('StreamFramer reassembles packets across arbitrary chunk boundaries', () => {
  const wire = Buffer.concat([encodeAudioPacket(audioFixture), encodeAudioPacket({
    ...audioFixture, header: { ...audioFixture.header, sequence: 8 },
  })]);
  const framer = new StreamFramer();
  const got: number[] = [];
  // feed in awkward 7-byte chunks (TCP gives you whatever it wants)
  for (let i = 0; i < wire.length; i += 7) {
    for (const pkt of framer.push(wire.subarray(i, Math.min(i + 7, wire.length)))) {
      got.push(pkt.header.sequence);
    }
  }
  assert.deepEqual(got, [7, 8]);
});

test('TenMsReslicer emits exact 480-sample-per-channel frames at 48k', () => {
  const reslicer = new TenMsReslicer();
  const frames: number[] = [];
  // Link sends "natural buffer sizes" — simulate 3 packets of 240 fr/ch (5 ms)
  for (let seq = 0; seq < 3; seq++) {
    const pkt = {
      header: { ...audioFixture.header, sequence: seq },
      samples: Int16Array.from({ length: 2 * 240 }, (_, i) => seq * 1000 + i),
    };
    for (const f of reslicer.push(pkt)) frames.push(f.samples.length);
  }
  // 3 x 5ms = 15ms -> exactly ONE 10ms frame out (960 interleaved), 5ms held
  assert.deepEqual(frames, [2 * 480]);
});

test('TenMsReslicer drops its partial on a discontinuity (never glues across an xrun)', () => {
  const reslicer = new TenMsReslicer();
  reslicer.push({ header: { ...audioFixture.header }, samples: Int16Array.from({ length: 2 * 240 }, () => 1) });
  const after = reslicer.push({
    header: { ...audioFixture.header, flags: 1 }, // DISCONTINUITY
    samples: Int16Array.from({ length: 2 * 480 }, () => 2),
  });
  assert.equal(after.length, 1);
  assert.ok([...after[0].samples].every((s) => s === 2), 'pre-xrun samples must not leak into the frame');
});
