/**
 * ============================================================================
 * HARNESS 02 — LOAD-ITEM LOAD-AND-VERIFY PROBE   (arch §6.7, §11)
 * ----------------------------------------------------------------------------
 * WHAT IT TESTS: the "add an effect" path (Contract 4 add_device / Contract 2
 * browserLoadItem). This is a PROVISIONAL seam (see PROVISIONAL-SEAMS #2):
 * `Browser.load_item` exists in the control-surface API, but load reliability
 * and the post-load device-list READBACK (the "✓ receipt") are unproven, and
 * browser URIs vary by Live version.
 *
 * THE PROBE (load-and-verify, arch §11):
 *   1. select the target track (stock `/live/view/set/selected_track`).
 *   2. snapshot device count BEFORE (stock `/live/track/get/num_devices`).
 *   3. call the ENGINE-EXTENSION load address with a browser item URI.
 *   4. re-read device count AFTER; success = exactly one new device.
 *   (A fuller version also name-matches the new device; count is the minimum.)
 *
 * WHAT TO OBSERVE (to close the seam):
 *   - does the count go up by exactly 1?
 *   - does a known-good URI from the boot index still resolve on this Live?
 *   - is a FAILED load detectable (count unchanged) so the AI knows it failed?
 *
 * ADDRESSES are IMPORTED from Contract 2 (contracts/types/osc.ts) — the
 * shipped engine extension (engine/) implements exactly those, so there is one
 * source of truth and nothing to keep in sync by hand. Provide a real URI via
 * env ITEM_URI (get one with: /live/browser/query — see engine/README) once
 * the engine has indexed the browser.
 *
 * RUNNABLE NOW: pure Node. Without a rig, the gets time out and we say so.
 * ============================================================================
 */

import { OscClient, hostFromEnv, rigHint } from './osc-helper.ts';
import { DOWN } from '../../contracts/types/osc.ts';

// Contract 2 [EXT] address — imported, not duplicated (drift is now impossible):
const LOAD_ADDR = DOWN.browserLoadItem.address;
const TRACK_INDEX = Number(process.env.TRACK ?? 0);
const ITEM_URI = process.env.ITEM_URI ?? ''; // e.g. a Reverb URI from the boot index
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 800);

async function getNumDevices(client: OscClient, track: number): Promise<number> {
  client.send('/live/track/get/num_devices', [track]);
  const reply = await client.waitFor(
    (m) => m.address === '/live/track/get/num_devices' && m.args[0] === track,
    TIMEOUT_MS,
  );
  return Number(reply.args[1]);
}

async function main(): Promise<void> {
  const client = new OscClient({ host: hostFromEnv() });
  await client.bind();

  if (!ITEM_URI) {
    console.log('No ITEM_URI provided — this probe needs a browser item URI from your boot index.');
    console.log('Set ITEM_URI=<uri> (and optionally TRACK=<n>) then re-run.');
    console.log('Structure it WILL execute with a URI:');
    console.log('  1) select track, 2) count devices, 3) load_item, 4) recount, 5) diff.');
    client.close();
    rigHint();
    process.exit(0);
  }

  try {
    console.log(`Selecting track ${TRACK_INDEX}…`);
    client.send('/live/view/set/selected_track', [TRACK_INDEX]);
    await sleep(50);

    const before = await getNumDevices(client, TRACK_INDEX);
    console.log(`Devices before: ${before}`);

    console.log(`Loading item via ${LOAD_ADDR}: ${ITEM_URI}`);
    client.send(LOAD_ADDR, [TRACK_INDEX, ITEM_URI]);
    await sleep(300); // give Live time to instantiate

    const after = await getNumDevices(client, TRACK_INDEX);
    console.log(`Devices after:  ${after}`);

    const delta = after - before;
    if (delta === 1) {
      console.log('✓ PASS: exactly one new device — load-and-verify works. Seam #2 closes for this URI.');
    } else if (delta === 0) {
      console.log('✗ load appears to have FAILED (no new device). Good news: it IS detectable.');
    } else {
      console.log(`⚠ unexpected device delta (${delta}). Investigate — maybe a rack expanded.`);
    }
  } catch (e) {
    console.log('timed out talking to the engine:', (e as Error).message);
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
