/**
 * looper-wire-log.ts — show EXACTLY what comes back on the wire for each command.
 *
 *   TRACK=0 DEVICE=0 node --experimental-strip-types harnesses/src/looper-wire-log.ts
 *
 * Mimics harness 04's sends (set, wait 60 ms, get) but instead of matching one
 * reply it passively logs EVERY /live/looper message received, with its address,
 * args, and arrival time. This reveals whether /live/looper/set_state is sending
 * a reply at all, what value it carries, and whether it beats the get-reply —
 * which is what decides the fix.
 */
import { OscClient, hostFromEnv } from './osc-helper.ts';
import { DOWN, LooperState } from '../../contracts/types/osc.ts';

const SET = DOWN.looperSetState.address;
const GET = DOWN.looperGetState.address;
const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 1);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  const t0 = Date.now();
  const stamp = (): string => `+${String(Date.now() - t0).padStart(4)}ms`;

  c.onMessage((m) => {
    if (typeof m.address === 'string' && m.address.includes('/live/looper')) {
      console.log(`  ${stamp()}  RECV  ${m.address}   args=${JSON.stringify(m.args)}`);
    }
  });

  for (const [name, value] of Object.entries(LooperState) as Array<[string, number]>) {
    console.log(`\n=== command ${name}(${value}) — expect the eventual echo to be ${value} ===`);
    console.log(`  ${stamp()}  SEND  set_state [${TRACK},${DEVICE},${value}]`);
    c.send(SET, [TRACK, DEVICE, value]);
    await sleep(60);
    console.log(`  ${stamp()}  SEND  get/state [${TRACK},${DEVICE}]`);
    c.send(GET, [TRACK, DEVICE]);
    await sleep(500);   // watch everything that arrives in the next half second
  }

  c.close();
  console.log('\nRead the RECV lines: an echo on /live/looper/set_state that arrives');
  console.log('before the /live/looper/get/state reply is what harness 04 was catching.');
}

main().catch((e) => { console.error(e); process.exit(1); });
