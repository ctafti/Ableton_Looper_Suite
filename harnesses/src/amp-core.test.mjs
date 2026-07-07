/**
 * amp-core.test.mjs — exercises amp.js's PURE logic against the REAL models.json.
 *
 * This is the part of the amp that does NOT need Max/Live/neural~/a Mac, so it is
 * the part I can actually prove off-rig. Everything Max-specific (LiveAPI, Task,
 * File, outlets, the audio graph, prewarm, the crossfade, OSC readback, the
 * swap-click test) is rig-gated and covered by NAM_A2_Amp.build.md instead.
 *
 *   node amp-core.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const amp = require(join(here, 'amp.js'));

const manifestPath = join(here, 'models.json');
const manifestText = readFileSync(manifestPath, 'utf8');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  \u2713', name); };

console.log('amp.js pure-logic tests (against the real models.json)\n');

// --- manifest parse + validate ------------------------------------------------
const m = amp.validateManifest(amp.parseManifest(manifestText));
ok('real models.json parses + validates (version 1)', () => {
  assert.equal(m.version, 1);
  assert.equal(m.entries.length, 6);
});

// --- tombstone (index 0 was removed: file:null) -------------------------------
ok('index 0 resolves as tombstone (deleted tone, file:null) — device must NOT load', () => {
  const r = amp.resolveEntry(m, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tombstone');
});

// --- live entries 1..5 resolve to real .nam files -----------------------------
ok('indices 1..5 resolve to real .nam capture files', () => {
  for (let i = 1; i <= 5; i++) {
    const r = amp.resolveEntry(m, i);
    assert.equal(r.ok, true, `index ${i} should resolve`);
    assert.ok(amp.isNam(r.entry.file), `index ${i} file should be .nam (got ${r.entry.file})`);
  }
});

// --- missing index ------------------------------------------------------------
ok('unknown index (99) resolves as missing, not a crash', () => {
  const r = amp.resolveEntry(m, 99);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
});

// --- abspath build for a real entry (subfolder + spaces) ----------------------
ok('joinModelPath builds a correct absolute path (subfolder + spaces preserved)', () => {
  const dir = '/Users/x/Aibleton/Aibleton/models';
  const r = amp.resolveEntry(m, 1);
  const abs = amp.joinModelPath(dir, r.entry.file);
  assert.equal(
    abs,
    dir + '/Full Rig Peavey 5150 + Mesa 4x12/Full Rig Peavey 5150 MXR Mesa OS SM57 - jp_is_out_of_tune.nam',
  );
  assert.ok(!abs.includes('//'), 'no doubled slashes');
});

// --- resolveEntry matches on the index FIELD, not array position (append-only)-
ok('resolveEntry matches on index field, not array position (append-only safety)', () => {
  // A manifest whose array order does NOT match index order:
  const scrambled = { version: 1, entries: [
    { index: 5, file: 'e5.nam', name: 'five', toneId: null },
    { index: 2, file: 'e2.nam', name: 'two', toneId: null },
    { index: 0, file: null, name: 'gone', toneId: 1 },
  ]};
  amp.validateManifest(scrambled);
  assert.equal(amp.resolveEntry(scrambled, 2).entry.file, 'e2.nam');
  assert.equal(amp.resolveEntry(scrambled, 5).entry.file, 'e5.nam');
  assert.equal(amp.resolveEntry(scrambled, 0).reason, 'tombstone');
});

// --- info-outlet classification (verified vocabulary, handoff §9) -------------
ok('classifyInfo recognizes the verified neural~ info vocabulary', () => {
  assert.equal(amp.classifyInfo(['loaded', '/x.nam']).kind, 'loaded');
  assert.equal(amp.classifyInfo(['error', 'bad', 'file']).kind, 'error');
  assert.equal(amp.classifyInfo(['queued', '/x.nam']).kind, 'queued');
  assert.equal(amp.classifyInfo(['latency', 0]).kind, 'latency');
  assert.equal(amp.classifyInfo(['loudness', -2.83]).kind, 'loudness');
  assert.equal(amp.classifyInfo(['cleared']).kind, 'cleared');
  assert.equal(amp.classifyInfo(['bang']).kind, 'bang');
  assert.equal(amp.classifyInfo(['wat']).kind, 'unknown');
});

// --- Load OK decision: OBSERVED, never assumed --------------------------------
ok('loadOkFromSelector: loaded→1, error→0, queued→null(stay pending)', () => {
  assert.equal(amp.loadOkFromSelector('loaded'), 1);
  assert.equal(amp.loadOkFromSelector('error'), 0);
  assert.equal(amp.loadOkFromSelector('queued'), null);
  assert.equal(amp.loadOkFromSelector('latency'), null);
  assert.equal(amp.loadOkFromSelector('cleared'), null);
});

// --- validation rejects malformed manifests -----------------------------------
ok('validateManifest rejects malformed manifests (version / shape / entry)', () => {
  assert.throws(() => amp.validateManifest({ version: 2, entries: [] }), /version must be 1/);
  assert.throws(() => amp.validateManifest({ version: 1, entries: {} }), /must be an array/);
  assert.throws(() => amp.validateManifest({ version: 1, entries: [{ index: 'x', file: 'a' }] }), /non-number index/);
  assert.throws(() => amp.validateManifest({ version: 1, entries: [{ index: 0, file: 3 }] }), /bad file/);
  assert.throws(() => amp.parseManifest('{ not json'), /not valid JSON/);
});

// --- drop-and-Reload adoption (REV 2026-07-05) --------------------------------
ok('planAdoptions: appends only unknown root .nam files, append-only indices', () => {
  const found = [
    'Full Rig Peavey 5150 MXR Mesa OS SM57 - jp_is_out_of_tune.nam', // NOT in manifest at ROOT (manifest paths are in a subfolder) -> adopted
    'new_amp_b.nam', 'new_amp_a.nam', 'notes.txt', 'cover.png',
  ];
  const plan = amp.planAdoptions(m.entries, found);
  assert.equal(plan.length, 3);                       // txt/png ignored
  assert.deepEqual(plan.map(e => e.index), [6, 7, 8]); // continues after max index 5
  assert.equal(plan[0].file < plan[1].file, true);     // deterministic sorted order
  assert.equal(plan.every(e => e.toneId === null), true); // hub stays ToneID authority
  assert.equal(plan.every(e => !e.name.endsWith('.nam')), true);
});
ok('planAdoptions: already-manifested root files are NOT re-adopted; tombstones ignored', () => {
  const entries = [
    { index: 0, file: null, name: 'gone', toneId: 1 },
    { index: 3, file: 'kept.nam', name: 'kept', toneId: null },
  ];
  const plan = amp.planAdoptions(entries, ['kept.nam', 'fresh.nam']);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].file, 'fresh.nam');
  assert.equal(plan[0].index, 4); // max(0,3)+1, tombstone index respected
});
ok('planAdoptions: nothing new -> empty plan (Reload stays a pure re-read)', () => {
  assert.deepEqual(amp.planAdoptions(m.entries, []), []);
});

// --- three-level hierarchy (gear -> pack -> tone) ------------------------------
ok('splitEntryPath: Gear/Pack/file, legacy Pack/file -> Other, loose -> null', () => {
  assert.deepEqual(amp.splitEntryPath('Amp Head/Tweed/a.nam'), { gear: 'Amp Head', pack: 'Tweed' });
  assert.deepEqual(amp.splitEntryPath('Full Rig Peavey 5150 + Mesa 4x12/x.nam'),
                   { gear: 'Other', pack: 'Full Rig Peavey 5150 + Mesa 4x12' });
  assert.equal(amp.splitEntryPath('loose.nam'), null);
  assert.equal(amp.splitEntryPath(null), null);
});
const H = [
  { index: 0, file: null, name: 'gone' },
  { index: 1, file: 'stray.nam', name: 's' },
  { index: 2, file: 'Amp Head/Tweed/a.nam', name: 'a' },
  { index: 3, file: 'Amp Head/Tweed/b.nam', name: 'b' },
  { index: 4, file: 'Amp + Cab/JC/c.nam', name: 'c' },
  { index: 5, file: 'LegacyPack/d.nam', name: 'd' },
];
ok('gearsFrom: ordered unique gears; loose/tombstone skipped; legacy -> Other', () => {
  assert.deepEqual(amp.gearsFrom(H).map(g => g.label), ['Amp Head', 'Amp + Cab', 'Other']);
  assert.deepEqual(amp.gearsFrom(m.entries).map(g => g.label), ['Other']); // real manifest: 1-level Peavey
});
ok('packsInGear + tonesIn: scoped and ordered', () => {
  assert.deepEqual(amp.packsInGear(H, 'Amp Head'), [ { label: 'Tweed', firstIndex: 2 } ]);
  assert.deepEqual(amp.tonesIn(H, 'Amp Head', 'Tweed').map(t => t.index), [2, 3]);
  assert.deepEqual(amp.tonesIn(m.entries, 'Other', 'Full Rig Peavey 5150 + Mesa 4x12').map(t => t.index),
                   [1,2,3,4,5]);
});
ok('entryPlace: index -> {gear,pack}; loose/tombstone/missing -> null (truthful-DI trigger)', () => {
  assert.deepEqual(amp.entryPlace(H, 4), { gear: 'Amp + Cab', pack: 'JC' });
  assert.equal(amp.entryPlace(H, 1), null);  // loose
  assert.equal(amp.entryPlace(H, 0), null);  // tombstone
  assert.equal(amp.entryPlace(H, 99), null); // missing
});
ok('planAdoptions: depth-2 paths adopt intact', () => {
  const plan = amp.planAdoptions(m.entries, ['Amp Head/Tweed/a.nam', 'root.nam']);
  assert.deepEqual(plan.map(e => e.file), ['Amp Head/Tweed/a.nam', 'root.nam']);
  assert.equal(plan[0].name, 'a');
});

ok('reloadManifest BOOTSTRAPS an empty manifest when none exists (deleted-models.json bug)', () => {
  // In this env the disk read fails (no readable models.json path), so the
  // instantiation-time reloadManifest() had no text and NO manifest in memory —
  // exactly the user's state after deleting models.json. Before the fix that
  // left _manifest null and Reload a no-op forever; now it bootstraps empty.
  assert.deepEqual(amp._getManifest(), { version: 1, entries: [] });
  // and a subsequent failed read must KEEP the in-memory manifest (return false)
  assert.equal(amp.reloadManifest(), false);
  assert.deepEqual(amp._getManifest(), { version: 1, entries: [] });
});

console.log(`\n${pass}/${pass} pure-logic checks passed.`);
console.log('(Max/Live/neural~/OSC/swap-click behavior is rig-gated — see NAM_A2_Amp.build.md.)');
