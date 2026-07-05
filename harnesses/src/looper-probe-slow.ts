/**
 * looper-probe-slow.ts — diagnostic for the "echo lags by one" symptom.
 *
 *   TRACK=0 DEVICE=0 SETTLE_MS=400 node --experimental-strip-types harnesses/src/looper-probe-slow.ts
 *
 * Same set→get round-trip as harness 04, but with a LONG, configurable settle
 * (default 400 ms) between set and read, and it only listens for the get-reply.
 * Purpose: tell apart two causes of a one-behind echo —
 *   • settle latency  — the device DOES reach the state, just later than harness
 *     04's hardcoded 60 ms window (Max defers live.* Live-API output to the UI
 *     thread). Then every state matches here at 400 ms.
 *   • structural lag  — the device reports one behind no matter how long you wait.
 *     Then states still mismatch here, and the fix is in the v8, not the timing.
 */
import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';
import { DOWN, LooperState } from '../../contracts/types/osc.ts';

const SET = DOWN.looperSetState.address;
const GET = DOWN.looperGetState.address;
const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 1);
const SETTLE = Number(process.env.SETTLE_MS ?? 400);
const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 1500);

const STATES = (Object.entries(LooperState) as Array<[string, number]>);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  console.log(`Slow looper probe — settle ${SETTLE} ms, track ${TRACK}, device ${DEVICE}.`);
  let allOk = true;

  for (const [name, value] of STATES) {
    c.send(SET, [TRACK, DEVICE, value]);
    await sleep(SETTLE);                                  // give the device time to actually flip
    c.send(GET, [TRACK, DEVICE]);
    try {
      const reply = await c.waitFor(
        (m) => m.address === GET && Number(m.args[0]) === TRACK && Number(m.args[1]) === DEVICE,
        TIMEOUT,
      );
      const got = Number(reply.args[2]);
      const ok = got === value;
      allOk = allOk && ok;
      console.log(`  set ${name}(${value}), waited ${SETTLE} ms → State Out = ${got}  ${ok ? '✓' : '✗'}`);
    } catch (e) {
      allOk = false;
      console.log(`  set ${name}(${value}) → no get-reply (${(e as Error).message})`);
      rigHint();
    }
    await sleep(150);
  }

  c.close();
  if (allOk) {
    console.log(`\n✓ All states matched at ${SETTLE} ms settle → it's SETTLE LATENCY, not a device bug.`);
    console.log(`  The device reaches the state; it just needs more than harness 04's 60 ms.`);
    console.log(`  Try lowering SETTLE_MS (e.g. 200, 120, 90) to find the real settle floor.`);
  } else {
    console.log(`\n✗ Still mismatching at ${SETTLE} ms → STRUCTURAL: the device reports one behind.`);
    console.log(`  The fix is in the v8 (how it reads State / writes State Out), not the timing.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
