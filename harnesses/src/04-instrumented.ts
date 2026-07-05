/**
 * 04-instrumented.ts — harness 04, but it SHOWS its work.
 *
 *   TRACK=0 DEVICE=0 node --experimental-strip-types harnesses/src/04-instrumented.ts
 *
 * Same sends and same (get|set) predicate as harness 04, but it:
 *   • logs every /live/looper message received (persistent listener), with time;
 *   • logs, inside the waitFor predicate, every message it is evaluated against
 *     and whether it matched;
 *   • prints which reply (address + args + arrival time) confirmed each command.
 *
 * The hypothesis under test (per external review): command N is being confirmed
 * against command N-1's leftover get-reply — a reply-correlation race, not a slow
 * device. If so, you'll see the confirming reply arrive suspiciously early (right
 * as waitFor arms) and/or carry args from the previous state.
 */
import { OscClient, hostFromEnv } from './osc-helper.ts';
import { DOWN, LooperState } from '../../contracts/types/osc.ts';

const SET = DOWN.looperSetState.address;
const GET = DOWN.looperGetState.address;
const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 1);
const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 800);

const STATES = Object.entries(LooperState) as Array<[string, number]>;
const t0 = Date.now();
const ts = (): string => `+${String(Date.now() - t0).padStart(5)}ms`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function probe(c: OscClient, name: string, value: number): Promise<number> {
  console.log(`\n[${ts()}] === ${name}(${value}) : send set_state ===`);
  c.send(SET, [TRACK, DEVICE, value]);
  await sleep(60);
  console.log(`[${ts()}] ${name}(${value}) : send get/state, then arm waitFor`);
  c.send(GET, [TRACK, DEVICE]);

  const reply = await c.waitFor((m) => {
    const match =
      (m.address === GET || m.address === SET) &&
      Number(m.args[0]) === TRACK && Number(m.args[1]) === DEVICE;
    if (typeof m.address === 'string' && m.address.includes('/live/looper')) {
      console.log(`[${ts()}]    waitFor evaluates ${m.address} args=${JSON.stringify(m.args)} -> ${match ? 'MATCH' : 'skip'}`);
    }
    return match;
  }, TIMEOUT);

  const got = Number(reply.args[2]);
  const flag = got === value ? '✓' : '✗  <-- confirmed against the WRONG reply if these args are from a prior command';
  console.log(`[${ts()}] ${name}(${value}) : CONFIRMED by ${reply.address} args=${JSON.stringify(reply.args)} => echo ${got}  ${flag}`);
  await sleep(120);
  return got;
}

async function main(): Promise<void> {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  // Persistent view of everything on the wire, independent of waitFor.
  c.onMessage((m) => {
    if (typeof m.address === 'string' && m.address.includes('/live/looper')) {
      console.log(`[${ts()}]  RECV ${m.address} args=${JSON.stringify(m.args)}`);
    }
  });

  for (const [name, value] of STATES) await probe(c, name, value);
  c.close();

  console.log('\nInterpretation:');
  console.log(' • If each CONFIRMED reply arrives ~70-90 ms after its get send and its args');
  console.log('   match the command, the device is fine and this instrumented run passes.');
  console.log(' • If a CONFIRMED reply is matched within a few ms of arming (a leftover) or');
  console.log('   carries the previous state, that is the reply-correlation race to fix in');
  console.log('   the harness / osc-helper (flush -> arm -> send; correlate on args, not just address).');
}

main().catch((e) => { console.error(e); process.exit(1); });
