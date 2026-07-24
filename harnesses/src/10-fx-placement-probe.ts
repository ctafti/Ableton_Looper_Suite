/**
 * 10-fx-placement-probe.ts — the two UNKNOWNS behind the FX side panel
 * (owner decision 2026-07-24: leverage stock Live devices as the FX chain):
 *
 *   1. WHERE does `/live/browser/load_item` (frozen since Phase 1, Seam 2)
 *      insert a device on a track that already has a chain? (end? selection?)
 *   2. Does `/live/track/delete_device [t, d]` exist and act?
 *
 * READ-ONLY (default): lists the target track's devices, queries the browser
 * for the five curated FX and prints the URIs (index freshness check).
 * MUTATING (CONFIRM=yes): loads a Compressor onto TRACK (default 0), observes
 * the resulting device LIST + POSITION, then deletes exactly the device it
 * added (verified by name at that index first), and confirms the list is back.
 *
 * Rig server DOWN (binds 11001). Live open on the dev Set.
 *
 *   node --experimental-strip-types src/10-fx-placement-probe.ts
 *   CONFIRM=yes TRACK=0 node --experimental-strip-types src/10-fx-placement-probe.ts
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

const TRACK = Number(process.env.TRACK ?? 0);
const MUTATE = process.env.CONFIRM === 'yes';
const QUERIES = ['Compressor', 'Pedal', 'Delay', 'Reverb', 'Chorus-Ensemble'];

async function ask(c: OscClient, address: string, args: (number | string)[], matchAddr = address, timeoutMs = 3000): Promise<OscMessage | null> {
  c.send(address, args);
  try { return await c.waitFor((m) => m.address === matchAddr, timeoutMs); } catch { return null; }
}

async function deviceNames(c: OscClient): Promise<string[] | null> {
  const r = await ask(c, '/live/track/get/devices/name', [TRACK]);
  return r ? r.args.slice(1).map(String) : null;
}

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  c.onMessage((m) => { if (m.address === '/live/error') console.log(`  [/live/error] ${m.args.map(String).join(' ')}`); });
  try {
    console.log('--- PHASE A: read-only ---');
    const before = await deviceNames(c);
    if (!before) { console.log('NO ANSWER — Live + engine up? rig stopped?'); rigHint(); return; }
    console.log(`track ${TRACK} devices: ${before.map((n, i) => `[${i}] ${n}`).join('  ')}`);

    // Build the index OURSELVES first (get-uri pattern: the reply address was
    // never pinned in Phase 1, so match ANY browser* address; first rescan can
    // take several seconds while the engine walks the whole browser tree).
    console.log('rescanning browser index (first build can take a while)…');
    c.send('/live/browser/rescan', []);
    try {
      const scan = await c.waitFor((m) => m.address.includes('browser') && m.address.includes('rescan'), 20000);
      console.log(`index reply on ${scan.address}: [${scan.args.join(', ')}]`);
    } catch { console.log('no rescan reply in 20s — querying anyway (index may already exist)'); }

    const uris: Record<string, string | null> = {};
    for (const q of QUERIES) {
      c.send('/live/browser/query', [q, 3]);
      let r: OscMessage | null = null;
      try { r = await c.waitFor((m) => m.address.includes('browser') && !m.address.includes('rescan'), 6000); } catch { r = null; }
      const strings = r ? r.args.filter((a): a is string => typeof a === 'string') : [];
      const uri = strings.find((x) => x.includes('#') || x.startsWith('query:')) ?? null;
      uris[q] = uri;
      console.log(`query "${q}": ${r ? `reply on ${r.address}, args [${r.args.join(', ')}] -> uri ${uri}` : 'NO ANSWER'}`);
    }

    if (!MUTATE) { console.log('\nREAD-ONLY done. CONFIRM=yes to run the load/position/delete probe.'); return; }

    console.log('\n--- PHASE B: load + position ---');
    const uri = uris['Compressor'];
    if (!uri) { console.log('no Compressor URI — cannot probe load'); return; }
    c.send('/live/browser/load_item', [TRACK, uri]);
    let after: string[] | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      after = await deviceNames(c);
      if (after && after.length === before.length + 1) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!after || after.length !== before.length + 1) { console.log(`VERDICT: load did NOT act (count ${after?.length ?? '?'})`); return; }
    const pos = after.findIndex((n, i) => n !== before[i]);
    const landedAt = pos < 0 ? after.length - 1 : pos;
    console.log(`loaded "${after[landedAt]}" — LANDED AT INDEX ${landedAt} of ${after.length} (fixtures were 0..${before.length - 1})`);
    console.log(`list now: ${after.map((n, i) => `[${i}] ${n}`).join('  ')}`);

    console.log('\n--- PHASE C: delete_device ---');
    const verify = await ask(c, '/live/track/get/devices/name', [TRACK]);
    const names = verify ? verify.args.slice(1).map(String) : [];
    if (!/compressor/i.test(names[landedAt] ?? '')) { console.log(`REFUSING delete: index ${landedAt} reads "${names[landedAt]}" — remove by hand`); return; }
    c.send('/live/track/delete_device', [TRACK, landedAt]);
    let final: string[] | null = null;
    const d2 = Date.now() + 6000;
    while (Date.now() < d2) {
      final = await deviceNames(c);
      if (final && final.length === before.length) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!final || final.length !== before.length) { console.log('VERDICT: delete_device did NOT act — remove the Compressor by hand in Live'); return; }
    const intact = final.every((n, i) => n === before[i]);
    console.log(`delete ACTED — original device list intact: ${intact ? 'YES' : 'NO — compare above!'}`);

    console.log('\n--- PHASE D: selected_device placement candidate (the PRE question) ---');
    // If a device can be SELECTED first, load_item may insert AFTER it (Live's
    // browser behavior) — that would unlock pre-amp placement. Unprobed address:
    c.send('/live/view/set/selected_device', [TRACK, 0]); // select the amp
    await new Promise((r) => setTimeout(r, 500));
    c.send('/live/browser/load_item', [TRACK, uri]);
    let afterD: string[] | null = null;
    const d3 = Date.now() + 8000;
    while (Date.now() < d3) {
      afterD = await deviceNames(c);
      if (afterD && afterD.length === before.length + 1) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!afterD || afterD.length !== before.length + 1) console.log('VERDICT D: load after selected_device did NOT act (or address unsupported — see /live/error above)');
    else {
      const posD = afterD.findIndex((n, i) => n !== before[i]);
      const atD = posD < 0 ? afterD.length - 1 : posD;
      console.log(`VERDICT D: landed at index ${atD} ${atD === 1 ? '— SELECTION-RELATIVE INSERT WORKS (pre-amp placement unlocked!)' : atD === afterD.length - 1 ? '— still appended (selection ignored or address dead)'  : '— unexpected position'}`);
      console.log(`list: ${afterD.map((n, i) => `[${i}] ${n}`).join('  ')}`);
      const nm = await ask(c, '/live/track/get/name', [TRACK]); // reuse verify pattern
      const check = await ask(c, '/live/track/get/devices/name', [TRACK]);
      const cn = check ? check.args.slice(1).map(String) : [];
      if (/compressor/i.test(cn[atD] ?? '')) {
        c.send('/live/track/delete_device', [TRACK, atD]);
        const d4 = Date.now() + 6000;
        let fin: string[] | null = null;
        while (Date.now() < d4) { fin = await deviceNames(c); if (fin && fin.length === before.length) break; await new Promise((r) => setTimeout(r, 300)); }
        console.log(`cleanup: ${fin && fin.length === before.length ? 'deleted, list restored' : 'DELETE FAILED — remove the Compressor by hand'}`);
      } else console.log(`cleanup REFUSED: index ${atD} reads "${cn[atD]}" — remove by hand`);
    }
    console.log('\n--- PROBE DONE — paste this whole output back ---');
  } finally { c.close(); }
}

main().catch((e) => { console.error('probe failed:', e instanceof Error ? e.message : e); process.exit(1); });
