/**
 * ============================================================================
 * HARNESS 05 — CONFIRMED-ECHO PINGER   (arch §12)
 * ----------------------------------------------------------------------------
 * WHAT IT DEMONSTRATES: the core §12 pattern the whole system relies on —
 * "confirm by expectation-matching, not receipts." OSC is fire-and-forget UDP
 * with no ACK, so on send we register an EXPECTATION (an address+predicate we
 * expect to see) and treat the matching listener echo as the confirmation. This
 * harness is a reusable tool: give it a command to send and an echo to expect,
 * and it reports confirmed / timed-out, with the round-trip time.
 *
 * DEFAULT SCENARIO (safe, stock AbletonOSC): arm the track's playing-slot
 * listener, FIRE a clip, and expect the `playing_slot_index` echo to report the
 * fired slot within window W. This is exactly how the hub confirms a fire.
 *
 *   arm    : /live/track/start_listen/playing_slot_index  (stock)
 *   command: /live/clip_slot/fire  track slot              (stock)
 *   expect : /live/track/get/playing_slot_index  track slot (echo)
 *
 * WHAT TO OBSERVE: confirmed within W? what's the confirm latency? does firing
 * A then B supersede A's expectation (arch §12 backpressure — try SLOT2)?
 *
 * GENERIC USE: override via env — CMD_ADDR, CMD_ARGS (comma nums), EXPECT_ADDR,
 * plus TRACK/SLOT. Without a rig it times out and explains.
 * ============================================================================
 */

import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';

const TRACK = Number(process.env.TRACK ?? 0);
const SLOT = Number(process.env.SLOT ?? 0);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 1500);

// Defaults model a clip fire + playing_slot confirmation (all stock, Contract 2).
const ARM_ADDR = process.env.ARM_ADDR ?? '/live/track/start_listen/playing_slot_index';
const CMD_ADDR = process.env.CMD_ADDR ?? '/live/clip_slot/fire';
const EXPECT_ADDR = process.env.EXPECT_ADDR ?? '/live/track/get/playing_slot_index';

function parseArgs(envVal: string | undefined, fallback: number[]): number[] {
  if (!envVal) return fallback;
  return envVal.split(',').map((s) => Number(s.trim()));
}

async function main(): Promise<void> {
  const client = new OscClient({ host: hostFromEnv() });
  await client.bind();

  const cmdArgs = parseArgs(process.env.CMD_ARGS, [TRACK, SLOT]);

  console.log('Confirmed-echo pinger (arch §12):');
  console.log(`  arm    : ${ARM_ADDR} [${TRACK}]`);
  console.log(`  command: ${CMD_ADDR} [${cmdArgs.join(', ')}]`);
  console.log(`  expect : ${EXPECT_ADDR} reporting track ${TRACK} -> slot ${SLOT} within ${WINDOW_MS}ms`);

  try {
    // 1) arm the listener so the engine will echo changes
    client.send(ARM_ADDR, [TRACK]);
    await sleep(80);

    // 2) register the expectation, THEN send the command (avoid a race)
    const t0 = performance.now();
    const expectation = client.waitFor(
      (m) => m.address === EXPECT_ADDR && Number(m.args[0]) === TRACK && Number(m.args[1]) === SLOT,
      WINDOW_MS,
    );
    client.send(CMD_ADDR, cmdArgs);

    // 3) await confirmation
    await expectation;
    const dt = performance.now() - t0;
    console.log(`\n✓ CONFIRMED in ${dt.toFixed(1)}ms — the echo matched the expectation.`);
    console.log('  This is the confirmation primitive every command uses.');
  } catch (e) {
    console.log(`\n✗ NOT confirmed within ${WINDOW_MS}ms (${(e as Error).message}).`);
    console.log('  On a rig this means: retry (idempotent) or reconcile (stateful) per Contract 8.');
    rigHint();
  } finally {
    client.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
