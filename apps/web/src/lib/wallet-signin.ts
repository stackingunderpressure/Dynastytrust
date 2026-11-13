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

import { schnorr } from '@noble/curves/secp256k1';
import { supabase } from './supabase';
import { recordKeySession } from './key-account';
import { signInScreenCode } from 'tapit-attest';

// -- Threat model G (docs/tapit-signin-binding-build-note.md) --------------
// 1. The sign-in number: every request's challenge has a two-digit number
//    (signInScreenCode). This page shows it; the Tapit wallet makes the
//    person type it and signs it into the proof; the server refuses a proof
//    without it. A request nobody started on a screen of their own cannot be
//    approved by tapping through it.
// 2. The login trap: an attacker could approve their OWN request and send
//    someone the return link, signing that person's browser into the
//    attacker's account. So every start remembers its challenge here for a
//    few minutes, and a returning approval for a challenge this browser did
//    not start is refused. localStorage, not sessionStorage: on an iPhone
//    the wallet may hand back to a different tab of the same browser.
const PENDING = 'dt:tapitPending:v1';
const PENDING_TTL_MS = 10 * 60 * 1000;
type Pending = { nonce: string; at: number }[];
function readPending(): Pending {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING) || '[]');
    return Array.isArray(v) ? (v as Pending).filter(p => p && typeof p.nonce === 'string' && Date.now() - p.at < PENDING_TTL_MS) : [];
  } catch {
    return [];
  }
}
function rememberPending(nonce: string): void {
  try { localStorage.setItem(PENDING, JSON.stringify([...readPending(), { nonce, at: Date.now() }].slice(-8))); } catch { /* private mode: the return will be refused, so say so there */ }
}
/** Did THIS browser start the sign-in this nonce belongs to? Consumes it. */
export function takePending(nonce: string): boolean {
  const all = readPending();
  const hit = all.some(p => p.nonce === nonce);
  try { localStorage.setItem(PENDING, JSON.stringify(all.filter(p => p.nonce !== nonce))); } catch { /* nothing to clear */ }
  return hit;
}
/** The two-digit number to show for a request's challenge. */
export function numberFor(challenge: unknown): string {
  return signInScreenCode(challenge as { nonce: string });
}
function nonceOf(challenge: unknown): string {
  const n = (challenge as { nonce?: unknown } | null)?.nonce;
  if (typeof n !== 'string') throw new Error('The sign-in server sent a challenge without a nonce');
  return n;
}

const API = '/api';

// The Tapit wallet's sign handler. Override per-env with VITE_TAPIT_WALLET_URL.
// Exported so other Tapit sign-request intents (e.g. lib/tapit-cosign.ts's
// psbt-cosign, Cut B stage B2) hit the same wallet without a second env
// override to keep in sync.
export const WALLET_SIGN_URL =
  (import.meta.env?.VITE_TAPIT_WALLET_URL as string | undefined) ??
  'https://tapit-wallet.netlify.app/sign';

// The wallet's plain root -- visiting it with no existing session routes
// into Tapit's own FreshOnboarding (tapit-wallet's WalletProvider/
// FreshLoginShell gate on wallet state at that root, no query params
// needed). Used for "new to Tapit, create an account" -- deliberately NOT
// the /sign challenge URL above, which bundles a DynastyTrust sign-in
// request that makes no sense for someone who has nothing to sign yet.
export const WALLET_BASE_URL = WALLET_SIGN_URL.replace(/\/sign\/?$/, '') || WALLET_SIGN_URL;

export type TapitMode = 'signin' | 'link' | 'signup';

// The name typed before 'signup' leaves for the wallet; read back when it
// returns (a full-page redirect cannot carry it in memory).
const SIGNUP_NAME = 'dt:tapitSignupName';
export function rememberSignupName(name: string): void {
  try { sessionStorage.setItem(SIGNUP_NAME, name.trim().slice(0, 40)); } catch { /* private mode: no name */ }
}
function takeSignupName(): string | null {
  try { const n = sessionStorage.getItem(SIGNUP_NAME); sessionStorage.removeItem(SIGNUP_NAME); return n; } catch { return null; }
}

