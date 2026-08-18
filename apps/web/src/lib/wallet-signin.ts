/**
 * wallet-signin.ts -- browser half of Tapit sign-in (the link model).
 *
 * Flow: mint a challenge (server) -> hand it to the Tapit wallet -> the wallet
 * proves key control and redirects back with ?grant= -> we post the proof to
 * the server, which verifies it and (for sign-in) mints a session token we
 * redeem here into a real Supabase session.
 *
 * Transport contract = the tapit-wallet sign-request protocol (DT is the
 * consumer):
 *   request:  <WALLET>/sign?req=<b64url(JSON{intent:'sign-in',origin,callback,challenge})>
 *   response: <callback>?grant=<base64(JSON{v,signIn})>
 *   The wallet returns the SignInAttestation in the grant's `signIn` field.
 *   Our callback carries ?tapit_mode= (signin vs link) and MUST land on a
 *   RequireAuth-covered path (not the public Landing at "/"), so we route it
 *   through /keys.
 *
 * Green/red is NOT here -- the liveness ladder is the single green/red model.
 * This only proves key control and logs in. No keys are touched.
 */

import { supabase } from './supabase';

const API = '/api';

// The Tapit wallet's sign handler. Override per-env with VITE_TAPIT_WALLET_URL.
// Exported so other Tapit sign-request intents (e.g. lib/tapit-cosign.ts's
// psbt-cosign, Cut B stage B2) hit the same wallet without a second env
// override to keep in sync.
export const WALLET_SIGN_URL =
  (import.meta.env.VITE_TAPIT_WALLET_URL as string | undefined) ??
  'https://tapit-wallet.netlify.app/sign';

// The wallet's plain root -- visiting it with no existing session routes
// into Tapit's own FreshOnboarding (tapit-wallet's WalletProvider/
// FreshLoginShell gate on wallet state at that root, no query params
// needed). Used for "new to Tapit, create an account" -- deliberately NOT
// the /sign challenge URL above, which bundles a DynastyTrust sign-in
// request that makes no sense for someone who has nothing to sign yet.
export const WALLET_BASE_URL = WALLET_SIGN_URL.replace(/\/sign\/?$/, '') || WALLET_SIGN_URL;

export type TapitMode = 'signin' | 'link';

// Challenge + attestation payloads are pure ASCII (hex, ISO timestamps, a
// domain), so plain btoa/atob are safe -- no escape()/unescape() needed.
// Exported for lib/tapit-cosign.ts to reuse the identical encoding the
// wallet expects rather than a second hand-rolled copy.
export function b64urlEncode(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64Decode<T>(s: string): T {
  // Tolerant of both base64 (what the wallet's btoa emits) and base64url.
  return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/'))) as T;
}

/**
 * Start a sign-in (fresh login) or link (bind while logged in). Mints a
 * challenge, packages it for the wallet, and navigates there.
 */
export async function startTapitFlow(mode: TapitMode): Promise<void> {
  const res = await fetch(`${API}/wallet-signin-challenge`, { method: 'POST' });
  const text = await res.text();
  let payload: { challenge?: unknown; error?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Could not start Tapit sign-in (server returned non-JSON)');
  }
  if (!res.ok || !payload.challenge) {
    throw new Error(payload.error ?? 'Could not start Tapit sign-in');
  }
  // Land on /keys so RequireAuth's callback handler runs (the public Landing
  // at "/" would not). tapit_mode rides along; the wallet preserves it and
  // appends ?grant=.
  const callback = `${window.location.origin}/keys?tapit_mode=${mode}`;
  const req = b64urlEncode({
    intent: 'sign-in',
    origin: 'DynastyTrust',
    callback,
    challenge: payload.challenge,
  });
  window.location.href = `${WALLET_SIGN_URL}?req=${req}`;
}

export interface TapitCallback {
  mode: TapitMode;
  grant: unknown;
}

/** If the current URL is a wallet redirect, parse it. Returns null otherwise. */
export function readTapitCallback(): TapitCallback | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('grant');
  if (!raw) return null;
  const mode: TapitMode = params.get('tapit_mode') === 'link' ? 'link' : 'signin';
  try {
    return { mode, grant: b64Decode<unknown>(raw) };
  } catch {
    return null;
  }
}

export interface TapitResult {
  mode: TapitMode;
}

// The wallet returns the attestation in grant.signIn; tolerate grant.attestation too.
function attestationFromGrant(grant: unknown): unknown {
  if (grant && typeof grant === 'object') {
    const g = grant as Record<string, unknown>;
    return g.signIn ?? g.attestation;
  }
  return undefined;
}

/**
 * Complete the flow. For 'signin', verify the proof server-side then redeem
 * the returned magiclink token into a Supabase session. For 'link', post the
 * proof to the JWT-gated bind endpoint.
 */
export async function completeTapitCallback(cb: TapitCallback): Promise<TapitResult> {
  const attestation = attestationFromGrant(cb.grant);
  if (!attestation) throw new Error('Wallet returned no sign-in proof');
  const grant = { attestation };

  if (cb.mode === 'link') {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sign in before linking a wallet');
    const res = await fetch(`${API}/wallet-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ grant }),
    });
    const payload = await parseJson(res);
    if (!res.ok) throw new Error((payload.error as string) ?? 'Could not link wallet');
    return { mode: 'link' };
  }

  const res = await fetch(`${API}/wallet-signin-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant }),
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error((payload.error as string) ?? 'Tapit sign-in failed');

  const { error } = await supabase.auth.verifyOtp({
    token_hash: payload.token_hash as string,
    type: 'magiclink',
  });
  if (error) throw new Error(error.message);

  return { mode: 'signin' };
}

export function clearTapitCallbackUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('grant');
  url.searchParams.delete('tapit_mode');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected server response: ${text.slice(0, 120)}`);
  }
}
