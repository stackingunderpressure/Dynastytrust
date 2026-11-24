/**
 * passkey-account.ts -- an account made from Face ID alone: no email, no
 * password, no words (zero-knowledge storage Z4,
 * docs/z4-accounts-without-identity-build-note.md).
 *
 * The phone makes a passkey just for signing in to DynastyTrust. Its PRF
 * extension, evaluated with ONE fixed salt, gives the same 32-byte secret
 * every time -- on this phone, and on any other device the passkey syncs
 * to (iCloud Keychain, Google Password Manager). That secret becomes a
 * sign-in key (BIP 340), which answers the server's sign-in challenge
 * exactly the way a Tapit wallet does, through the key-account functions
 * that already exist (key-signup.js with kind 'device', wallet-signin-verify.js).
 *
 * The sign-in key is never a Bitcoin key and never shown. Nothing about the
 * person is sent: no email, no name (operator's chip: the name stays on the
 * phone -- lib/account-name.ts).
 *
 * Recovery (operator's chip: synced passkey only): a new device signed into
 * the same Apple or Google account finds the passkey and gets the same key.
 * Lose that too and the account is gone; money in a vault stays safe with
 * its own keys, and the person is invited back. UNVERIFIED on real devices
 * when written: the second-device sign-in is the slice's walk.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { answerSignInChallenge, signInScreenCode, type SignInChallenge } from 'tapit-attest';
import { supabase } from './supabase';
import { passkeysAvailable } from './passkey';
import { recordKeySession } from './key-account';

const API = '/api';
const STORE = 'dt:faceIdAccount:v1';
const enc = new TextEncoder();

/** The one PRF salt for sign-in. Fixed, so every synced device derives the
 *  same key; distinct from the salts that protect Bitcoin keys here. */
export const SIGNIN_PRF_SALT = sha256(enc.encode('dynastytrust-signin-prf-v1'));

/** Pure: the sign-in private key (hex) for a passkey's PRF secret. */
export function signInKeyFromPrf(prfSecret: Uint8Array): string {
  if (prfSecret.length !== 32) throw new Error('Unexpected passkey secret length.');
  for (let counter = 0; counter < 16; counter++) {
    const k = hkdf(sha256, prfSecret, enc.encode('dynastytrust-signin-key-v1'), enc.encode(`secp256k1-${counter}`), 32);
    const hex = bytesToHex(k);
    if (secp256k1.utils.isValidPrivateKey(k)) return hex;
  }
  throw new Error('Could not make a sign-in key from this passkey.');
}

// --- WebAuthn: a discoverable passkey, so another device can find it -------

interface PasskeyIo {
  /** Make the sign-in passkey; returns its credential id (base64). */
  create(): Promise<string>;
  /** PRF secret for SIGNIN_PRF_SALT. `credentialIdB64` null = let the
   *  device offer any DynastyTrust sign-in passkey it has (a new device). */
  secret(credentialIdB64: string | null): Promise<{ credentialIdB64: string; secret: Uint8Array }>;
}

const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const NO_PRF = 'This phone or browser cannot make a Face ID account (it lacks the passkey "PRF" feature). Use Tapit, or another way in.';

export const webauthnSignInPasskey: PasskeyIo = {
  async create() {
    if (!passkeysAvailable()) throw new Error(NO_PRF);
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'DynastyTrust', id: window.location.hostname },
        // What the phone's password list shows. Not the person's name: no
        // name is needed, and none is sent anywhere.
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'DynastyTrust sign-in', displayName: 'DynastyTrust sign-in' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        timeout: 120_000,
        extensions: { prf: {} },
      } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error('Face ID was cancelled.');
    const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
    if (ext.prf && ext.prf.enabled === false) throw new Error(NO_PRF);
    return b64(new Uint8Array(cred.rawId));
  },

  async secret(credentialIdB64) {
    if (!passkeysAvailable()) throw new Error(NO_PRF);
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: window.location.hostname,
        ...(credentialIdB64 ? { allowCredentials: [{ type: 'public-key', id: unb64(credentialIdB64) }] } : {}),
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: SIGNIN_PRF_SALT } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error('Face ID was cancelled.');
    const first = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
    if (!first) throw new Error(NO_PRF);
    return { credentialIdB64: b64(new Uint8Array(assertion.rawId)), secret: new Uint8Array(first) };
  },
};

// --- talking to the existing key-account functions --------------------------

async function post(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`Unexpected server response: ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error((payload.error as string) ?? 'The server refused');
  return payload;
}

/** Answer a fresh challenge with the sign-in key. The passkey is bound to
 *  this site, so the sign-in number is filled in here (it guards a Tapit
 *  approval made on another screen; a passkey cannot be used elsewhere). */
async function grantFor(privHex: string): Promise<{ attestation: unknown }> {
  const { challenge } = await post('wallet-signin-challenge', {});
  const c = challenge as SignInChallenge;
  return { attestation: answerSignInChallenge({ challenge: c, signerPrivateKey: privHex, screenCode: signInScreenCode(c) }) };
}

async function redeem(payload: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ token_hash: String(payload.token_hash), type: 'magiclink' });
  if (error) throw new Error(error.message);
  await recordKeySession(payload.key_session_claim);
}

function remember(credentialIdB64: string): void {
  try { localStorage.setItem(STORE, JSON.stringify({ credentialIdB64 })); } catch { /* next sign-in asks the device to find it */ }
}

/** The sign-in passkey this phone made or last used, if any. */
export function faceIdAccountOnThisPhone(): string | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? ((JSON.parse(raw) as { credentialIdB64?: string }).credentialIdB64 ?? null) : null;
  } catch {
    return null;
  }
}

export function faceIdAccountsPossible(): boolean {
  return passkeysAvailable();
}

/** Create an account with Face ID alone (two prompts: make, then use). */
export async function createFaceIdAccount(io: PasskeyIo = webauthnSignInPasskey): Promise<void> {
  const id = await io.create();
  const { secret } = await io.secret(id);
  const grant = await grantFor(signInKeyFromPrf(secret));
  await redeem(await post('key-signup', { grant, kind: 'device' }));
  remember(id);
}

/** Sign in with Face ID. On a device that has not used it yet, the phone
 *  offers the DynastyTrust sign-in passkeys it has (synced ones included). */
export async function signInWithFaceIdAccount(io: PasskeyIo = webauthnSignInPasskey): Promise<void> {
  const { credentialIdB64, secret } = await io.secret(faceIdAccountOnThisPhone());
  const grant = await grantFor(signInKeyFromPrf(secret));
  let payload: Record<string, unknown>;
  try {
    payload = await post('wallet-signin-verify', { grant });
  } catch (e) {
    // The phone may also hold passkeys that guard Bitcoin keys here; those
    // give a different key, which has no account.
    if (e instanceof Error && /no DynastyTrust account/.test(e.message)) {
      throw new Error('That passkey is not a DynastyTrust account. When Face ID asks, choose "DynastyTrust sign-in". No account yet? Create one with Face ID.');
    }
    throw e;
  }
  await redeem(payload);
  remember(credentialIdB64);
}

/** Signed in already (email, username or Tapit): add Face ID sign-in to
 *  THIS account, so it can later drop its email (slice 3). */
export async function addFaceIdToThisAccount(io: PasskeyIo = webauthnSignInPasskey): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in first.');
  const id = await io.create();
  const { secret } = await io.secret(id);
  const grant = await grantFor(signInKeyFromPrf(secret));
  await post('wallet-link', { grant, kind: 'device' }, token);
  remember(id);
}
