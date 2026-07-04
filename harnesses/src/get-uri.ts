/**
 * get-uri.ts — throwaway helper to fetch a REAL browser URI from the engine.
 *
 * Flow (arch §11): rescan the browser index, then query by name, then print
 * the first matching URI so you can feed it to 02-load-item-verify.ts.
 *
 *   NAME="Reverb" node --experimental-strip-types src/get-uri.ts
 *
 * Defaults to querying "Reverb". Override with NAME=<something in your browser>.
 */
import { OscClient, hostFromEnv, rigHint, type OscMessage } from './osc-helper.ts';

const NAME = process.env.NAME ?? 'Reverb';
const MAX = Number(process.env.MAX ?? 5);

async function main() {
  const c = new OscClient({ host: hostFromEnv() });
  await c.bind();

  // Log every reply so we can see the engine's actual address/arg shapes.
  c.onMessage((m: OscMessage) => {
    console.log(`  ‹reply› ${m.address}  [${m.args.join(', ')}]`);
  });

  try {
    // 1) Build/refresh the lazy browser index. First call can be slow — it
    //    walks Live's whole browser tree — so give it a generous timeout.
    console.log('Rescanning browser index (first run can take several seconds)…');
    c.send('/live/browser/rescan', []);
    const scan = await c.waitFor(
      (m) => m.address.includes('browser') && m.address.includes('rescan'),
      15000,
    );
    console.log(`Index built. rescan reply args: [${scan.args.join(', ')}]`);

    // 2) Query by name. Reply comes back on a browser* address carrying the URI.
    console.log(`Querying for "${NAME}" (max ${MAX})…`);
    c.send('/live/browser/query', [NAME, MAX]);
    const hit = await c.waitFor(
      (m) => m.address.includes('browser') && !m.address.includes('rescan'),
      5000,
    );

    console.log('');
    console.log(`RAW query reply: address=${hit.address}`);
    console.log(`RAW query args : [${hit.args.join(', ')}]`);
    console.log('');

    // The URI is whichever string arg looks like a browser path. Print all
    // string args so you can eyeball the right one; also guess the first.
    const strings = hit.args.filter((a): a is string => typeof a === 'string');
    if (strings.length === 0) {
      console.log('No string args in the reply — the URI may be encoded differently.');
      console.log('Look at the RAW args above and tell your AI what shape they are.');
    } else {
      console.log('String args returned (a URI is usually the query:... one):');
      strings.forEach((s, i) => console.log(`  [${i}] ${s}`));
      const uri = strings.find((s) => s.includes(':')) ?? strings[strings.length - 1];
      console.log('');
      console.log('Best-guess URI to use next:');
      console.log(`  ITEM_URI='${uri}' node --experimental-strip-types src/02-load-item-verify.ts`);
    }
  } catch (e) {
    console.log(`\n✗ ${(e as Error).message}`);
    rigHint();
  } finally {
    c.close();
  }
}

main();
