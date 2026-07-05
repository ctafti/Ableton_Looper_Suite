/**
 * engine-ping.ts — ask the engine its version over OSC and print it.
 *
 *   node --experimental-strip-types harnesses/src/engine-ping.ts
 *
 * Hits /live/engine/ping (a REAL request handler in extension.py that replies
 * with (ENGINE_VERSION, PROTOCOL) on the same address). Unlike /live/engine/hello
 * — which is an unsolicited announce at init only — ping works any time, so it's
 * the clean liveness+version probe. Use it to confirm Live actually reloaded a
 * freshly-installed extension.py: the version it prints is the code Live is really
 * running, regardless of what's on disk.
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();
  try {
    console.log('/live/engine/ping …');
    c.send('/live/engine/ping', []);
    const reply: OscMessage = await c.waitFor(
      (m) => m.address.includes('/live/engine/ping') || m.address.includes('/live/engine/hello'),
      3000,
    );
    const [version, protocol] = reply.args;
    console.log(`\n✓ engine is ALIVE`);
    console.log(`  version:  ${version}`);
    console.log(`  protocol: ${protocol}`);
    console.log(`\n  (compare 'version' to ENGINE_VERSION in the extension.py you installed.)`);
  } catch (e) {
    console.log(`\n✗ no ping reply: ${(e as Error).message}`);
    console.log('  Either the engine did not load, AbletonOSC is not selected, or');
    console.log('  Live was not fully quit + reopened after installing the extension.');
    rigHint();
  } finally {
    c.close();
  }
}

main();
