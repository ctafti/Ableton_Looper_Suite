/**
 * 08-track-dup-probe.ts — the Phase-5a STEP ZERO #3 probe: track duplication
 * and deletion over stock AbletonOSC, OBSERVED before any hub code is written
 * (the EQ probes 06/07 are the model).
 *
 * WHAT IT ANSWERS (observe, never assume):
 *   1. Does `/live/song/duplicate_track [i]` exist and act? (watch /live/error)
 *   2. Where does the duplicate land (index)? What NAME does Live give it?
 *   3. Does the duplicate carry devices? clips? input routing?
 *   4. Does the duplicate's spectral device SEND (SPC1 on 11003), and does it
 *      RE-TAG itself after the track is renamed with a fresh [[tag]]?
 *   5. Does `/live/track/start_listen/name` exist (self-healing prerequisite)?
 *   6. Does `/live/song/delete_track [i]` exist and act? (cleanup + item 3)
 *
 * TWO MODES:
 *   READ-ONLY (default):    inventory only — counts, names, tags, SPC1 tags
 *                           seen. Writes NOTHING. Safe with any Set open.
 *   MUTATING (CONFIRM=yes): duplicates ONE track, inspects it, renames it with
 *                           a probe tag, then DELETES ONLY that probe track
 *                           (verified by name immediately before deleting) and
 *                           confirms the Set is back to its starting shape.
 *
 * RUN ON THE DEV SET ONLY (template v2, 3 chains). Do NOT run while the rig
 * server is up — this binds UDP 11001 AND 11003 (spectral watch).
 *
 *   node --experimental-strip-types src/08-track-dup-probe.ts
 *   CONFIRM=yes TRACK=0 node --experimental-strip-types src/08-track-dup-probe.ts
 */
import dgram from 'node:dgram';
import { OscClient, hostFromEnv, rigHint, type OscMessage, type OscValue } from './osc-helper.ts';

const TRACK = Number(process.env.TRACK ?? 0);
const MUTATE = process.env.CONFIRM === 'yes';
const SPECTRAL_PORT = Number(process.env.SPECTRAL_UDP_PORT ?? 11003);
const PROBE_NAME_1 = 'PROBE [T99]';
const PROBE_NAME_2 = 'PROBE2 [T99]';
const TAG_PATTERN = /\[(T\d+)\]/; // Contract 7 CHAIN_TAG.pattern verbatim ([TN] scheme, P5-e)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const errors: string[] = [];

async function ask(
  c: OscClient,
  address: string,
  args: OscValue[],
  matchAddr: string = address,
  timeoutMs = 2000,
): Promise<OscMessage | null> {
  c.send(address, args);
  try {
    return await c.waitFor((m) => m.address === matchAddr, timeoutMs);
  } catch {
    return null;
  }
}

async function trackNames(c: OscClient): Promise<string[] | null> {
  const n = await ask(c, '/live/song/get/num_tracks', []);
  if (!n) return null;
  const count = Number(n.args[0]);
  const r = await ask(c, '/live/song/get/track_names', [0, count]);
  return r ? r.args.map(String) : null;
}

async function pollNumTracks(c: OscClient, want: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const r = await ask(c, '/live/song/get/num_tracks', [], '/live/song/get/num_tracks', 800);
    if (r) {
      last = Number(r.args[0]);
      if (last === want) return last;
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  return last;
}

/** Passive SPC1 tag watcher on 11003. Returns tag -> frame count. */
function watchSpectralTags(ms: number): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const seen = new Map<string, number>();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf) => {
      try {
        if (buf.length < 22 || buf.readUInt32LE(0) !== 0x53504331) return; // 'SPC1'
        const tagLen = buf.readUInt16LE(20);
        const tag = buf.toString('utf8', 22, 22 + tagLen);
        seen.set(tag, (seen.get(tag) ?? 0) + 1);
      } catch { /* ignore */ }
    });
    sock.on('error', () => { sock.close(); resolve(seen); }); // port taken => rig up; report empty
    sock.bind(SPECTRAL_PORT, () => setTimeout(() => { sock.close(); resolve(seen); }, ms));
  });
}

