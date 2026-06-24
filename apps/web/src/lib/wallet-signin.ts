/**
 * wallet-signin.ts -- browser half of Tapit sign-in (the link model).
 *
 * Flow: mint a challenge (server) -> hand it to the Tapit wallet -> the wallet
 * proves key control and redirects back with ?tapit_grant= -> we post the
 * grant to the server, which verifies the proof and (for sign-in) mints a
 * session token we redeem here into a real Supabase session.
 *
 * Transport contract with the wallet (DT side defined here; the wallet's
 * /sign handler is the matching cut in tapit-wallet):
 *   request:  <WALLET>/sign?req=<b64url(JSON{intent,challenge,return_url})>
 *   response: <return_url>?tapit_grant=<b64url(JSON{attestation})>&tapit_mode=...
 *
 * GREEN/RED is guidance only -- a red wallet still signs in; we surface the
 * sweep / readiness flow. Nothing here touches base multisig spend.
 */

import { supabase } from './supabase';

const API = '/api';

// The Tapit wallet's sign handler. Override per-env with VITE_TAPIT_WALLET_URL.
const WALLET_SIGN_URL =
  (import.meta.env.VITE_TAPIT_WALLET_URL as string | undefined) ??
  'https://tapit-wallet.netlify.app/sign';

export type TapitMode = 'signin' | 'link';

// Challenge + attestation payloads are pure ASCII (hex, ISO timestamps, a
// domain), so plain btoa/atob are safe -- no escape()/unescape() needed.
function b64urlEncode(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode<T>(s: string): T {
  return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/'))) as T;
}

/**
 * Start a sign-in (fresh login) or link (bind while logged in). Mints a
 * challenge, packages it for the wallet, and navigates there. The wallet
 * brings the user back to the callback below.
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
  const returnUrl = `${window.location.origin}/?tapit_mode=${mode}`;
  const req = b64urlEncode({ intent: 'sign-in', challenge: payload.challenge, return_url: returnUrl });
  window.location.href = `${WALLET_SIGN_URL}?req=${req}`;
}

export interface TapitCallback {
  mode: TapitMode;
  grant: unknown;
}

/**
 * If the current URL is a wallet redirect, parse it. Returns null otherwise.
 * Caller should clear the URL after handling (clearTapitCallbackUrl).
 */
export function readTapitCallback(): TapitCallback | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('tapit_grant');
  if (!raw) return null;
  const mode: TapitMode = params.get('tapit_mode') === 'link' ? 'link' : 'signin';
  try {
    return { mode, grant: b64urlDecode<unknown>(raw) };
  } catch {
    return null;
  }
}

export interface TapitResult {
  mode: TapitMode;
  red: boolean;
  redReason: string | null;
}

/**
 * Complete the flow. For 'signin', verify the proof server-side then redeem
 * the returned magiclink token into a Supabase session. For 'link', post the
 * proof to the JWT-gated bind endpoint.
 */
export async function completeTapitCallback(cb: TapitCallback): Promise<TapitResult> {
  if (cb.mode === 'link') {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Sign in before linking a wallet');
    const res = await fetch(`${API}/wallet-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ grant: cb.grant }),
    });
    const payload = await parseJson(res);
    if (!res.ok) throw new Error((payload.error as string) ?? 'Could not link wallet');
    return { mode: 'link', red: false, redReason: null };
  }

  const res = await fetch(`${API}/wallet-signin-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: cb.grant }),
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error((payload.error as string) ?? 'Tapit sign-in failed');

  const { error } = await supabase.auth.verifyOtp({
    token_hash: payload.token_hash as string,
    type: 'magiclink',
  });
  if (error) throw new Error(error.message);

  return {
    mode: 'signin',
    red: !!payload.red,
    redReason: (payload.red_reason as string | null) ?? null,
  };
}

export function clearTapitCallbackUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('tapit_grant');
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
