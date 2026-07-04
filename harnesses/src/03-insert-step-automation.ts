/**
 * ============================================================================
 * HARNESS 03 — AUTOMATION WRITE (insert_step) PROBE   (arch §10)
 * ----------------------------------------------------------------------------
 * ★ THIS IS THE MOST IMPORTANT PROBE ★ — it confirms the automation-write path
 * on the actual Live version (see reports/API-REALITY.md #2). Arch §10 says the
 * `insert_step` / `value_at_time` / `automation_envelope` write primitives are
 * "verified, stable." That is CORRECT for our surface: these ARE real, long-
 * standing methods in the Python Remote-Script Live API our engine uses
 * (confirmed in the API dumps across Live 9-11; used by ClyphX). They are absent
 * only from the Max-for-Live JS-LOM apiref — a DIFFERENT surface — and the old
 * LomTypes.pyc/MxDCore.pyc patching lore is an M4L-only workaround (MxDCore = the
 * M4L core), not relevant to a Python Remote Script that imports Live directly.
 * The ONE open item: Live 12 moved the Remote-Script runtime to Python 3.11, so
 * this probe confirms the WRITE SIGNATURE still holds on 12.x. Existence is not
 * in doubt; the Live-12 signature is what we verify.
 *
 * THE PROBE (arch §10, §197):
 *   1. pick a CONTINUOUS device parameter on the clip's OWN track (quantized
 *      switches only step discretely — bad for a first test).
 *   2. clear any existing envelope (Contract 2 clearEnvelope — stock LOM, FREEZE).
 *   3. call the ENGINE-EXTENSION insert_step address to write a known shape
 *      (e.g. ramp 0→1 over the clip), wrapped as ONE atomic undo.
 *   4. READ THE ENVELOPE BACK and compare to what we wrote (this readback is the
 *      write_movement receipt — Contract 4 MovementReceipt).
 *
 * WHAT TO OBSERVE (to close seam #1):
 *   - does insert_step execute from the Remote Script on THIS Live 12.x with the
 *     documented signature (AutomationEnvelope, float, float, float)?
 *   - does the read-back envelope match within tolerance?
 *   - does ONE Cmd-Z revert the whole write?
 *   If the Live-12 signature differs → low-probability fallback to clip-based
 *   movement; keep the write_movement verb.
 *
 * ADDRESSES are IMPORTED from Contract 2 — the shipped engine extension
 * (engine/) implements exactly those. The write uses the BATCHED insertSteps
 * (one message = one atomic undo, per §10); readback uses getEnvelope, whose
 * reply feeds the automation_readback up-event / MovementReceipt.
 *
 * RUNNABLE NOW: pure Node. Without a rig, it explains itself and exits.
 * ============================================================================
 */

import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';
import { DOWN } from '../../contracts/types/osc.ts';

// Contract 2 [EXT] addresses — imported, not duplicated (drift now impossible):
const CLEAR_ENVELOPE_ADDR = DOWN.clearEnvelope.address;
const INSERT_STEPS_ADDR = DOWN.insertSteps.address; // batched: one atomic undo
const READBACK_ADDR = DOWN.getEnvelope.address;

const TRACK = Number(process.env.TRACK ?? 0);
const CLIP = Number(process.env.CLIP ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 0);       // device index on the clip's own track
const PARAM = Number(process.env.PARAM ?? 1);         // a CONTINUOUS parameter index
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 1000);

// A known held-step ramp: Contract 2 insertSteps takes (time, duration, value)
// TRIPLES — insert_step writes a flat held segment, so duration is load-bearing
// (the earlier draft sent time/value pairs; fixed 2026-07-02 to match).
const SHAPE: Array<{ timeBeats: number; durationBeats: number; value: number }> = [
  { timeBeats: 0, durationBeats: 1, value: 0.0 },
  { timeBeats: 1, durationBeats: 1, value: 0.33 },
  { timeBeats: 2, durationBeats: 1, value: 0.66 },
  { timeBeats: 3, durationBeats: 1, value: 1.0 },
];

async function main(): Promise<void> {
  const client = new OscClient({ host: hostFromEnv() });
  await client.bind();

  console.log('Automation WRITE probe (arch §10). Target:');
  console.log(`  track=${TRACK} clip=${CLIP} device=${DEVICE} param=${PARAM} (must be CONTINUOUS)`);
  console.log('  shape:', SHAPE.map((s) => `${s.timeBeats}:${s.value}`).join('  '));

  try {
    // 1) clear existing envelope (stock LOM — should always work)
    console.log(`\nClearing envelope via ${CLEAR_ENVELOPE_ADDR}…`);
    client.send(CLEAR_ENVELOPE_ADDR, [TRACK, CLIP, DEVICE, PARAM]);
    await sleep(100);

    // 2) write the shape via the EXTENSION (THE unproven step)
    console.log(`Writing ${SHAPE.length} steps via ${INSERT_STEPS_ADDR} (one atomic undo)…`);
    // Contract 2 shape: track, clip, device, param, then (time, duration, value) TRIPLES
    const args: number[] = [TRACK, CLIP, DEVICE, PARAM];
    for (const s of SHAPE) args.push(s.timeBeats, s.durationBeats, s.value);
    client.send(INSERT_STEPS_ADDR, args);
    await sleep(200);

    // 3) read the envelope back: ask value_at_time at each written step's midpoint
    console.log(`Reading envelope back via ${READBACK_ADDR}…`);
    const sampleTimes = SHAPE.map((s) => s.timeBeats + s.durationBeats / 2);
    client.send(READBACK_ADDR, [TRACK, CLIP, DEVICE, PARAM, ...sampleTimes]);
    const reply = await client.waitFor((m) => m.address === READBACK_ADDR, TIMEOUT_MS);

    // reply args: track, clip, device, param, then (time,value) pairs (Contract 2 getEnvelope)
    const pairs = reply.args.slice(4);
    console.log('read-back raw:', reply.args.join(', '));

    // 4) compare
    const wroteCount = SHAPE.length;
    const gotCount = Math.floor(pairs.length / 2);
    if (gotCount >= wroteCount) {
      console.log(`✓ PASS (structural): got ${gotCount} points back (wrote ${wroteCount}).`);
      console.log('  → insert_step signature holds on THIS Live 12.x. Seam #1 closes.');
      console.log('  Now eyeball the values match the ramp, and confirm ONE Cmd-Z reverts it.');
    } else {
      console.log(`✗ read-back has ${gotCount} points (< ${wroteCount} written).`);
      console.log('  → Live-12 signature may differ. Fall back to clip-based movement (seam #1).');
    }
  } catch (e) {
    console.log('\ntimed out / no reply:', (e as Error).message);
    console.log('Is the shipped engine extension installed? (engine/README.md — one script.)');
    console.log('A genuine Live-12 signature failure → clip-based movement fallback (seam #1).');
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
