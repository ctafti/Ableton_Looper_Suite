/**
 * looper-core.test.mjs — exercises looper.js v2's PURE logic off-rig.
 *
 * This is the part of the looper that does NOT need Max/Live/a Mac. Everything
 * Max-specific (LiveAPI observers, the echo path, Tasks, the injected signal
 * graph, snapshot~ timing, the buttons' set-without-output behavior) is
 * rig-gated and covered by harness 04 + the v2 human test instead.
 *
 *   node looper-core.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// works from devgen/ (looper.js beside it) OR from harnesses/src/ (repo layout)
const candidates = [join(here, 'looper.js'), join(here, '..', '..', 'devgen', 'looper.js')];
const srcPath = candidates.find(p => { try { readFileSync(p); return true; } catch { return false; } });
if (!srcPath) throw new Error('looper.js not found beside test or in ../../devgen');
// Copy to a .cjs temp file: `.cjs` is ALWAYS CommonJS, so looper.js's
// `module.exports` is honored even inside a "type":"module" project (where a
// bare `.js` would be loaded as ESM and export nothing). Keeps looper.js itself
// untouched and Max-compatible.
const tmpCjs = join(mkdtempSync(join(tmpdir(), 'looper-')), 'looper.cjs');
writeFileSync(tmpCjs, readFileSync(srcPath));
const L = require(tmpCjs);

const { STOP, PLAY, RECORD, OVERDUB } = L;
const SR = 48000;
const LEN = 96000; // a 2 s loop

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  \u2713', name); };
const get = (msgs, sel) => msgs.filter(m => m[0] === sel);
const one = (msgs, sel) => {
  const hits = get(msgs, sel);
  assert.equal(hits.length, 1, `expected exactly one "${sel}", got ${hits.length}`);
  return hits[0];
};
const none = (msgs, sel) =>
  assert.equal(get(msgs, sel).length, 0, `expected no "${sel}"`);

console.log('looper.js v2 pure-logic tests\n');

// --- state basics --------------------------------------------------------------
ok('clampState clamps to 0..3 and truncates', () => {
  assert.equal(L.clampState(-5), STOP);
  assert.equal(L.clampState(9), OVERDUB);
  assert.equal(L.clampState(2.9), 2);
});

ok('stateName matches R3 vocabulary exactly', () => {
  assert.deepEqual([0, 1, 2, 3].map(L.stateName),
    ['STOPPED', 'PLAYING', 'RECORDING', 'OVERDUB']);
});

// --- length capture ------------------------------------------------------------
ok('clampLen: negative -> 0, rounds, caps at the 60 s buffer', () => {
  assert.equal(L.clampLen(-100, SR), 0);
  assert.equal(L.clampLen(1000.4, SR), 1000);
  assert.equal(L.bufCapSamps(SR), 2880000);
  assert.equal(L.clampLen(99999999, SR), 2880000);
});

ok('needSnap fires exactly on leaving RECORD', () => {
  for (const t of [STOP, PLAY, OVERDUB]) assert.equal(L.needSnap(RECORD, t), true);
  assert.equal(L.needSnap(RECORD, RECORD), false);
  assert.equal(L.needSnap(PLAY, STOP), false);
  assert.equal(L.needSnap(STOP, RECORD), false);
});

ok('loopFreq: sr/len, and 0 (hold) for an empty loop', () => {
  assert.equal(L.loopFreq(LEN, SR), 0.5);
  assert.equal(L.loopFreq(0, SR), 0);
});

// --- dspPlan: RECORD -----------------------------------------------------------
ok('RECORD: counter reset, count-index, raw write, no overdub feedback, loop muted', () => {
  const m = L.dspPlan(STOP, RECORD, 0, SR);
  one(m, 'cnt');
  assert.deepEqual(one(m, 'srcsel'), ['srcsel', 1]);
  assert.deepEqual(one(m, 'wgate'), ['wgate', 1]);
  assert.deepEqual(one(m, 'wminus'), ['wminus', 0]);
  assert.deepEqual(one(m, 'ovd'), ['ovd', 0]);
  assert.deepEqual(one(m, 'play'), ['play', 0, 10]);
});

ok('re-RECORD over an existing loop is the same fresh-record plan', () => {
  assert.deepEqual(L.dspPlan(PLAY, RECORD, LEN, SR), L.dspPlan(STOP, RECORD, 0, SR));
});

// --- dspPlan: PLAY -------------------------------------------------------------
ok('PLAY from STOP restarts the loop: phasor index, freq sr/len, phase 0, gate open', () => {
  const m = L.dspPlan(STOP, PLAY, LEN, SR);
  assert.deepEqual(one(m, 'srcsel'), ['srcsel', 2]);
  assert.deepEqual(one(m, 'freq'), ['freq', 0.5]);
  assert.deepEqual(one(m, 'phase'), ['phase', 0]);
  assert.deepEqual(one(m, 'wgate'), ['wgate', 0]);   // no writing
  assert.deepEqual(one(m, 'wminus'), ['wminus', -1]); // poke~ index -> -1
  assert.deepEqual(one(m, 'play'), ['play', 1, 10]);
});

ok('PLAY from RECORD restarts at 0 too (seamless: record ended at len === wrap)', () => {
  const m = L.dspPlan(RECORD, PLAY, LEN, SR);
  one(m, 'phase'); one(m, 'freq');
});

ok('PLAY from OVERDUB keeps the loop running (no phase/freq touch)', () => {
  const m = L.dspPlan(OVERDUB, PLAY, LEN, SR);
  none(m, 'phase'); none(m, 'freq');
  assert.deepEqual(one(m, 'wgate'), ['wgate', 0]);
});

ok('PLAY with an empty loop is truthful silence (gate stays closed)', () => {
  const m = L.dspPlan(STOP, PLAY, 0, SR);
  assert.deepEqual(one(m, 'play'), ['play', 0, 10]);
  assert.deepEqual(one(m, 'freq'), ['freq', 0]);
});

// --- dspPlan: OVERDUB ----------------------------------------------------------
ok('OVERDUB from PLAY punches in without resetting the loop position', () => {
  const m = L.dspPlan(PLAY, OVERDUB, LEN, SR);
  assert.deepEqual(one(m, 'ovd'), ['ovd', 1]);       // write = input + read
  assert.deepEqual(one(m, 'wgate'), ['wgate', 1]);
  assert.deepEqual(one(m, 'wminus'), ['wminus', 0]);
  none(m, 'phase'); none(m, 'freq');
  assert.deepEqual(one(m, 'play'), ['play', 1, 10]);
});

ok('OVERDUB from STOP restarts the loop at 0', () => {
  const m = L.dspPlan(STOP, OVERDUB, LEN, SR);
  assert.deepEqual(one(m, 'phase'), ['phase', 0]);
  assert.deepEqual(one(m, 'freq'), ['freq', 0.5]);
});

ok('OVERDUB straight out of RECORD layers seamlessly from 0', () => {
  const m = L.dspPlan(RECORD, OVERDUB, LEN, SR);
  assert.deepEqual(one(m, 'phase'), ['phase', 0]);
  assert.deepEqual(one(m, 'ovd'), ['ovd', 1]);
});

ok('OVERDUB with no loop recorded writes nothing and plays nothing', () => {
  const m = L.dspPlan(STOP, OVERDUB, 0, SR);
  assert.deepEqual(one(m, 'wgate'), ['wgate', 0]);
  assert.deepEqual(one(m, 'wminus'), ['wminus', -1]);
  assert.deepEqual(one(m, 'play'), ['play', 0, 10]);
});

// --- dspPlan: STOP -------------------------------------------------------------
ok('STOP pauses (freq 0), closes both gates, keeps content (no clear)', () => {
  for (const prev of [PLAY, RECORD, OVERDUB]) {
    const m = L.dspPlan(prev, STOP, LEN, SR);
    assert.deepEqual(one(m, 'freq'), ['freq', 0]);
    assert.deepEqual(one(m, 'wgate'), ['wgate', 0]);
    assert.deepEqual(one(m, 'wminus'), ['wminus', -1]);
    assert.deepEqual(one(m, 'play'), ['play', 0, 10]);
    none(m, 'clear');
  }
});

// --- every (prev,target) pair yields a consistent, complete plan ---------------
ok('all 16 state pairs: write gate pair always consistent, play gate always present', () => {
  for (const p of [STOP, PLAY, RECORD, OVERDUB])
    for (const t of [STOP, PLAY, RECORD, OVERDUB]) {
      const m = L.dspPlan(p, t, LEN, SR);
      const w = one(m, 'wgate')[1], wm = one(m, 'wminus')[1];
      assert.equal(wm, w - 1, `wminus must be wgate-1 (${p}->${t})`);
      one(m, 'play');
      one(m, 'ovd');
    }
});

// --- clear ---------------------------------------------------------------------
ok('clearPlan wipes the buffer and zeroes length + phasor', () => {
  const m = L.clearPlan();
  one(m, 'clear');
  assert.deepEqual(one(m, 'len'), ['len', 0]);
  assert.deepEqual(one(m, 'freq'), ['freq', 0]);
});

// --- UI truth ------------------------------------------------------------------
const H0 = { u: false, r: false };
const HU = { u: true, r: false };   // can undo (hearing latest)
const HR = { u: false, r: true };   // can redo (hearing rolled-back take)

ok('uiPlan: exactly one lit button, matching the observed state', () => {
  const leds = ['ledstop', 'ledplay', 'ledrec', 'leddub'];
  for (const s of [STOP, PLAY, RECORD, OVERDUB]) {
    const m = L.uiPlan(s, LEN, SR, H0);
    const lit = leds.filter(sel => one(m, sel)[1] === 1);
    assert.equal(lit.length, 1);
    assert.equal(lit[0], leds[s]);
  }
});

ok('uiPlan status: empty marker, and loop length in seconds once a loop exists', () => {
  assert.equal(one(L.uiPlan(STOP, 0, SR, H0), 'status')[1], 'STOPPED \u00b7 empty');
  assert.equal(one(L.uiPlan(STOP, LEN, SR, H0), 'status')[1], 'STOPPED \u00b7 2.0 s');
  assert.equal(one(L.uiPlan(PLAY, LEN, SR, H0), 'status')[1], 'PLAYING \u00b7 2.0 s');
  assert.equal(one(L.uiPlan(OVERDUB, LEN, SR, H0), 'status')[1], 'OVERDUB \u00b7 2.0 s');
  // RECORDING never shows a stale length (the new one isn't known yet)
  assert.equal(one(L.uiPlan(RECORD, LEN, SR, H0), 'status')[1], 'RECORDING');
});

// --- v2.1: position bar ----------------------------------------------------------
ok('posFrac: loop position while playing, buffer-fill while recording, 0 when empty', () => {
  assert.equal(L.posFrac(48000, PLAY, LEN, L.bufCapSamps(SR)), 0.5);   // mid-loop
  assert.equal(L.posFrac(LEN, PLAY, LEN, L.bufCapSamps(SR)), 1);       // clamped at wrap
  assert.equal(L.posFrac(1440000, RECORD, 0, L.bufCapSamps(SR)), 0.5); // 30 s of 60 s
  assert.equal(L.posFrac(48000, STOP, 0, L.bufCapSamps(SR)), 0);       // empty -> 0
  assert.equal(L.posFrac(-5, PLAY, LEN, L.bufCapSamps(SR)), 0);        // clamped low
});

ok('posFrac while STOPPED with a loop holds the paused position', () => {
  assert.equal(L.posFrac(24000, STOP, LEN, L.bufCapSamps(SR)), 0.25);
});

// --- v2.1/v2.2: undo policy -------------------------------------------------------
ok('needUndoSave: entering a dub pass or re-record over an existing loop', () => {
  assert.equal(L.needUndoSave(PLAY, OVERDUB, LEN), true);
  assert.equal(L.needUndoSave(STOP, OVERDUB, LEN), true);
  assert.equal(L.needUndoSave(RECORD, OVERDUB, LEN), true);  // dub straight out of record
  assert.equal(L.needUndoSave(PLAY, RECORD, LEN), true);     // re-record replaces the loop
  assert.equal(L.needUndoSave(STOP, RECORD, LEN), true);
});

ok('needUndoSave: nothing to save with no loop; staying in a state never re-saves', () => {
  assert.equal(L.needUndoSave(STOP, OVERDUB, 0), false);   // empty loop
  assert.equal(L.needUndoSave(STOP, RECORD, 0), false);    // first record
  assert.equal(L.needUndoSave(OVERDUB, OVERDUB, LEN), false);
  assert.equal(L.needUndoSave(RECORD, RECORD, LEN), false);
  assert.equal(L.needUndoSave(OVERDUB, PLAY, LEN), false); // leaving a dub saves nothing
  assert.equal(L.needUndoSave(PLAY, STOP, LEN), false);
});

ok('histNext: save enables undo and invalidates redo; undo<->redo alternate', () => {
  let h = H0;
  h = L.histNext(h, 'save');   assert.deepEqual(h, HU);
  h = L.histNext(h, 'undo');   assert.deepEqual(h, HR);
  h = L.histNext(h, 'redo');   assert.deepEqual(h, HU);
  h = L.histNext(h, 'undo');   assert.deepEqual(h, HR);
  h = L.histNext(h, 'save');   assert.deepEqual(h, HU);  // new dub kills redo
});

ok('histNext: unavailable events are no-ops (a refused press changes nothing)', () => {
  assert.deepEqual(L.histNext(H0, 'undo'), H0);   // nothing saved yet
  assert.deepEqual(L.histNext(H0, 'redo'), H0);
  assert.deepEqual(L.histNext(HU, 'redo'), HU);   // hearing latest: no redo
  assert.deepEqual(L.histNext(HR, 'undo'), HR);   // already rolled back: no undo
});

ok('undo is NEVER a toggle: two undo presses do not redo (the v2.1 confusion)', () => {
  let h = L.histNext(H0, 'save');
  h = L.histNext(h, 'undo');
  h = L.histNext(h, 'undo');            // second press refused, NOT a redo
  assert.deepEqual(h, HR);
});

ok('swapOffered: only with its flag, and only while PLAY or STOP', () => {
  assert.equal(L.swapOffered(true, PLAY), true);
  assert.equal(L.swapOffered(true, STOP), true);
  assert.equal(L.swapOffered(true, RECORD), false);   // write gate open
  assert.equal(L.swapOffered(true, OVERDUB), false);  // write gate open
  assert.equal(L.swapOffered(false, PLAY), false);
});

ok('takeText tells you what you are hearing', () => {
  assert.equal(L.takeText(HU), 'take: current');
  assert.equal(L.takeText(HR), 'take: undone');
  assert.equal(L.takeText(H0), ' ');                  // no history -> blank
});

ok('uiPlan greys/un-greys Undo and Redo independently, and sets the indicator', () => {
  let m = L.uiPlan(PLAY, LEN, SR, HU);
  assert.deepEqual(one(m, 'uact'), ['uact', 1]);
  assert.deepEqual(one(m, 'ract'), ['ract', 0]);
  assert.deepEqual(one(m, 'uind'), ['uind', 'take: current']);
  m = L.uiPlan(PLAY, LEN, SR, HR);
  assert.deepEqual(one(m, 'uact'), ['uact', 0]);
  assert.deepEqual(one(m, 'ract'), ['ract', 1]);
  assert.deepEqual(one(m, 'uind'), ['uind', 'take: undone']);
  m = L.uiPlan(OVERDUB, LEN, SR, HU);                 // write gate open: both grey
  assert.deepEqual(one(m, 'uact'), ['uact', 0]);
  assert.deepEqual(one(m, 'ract'), ['ract', 0]);
  m = L.uiPlan(PLAY, LEN, SR, H0);
  assert.deepEqual(one(m, 'uind'), ['uind', ' ']);
});

// --- buttons -------------------------------------------------------------------
ok('button map: rec/play/dub/stop -> states; any click value is an intent', () => {
  assert.equal(L.btnIntent('btnrec', 1), RECORD);
  assert.equal(L.btnIntent('btnrec', 0), RECORD);   // click on the lit button
  assert.equal(L.btnIntent('btnplay', 1), PLAY);
  assert.equal(L.btnIntent('btndub', 0), OVERDUB);
  assert.equal(L.btnIntent('btnstop', 1), STOP);
});

ok('v2.3: clear/undo/redo accept ANY value — the alternating-toggle regression', () => {
  // THE BUG (rig, 2026-07-08): the widgets emit ONE event per click with
  // alternating value 1,0,1,0; v2.2's nonzero filter ate every second press.
  for (const v of [1, 0]) {
    assert.equal(L.btnIntent('btnclear', v), 'clear');
    assert.equal(L.btnIntent('btnundo', v), 'undo');
    assert.equal(L.btnIntent('btnredo', v), 'redo');
  }
});

ok('v2.3: one-shot buttons get un-latched after every press; transports do not', () => {
  assert.deepEqual(L.btnResetMsg('btnclear'), ['cset', 0]);
  assert.deepEqual(L.btnResetMsg('btnundo'), ['uset', 0]);
  assert.deepEqual(L.btnResetMsg('btnredo'), ['rset', 0]);
  for (const sel of ['btnrec', 'btnplay', 'btndub', 'btnstop'])
    assert.equal(L.btnResetMsg(sel), null);   // their latch IS the highlight
});

ok('unknown selectors are ignored', () => {
  assert.equal(L.btnIntent('btnwat', 1), null);
});

console.log(`\nall ${pass} tests passed`);
