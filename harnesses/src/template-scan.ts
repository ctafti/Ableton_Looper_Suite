/**
 * template-scan.ts — verify the template .als against Contract 7, machine-readably.
 *
 *   node --experimental-strip-types src/template-scan.ts
 *
 * This is EXACTLY the scan the hub's boot detector will run (arch §12 /
 * Contract 7 TemplateScan): read track_names + cue_points ONCE, parse the
 * sentinel + chain tags, and check the required devices resolve by name.
 * Running it as a harness first means a wrong assumption about stock
 * AbletonOSC's reply shapes surfaces HERE, not inside the hub.
 *
 * OBSERVE, NEVER ASSUME: raw reply args are printed verbatim before any
 * interpretation, so a surprising shape is visible even when parsing fails.
 * Return-track visibility via track_names is UNVERIFIED (song.tracks may
 * exclude returns) — this scan reports what it sees and marks the returns
 * check OBSERVED or NOT-VISIBLE rather than failing on it.
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';
import {
  SENTINEL,
  parseSentinelVersion,
  chainTagFromTrackName,
} from '../../contracts/types/template.ts';

const TIMEOUT = 3000;

async function ask(c: OscClient, address: string, args: (number | string)[] = []): Promise<OscMessage> {
  c.send(address, args);
  return c.waitFor((m) => m.address === address, TIMEOUT);
}

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  let fail = false;
  const bad = (msg: string) => { fail = true; console.log(`  ✗ ${msg}`); };
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);

  try {
    // 0) engine alive?
    c.send('/live/engine/ping', []);
    await c.waitFor((m) => m.address.includes('/live/engine/ping'), TIMEOUT);
    console.log('engine alive.\n');

    // 1) track names -> chain tags
    const names = await ask(c, '/live/song/get/track_names');
    console.log(`/live/song/get/track_names raw: ${JSON.stringify(names.args)}`);
    const trackNames = names.args.map(String);
    const tags = trackNames.map((n) => chainTagFromTrackName(n));
    const chainTags = tags.filter((t): t is string => t !== null);
    console.log(`  chain tracks: ${trackNames
      .map((n, i) => (tags[i] ? `[${i}] "${n}" -> ${tags[i]}` : null))
      .filter(Boolean)
      .join(', ') || 'NONE'}`);
    if (chainTags.length >= 1) ok(`${chainTags.length} chain tag(s) parsed`);
    else bad('no [TN]-marked chain tracks found');
    const expected = ['T1', 'T2', 'T3']; // [TN] scheme, P5-e 2026-07-23
    for (const t of expected) {
      if (chainTags.includes(t)) ok(`tag present: ${t}`);
      else bad(`missing expected tag: ${t}`);
    }
    // returns visibility: OBSERVATION, not assumption
    const returnish = trackNames.filter((n) => /reverb|delay|^[ab]-|return/i.test(n));
    console.log(
      returnish.length > 0
        ? `  returns visible in track_names: ${JSON.stringify(returnish)} (OBSERVED)`
        : '  returns NOT visible in track_names (likely song.tracks excludes returns — FINDING, hub must detect returns another way or trust the template)',
    );

    // 2) cue points -> sentinel
    const cues = await ask(c, '/live/song/get/cue_points');
    console.log(`\n/live/song/get/cue_points raw: ${JSON.stringify(cues.args)}`);
    const cueStrings = cues.args.filter((a): a is string => typeof a === 'string');
    const versions = cueStrings.map(parseSentinelVersion).filter((v): v is number => v !== null);
    if (versions.length === 0) bad(`no cue point matching "${SENTINEL.prefix}" — sentinel missing or misnamed`);
    else if (versions[0] === SENTINEL.version) ok(`sentinel found, version ${versions[0]} (matches contract)`);
    else bad(`sentinel found but version ${versions[0]} != contract ${SENTINEL.version}`);

    // 3) devices on each chain track, by index within track_names
    console.log('');
    for (let i = 0; i < trackNames.length; i++) {
      if (!tags[i]) continue;
      const dev = await ask(c, '/live/track/get/devices/name', [i]);
      console.log(`/live/track/get/devices/name ${i} raw: ${JSON.stringify(dev.args)}`);
      const devNames = dev.args.slice(1).map(String); // arg0 echoes track index
      if (tags[i] === 'T1') {
        if (devNames.some((n) => /nam|gateway/i.test(n))) ok(`[${i}] amp matched by ROLE_MATCHERS: ${devNames[0] ?? '?'}`);
        else bad(`[${i}] no device matches amp matcher /nam|gateway/i — got ${JSON.stringify(devNames)}`);
        if (devNames.some((n) => /looper/i.test(n))) ok(`[${i}] looper matched by ROLE_MATCHERS`);
        else bad(`[${i}] no device matches looper matcher /looper/i`);
      } else if (devNames.length === 0) {
        ok(`[${i}] ${tags[i]}: empty (structure-only, as specified)`);
      } else {
        console.log(`  [${i}] ${tags[i]}: unexpected devices ${JSON.stringify(devNames)} (not fatal — noting)`);
      }
    }

    console.log(fail ? '\n✗ SCAN FAILED — fix the .als (or the contract is wrong: that is DATA).' : '\n✓ TEMPLATE SCAN PASSES Contract 7 (skeleton scope).');
  } catch (e) {
    console.log(`\n✗ scan error: ${(e as Error).message}`);
    console.log('  Is the TEMPLATE set the one open in Live right now?');
    rigHint();
  } finally {
    c.close();
  }
}

main();
