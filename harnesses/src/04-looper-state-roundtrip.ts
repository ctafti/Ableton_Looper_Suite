/**
 * ============================================================================
 * HARNESS 04 — LOOPER-STATE ROUND-TRIP PROBE   (arch §6.3, §15)   [FIXED 2026-07-05]
 * ----------------------------------------------------------------------------
 * Confirms our custom M4L looper's state can be SET absolutely AND that the
 * device REPORTS its resulting state back (observed, never assumed). Closes
 * provisional seam #3.
 *
 * WHY THIS WAS REWRITTEN: the previous version read ONCE ~60 ms after the set and
 * matched a reply on the get-OR-set address. That's two bugs: (1) it matched
 * whatever landed first (including stale frames), and (2) the device's state
 * becomes readable ~100 ms after the set (Live delivers the command to the M4L
 * device on a low-priority thread), so a single 60 ms read catches the PREVIOUS
 * value. Neither is a device fault — measured: the device reports the right
 * values, just not within 60 ms.
 *
 * THE FIX (correct correlation + honest confirmation):
 *   for each absolute state {Stop, Play, Record, Overdub}:
 *     send set_state, then POLL get_state until the device's REPORTED state equals
 *     the command (observed confirmation) or SETTLE_TIMEOUT elapses. Each read
 *     matches ONLY a fresh get-reply for THIS track/device — never the set address.
 *   The elapsed time to reach the commanded state is the SETTLE LATENCY, printed
 *   per state so the number is visible, not guessed.
 *
 * A device that never reaches the commanded state times out -> FAIL. So this
 * still proves observed truth; it just no longer mistakes "read too early" for
 * "device wrong."
 *
 * STATE NUMBERS + ADDRESSES imported from Contract 2 (no local drift). Device
 * defaults to 1 (looper = CHAIN_DEVICE_ORDER[1]); override with DEVICE=<n>.
 * ============================================================================
 */
import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';
import { DOWN, LooperState } from '../../contracts/types/osc.ts';

const SET = DOWN.looperSetState.address;   // Contract 2 [EXT]
const GET = DOWN.looperGetState.address;   // Contract 2 [EXT]
const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 1);
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 1500); // max wait to reach a state
const GET_TIMEOUT_MS = Number(process.env.GET_TIMEOUT_MS ?? 400);        // per-read reply wait
const POLL_MS = Number(process.env.POLL_MS ?? 25);                       // gap between reads

const STATES: Array<{ name: string; value: number }> = (
  Object.entries(LooperState) as Array<[string, number]>
).map(([name, value]) => ({ name, value }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One read: send get, wait for a FRESH get-reply for this track/device. */
async function readState(client: OscClient, track: number): Promise<number> {
  client.send(GET, [track, DEVICE]);
  const reply = await client.waitFor(
    (m) => m.address === GET && Number(m.args[0]) === track && Number(m.args[1]) === DEVICE,
    GET_TIMEOUT_MS,
  );
  return Number(reply.args[2]);
}

/**
 * Send the command, then poll the device's REPORTED state until it equals the
 * command (observed confirmation) or we exceed SETTLE_TIMEOUT. Returns the last
 * value seen and the latency to confirmation (-1 latency = never confirmed).
 */
async function commandAndConfirm(
  client: OscClient, track: number, value: number,
): Promise<{ got: number; latencyMs: number }> {
  const t0 = Date.now();
  client.send(SET, [track, DEVICE, value]);
  let last = NaN;
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    try {
      last = await readState(client, track);
      if (last === value) return { got: value, latencyMs: Date.now() - t0 };
    } catch {
      /* no reply this poll — retry */
    }
    await sleep(POLL_MS);
  }
  return { got: last, latencyMs: -1 };
}

async function main(): Promise<void> {
  const client = new OscClient({ host: hostFromEnv() });
  await client.bind();

  console.log(`Looper-state round trip (poll-until-settled) on track ${TRACK}, device ${DEVICE}.`);
  let allOk = true;
  let anyReply = false;
  const latencies: number[] = [];

  for (const s of STATES) {
    const { got, latencyMs } = await commandAndConfirm(client, TRACK, s.value);
    if (!Number.isNaN(got)) anyReply = true;
    const ok = got === s.value;
    allOk = allOk && ok;
    if (ok) {
      latencies.push(latencyMs);
      console.log(`  set ${s.name}(${s.value}) → confirmed ${got} in ${latencyMs} ms  ✓`);
    } else {
      console.log(`  set ${s.name}(${s.value}) → NEVER confirmed within ${SETTLE_TIMEOUT_MS} ms (last saw ${got})  ✗`);
    }
    await sleep(120);
  }

  // idempotency: re-send Play twice; it must stay Play (a re-send confirms fast).
  try {
    await commandAndConfirm(client, TRACK, 1);
    const second = await commandAndConfirm(client, TRACK, 1);
    console.log(`  idempotency: re-sent Play → ${second.got === 1 ? '✓ still Play' : '✗ ' + second.got}`);
  } catch {
    /* covered above */
  }

  client.close();

  if (!anyReply) {
    console.log('\nNo replies at all — engine/looper not reachable.');
    rigHint();
    return;
  }

  if (latencies.length) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(`\nSettle latency: avg ${avg} ms, max ${Math.max(...latencies)} ms (${latencies.length} states).`);
  }
  console.log(
    allOk
      ? '✓ PASS — every state observed-confirmed by the device. Seam #3 closes.'
      : '✗ some states never confirmed — investigate the M4L device / engine cache.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
