/**
 * engine-hello.ts — confirm OUR custom engine extension is loaded (not just
 * stock AbletonOSC). The extension announces itself unsolicited on
 * /live/engine/hello at init, AND (per the analysis) responds to a request on
 * the same address. We try the request/response path with a listener already
 * armed, so we catch either the solicited reply or a late unsolicited announce.
 *
 *   node --experimental-strip-types src/engine-hello.ts
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  c.onMessage((m: OscMessage) => {
    if (m.address.includes('engine') || m.address.includes('hello')) {
      console.log(`  ‹reply› ${m.address}  [${m.args.join(', ')}]`);
    }
  });

  console.log('Asking /live/engine/hello (custom extension announce)…');
  c.send('/live/engine/hello', []);

  try {
    const hit = await c.waitFor(
      (m) => m.address.includes('engine') || m.address.includes('hello'),
      3000,
    );
    console.log('');
    console.log(`✓ CUSTOM ENGINE ALIVE — ${hit.address} [${hit.args.join(', ')}]`);
    console.log('  This proves engine/extension.py loaded, not just stock AbletonOSC.');
  } catch (e) {
    console.log(`\n✗ No engine hello within 3s: ${(e as Error).message}`);
    console.log('  Either the custom extension did not load, or it only announces');
    console.log('  unsolicited at init (not on request). If so: quit + reopen Live');
    console.log('  with this prober ALREADY RUNNING to catch the init announce,');
    console.log('  or check Live Log.txt for the /live/engine/hello line.');
    rigHint();
  } finally {
    c.close();
  }
}

main();
