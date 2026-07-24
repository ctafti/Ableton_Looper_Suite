/**
 * 06-eq-param-probe.ts — READ-ONLY value probe for the EQ Eight fixture.
 * Phase 4 session 2, step two (after the name probe confirmed the surface).
 *
 * WHAT IT ANSWERS (observe, never assume):
 *   1. min / max / current value for the 4 globals + all 40 A-channel band
 *      params (the owner-decided mirror scope) — what UNITS does OSC speak?
 *   2. Does `/live/device/get/parameter/value_string` answer at all? If yes,
 *      Live hands us its own display string ("80 Hz", "-3.2 dB") and the
 *      overlay's value↔Hz/dB mapping becomes empirical, not formula-guessed.
 *
 * WRITES NOTHING. Safe with any Set open. Do NOT run while the rig server is
 * up (both bind UDP 11001).
 *
 *   TRACK=0 DEVICE=2 node --experimental-strip-types src/06-eq-param-probe.ts
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage, type OscValue } from './osc-helper.ts';

const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 2);

async function ask(
  c: OscClient,
  address: string,
  args: OscValue[],
  match: (m: OscMessage) => boolean,
  timeoutMs = 1500,
): Promise<OscMessage | null> {
  c.send(address, args);
  try {
    return await c.waitFor(match, timeoutMs);
  } catch {
    return null;
  }
}

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  try {
    // ---- bulk reads: names, values, mins, maxs ----------------------------
    const bulk = async (leaf: string) =>
      ask(c, `/live/device/get/parameters/${leaf}`, [TRACK, DEVICE], (m) =>
        m.address.includes(`parameters/${leaf}`),
      );

    const nameR = await bulk('name');
    if (!nameR) throw new Error('no reply to parameters/name — is Live + engine up? rig server stopped?');
    const names = nameR.args.slice(2).map(String);

    const valR = await bulk('value');
    const minR = await bulk('min');
    const maxR = await bulk('max');
    const pick = (m: OscMessage | null, i: number): string =>
      m ? String(m.args[2 + i]) : 'NO ANSWER';

    console.log(`track ${TRACK} device ${DEVICE}: ${names.length} params`);
    console.log(`bulk value=${valR ? 'OK' : 'NO ANSWER'} min=${minR ? 'OK' : 'NO ANSWER'} max=${maxR ? 'OK' : 'NO ANSWER'}`);

    // ---- value_string capability probe (ONE param first) ------------------
    // Try the per-parameter display-string getter on "1 Frequency A". If the
    // address is absent in this AbletonOSC build it will simply time out —
    // that is a finding, not an error.
    const freqAIdx = names.findIndex((n) => n === '1 Frequency A');
    const vsProbe =
      freqAIdx >= 0
        ? await ask(
            c,
            '/live/device/get/parameter/value_string',
            [TRACK, DEVICE, freqAIdx],
            (m) => m.address.includes('value_string'),
            1200,
          )
        : null;
    const vsSupported = vsProbe !== null;
    console.log(
      `value_string probe: ${
        vsSupported ? `SUPPORTED — reply args ${JSON.stringify(vsProbe!.args)}` : 'NO ANSWER (unsupported or timeout) — will skip'
      }`,
    );

    // ---- the params we care about: 4 globals + 40 A-channel ---------------
    const GLOBALS = ['Device On', 'Output', 'Scale', 'Adaptive Q'];
    const wanted = names.map((n, i) => ({ n, i })).filter(({ n }) => GLOBALS.includes(n));
    const aChannel = names.map((n, i) => ({ n, i })).filter(({ n }) => /^[1-8] .* A$/.test(n));

    console.log('');
    console.log('IDX  NAME               MIN        MAX        VALUE      DISPLAY');
    const row = async ({ n, i }: { n: string; i: number }) => {
      let display = '';
      if (vsSupported) {
        const r = await ask(
          c,
          '/live/device/get/parameter/value_string',
          [TRACK, DEVICE, i],
          (m) => m.address.includes('value_string') && Number(m.args[2]) === i,
          1200,
        );
        display = r ? String(r.args[r.args.length - 1]) : 'timeout';
      }
      console.log(
        `${String(i).padStart(3)}  ${n.padEnd(17)}  ${pick(minR, i).padEnd(9)}  ${pick(maxR, i).padEnd(9)}  ${pick(valR, i).padEnd(9)}  ${display}`,
      );
    };

    for (const w of wanted) await row(w);
    console.log('  ── A channel (the 40-param mirror scope) ──');
    for (const w of aChannel) await row(w);

    // one B-channel sample so we can confirm B mirrors A's ranges
    const bSample = names.findIndex((n) => n === '1 Frequency B');
    if (bSample >= 0) {
      console.log('  ── B-channel sample (expected inactive in Stereo mode) ──');
      await row({ n: names[bSample], i: bSample });
    }

    console.log('');
    console.log('Paste this whole output back. Nothing was written.');
  } catch (e) {
    console.log(`\n✗ ${(e as Error).message}`);
    rigHint();
  } finally {
    c.close();
  }
}

main();
