import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver, type LiveSnapshot } from '../src/resolver/resolver.ts';
import {
  CommandLifecycle,
  quantWindowMs,
  msToNextBoundary,
  type LifecycleEvents,
} from '../src/lifecycle/lifecycle.ts';
import { IDEMPOTENT, STATEFUL } from '../../contracts/types/command-rule.ts';
import { MirrorStore, MirrorClient } from '../src/mirror/mirror.ts';
import { gatePattern, rampPattern, depthToValue, stepsToArgs } from '../src/math/movement.ts';
import { makeBandMap, collapse, PeakHold, additiveSum } from '../src/math/bands.ts';
import { SPECTRAL } from '../../contracts/types/spectral.ts';
import { ChainID, Slot, LiveTrackIndex, LiveClipSlotIndex } from '../../contracts/types/ids.ts';
import type { MirrorSnapshot } from '../../contracts/types/ws.ts';

// ---------------------------------------------------------------------------
// RESOLVER
// ---------------------------------------------------------------------------
const devices = (names: string[]) => names.map((name) => ({ name, paramNames: ['Device On', 'Gain', 'State'] }));
const snap: LiveSnapshot = {
  tracks: [
    { name: 'Clean [[chain.clean]]', devices: devices(['NAM Rack', 'NAM_A2_Looper', 'EQ Eight', 'NAM_A2_Spectral']) },
    { name: 'Crunch [[chain.crunch]]', devices: devices(['Gateway', 'NAM_A2_Looper', 'Echo', 'EQ Eight', 'NAM_A2_Spectral']) },
    { name: 'A-Reverb', devices: devices(['Reverb']) }, // return: no [[tag]] -> not a chain
  ],
  numScenes: 6,
};

test('resolver: chains minted from tags; returns ignored; roles mapped', () => {
  const r = new Resolver();
  r.rebuildFromSnapshot(snap);
  assert.deepEqual(r.chainIds().map(String), ['chain_chain.clean', 'chain_chain.crunch']);
  const crunch = ChainID('chain_chain.crunch');
  assert.equal(r.resolveChain(crunch), 1);
  assert.equal(r.resolveDevice(crunch, 'amp')?.device, 0);
  assert.equal(r.resolveDevice(crunch, 'looper')?.device, 1);
  assert.equal(r.resolveDevice(crunch, 'inline_fx')?.device, 2, 'Echo sits between looper and eq');
  assert.equal(r.resolveDevice(crunch, 'eq')?.device, 3);
  assert.equal(r.resolveDevice(crunch, 'spectral')?.device, 4);
  // clean chain has NO inline device -> role absent, honestly
  assert.equal(r.resolveDevice(ChainID('chain_chain.clean'), 'inline_fx'), undefined);
});

test('resolver: IDs survive a reorder (THE point of Contract 1)', () => {
  const r = new Resolver();
  r.rebuildFromSnapshot(snap);
  const clean = ChainID('chain_chain.clean');
  assert.equal(r.resolveChain(clean), 0);
  // Live-side reorder: crunch now first
  r.rebuildFromSnapshot({ ...snap, tracks: [snap.tracks[1], snap.tracks[0], snap.tracks[2]] });
  assert.equal(r.resolveChain(clean), 1, 'same ChainID follows its track');
  // reverse lookup + cells + params still line up
  assert.equal(String(r.chainForTrack(LiveTrackIndex(1))), String(clean));
  assert.deepEqual(r.resolveCell({ chain: clean, slot: Slot(3) }), { track: 1, clipSlot: 3 });
  assert.equal(r.resolveParam({ chain: clean, device: 'amp', param: 'gain' })?.parameter, 1, 'param by name, case-insensitive');
  assert.equal(String(r.cellForTrackSlot(LiveTrackIndex(1), LiveClipSlotIndex(2))?.chain), String(clean));
});