/** Shared by every flow below -- mints a fresh, server-persisted,
 *  single-use challenge. Extracted so startTapitPubkeyConnectRequest
 *  doesn't duplicate this fetch-and-validate logic a third time. */
async function mintSignInChallenge(): Promise<unknown> {
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
  return payload.challenge;
}

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
export interface TapitStart { url: string; screenCode: string }

/** Prepare a same-device Tapit sign-in: the wallet link and its number. The
 *  page shows the number, then the person opens the link (a fresh tap, which
 *  iOS Safari also prefers to an automatic jump). */
export async function prepareTapitFlow(mode: TapitMode): Promise<TapitStart> {
  const challenge = await mintSignInChallenge();
  rememberPending(nonceOf(challenge));
  // Land on /keys so RequireAuth's callback handler runs (the public Landing
  // at "/" would not). tapit_mode rides along; the wallet preserves it and
  // appends ?grant=.
  const callback = `${window.location.origin}/keys?tapit_mode=${mode}`;
  const req = b64urlEncode({
    v: 1,
    intent: 'sign-in',
    origin: 'DynastyTrust',
    callback,
    challenge,
  });
  return { url: `${WALLET_SIGN_URL}?req=${req}`, screenCode: numberFor(challenge) };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface TapitConnectRequest {
  /** Same URL prepareTapitFlow would navigate to -- render as a QR, or as a
   *  plain link for same-device use. Scanning it on a phone opens Tapit's
   *  existing /sign route unchanged; the only new behavior lives in how
   *  approval gets delivered back (see response_channel below). */
  requestUrl: string;
  /** This request's ephemeral reply keypair (tapit-nostr-cosign.ts's same
   *  one-request-only pattern). Keep replyPrivateKey in memory only for as
   *  long as this one connect attempt is open -- never persisted, never
   *  reused across requests -- and pass it to
   *  tapit-signin-response-channel.ts's subscribeSignInResponses to
   *  decrypt whatever comes back. */
  replyPrivateKey: string;
  replyPublicKey: string;
  /** The two-digit number this page shows; Tapit asks for it (threat model G). */
  screenCode: string;
}

/**
 * Builds a sign-in/link request that can be delivered WITHOUT a full-page
 * redirect: the wallet answers by publishing the signed grant over Nostr
 * to this request's ephemeral reply key (tapit-wallet's
 * signInResponseChannel.ts, mirroring the psbt-cosign response_channel
 * pattern already proven for Cut B3) instead of navigating back to a
 * callback URL. Lets this tab stay open on a QR while a DIFFERENT device
 * (the phone with Tapit on it) does the approving -- a URL redirect could
 * never do that, since scanning a QR opens a new browser context, not
 * this tab. Same challenge-minting and request shape as prepareTapitFlow;
 * this only adds response_channel and returns the URL instead of
 * navigating to it.
 */
export async function startTapitConnectRequest(mode: TapitMode): Promise<TapitConnectRequest> {
  const challenge = await mintSignInChallenge();
  rememberPending(nonceOf(challenge));
  const replyPriv = crypto.getRandomValues(new Uint8Array(32));
  const replyPrivateKey = toHex(replyPriv);
  const replyPublicKey = toHex(schnorr.getPublicKey(replyPriv));

  // Still a real callback URL (used only if the person taps "open Tapit
  // directly" instead of scanning) -- same /keys landing RequireAuth
  // already handles for the redirect path.
  const callback = `${window.location.origin}/keys?tapit_mode=${mode}`;
  const req = b64urlEncode({
    v: 1,
    intent: 'sign-in',
    origin: 'DynastyTrust',
    callback,
    challenge,
    response_channel: { kind: 'nostr', requester_pubkey: replyPublicKey },
  });
  return {
    requestUrl: `${WALLET_SIGN_URL}?req=${req}`,
    replyPrivateKey,
    replyPublicKey,
    screenCode: numberFor(challenge),
  };
}

/**
 * Connect by pasting the OTHER end's known Tapit pubkey directly,
 * skipping the QR/URL entirely. Operator, 2026-08-19: the QR + "open
 * Tapit directly" fallback both either need a second device or trigger
 * tapit-wallet's own full-page reload (which re-locks an already-open
 * wallet, indistinguishable from onboarding to someone who didn't expect
 * it). This delivers the EXACT SAME sign-in challenge as a Nostr event
 * addressed to the pasted pubkey instead -- tapit-wallet's signInChannel.ts
 * picks it up in its own, already-open Inbox and routes to the same /sign
 * review screen via in-app navigation, no page reload, no re-lock.
 * Response delivery is unchanged: the caller still listens with
 * subscribeSignInResponses(replyPrivateKey, replyPublicKey, ...), the
 * same as startTapitConnectRequest's QR path.
 */
export async function startTapitPubkeyConnectRequest(
  mode: TapitMode,
  recipientXOnlyPubkey: string,
): Promise<TapitConnectRequest & { delivered: boolean }> {
  const challenge = await mintSignInChallenge();
  rememberPending(nonceOf(challenge));
  const replyPriv = crypto.getRandomValues(new Uint8Array(32));
  const replyPrivateKey = toHex(replyPriv);
  const replyPublicKey = toHex(schnorr.getPublicKey(replyPriv));
  const callback = `${window.location.origin}/keys?tapit_mode=${mode}`;

  const { sendSignInRequestOverNostr } = await import('./tapit-signin-request-delivery');
  const { delivered } = await sendSignInRequestOverNostr({
    mode,
    challenge,
    callback,
    replyPublicKey,
    recipientXOnlyPubkey,
  });

  return {
    // No QR/link is shown for this path, but TapitConnectRequest's shape
    // is kept so the caller can reuse the exact same waiting-state UI;
    // the URL is still valid as a manual fallback if delivery never lands.
    requestUrl: `${WALLET_SIGN_URL}?req=${b64urlEncode({
      v: 1, intent: 'sign-in', origin: 'DynastyTrust', callback, challenge,
      response_channel: { kind: 'nostr', requester_pubkey: replyPublicKey },
    })}`,
    replyPrivateKey,
    replyPublicKey,
    delivered,
    screenCode: numberFor(challenge),
  };
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
  const m = params.get('tapit_mode');
  const mode: TapitMode = m === 'link' ? 'link' : m === 'signup' ? 'signup' : 'signin';
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
  // Threat model G, the login trap: only finish a sign-in this browser started.
  const nonce = (attestation as { challenge?: { nonce?: unknown } }).challenge?.nonce;
  if (typeof nonce !== 'string' || !takePending(nonce)) {
    throw new Error('This Tapit approval is for a sign-in that was not started in this browser, so it was not used. If you started it here, start again: sign-ins expire after a few minutes. If someone sent you this link, ignore it.');
  }
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

  // 'signup' (2026-11-13, operator: "run your own Tapit wallet, sign in
  // through it, not email"): the Tapit key alone makes the account -- no
  // email ever (key-signup.js, a never-mailed placeholder underneath).
  const signup = cb.mode === 'signup';
  const res = await fetch(`${API}/${signup ? 'key-signup' : 'wallet-signin-verify'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signup ? { grant, kind: 'tapit', display_name: takeSignupName() } : { grant }),
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error((payload.error as string) ?? (signup ? 'Could not create the account with Tapit' : 'Tapit sign-in failed'));

  const { error } = await supabase.auth.verifyOtp({
    token_hash: payload.token_hash as string,
    type: 'magiclink',
  });
  if (error) throw new Error(error.message);
  // A Tapit key proof earned this session too: record it as key-made.
  await recordKeySession(payload.key_session_claim);

  return { mode: signup ? 'signup' : 'signin' };
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
