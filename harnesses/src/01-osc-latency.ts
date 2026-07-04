/**
 * ============================================================================
 * HARNESS 01 — OSC ROUND-TRIP LATENCY TIMER   (arch §6.2)
 * ----------------------------------------------------------------------------
 * WHAT IT MEASURES: how long a command→echo round trip takes over OSC. This is
 * the number that decides whether "confirmed" feedback feels instant, and it
 * feeds the §8 visual-clock latency offset. We measure a cheap, always-present
 * stock AbletonOSC get: send `/live/song/get/tempo`, wait for the
 * `/live/song/get/tempo` reply, time it. Repeat N times, report the spread.
 *
 * WHY THIS QUERY: `/live/song/get/tempo` is stock AbletonOSC (FREEZE-NOW,
 * Contract 2) and side-effect-free, so it's the safest latency ping.
 *
 * RUNNABLE NOW: pure Node, no install. WITHOUT A RIG it will time out on every
 * ping and tell you so (that's expected). WHEN YOU HAVE THE RIG, see the steps
 * printed by rigHint() / the block at the bottom.
 * ============================================================================
 */

import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';

const N = Number(process.env.PINGS ?? 30);
const PER_PING_TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 500);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  const client = new OscClient({ host: hostFromEnv() });
  try {
    await client.bind();
  } catch (e) {
    console.error('could not bind UDP 11001 (is another OSC client running?):', (e as Error).message);
    process.exit(1);
  }

  console.log(`Pinging ${hostFromEnv()}:11000 with /live/song/get/tempo x${N} (timeout ${PER_PING_TIMEOUT_MS}ms each)…`);
  const samples: number[] = [];
  let timeouts = 0;

  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    client.send('/live/song/get/tempo');
    try {
      await client.waitFor((m) => m.address === '/live/song/get/tempo', PER_PING_TIMEOUT_MS);
      samples.push(performance.now() - t0);
    } catch {
      timeouts++;
    }
    await sleep(20); // don't flood; UDP drops under burst (arch §12)
  }

  client.close();

  if (samples.length === 0) {
    console.log(`\nNo replies received (${timeouts}/${N} timed out).`);
    rigHint();
    process.exit(0);
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  console.log('\nLatency (ms), round trip command→echo:');
  console.log(`  replies : ${samples.length}/${N}  (timeouts: ${timeouts})`);
  console.log(`  min     : ${samples[0].toFixed(1)}`);
  console.log(`  median  : ${percentile(samples, 50).toFixed(1)}`);
  console.log(`  mean    : ${mean.toFixed(1)}`);
  console.log(`  p95     : ${percentile(samples, 95).toFixed(1)}`);
  console.log(`  max     : ${samples[samples.length - 1].toFixed(1)}`);
  console.log('\nRule of thumb: median under ~30–50 ms feels instant for confirmed UI.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