function fmtTags(m: Map<string, number>): string {
  if (m.size === 0) return '(none)';
  return [...m.entries()].map(([t, n]) => `${t} x${n}`).join(', ');
}

// ---------------------------------------------------------------------------
async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  c.onMessage((m) => {
    if (m.address === '/live/error') {
      const line = m.args.map(String).join(' ');
      errors.push(line);
      console.log(`  [/live/error] ${line}`);
    }
  });

  try {
    // ---- PHASE A: read-only inventory -------------------------------------
    console.log('--- PHASE A: read-only inventory ---');
    const before = await trackNames(c);
    if (!before) {
      console.log('NO ANSWER from /live/song/get/num_tracks — is Live + engine up? rig server stopped?');
      rigHint();
      return;
    }
    console.log(`num_tracks = ${before.length}`);
    before.forEach((n, i) => {
      const tag = n.match(TAG_PATTERN)?.[1] ?? '-';
      console.log(`  track ${i}: "${n}"  tag=${tag}`);
    });

    const stale = before.findIndex((n) => n.includes('PROBE') || n.includes('[T99]'));
    if (stale >= 0) {
      console.log(`REFUSING: track ${stale} looks like a leftover probe track ("${before[stale]}").`);
      console.log('Delete it in Live by hand, then re-run.');
      return;
    }

    console.log(`watching SPC1 tags on ${SPECTRAL_PORT} for 2s (baseline)...`);
    const baseTags = await watchSpectralTags(2000);
    console.log(`  spectral tags seen: ${fmtTags(baseTags)}`);

    if (!MUTATE) {
      console.log('');
      console.log('READ-ONLY mode done. Re-run with CONFIRM=yes to run the duplicate/rename/delete probe.');
      return;
    }

    // ---- PHASE B: duplicate ------------------------------------------------
    console.log('');
    console.log(`--- PHASE B: duplicate track ${TRACK} ("${before[TRACK]}") ---`);
    if (TRACK < 0 || TRACK >= before.length) throw new Error(`TRACK=${TRACK} out of range`);
    const errCountBefore = errors.length;
    c.send('/live/song/duplicate_track', [TRACK]);
    const afterDupCount = await pollNumTracks(c, before.length + 1, 5000);
    if (afterDupCount !== before.length + 1) {
      console.log(`VERDICT: duplicate_track did NOT act (num_tracks stayed ${afterDupCount}).`);
      if (errors.length > errCountBefore) console.log('  (see /live/error above — address likely unsupported)');
      else console.log('  (no /live/error either — silent no-op?)');
      console.log('STOP: this is the [EXT] fork — owner decision needed.');
      return;
    }
    console.log(`num_tracks ${before.length} -> ${afterDupCount} — duplicate ACTED`);

    const afterDup = await trackNames(c);
    if (!afterDup) throw new Error('track_names stopped answering after duplicate');
    let di = -1;
    for (let i = 0; i < afterDup.length; i++) {
      if (i < TRACK && afterDup[i] !== before[i]) console.log(`  ! track ${i} name changed unexpectedly`);
      if (i > TRACK && afterDup[i] === before[i - 1] && di < 0 && afterDup[TRACK] === before[TRACK]) di = TRACK + 1;
    }
    // Simplest robust landing check: diff lengths + report the full list.
    console.log('track list after duplicate:');
    afterDup.forEach((n, i) => console.log(`  track ${i}: "${n}"`));
    if (di < 0) {
      // fall back: find the first index where lists diverge
      di = afterDup.findIndex((n, i) => n !== before[i]);
      if (di < 0) di = afterDup.length - 1;
    }
    console.log(`duplicate landed at index ${di}, name = "${afterDup[di]}" (source was "${before[TRACK]}")`);

    // ---- inspect the duplicate --------------------------------------------
    console.log('');
    console.log('--- inspect the duplicate ---');
    const devR = await ask(c, '/live/track/get/devices/name', [di]);
    console.log(`devices: ${devR ? devR.args.slice(1).map(String).join(' | ') : 'NO ANSWER'}`);
    const srcDevR = await ask(c, '/live/track/get/devices/name', [TRACK]);
    console.log(`source devices: ${srcDevR ? srcDevR.args.slice(1).map(String).join(' | ') : 'NO ANSWER'}`);

    const clips: string[] = [];
    for (let s = 0; s < 5; s++) {
      const r = await ask(c, '/live/clip_slot/get/has_clip', [di, s]);
      clips.push(r ? `${s}:${r.args[2]}` : `${s}:?`);
    }
    console.log(`has_clip slots 0-4: ${clips.join(' ')}`);

    const routeR = await ask(c, '/live/track/get/input_routing_channel', [di]);
    console.log(`input_routing_channel: ${routeR ? routeR.args.slice(1).map(String).join(' ') : 'NO ANSWER'}`);

    console.log(`watching SPC1 tags for 2s (post-duplicate, tags may collide)...`);
    console.log(`  spectral tags seen: ${fmtTags(await watchSpectralTags(2000))}`);

    // ---- rename with a fresh tag: does spectral re-tag? --------------------
    console.log('');
    console.log('--- rename probe: fresh [[tag]] ---');
    c.send('/live/track/set/name', [di, PROBE_NAME_1]);
    const nameR = await ask(c, '/live/track/get/name', [di]);
    console.log(`name after set: ${nameR ? `"${nameR.args[1]}"` : 'NO ANSWER'}`);
    console.log(`watching SPC1 tags for 3s (does [T99] appear?)...`);
    const renamedTags = await watchSpectralTags(3000);
    console.log(`  spectral tags seen: ${fmtTags(renamedTags)}`);
    console.log(`  VERDICT re-tag: ${renamedTags.has('T99') ? 'YES — device re-resolved the new tag' : 'NO probe.dup frames (device did not re-tag, or no audio device on this Set)'}`);

    // ---- name listener probe (self-healing prerequisite) -------------------
    console.log('');
    console.log('--- name-listener probe: /live/track/start_listen/name ---');
    const errCountBeforeListen = errors.length;
    c.send('/live/track/start_listen/name', [di]);
    await new Promise((res) => setTimeout(res, 500));
    const listenErrored = errors.length > errCountBeforeListen;
    let unsolicited: OscMessage | null = null;
    const waiter = c
      .waitFor((m) => m.address === '/live/track/get/name' && String(m.args[1] ?? '') === PROBE_NAME_2, 2500)
      .then((m) => (unsolicited = m))
      .catch(() => null);
    c.send('/live/track/set/name', [di, PROBE_NAME_2]);
    await waiter;
    console.log(`  start_listen/name errored: ${listenErrored ? 'YES' : 'no'}`);
    console.log(`  unsolicited name echo on rename: ${unsolicited ? 'YES — name listeners SUPPORTED' : 'none seen'}`);
    c.send('/live/track/stop_listen/name', [di]);

    // ---- cleanup: delete ONLY the verified probe track ---------------------
    console.log('');
    console.log('--- cleanup: delete the probe track ---');
    const verify = await ask(c, '/live/track/get/name', [di]);
    const verifyName = verify ? String(verify.args[1]) : '';
    if (!verifyName.startsWith('PROBE')) {
      console.log(`REFUSING delete: track ${di} is now named "${verifyName}" (not our probe). Delete by hand in Live.`);
      return;
    }
    c.send('/live/song/delete_track', [di]);
    const afterDel = await pollNumTracks(c, before.length, 5000);
    if (afterDel !== before.length) {
      console.log(`VERDICT: delete_track did NOT act (num_tracks = ${afterDel}). Delete the probe track by hand.`);
      return;
    }
    console.log(`num_tracks back to ${afterDel} — delete ACTED`);
    const final = await trackNames(c);
    const intact = final && final.length === before.length && final.every((n, i) => n === before[i]);
    console.log(`original track list intact: ${intact ? 'YES' : 'NO — compare above by hand!'}`);
    if (!intact && final) final.forEach((n, i) => console.log(`  track ${i}: "${n}"`));

    console.log('');
    console.log('--- PROBE DONE — paste this whole output back ---');
  } finally {
    c.close();
  }
}

main().catch((e) => {
  console.error('probe failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
