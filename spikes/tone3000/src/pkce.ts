/**
 * ============================================================================
 * TONE3000 SPIKE — PKCE helper (RFC 7636, S256)
 * ----------------------------------------------------------------------------
 * PLAIN LANGUAGE: OAuth with PKCE means we prove we're the same app that
 * started the login without needing to ship a secret in client-side code. We
 * make a random "verifier", hash it into a "challenge", send the CHALLENGE when
 * asking the user to log in, then send the VERIFIER when trading the returned
 * code for tokens. TONE3000 requires S256 (SHA-256) and base64url encoding.
 *
 * GROUNDED IN: TONE3000 API docs (code_challenge_method=S256; base64url) and
 * the reference client github.com/tone-3000/t3k-api. No network here — pure
 * crypto, so this file is fully runnable/testable off-rig.
 * ============================================================================
 */

import { createHash, randomBytes } from 'node:crypto';

/** base64url: standard base64 with +/ → -_ and no `=` padding (RFC 7636 §A). */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A high-entropy code verifier (43–128 chars). 32 random bytes → 43 chars. */
export function makeCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge = base64url(SHA256(verifier)). */
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** A random `state` value to defend against CSRF on the callback. */
export function makeState(): string {
  return base64url(randomBytes(16));
}

/** Convenience: everything you need to start an authorize request. */
export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly state: string;
}

export function makePkcePair(): PkcePair {
  const codeVerifier = makeCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: challengeFromVerifier(codeVerifier),
    codeChallengeMethod: 'S256',
    state: makeState(),
  };
}

// Tiny self-test when run directly: `node --import tsx src/pkce.ts` (or ts-node).
// Verifies the challenge is deterministic and base64url-clean.
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = makePkcePair();
  const clean = (s: string) => /^[A-Za-z0-9\-_]+$/.test(s);
  console.log('verifier :', p.codeVerifier);
  console.log('challenge:', p.codeChallenge);
  console.log('state    :', p.state);
  console.log('challenge is deterministic:', challengeFromVerifier(p.codeVerifier) === p.codeChallenge);
  console.log('all base64url-clean       :', clean(p.codeVerifier) && clean(p.codeChallenge) && clean(p.state));
}
