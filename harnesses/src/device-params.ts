/**
 * device-params.ts — read a device's parameter NAMES over OSC and confirm a
 * target param is present. Proves a js2max-GENERATED device is hub-addressable
 * (the whole point of the device-generation pipeline).
 *
 *   TRACK=0 DEVICE=0 WANT=Gain node --experimental-strip-types src/device-params.ts
 *
 * Uses stock AbletonOSC device addresses (confirmed in device.py):
 *   /live/device/get/num_parameters   (track, device) -> (track, device, count)
 *   /live/device/get/parameters/name  (track, device) -> (track, device, name0, name1, ...)
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

const TRACK = Number(process.env.TRACK ?? 0);
const DEVICE = Number(process.env.DEVICE ?? 0);
const WANT = process.env.WANT ?? 'Gain';

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  try {
    // 1. how many params?
    console.log(`/live/device/get/num_parameters (track=${TRACK}, device=${DEVICE})…`);
    c.send('/live/device/get/num_parameters', [TRACK, DEVICE]);
    const numReply: OscMessage = await c.waitFor(
      (m) => m.address.includes('num_parameters'),
      1500,
    );
    const count = numReply.args[numReply.args.length - 1];
    console.log(`  device reports ${count} parameters`);

    // 2. read the names
    console.log('/live/device/get/parameters/name…');
    c.send('/live/device/get/parameters/name', [TRACK, DEVICE]);
    const nameReply: OscMessage = await c.waitFor(
      (m) => m.address.includes('parameters/name'),
      1500,
    );
    // reply args: (track, device, name0, name1, ...) — drop the first two
    const names = nameReply.args
      .slice(2)
      .filter((a): a is string => typeof a === 'string');

    console.log('');
    console.log('Parameters on this device:');
    names.forEach((n, i) => console.log(`  [${i}] ${n}`));
    console.log('');

    if (names.includes(WANT)) {
      console.log(`✓ CONFIRMED: "${WANT}" is present and readable over OSC.`);
      console.log('  A GENERATED device exposes a hub-addressable parameter by name.');
      console.log('  → Device-generation pipeline is proven END TO END.');
    } else {
      console.log(`✗ "${WANT}" not found among the names above.`);
      console.log('  Either wrong track/device index, or the generated param is');
      console.log('  not a real Live parameter (check the .amxd has a live.* object).');
    }
  } catch (e) {
    console.log(`\n✗ ${(e as Error).message}`);
    rigHint();
  } finally {
    c.close();
  }
}

main();