// ---------------------------------------------------------------------------
// LIFECYCLE (fake clock)
// ---------------------------------------------------------------------------
function harness() {
  let now = 0;
  const log: string[] = [];
  const events: LifecycleEvents = {
    status: (id, phase, extra) => log.push(`${id}:${phase}${extra?.queuedForMs ? ':' + extra.queuedForMs : ''}${extra?.reason ? ':' + extra.reason : ''}`),
    resend: (id, attempt) => log.push(`${id}:resend${attempt}`),
    reconcile: (id) => log.push(`${id}:reconcile`),
  };
  const lc = new CommandLifecycle(events, () => now);
  return { lc, log, advance: (ms: number) => { now += ms; lc.tick(); } };
}

test('lifecycle: echo within window confirms', () => {
  const { lc, log, advance } = harness();
  lc.register({ commandId: 'c1', targetKey: 'slot:0', semantics: IDEMPOTENT, windowMs: 300, expect: (e) => e === 'echo-A' });
  advance(100);
  lc.onEcho('echo-A');
  assert.deepEqual(log, ['c1:sent', 'c1:confirmed']);
});

test('lifecycle: idempotent retries (max 3) then fails; stateful reconciles instead', () => {
  const { lc, log, advance } = harness();
  lc.register({ commandId: 'i', targetKey: 't1', semantics: IDEMPOTENT, windowMs: 100, expect: () => false });
  lc.register({ commandId: 's', targetKey: 't2', semantics: STATEFUL, windowMs: 100, expect: () => false });
  advance(101); advance(101); advance(101);
  assert.deepEqual(log, [
    'i:sent', 's:sent',
    'i:resend2', 's:reconcile',   // stateful NEVER blind-retries (Contract 8)
    'i:resend3',
    'i:failed:no echo within window',
  ]);
  assert.equal(lc.inFlight, 0);
});

test('lifecycle: same-target command supersedes the in-flight one', () => {
  const { lc, log } = harness();
  lc.register({ commandId: 'a', targetKey: 'slot:2', semantics: IDEMPOTENT, windowMs: 500, expect: (e) => e === 'A' });
  lc.register({ commandId: 'b', targetKey: 'slot:2', semantics: IDEMPOTENT, windowMs: 500, expect: (e) => e === 'B' });
  lc.onEcho('A'); // stale echo for superseded command must be ignored
  lc.onEcho('B');
  assert.deepEqual(log, ['a:sent', 'a:failed:superseded', 'b:sent', 'b:confirmed']);
});

test('lifecycle: queued phase carries the countdown; quant math is exact', () => {
  const { lc, log } = harness();
  // 120 bpm -> 500ms/beat; 1-bar quant (4 beats), position 1.5 beats in -> 2.5 beats = 1250ms
  assert.equal(msToNextBoundary(1.5, 4, 120), 1250);
  assert.equal(msToNextBoundary(8, 4, 120), 0, 'exactly on the boundary fires now');
  const w = quantWindowMs(1.5, 4, 120);
  assert.equal(w, 1650);
  lc.register({ commandId: 'q', targetKey: 'slot:5', semantics: IDEMPOTENT, windowMs: w, queuedForMs: 1250, expect: () => false });
  assert.deepEqual(log, ['q:sent', 'q:queued:1250']);
});

// ---------------------------------------------------------------------------
// MIRROR round trip
// ---------------------------------------------------------------------------
function tinySnapshot(): MirrorSnapshot {
  return {
    tempoBpm: 120, isPlaying: false, metronome: true, globalQuantization: 4, linkEnabled: false,
    chains: [{
      id: ChainID('chain_x'), name: 'X', color: '#C77D4A', toneId: null,
      volume01: 0.85, panMinus1to1: 0, sendA01: 0, sendB01: 0, muted: false, armed: false,
      live: false, inputName: 'guitar',
      cells: [{ slot: Slot(0), hasClip: true, name: 'take1', lengthBeats: 8, playing: false, recording: false, isLooper: false }],
      looper: null,
      devices: [{ role: 'amp', name: 'NAM Rack', params: [{ name: 'Gain', value: 0.4, min: 0, max: 1, quantized: false }] }],
    }],
    scenes: [{ id: 'scene_0' as never, name: 'A', triggered: false }],
  };
}

