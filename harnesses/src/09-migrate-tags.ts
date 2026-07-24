/**
 * 09-migrate-tags.ts — ONE-SHOT migration of the dev Set's chain-track names
 * from the `[[tag]]` scheme to the `[TN]` marker scheme (owner decision P5-e,
 * Contract 7 CHANGELOG 2026-07-23).
 *
 * WHAT IT DOES (CONFIRM=yes only; read-only preview otherwise):
 *   "Clean [[chain.clean]]"     -> "Clean [T1]"
 *   "Crunch [[chain.crunch]]"   -> "Crunch [T2]"
 *   "Shimmer [[chain.shimmer]]" -> "Shimmer [T3]"
 * Human labels are PRESERVED verbatim (whatever text sits outside the old
 * brackets); only the marker changes. Every rename is confirmed by a
 * /live/track/get/name readback — observed, never assumed.
 *
 * REFUSES if: a track already carries a [TN] marker (already migrated), or an
 * old [[tag]] isn't one of the three known dev tags (unknown Set).
 *
 * Do NOT run while the rig server is up (binds 11001). Live open on the dev
 * Set. Afterwards: SAVE the Set in Live (Cmd-S) — the rename lives in Live's
 * undo history until saved.
 *
 *   node --experimental-strip-types src/09-migrate-tags.ts
 *   CONFIRM=yes node --experimental-strip-types src/09-migrate-tags.ts
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

const MUTATE = process.env.CONFIRM === 'yes';
const OLD_TAG = /\[\[([a-zA-Z0-9._-]+)\]\]/;
const NEW_TAG = /\[(T\d+)\]/; // Contract 7 CHAIN_TAG.pattern verbatim (P5-e)
const MAP: Record<string, string> = {
  'chain.clean': 'T1',
  'chain.crunch': 'T2',
  'chain.shimmer': 'T3',
};

async function ask(c: OscClient, address: string, args: (number | string)[]): Promise<OscMessage | null> {
  c.send(address, args);
  try {
    return await c.waitFor((m) => m.address === address, 2000);
  } catch {
    return null;
  }
}

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  try {
    const n = await ask(c, '/live/song/get/num_tracks', []);
    if (!n) {
      console.log('NO ANSWER — is Live + engine up? rig server stopped?');
      rigHint();
      return;
    }
    const count = Number(n.args[0]);
    const namesR = await ask(c, '/live/song/get/track_names', [0, count]);
    if (!namesR) throw new Error('track_names did not answer');
    const names = namesR.args.map(String);

    console.log('--- current tracks ---');
    names.forEach((nm, i) => console.log(`  track ${i}: "${nm}"`));

    // plan
    const plan: { index: number; from: string; to: string }[] = [];
    for (let i = 0; i < names.length; i++) {
      const nm = names[i];
      if (NEW_TAG.test(nm)) {
        console.log(`REFUSING: track ${i} "${nm}" already carries a [TN] marker — Set looks migrated (or partially). Nothing changed.`);
        return;
      }
      const m = nm.match(OLD_TAG);
      if (!m) continue; // not a chain track
      const newTag = MAP[m[1]];
      if (!newTag) {
        console.log(`REFUSING: track ${i} "${nm}" has unknown tag "${m[1]}" — not the known dev Set. Nothing changed.`);
        return;
      }
      const label = nm.replace(OLD_TAG, '').trim().replace(/\s+/g, ' ');
      plan.push({ index: i, from: nm, to: `${label} [${newTag}]` });
    }
    if (plan.length !== 3) {
      console.log(`REFUSING: expected exactly 3 old-tag chain tracks, found ${plan.length}. Nothing changed.`);
      return;
    }

    console.log('--- migration plan ---');
    for (const p of plan) console.log(`  track ${p.index}: "${p.from}"  ->  "${p.to}"`);

    if (!MUTATE) {
      console.log('');
      console.log('PREVIEW only. Re-run with CONFIRM=yes to apply.');
      return;
    }

    console.log('--- applying (each confirmed by readback) ---');
    let allOk = true;
    for (const p of plan) {
      c.send('/live/track/set/name', [p.index, p.to]);
      const r = await ask(c, '/live/track/get/name', [p.index]);
      const got = r ? String(r.args[1]) : 'NO ANSWER';
      const ok = got === p.to;
      allOk = allOk && ok;
      console.log(`  track ${p.index}: readback "${got}" ${ok ? '✓' : '✗ MISMATCH'}`);
    }
    console.log('');
    console.log(allOk
      ? 'MIGRATION DONE — now SAVE the Set in Live (Cmd-S), then paste this output back.'
      : 'MISMATCH above — paste this output back before doing anything else.');
  } finally {
    c.close();
  }
}

main().catch((e) => {
  console.error('migration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
