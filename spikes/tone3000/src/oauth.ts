/**
 * ============================================================================
 * TONE3000 SPIKE — OAuth 2.0 authorize + token exchange
 * ----------------------------------------------------------------------------
 * PLAIN LANGUAGE: two steps of the login.
 *   1) buildAuthorizeUrl(): the URL we send the user to (in a browser / QR).
 *      They approve, TONE3000 redirects back to our redirect_uri with a `code`.
 *   2) exchangeCodeForToken(): trade that `code` (+ our PKCE verifier) for an
 *      access_token we can use as a Bearer to call the API.
 *   Plus refreshToken() for when the access token expires.
 *
 * GROUNDED IN: TONE3000 API docs, verified 2026-07-01:
 *   - Base: https://www.tone3000.com/api/v1/
 *   - GET  /oauth/authorize  params: client_id, redirect_uri, response_type=code,
 *          code_challenge, code_challenge_method=S256, state,
 *          optional: prompt (select_tone|load_tone), tone_id, gears, format,
 *          architecture, calibrated, menubar, login_hint
 *   - POST /oauth/token  (application/x-www-form-urlencoded):
 *          grant_type=authorization_code|refresh_token, code, code_verifier,
 *          redirect_uri, client_id → { access_token, refresh_token,
 *          token_type:'bearer', expires_in, scope }
 *   - client_id = the PUBLISHABLE key (client-safe). The secret key (t3k_cs_…)
 *     is server-only and is NOT used in the PKCE flow.
 *
 * OFF-RIG SAFETY: buildAuthorizeUrl is pure string work (runnable now).
 * exchangeCodeForToken/refreshToken hit the real TONE3000 token endpoint, so
 * they only work with a real code/creds — see README "to run for real".
 * ============================================================================
 */

export const TONE3000 = {
  base: 'https://www.tone3000.com/api/v1',
  authorizePath: '/oauth/authorize',
  tokenPath: '/oauth/token',
} as const;

export interface AuthorizeParams {
  clientId: string; // publishable key
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** optional UX hints from the docs. */
  prompt?: 'select_tone' | 'load_tone';
  toneId?: number;
  /** architecture=2 selects A2 (see fetch-a2-model.ts). */
  architecture?: number;
  gears?: string;
  format?: string;
  loginHint?: string;
}

/** Build the authorize URL to open in a browser / encode as a QR. Pure. */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    state: p.state,
  });
  if (p.prompt) q.set('prompt', p.prompt);
  if (p.toneId != null) q.set('tone_id', String(p.toneId));
  if (p.architecture != null) q.set('architecture', String(p.architecture));
  if (p.gears) q.set('gears', p.gears);
  if (p.format) q.set('format', p.format);
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${TONE3000.base}${TONE3000.authorizePath}?${q.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer' | string;
  expires_in: number;
  scope?: string;
}

/**
 * Trade an authorization `code` for tokens. Hits the real token endpoint.
 * Uses x-www-form-urlencoded per the docs. No client secret (PKCE public client).
 */
export async function exchangeCodeForToken(args: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
  });
  const res = await fetch(`${TONE3000.base}${TONE3000.tokenPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await safeText(res)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh an expired access token. */
export async function refreshToken(args: {
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  });
  const res = await fetch(`${TONE3000.base}${TONE3000.tokenPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`refresh failed: ${res.status} ${await safeText(res)}`);
  }
  return (await res.json()) as TokenResponse;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
