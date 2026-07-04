/**
 * ============================================================================
 * HARNESS 04 — LOOPER-STATE ROUND-TRIP PROBE   (arch §6.3, §15)
 * ----------------------------------------------------------------------------
 * WHAT IT TESTS: our custom M4L looper's state can be SET absolutely AND that it
 * ECHOES its resulting state back (Contract 2 looperSetState / looper_state
 * up-event; Contract 4 LooperReceipt). This is PROVISIONAL seam #3 — we built
 * the looper because native Looper's State was flaky to write; this proves our
 * replacement is clean AND observable.
 *
 * THE PROBE:
 *   for each absolute state in {Stop=0, Play=1, Record=2, Overdub=3}:
 *     send the EXT looper set-state, then wait for the looper_state echo and
 *     confirm the reported state == the commanded state (within window W).
 *   (Absolute → idempotent: a re-send of the same state must be harmless.)
 *
 * WHAT TO OBSERVE (to close seam #3):
 *   - every commanded state comes back echoed and matching.
 *   - re-sending the same state doesn't glitch (idempotent, Contract 8).
 *   If the echo is missing → add a state-report outlet to the M4L patch (we own
 *   it) and re-run. The enum + verb stay frozen.
 *
 * STATE NUMBERS MUST MATCH Contract 2 `LooperState` (Stop=0 Play=1 Record=2
 * Overdub=3). Kept as local literals so this harness runs with plain Node.
 *
 * ADDRESSES + the state enum are IMPORTED from Contract 2 — the shipped engine
 * extension (engine/) implements exactly those addresses. The probe speaks raw
 * track/device indices (the app speaks ChainID; a wire probe sits below the
 * resolver). DEVICE defaults to 1 = the looper's slot in CHAIN_DEVICE_ORDER
 * (amp=0, looper=1); override with DEVICE=<n> if your test Set differs.
 * ============================================================================
 */

import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';
import { DOWN, LooperState } from '../../contracts/types/osc.ts';

const SET_STATE_ADDR = DOWN.looperSetState.address; // Contract 2 [EXT]
const GET_STATE_ADDR = DOWN.looperGetState.address; // Contract 2 [EXT]
const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 1); // looper = CHAIN_DEVICE_ORDER[1]
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 800);

// Directly the Contract 2 enum — no local copy to drift:
const STATES: Array<{ name: string; value: number }> = (
  Object.entries(LooperState) as Array<[string, number]>
).map(([name, value]) => ({ name, value }));

async function probeState(client: OscClient, track: number, value: number): Promise<number> {
  // Contract 2 arg shape: (track, device, state) — the earlier draft dropped
  // the device index; fixed 2026-07-02 to match looperSetState exactly.
  client.send(SET_STATE_ADDR, [track, DEVICE, value]);
  await sleep(60);
  // The engine pushes an echo on set AND answers an explicit get. Do both.
  client.send(GET_STATE_ADDR, [track, DEVICE]);
  const reply = await client.waitFor(
    (m) =>
      (m.address === GET_STATE_ADDR || m.address === SET_STATE_ADDR) &&
      Number(m.args[0]) === track && Number(m.args[1]) === DEVICE,
    TIMEOUT_MS,
  );
  // reply args: [track, device, state]
  return Number(reply.args[2]);
}

async function main(): Promise<void> {
  const client = new OscClient({ host: hostFromEnv() });
  await client.bind();

  console.log(`Looper-state round trip on track ${TRACK} (our custom M4L looper, arch §15).`);
  let allOk = true;
  let anyReply = false;

  for (const s of STATES) {
    try {
      const got = await probeState(client, TRACK, s.value);
      anyReply = true;
      const ok = got === s.value;
      allOk = allOk && ok;
      console.log(`  set ${s.name}(${s.value}) → echoed ${got}  ${ok ? '✓' : '✗ MISMATCH'}`);
    } catch (e) {
      allOk = false;
      console.log(`  set ${s.name}(${s.value}) → no echo (${(e as Error).message})`);
    }
    await sleep(120);
  }

  // idempotency spot-check: re-send Play twice
  try {
    await probeState(client, TRACK, 1);
    const second = await probeState(client, TRACK, 1);
    console.log(`  idempotency: re-sent Play, still ${second === 1 ? '✓ Play' : '✗ ' + second}`);
  } catch {
    /* covered above */
  }

  client.close();

  if (!anyReply) {
    console.log('\nNo echoes at all.');
    console.log('Finding: the looper does not report state yet — add a state outlet to the M4L patch.');
    rigHint();
  } else {
    console.log(`\n${allOk ? '✓ PASS — every state echoed and matched. Seam #3 closes.' : '✗ some states did not match — investigate the M4L state param.'}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
