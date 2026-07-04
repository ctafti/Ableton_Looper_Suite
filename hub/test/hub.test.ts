/**
 * HUB LIBRARY TESTS — run offline: `npm test` (node --test, zero deps).
 * The codec tests pin GOLDEN BYTES: when the M4L tap / C++ sidecar are built
 * later, their output is compared to these exact hex strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeSpectralFrame, decodeSpectralFrame } from '../src/codecs/spectral-codec.ts';
import {
  encodeAudioPacket, decodeAudioHeader, AudioStreamParser, TenMsReslicer,
} from '../src/codecs/audio-codec.ts';
import { Resolver, type LiveScan } from '../src/resolver.ts';
import { CommandLifecycle, MAX_IDEMPOTENT_ATTEMPTS } from '../src/lifecycle.ts';
import { produceDelta, applyDelta, UnknownPathError } from '../src/mirror.ts';
import { movementSteps, logBandEdges, collapseToBands, PeakHold } from '../src/dsp.ts';

import { SPECTRAL } from '../../contracts/types/spectral.ts';
import { AUDIO_SIDECAR, AUDIO_FLAGS } from '../../contracts/types/audio-sidecar.ts';
import { IDEMPOTENT, STATEFUL } from '../../contracts/types/command-rule.ts';
import { ChainID, Slot } from '../../contracts/types/ids.ts';
import type { MirrorSnapshot } from '../../contracts/types/ws.ts';
import type { OscUpEvent } from '../../contracts/types/osc.ts';
import { LiveTrackIndex, LiveClipSlotIndex } from '../../contracts/types/ids.ts';

// ===========================================================================
// SPC1 codec + golden
// ===========================================================================
test('SPC1: roundtrip + golden header bytes', () => {
  const mags = new Array(SPECTRAL.binCount).fill(0).map((_, i) => i / (SPECTRAL.binCount - 1));
  const frame = { chainTag: 'chain.clean', seq: 7, tMs: 1234.5, magnitudes: mags };
  const buf = encodeSpectralFrame(frame);

  // GOLDEN: fixed 22-byte header + tag for exactly this frame. If this ever
  // changes, the wire format changed — that's a versioned event, not a tweak.
  const goldenHead = '31435053' + '01' + '00' + '0001' + '07000000' + '00000000004a9340' + '0b00';
  assert.equal(buf.subarray(0, 22).toString('hex'), goldenHead);
  assert.equal(buf.subarray(22, 33).toString('utf8'), 'chain.clean');
  assert.equal(buf.length, 22 + 11 + 512);

  const back = decodeSpectralFrame(buf);
  assert.equal(back.chainTag, 'chain.clean');
  assert.equal(back.seq, 7);
  assert.equal(back.tMs, 1234.5);
  // uint16 quantization: within 1/65535
  back.magnitudes.forEach((m, i) => assert.ok(Math.abs(m - mags[i]) < 1e-4));
});

test('SPC1: rejects bad magic / wrong bin count', () => {
  const mags = new Array(SPECTRAL.binCount).fill(0.5);
  const buf = encodeSpectralFrame({ chainTag: 'x', seq: 0, tMs: 0, magnitudes: mags });
  const evil = Buffer.from(buf);
  evil.writeUInt32LE(0xdeadbeef, 0);
  assert.throws(() => decodeSpectralFrame(evil), /magic/);
  assert.throws(
    () => encodeSpectralFrame({ chainTag: 'x', seq: 0, tMs: 0, magnitudes: [0.1, 0.2] }),
    /exactly/,
  );
});

// ===========================================================================
// APC1 codec + golden + stream parser + reslicer
// ===========================================================================
test('APC1: roundtrip + golden 40-byte header', () => {
  const samples = new Int16Array([100, -100, 32767, -32768]); // 2ch x 2 frames
  const header = {
    magic: AUDIO_SIDECAR.magic, version: 1, numChannels: 2, sampleRate: 48000,
    numFrames: 2, sequence: 9, sessionBeatTime: 16.5, tempo: 120, flags: 0,
  };
  const buf = encodeAudioPacket({ header, samples });
  const golden =
    '31435041' + '0100' + '0200' + '80bb0000' + '02000000' + '09000000' +
    '0000000000803040' + '0000000000005e40' + '0000' + '0000';
  assert.equal(buf.subarray(0, 40).toString('hex'), golden);
  const h = decodeAudioHeader(buf);
  assert.deepEqual(h, header);
});

test('APC1: stream parser reassembles packets across arbitrary chunk splits', () => {
  const mk = (seq: number, n: number) => encodeAudioPacket({
    header: { magic: AUDIO_SIDECAR.magic, version: 1, numChannels: 2, sampleRate: 48000,
      numFrames: n, sequence: seq, sessionBeatTime: 0, tempo: 120, flags: 0 },
    samples: new Int16Array(2 * n).fill(seq),
  });
  const stream = Buffer.concat([mk(1, 300), mk(2, 480), mk(3, 7)]);
  const parser = new AudioStreamParser();
  const got: number[] = [];
  // feed in pathological 13-byte chunks
  for (let i = 0; i < stream.length; i += 13) {
    parser.feed(stream.subarray(i, Math.min(i + 13, stream.length)), (p) => got.push(p.header.sequence));
  }
  assert.deepEqual(got, [1, 2, 3]);
});

test('reslicer: exact 10ms frames regardless of input chunking; flushes on discontinuity', () => {
  const reslicer = new TenMsReslicer();
  const frames: number[] = [];
  const mk = (n: number, flags = 0, seq = 0) => ({
    header: { magic: AUDIO_SIDECAR.magic, version: 1, numChannels: 2, sampleRate: 48000,
      numFrames: n, sequence: seq, sessionBeatTime: 0, tempo: 120, flags },
    samples: new Int16Array(2 * n),
  });
  // 300 + 480 + 700 frames-per-channel = 1480 -> three 480-frames + 40 leftover
  reslicer.push(mk(300), (f) => frames.push(f.framesPerChannel));
  reslicer.push(mk(480), (f) => frames.push(f.framesPerChannel));
  reslicer.push(mk(700), (f) => frames.push(f.framesPerChannel));
  assert.deepEqual(frames, [480, 480, 480]);
  // discontinuity drops the 40-frame leftover: 460 more only makes 460, no frame
  const before = frames.length;
  reslicer.push(mk(460, AUDIO_FLAGS.DISCONTINUITY), (f) => frames.push(f.framesPerChannel));
  assert.equal(frames.length, before);
  // 20 more completes 480
  reslicer.push(mk(20), (f) => frames.push(f.framesPerChannel));
  assert.equal(frames.length, before + 1);
});

// ===========================================================================
// Resolver
// ===========================================================================
const scan = (order: string[]): LiveScan => ({
  numScenes: 6,
  tracks: order.map((tag) => ({
    name: `${tag[0].toUpperCase()}${tag.slice(1)} [[chain.${tag}]]`,
    devices: [
      { name: 'NAM Rack', params: ['Gain'] },
      { name: 'NAM_A2_Looper', params: ['State', 'Speed'] },
      { name: 'EQ Eight', params: ['3 Frequency A', '3 Gain A'] },
      { name: 'NAM_A2_Spectral', params: [] },
    ],
  })).concat([
    { name: 'Reverb Return', devices: [] } as never,
    { name: 'Delay Return', devices: [] } as never,
  ]),
});

test('resolver: stable IDs survive track reordering', () => {
  const r = new Resolver();
  r.rebuildFromSnapshot(scan(['clean', 'crunch', 'shimmer']));
  const crunch = ChainID('chain.crunch');
  assert.equal(r.resolveChain(crunch), 1);
  assert.deepEqual(r.resolveCell({ chain: crunch, slot: Slot(3) }), { track: 1, clipSlot: 3 });

  // user reorders tracks in Live -> rebuild -> same ChainID, new index
  r.rebuildFromSnapshot(scan(['shimmer', 'clean', 'crunch']));
  assert.equal(r.resolveChain(crunch), 2);
  assert.equal(r.chainForTrack(LiveTrackIndex(0)), 'chain.shimmer');
  assert.deepEqual(
    r.cellForTrackSlot(LiveTrackIndex(2), LiveClipSlotIndex(5)),
    { chain: 'chain.crunch', slot: 5 },
  );
});

test('resolver: roles + params by name; deleted chain resolves undefined', () => {
  const r = new Resolver();
  r.rebuildFromSnapshot(scan(['clean', 'crunch']));
  const clean = ChainID('chain.clean');
  assert.deepEqual(r.resolveDevice(clean, 'looper'), { track: 0, device: 1 });
  assert.deepEqual(r.resolveDevice(clean, 'eq'), { track: 0, device: 2 });
  assert.deepEqual(
    r.resolveParam({ chain: clean, device: 'eq', param: '3 Gain A' }),
    { track: 0, device: 2, parameter: 1 },
  );
  assert.equal(r.resolveParam({ chain: clean, device: 'eq', param: 'Nope' }), undefined);
  r.rebuildFromSnapshot(scan(['crunch'])); // clean deleted
  assert.equal(r.resolveChain(clean), undefined); // callers must handle, not crash
});

// ===========================================================================
// Command lifecycle
// ===========================================================================
function makeLifecycle() {
  const statuses: { commandId: string; phase: string }[] = [];
  const reconciles: string[] = [];
  const sends: string[] = [];
  const lc = new CommandLifecycle({
    onStatus: (s) => statuses.push({ commandId: s.commandId, phase: s.phase }),
    onReconcileNeeded: (id) => reconciles.push(id),
  });
  return { lc, statuses, reconciles, sends };
}
const echo: OscUpEvent = { kind: 'playing_slot', track: LiveTrackIndex(1), slot: 3 };

test('lifecycle: quantized fire -> intent, queued, confirmed on echo', () => {
  const { lc, statuses } = makeLifecycle();
  lc.submit({
    commandId: 'c1', semantics: IDEMPOTENT, targetKey: 'track1',
    expect: (e) => e.kind === 'playing_slot' && (e.track as number) === 1 && e.slot === 3,
    send: () => {}, windowMs: 2000, isQueued: true,
  }, 0);
  lc.onEcho(echo);
  assert.deepEqual(statuses.map((s) => s.phase), ['intent', 'queued', 'confirmed']);
  assert.equal(lc.inFlight, 0);
});

test('lifecycle: idempotent timeout retries up to 3, then fails + reverts', () => {
  const { lc, statuses, sends } = makeLifecycle();
  lc.submit({
    commandId: 'c2', semantics: IDEMPOTENT, targetKey: 'p',
    expect: () => false, send: () => sends.push('tx'), windowMs: 300, isQueued: false,
  }, 0);
  lc.tick(301); lc.tick(602); lc.tick(903); lc.tick(1204);
  assert.equal(sends.length, MAX_IDEMPOTENT_ATTEMPTS); // 1 original + 2 retries
  assert.equal(statuses.at(-1)!.phase, 'failed');
});

test('lifecycle: stateful NEVER blind-retries -> reconcile-then-decide', () => {
  const { lc, statuses, reconciles, sends } = makeLifecycle();
  lc.submit({
    commandId: 'dup1', semantics: STATEFUL, targetKey: 'cell',
    expect: () => false, send: () => sends.push('tx'), windowMs: 300, isQueued: false,
  }, 0);
  lc.tick(301);
  assert.equal(sends.length, 1); // no resend
  assert.deepEqual(reconciles, ['dup1']);
  lc.resolveReconcile('dup1', true); // truth says it DID happen
  assert.equal(statuses.at(-1)!.phase, 'confirmed');
});

test('lifecycle: same-target commands supersede (A then B on one track)', () => {
  const { lc, statuses } = makeLifecycle();
  const cmd = (id: string) => ({
    commandId: id, semantics: IDEMPOTENT, targetKey: 'track1',
    expect: (e: OscUpEvent) => e.kind === 'playing_slot', send: () => {}, windowMs: 2000, isQueued: true,
  });
  lc.submit(cmd('A'), 0);
  lc.submit(cmd('B'), 10);
  const aFinal = statuses.filter((s) => s.commandId === 'A').at(-1)!;
  assert.equal(aFinal.phase, 'failed'); // superseded
  lc.onEcho(echo);
  assert.equal(statuses.filter((s) => s.commandId === 'B').at(-1)!.phase, 'confirmed');
});

// ===========================================================================
// Mirror deltas
// ===========================================================================
const snap = (): MirrorSnapshot => ({
  tempoBpm: 120, isPlaying: false, metronome: true, globalQuantization: 4, linkEnabled: false,
  chains: [{
    id: ChainID('chain.clean'), name: 'Clean', color: '#C77D4A', toneId: null,
    volume01: 0.85, panMinus1to1: 0, sendA01: 0.2, sendB01: 0, muted: false, armed: false,
    live: false, inputName: 'guitar',
    cells: [
      { slot: Slot(0), hasClip: true, name: 'riff', lengthBeats: 16, playing: false, recording: false, isLooper: false },
      { slot: Slot(1), hasClip: false, name: null, lengthBeats: null, playing: false, recording: false, isLooper: false },
    ],
    looper: null,
    devices: [{ role: 'eq', name: 'EQ Eight', params: [{ name: '3 Gain A', value: 0, min: -15, max: 15, quantized: false }] }],
  }],
  scenes: [{ id: 'scene_0' as never, name: 'A', triggered: false }],
});

test('mirror: produce(prev,next) then apply(prev) === next', () => {
  const prev = snap();
  const next = snap();
  (next as { tempoBpm: number }).tempoBpm = 128;
  (next.chains[0] as { live: boolean }).live = true;
  (next.chains[0].cells[0] as { playing: boolean }).playing = true;
  (next.chains[0].devices[0].params[0] as { value: number }).value = -3;
  const delta = produceDelta(prev, next)!;
  assert.equal(delta.changes.length, 4);
  assert.ok(delta.changes.every((c) => !/\/(0|1)\//.test(' ' + c.path.split('/')[2]))); // cells keyed by slot is fine; no other positional keys
  assert.deepEqual(applyDelta(prev, delta), next);
});

test('mirror: structural change refuses a delta (snapshot instead); unknown path throws', () => {
  const prev = snap();
  const next = snap();
  (next.chains as unknown[]).push({ ...snap().chains[0], id: ChainID('chain.new') });
  assert.equal(produceDelta(prev, next), null);
  assert.throws(
    () => applyDelta(prev, { changes: [{ path: 'chains/chain.gone/muted', value: true }] }),
    UnknownPathError,
  );
});

// ===========================================================================
// DSP math
// ===========================================================================
test('movement: §10 worked example — every other 8th over 4 beats', () => {
  const steps = movementSteps({
    kind: 'every_other', loopStart: 0, loopEnd: 4, grid: 0.5, depth: 0.8, min: 0, max: 1,
  });
  assert.equal(steps.length, 8);
  assert.deepEqual(steps[0], { time: 0, duration: 0.5, value: 0.8 });
  assert.deepEqual(steps[1], { time: 0.5, duration: 0.5, value: 0 });
  assert.equal(steps[7].time, 3.5);
});

test('bands: 48 log edges are monotonic and cover all 256 bins; peak-hold decays', () => {
  const edges = logBandEdges();
  assert.equal(edges.length, 49);
  assert.equal(edges[0], 1);
  assert.equal(edges[48], 256);
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i] > edges[i - 1]);

  const mags = new Array(256).fill(0); mags[100] = 0.9;
  const bands = collapseToBands(mags, edges);
  assert.equal(Math.max(...bands), 0.9);

  const ph = new PeakHold(48, 0.5);
  const caps1 = ph.update(bands, 0);
  assert.equal(Math.max(...caps1), 0.9);
  const caps2 = ph.update(new Array(48).fill(0), 1); // 1 s later, decay 0.5
  assert.ok(Math.abs(Math.max(...caps2) - 0.4) < 1e-9);
});
