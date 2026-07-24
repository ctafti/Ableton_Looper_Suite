/**
 * 07-eq-write-probe.ts — CONTROLLED write probe on the EQ Eight fixture.
 * Phase 4 session 2, step three. Touches BAND 5 ONLY (observed OFF in the
 * template -> inaudible), and RESTORES every value it changes, confirming the
 * restore by readback.
 *
 * WHAT IT ANSWERS:
 *   1. Do sets land on the normalized params (write -> readback -> display)?
 *   2. Q mapping second datapoint: predict Q = 0.1 * 180^v, check vs Live.
 *   3. Frequency mapping write-side check: predict Hz = 10 * 2200^v.
 *   4. The FULL Filter Type enum: cycle 0..7, read Live's label for each.
 *   5. Does /live/device/start_listen/parameter/value answer (listener echo
 *      on set)? Decides the EQ mirror's truth-flow design.
 *
 * Do NOT run while the rig server is up (both bind UDP 11001).
 *
 *   TRACK=0 DEVICE=2 node --experimental-strip-types src/07-eq-write-probe.ts
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage, type OscValue } from './osc-helper.ts';

const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 2);
const BAND = Number(process.env.BAND ?? 5); // OFF in the template = safe

const near = (a: number, b: number, eps = 2e-3) => Math.abs(a - b) < eps;
const predictHz = (v: number) => 10 * Math.pow(2200, v);
const predictQ = (v: number) => 0.1 * Math.pow(180, v);

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  const ask = async (
    address: string,
    args: OscValue[],
    match: (m: OscMessage) => boolean,
    timeoutMs = 1500,
  ): Promise<OscMessage | null> => {
    c.send(address, args);
    try {
      return await c.waitFor(match, timeoutMs);
    } catch {
      return null;
    }
  };

  const getVal = (p: number) =>
    ask('/live/device/get/parameter/value', [TRACK, DEVICE, p], (m) =>
      m.address.endsWith('/parameter/value') && Number(m.args[2]) === p,
    );
  const getStr = (p: number) =>
    ask('/live/device/get/parameter/value_string', [TRACK, DEVICE, p], (m) =>
      m.address.includes('value_string') && Number(m.args[2]) === p,
    );
  const last = (m: OscMessage | null) => (m ? m.args[m.args.length - 1] : null);

  try {
    // ---- resolve band params BY NAME (house rule) -------------------------
    const nameR = await ask('/live/device/get/parameters/name', [TRACK, DEVICE], (m) =>
      m.address.includes('parameters/name'),
    );
    if (!nameR) throw new Error('no reply to parameters/name — Live + engine up? rig server stopped?');
    const names = nameR.args.slice(2).map(String);
    const idx = (want: string) => {
      const i = names.findIndex((n) => n === want);
      if (i < 0) throw new Error(`param "${want}" not found`);
      return i;
    };
    const pOn = idx(`${BAND} Filter On A`);
    const pType = idx(`${BAND} Filter Type A`);
    const pFreq = idx(`${BAND} Frequency A`);
    const pQ = idx(`${BAND} Q A`);

    // ---- safety gate: band must be OFF ------------------------------------
    const onNow = Number(last(await getVal(pOn)));
    console.log(`band ${BAND} Filter On A = ${onNow} (${onNow === 0 ? 'OFF — safe to probe' : 'ON'})`);
    if (onNow !== 0) throw new Error(`band ${BAND} is ON — refusing to write. Pick an OFF band via BAND=n.`);

    // ---- save originals ---------------------------------------------------
    const orig = {
      type: Number(last(await getVal(pType))),
      freq: Number(last(await getVal(pFreq))),
      q: Number(last(await getVal(pQ))),
    };
    console.log(`originals: type=${orig.type} freq=${orig.freq} q=${orig.q}`);

    // ---- listener probe on the Q param ------------------------------------
    // Arm, then watch for ANY unsolicited /parameter/value echo for this
    // param after the write below. AbletonOSC listener replies typically ride
    // the matching get address.
    let listenerEchoes = 0;
    c.onMessage((m) => {
      if (m.address.endsWith('/parameter/value') && Number(m.args[2]) === pQ) listenerEchoes++;
    });
    c.send('/live/device/start_listen/parameter/value', [TRACK, DEVICE, pQ]);
    await new Promise((r) => setTimeout(r, 400)); // give an on-arm echo a beat
    const echoesAfterArm = listenerEchoes;
    console.log(`listener arm: ${echoesAfterArm > 0 ? `echo on arm (${echoesAfterArm})` : 'silent on arm'}`);

    // ---- WRITE 1: Q -> 0.7 ------------------------------------------------
    const echoesBeforeQ = listenerEchoes;
    c.send('/live/device/set/parameter/value', [TRACK, DEVICE, pQ, 0.7]);
    await new Promise((r) => setTimeout(r, 400));
    // sample the counter BEFORE issuing any GET (a GET reply rides the same
    // address and would pollute the count) — anything counted in this window
    // is an UNSOLICITED listener echo.
    const unsolicited = listenerEchoes - echoesBeforeQ;
    const qBack = Number(last(await getVal(pQ)));
    const qStr = String(last(await getStr(pQ)));
    console.log(
      `Q write: set 0.7 -> readback ${qBack} ${near(qBack, 0.7) ? '✓' : '✗ MISMATCH'} · display "${qStr}" vs predicted ${predictQ(0.7).toFixed(2)}`,
    );
    console.log(
      `listener echo on Q set: ${unsolicited > 0 ? `YES (${unsolicited} unsolicited) — parameter listener SUPPORTED` : 'NONE in the 400 ms window — listener unsupported or silent'}`,
    );

    // ---- WRITE 2: Frequency -> 0.75 ---------------------------------------
    c.send('/live/device/set/parameter/value', [TRACK, DEVICE, pFreq, 0.75]);
    await new Promise((r) => setTimeout(r, 300));
    const fBack = Number(last(await getVal(pFreq)));
    const fStr = String(last(await getStr(pFreq)));
    console.log(
      `Freq write: set 0.75 -> readback ${fBack} ${near(fBack, 0.75) ? '✓' : '✗ MISMATCH'} · display "${fStr}" vs predicted ${Math.round(predictHz(0.75))} Hz`,
    );

    // ---- Filter Type enum sweep 0..7 --------------------------------------
    console.log('Filter Type enum:');
    for (let t = 0; t <= 7; t++) {
      c.send('/live/device/set/parameter/value', [TRACK, DEVICE, pType, t]);
      await new Promise((r) => setTimeout(r, 150));
      const label = String(last(await getStr(pType)));
      console.log(`  ${t} = "${label}"`);
    }

    // ---- RESTORE ----------------------------------------------------------
    const restore = async (p: number, v: number, label: string) => {
      c.send('/live/device/set/parameter/value', [TRACK, DEVICE, p, v]);
      await new Promise((r) => setTimeout(r, 200));
      const back = Number(last(await getVal(p)));
      console.log(`restore ${label} -> ${v}: readback ${back} ${near(back, v) ? '✓' : '✗ NOT RESTORED'}`);
    };
    await restore(pType, orig.type, 'type');
    await restore(pFreq, orig.freq, 'freq');
    await restore(pQ, orig.q, 'q');

    c.send('/live/device/stop_listen/parameter/value', [TRACK, DEVICE, pQ]);
    console.log('');
    console.log('Done. Paste this whole output back.');
  } catch (e) {
    console.log(`\n✗ ${(e as Error).message}`);
    rigHint();
  } finally {
    c.close();
  }
}

main();