test('mirror: store deltas apply cleanly on the client; rev tracks by message', () => {
  const store = new MirrorStore(tinySnapshot());
  const client = new MirrorClient();
  assert.equal(client.applyMessage(store.snapshotMessage()), 'ok');
  const msgs = [
    store.setCell('chain_x', 0, 'playing', true),
    store.setChainField('chain_x', 'live', true),
    store.setParamValue('chain_x', 'amp', 'Gain', 0.7),
    store.setTop('isPlaying', true),
  ];
  for (const m of msgs) assert.equal(client.applyMessage(m), 'ok');
  assert.equal(client.snap!.chains[0].cells[0].playing, true);
  assert.equal(client.snap!.chains[0].live, true);
  assert.equal(client.snap!.chains[0].devices[0].params[0].value, 0.7);
  assert.equal(client.snap!.isPlaying, true);
  assert.equal(client.rev, store.revision);
});

test('mirror: a rev gap or unknown key demands resync', () => {
  const store = new MirrorStore(tinySnapshot());
  const client = new MirrorClient();
  client.applyMessage(store.snapshotMessage());
  store.setTop('isPlaying', true); // delta the client never sees
  const later = store.setTop('metronome', false);
  assert.equal(client.applyMessage(later), 'resync', 'gap detected');
  client.applyMessage(store.snapshotMessage()); // recover via snapshot
  const bad = { channel: 'state', type: 'delta', rev: store.revision + 1, payload: { changes: [{ path: 'chains/chain_GONE/muted', value: true }] } } as const;
  assert.equal(client.applyMessage(bad as never), 'resync', 'unknown stable ID = structural change missed');
});

// ---------------------------------------------------------------------------
// MATH
// ---------------------------------------------------------------------------
test('movement: §10 worked grid — every other 8th over a 4-beat loop', () => {
  const steps = gatePattern(0, 4, 0.5, depthToValue(0, 1, 0.8), 0);
  assert.equal(steps.length, 8);
  assert.deepEqual(steps[0], { time: 0, duration: 0.5, value: 0.8 });
  assert.deepEqual(steps[1], { time: 0.5, duration: 0.5, value: 0 });
  assert.deepEqual(steps[7], { time: 3.5, duration: 0.5, value: 0 });
  assert.equal(stepsToArgs(steps).length, 24);
});

test('movement: ramp hits its endpoints', () => {
  const steps = rampPattern(0, 4, 0.2, 1.0, 5);
  assert.equal(steps[0].value, 0.2);
  assert.equal(steps[4].value, 1.0);
  assert.ok(Math.abs(steps[0].duration - 0.8) < 1e-12);
});

test('bands: 48 log bands cover all 256 bins contiguously, monotonic, each >=1 bin', () => {
  const map = makeBandMap();
  assert.equal(map.ranges.length, 48);
  assert.equal(map.ranges[47][1], SPECTRAL.binCount);
  for (let i = 0; i < 48; i++) {
    const [a, b] = map.ranges[i];
    assert.ok(b > a, `band ${i} nonempty`);
    if (i > 0) assert.equal(a, map.ranges[i - 1][1], `band ${i} contiguous`);
  }
  // log spacing: last band spans more bins than the first
  assert.ok(map.ranges[47][1] - map.ranges[47][0] > map.ranges[0][1] - map.ranges[0][0]);
});

test('bands: collapse + peak-hold + additive sum behave', () => {
  const map = makeBandMap();
  const flat = collapse(new Array(SPECTRAL.binCount).fill(0.5), map);
  assert.ok(flat.every((v) => Math.abs(v - 0.5) < 1e-12));
  const ph = new PeakHold(48, 0.6);
  const caps1 = [...ph.update(flat, 0)];
  assert.equal(caps1[0], 0.5);
  const caps2 = ph.update(new Array(48).fill(0), 0.5); // 0.5s at 0.6/s decay -> 0.2
  assert.ok(Math.abs(caps2[0] - 0.2) < 1e-12);
  assert.equal(additiveSum([new Array(48).fill(0.7), new Array(48).fill(0.7)])[0], 1, 'clamped');
});
