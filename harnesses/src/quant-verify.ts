/**
 * quant-verify.ts — §6.2: verify the QUANT_BEATS assumption on the real rig.
 *
 * hub/src/lifecycle/lifecycle.ts freezes the beats->ms MATH but marks the
 * index->label lookup (QUANT_BEATS) "ASSUMED — verify on rig." This probe reads
 * /live/song/get/clip_trigger_quantization and interprets the returned index
 * against the assumed table, so you can confirm (by setting Live's transport
 * quantization dropdown to known values) that index N really means label L.
 *
 *   node --experimental-strip-types src/quant-verify.ts
 *
 * VERIFY LOOP: set Live's global launch-quantization dropdown (transport bar,
 * top-center) to each of these and re-run — the printed index must match:
 *     "None"  -> 0      "1 Bar" -> 4      "1/4" -> 7      "1/8" -> 9
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

// Mirror of QUANT_BEATS + the Live labels the indices are ASSUMED to mean.
const TABLE: { idx: number; label: string; beats: number }[] = [
  { idx: 0, label: 'None', beats: 0 },
  { idx: 1, label: '8 Bars', beats: 32 },
  { idx: 2, label: '4 Bars', beats: 16 },
  { idx: 3, label: '2 Bars', beats: 8 },
  { idx: 4, label: '1 Bar', beats: 4 },
  { idx: 5, label: '1/2', beats: 2 },
  { idx: 6, label: '1/2T', beats: 4 / 3 },
  { idx: 7, label: '1/4', beats: 1 },
  { idx: 8, label: '1/4T', beats: 2 / 3 },
  { idx: 9, label: '1/8', beats: 0.5 },
  { idx: 10, label: '1/8T', beats: 1 / 3 },
  { idx: 11, label: '1/16', beats: 0.25 },
  { idx: 12, label: '1/16T', beats: 1 / 6 },
  { idx: 13, label: '1/32', beats: 0.125 },
];

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  console.log('Reading /live/song/get/clip_trigger_quantization…');
  c.send('/live/song/get/clip_trigger_quantization', []);

  try {
    const reply: OscMessage = await c.waitFor(
      (m) => m.address.includes('clip_trigger_quantization'),
      1500,
    );
    const idx = typeof reply.args[0] === 'number' ? reply.args[0] : NaN;
    console.log(`raw reply: ${reply.address} [${reply.args.join(', ')}]`);
    console.log('');

    const row = TABLE.find((r) => r.idx === idx);
    if (!row) {
      console.log(`✗ index ${idx} is OUTSIDE the assumed table (0..13).`);
      console.log('  → Live enum ordering differs from QUANT_BEATS. Record the');
      console.log('    full mapping in API-REALITY before trusting the table.');
    } else {
      console.log(`Current quantization: index ${idx}`);
      console.log(`  table says  → Live label "${row.label}", ${row.beats} beats/boundary`);
      console.log('');
      console.log('CONFIRM: does Live\'s transport quantization dropdown right now');
      console.log(`         actually show "${row.label}"?`);
      console.log('  • YES → this row of QUANT_BEATS is verified.');
      console.log('  • NO  → mismatch! record what the dropdown really shows vs index.');
      console.log('');
      console.log('Triangulate the whole table by setting the dropdown to each and re-running:');
      console.log('  None → expect 0   |   1 Bar → expect 4   |   1/4 → expect 7   |   1/8 → expect 9');
    }
  } catch (e) {
    console.log(`\n✗ no reply: ${(e as Error).message}`);
    rigHint();
  } finally {
    c.close();
  }
}

main();
