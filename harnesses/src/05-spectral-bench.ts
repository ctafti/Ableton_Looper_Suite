/**
 * 05-spectral-bench.ts — PROVE THE SPECTRAL WIRE before the template is touched
 * (PHASE4-HANDOFF work item 1). Binds SPECTRAL_UDP_PORT (11003), captures real
 * SPC1 datagrams from NAM_A2_Spectral.amxd, and decodes every one with the
 * hub's OWN decoder (hub/src/codec/spectral-codec.ts) — so the device and the
 * hub are proven against the same frozen bytes, no debugging inside Max.
 *
 *   node --experimental-strip-types harnesses/src/05-spectral-bench.ts
 *   DURATION_MS=10000 node --experimental-strip-types harnesses/src/05-spectral-bench.ts
 *
 * PORT DISCIPLINE: binds 11003, NOT 11001 — safe alongside `npm run rig` TODAY.
 * Once the hub's telemetry relay lands (work item 3) the rig binds 11003 too,
 * and this harness and the rig can never run at the same time.
 *
 * OBSERVE, NEVER ASSUME: the first datagram's header bytes are printed
 * verbatim (hex) before any interpretation; the golden fixture is decoded
 * alongside as the conventions reference. Checks per frame: decoder accepts
 * (magic/version/binCount/length formula), 256 magnitudes all within 0..1;
 * per chainTag: seq monotonic (drop-stale contract), fps + jitter from tMs
 * deltas AND from arrival times. Exit 0 only if frames arrived and every
 * check passed.
 */
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeSpectralFrame } from '../../hub/src/codec/spectral-codec.ts';
import { SPECTRAL, SPECTRAL_UDP_PORT } from '../../contracts/types/spectral.ts';

const DURATION_MS = Number(process.env.DURATION_MS ?? 6000);
const here = dirname(fileURLToPath(import.meta.url));

// --- golden fixture: the conventions reference ------------------------------
try {
  const golden = decodeSpectralFrame(readFileSync(join(here, '../../hub/golden/spectral-frame.spc1.bin')));
  console.log(`golden fixture decodes: chainTag="${golden.chainTag}" seq=${golden.seq} tMs=${golden.tMs} bins=${golden.magnitudes.length}`);
} catch (e) {
  console.log(`(golden fixture not readable from here: ${(e as Error).message})`);
}

interface ChainStats {
  frames: number;
  firstSeq: number;
  lastSeq: number;
  seqGaps: number;      // skipped seq (lossy-OK — report, don't fail)
  seqRegressions: number; // seq going BACKWARDS (would break drop-stale — FAIL)
  lastTMs: number;
  tMsDeltas: number[];
  arrivals: number[];
  magMin: number;
  magMax: number;
  nonZeroFrames: number;
}

const chains = new Map<string, ChainStats>();
let total = 0;
let badFrames = 0;
let firstHexShown = false;

const sock = dgram.createSocket('udp4');
sock.on('message', (buf) => {
  total++;
  if (!firstHexShown) {
    firstHexShown = true;
    console.log(`\nfirst datagram: ${buf.length} bytes; header verbatim:`);
    console.log(`  ${buf.subarray(0, 34).toString('hex').replace(/(..)/g, '$1 ').trim()}`);
  }
  let frame;
  try {
    frame = decodeSpectralFrame(buf);
  } catch (e) {
    badFrames++;
    console.error(`DECODE FAIL: ${(e as Error).message}`);
    return;
  }
  const now = Date.now();
  let s = chains.get(frame.chainTag);
  if (!s) {
    s = { frames: 0, firstSeq: frame.seq, lastSeq: frame.seq - 1, seqGaps: 0, seqRegressions: 0, lastTMs: 0, tMsDeltas: [], arrivals: [], magMin: 1, magMax: 0, nonZeroFrames: 0 };
    chains.set(frame.chainTag, s);
    console.log(`chain "${frame.chainTag}": first frame (seq ${frame.seq})`);
  }
  s.frames++;
  if (frame.seq < s.lastSeq) s.seqRegressions++;
  else if (frame.seq > s.lastSeq + 1) s.seqGaps += frame.seq - s.lastSeq - 1;
  s.lastSeq = frame.seq;
  if (s.lastTMs > 0) s.tMsDeltas.push(frame.tMs - s.lastTMs);
  s.lastTMs = frame.tMs;
  s.arrivals.push(now);
  let anyNonZero = false;
  for (const m of frame.magnitudes) {
    if (m < 0 || m > 1 || Number.isNaN(m)) { badFrames++; console.error(`MAG OUT OF RANGE: ${m}`); return; }
    if (m < s.magMin) s.magMin = m;
    if (m > s.magMax) s.magMax = m;
    if (m > 0) anyNonZero = true;
  }
  if (anyNonZero) s.nonZeroFrames++;
});

sock.bind(SPECTRAL_UDP_PORT, () => {
  console.log(`listening on UDP ${SPECTRAL_UDP_PORT} for ${DURATION_MS} ms — play something through the chain…`);
});

function stats(xs: number[]): string {
  if (xs.length < 2) return 'n/a';
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const max = Math.max(...xs);
  const min = Math.min(...xs);
  return `mean ${mean.toFixed(1)} ms (min ${min.toFixed(1)} / max ${max.toFixed(1)}) ≈ ${(1000 / mean).toFixed(1)} fps`;
}

setTimeout(() => {
  sock.close();
  console.log(`\n===== BENCH RESULT (${DURATION_MS} ms) =====`);
  console.log(`datagrams: ${total}, decode/range failures: ${badFrames}, chains seen: ${chains.size}`);
  let fail = badFrames > 0 || total === 0;
  for (const [tag, s] of chains) {
    console.log(`\nchain "${tag}":`);
    console.log(`  frames ${s.frames}, seq ${s.firstSeq}→${s.lastSeq} (gaps ${s.seqGaps}, regressions ${s.seqRegressions})`);
    console.log(`  sender tMs deltas: ${stats(s.tMsDeltas)}`);
    const arr = s.arrivals.slice(1).map((t, i) => t - s.arrivals[i]);
    console.log(`  arrival deltas:    ${stats(arr)}`);
    console.log(`  magnitudes: min ${s.magMin.toFixed(4)} max ${s.magMax.toFixed(4)}; non-silent frames ${s.nonZeroFrames}/${s.frames}`);
    if (s.seqRegressions > 0) { console.error(`  FAIL: seq regressed — drop-stale would misbehave`); fail = true; }
    if (s.magMax === 0) console.log(`  NOTE: all-silent — was audio playing through the chain? DSP on?`);
  }
  if (total === 0) {
    console.error('\nNO DATAGRAMS. Checklist: device on a chain? Max console shows');
    console.error('"spectral-sender: up" and "chainTag = ..."? spectral-sender.js');
    console.error('deployed NEXT TO the .amxd? Live DSP on? Track name carries [[tag]]?');
  }
  process.exit(fail ? 1 : 0);
}, DURATION_MS);
