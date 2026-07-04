/**
 * ============================================================================
 * TONE3000 SPIKE — headless LAN / QR authorization flow
 * ----------------------------------------------------------------------------
 * PLAIN LANGUAGE: the rig has no keyboard-friendly browser session, so we do the
 * "device opens a little web listener, shows a QR, you approve on your phone"
 * flow (matches arch §2/§9 TONE3000 QR sign-in). Steps:
 *   1) start a tiny HTTP listener on this machine's LAN IP + a port.
 *   2) build the authorize URL with redirect_uri = that LAN URL, print it + a QR.
 *   3) you open it on your phone, approve; TONE3000 redirects the browser to our
 *      listener with ?code=…&state=…; we capture it, verify state, and exchange
 *      the code for tokens using the PKCE verifier.
 *
 * GROUNDED IN: TONE3000 docs' headless QR/LAN flow (localhost redirect URIs are
 * auto-allowed in dev; production register redirect URIs in settings).
 *
 * RUN: this one is INTERACTIVE and needs a real publishable key. Without creds
 * it prints exactly what it WOULD do and exits (so it's safe to run off-rig).
 * See README "to run for real".
 * ============================================================================
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { makePkcePair } from './pkce.ts';
import { buildAuthorizeUrl, exchangeCodeForToken, type TokenResponse } from './oauth.ts';

/** Best-effort LAN IPv4 (first non-internal). Falls back to 127.0.0.1. */
export function lanIPv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

export interface HeadlessResult {
  tokens: TokenResponse;
  redirectUri: string;
}

/**
 * Runs the full interactive flow. Resolves with tokens once the user approves.
 * `printQr` is injected so we don't hard-depend on a QR lib in the spike; pass
 * one in real usage (e.g. qrcode-terminal). The default just prints the URL.
 */
export async function runHeadlessFlow(opts: {
  clientId: string;
  port?: number;
  architecture?: number;
  printQr?: (url: string) => void;
  timeoutMs?: number;
}): Promise<HeadlessResult> {
  const port = opts.port ?? 47700;
  const ip = lanIPv4();
  const redirectUri = `http://${ip}:${port}/callback`;
  const pkce = makePkcePair();
  const authUrl = buildAuthorizeUrl({
    clientId: opts.clientId,
    redirectUri,
    codeChallenge: pkce.codeChallenge,
    state: pkce.state,
    prompt: 'select_tone',
    architecture: opts.architecture,
  });

  (opts.printQr ?? ((u) => console.log('Open on your phone:\n' + u)))(authUrl);

  return await new Promise<HeadlessResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('headless flow timed out waiting for approval'));
    }, opts.timeoutMs ?? 180_000);

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${ip}:${port}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end('not found');
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || state !== pkce.state) {
          res.writeHead(400).end('bad state or missing code');
          reject(new Error('state mismatch or missing code'));
          return;
        }
        const tokens = await exchangeCodeForToken({
          clientId: opts.clientId,
          code,
          codeVerifier: pkce.codeVerifier,
          redirectUri,
        });
        res.writeHead(200, { 'content-type': 'text/html' })
          .end('<h2>TONE3000 connected. You can close this tab.</h2>');
        clearTimeout(timer);
        server.close();
        resolve({ tokens, redirectUri });
      } catch (err) {
        res.writeHead(500).end('error');
        clearTimeout(timer);
        server.close();
        reject(err as Error);
      }
    });
    server.listen(port, () => console.log(`listening for TONE3000 callback on ${redirectUri}`));
  });
}

// CLI entry: reads T3K_CLIENT_ID from env; stubs out cleanly if absent.
if (import.meta.url === `file://${process.argv[1]}`) {
  const clientId = process.env.T3K_CLIENT_ID;
  if (!clientId) {
    const ip = lanIPv4();
    console.log('[STUB] No T3K_CLIENT_ID set — not starting a real flow.');
    console.log('[STUB] To run for real: set T3K_CLIENT_ID (publishable key) and re-run.');
    console.log(`[STUB] Would listen on   http://${ip}:47700/callback`);
    console.log('[STUB] Would open authorize URL:');
    console.log(
      buildAuthorizeUrl({
        clientId: 'pk_PUBLISHABLE_KEY_HERE',
        redirectUri: `http://${ip}:47700/callback`,
        codeChallenge: 'CHALLENGE',
        state: 'STATE',
        prompt: 'select_tone',
        architecture: 2,
      }),
    );
    process.exit(0);
  }
  runHeadlessFlow({ clientId, architecture: 2 })
    .then((r) => console.log('got tokens (scope:', r.tokens.scope, ')'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
