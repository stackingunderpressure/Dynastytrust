// Email-free sign-in: your 24 words ARE your account
// (docs/key-signin-build-note.md). Operator, 2026-11-13: "never have an
// email and only sign in with your key ... you create one there with a
// password and face lock and then that is your sign in".
//
// The sign-in key is worked out from the same 24 words as the person's
// first vault key (operator's choice), at its own hardened path,
// SIGN_IN_PATH. It is never a Bitcoin key: a vault key lives at
// m/48'/... (multisig) and nothing in a vault ever uses this path, so a
// sign-in signature can never be replayed as a spend and the server never
// sees a vault key. The same path on every network, so one set of words
// is one account whether the vault key is real bitcoin or test coins.
//
// On this phone the words stay inside the key store (Face ID or password,
// keystore.ts); this file only borrows them for the moment of signing.

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { answerSignInChallenge } from 'tapit-attest';
import { supabase } from './supabase';
import { inspectRecoveryWords, listKeys, restoreKeyFromWords, revealMnemonic, getKey, type LocalKey } from './keystore';

const API = '/api';
/** Hardened account 900001', separate from Legacy Recovery's 900000'. */
export const SIGN_IN_PATH = "m/86'/0'/900001'/0/0";
const STORE = 'dt:signInKey:v1';

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');

/** The sign-in private key (hex) for a set of words. */
export function signInPrivateKey(mnemonic: string): string {
  const k = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(SIGN_IN_PATH);
  if (!k.privateKey) throw new Error('Could not work out the sign-in key from these words.');
  return hex(k.privateKey);
}

/** Which key on this phone holds the account's words, if any. */
export function signInKeyOnThisPhone(): LocalKey | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const { keyId } = JSON.parse(raw) as { keyId?: string };
    const k = keyId ? getKey(keyId) : null;
    return k && k.status === 'active' && k.origin === 'software' ? k : null;
  } catch {
    return null;
  }
}

function remember(keyId: string): void {
  localStorage.setItem(STORE, JSON.stringify({ keyId }));
}

export function forgetSignInKeyOnThisPhone(): void {
  localStorage.removeItem(STORE);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`Unexpected server response: ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error((payload.error as string) ?? 'The server refused');
  return payload;
}

/** Answer a fresh server challenge with the words' sign-in key. */
async function proofFor(mnemonic: string): Promise<{ attestation: unknown }> {
  const { challenge } = await post('wallet-signin-challenge', {});
  const attestation = answerSignInChallenge({ challenge: challenge as never, signerPrivateKey: signInPrivateKey(mnemonic) });
  return { attestation };
}

async function redeem(payload: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ token_hash: String(payload.token_hash), type: 'magiclink' });
  if (error) throw new Error(error.message);
  await recordKeySession(payload.key_session_claim);
}

/**
 * Tell the server THIS new session was made by proving a key, so it counts
 * for joining a real-bitcoin vault (operator's chip: "Key sign-in is
 * enough"). Best effort: if it fails, sign-in still worked and only that
 * join asks for the authenticator code instead.
 */
export async function recordKeySession(claim: unknown): Promise<boolean> {
  if (typeof claim !== 'string' || !claim) return false;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return false;
    const res = await fetch(`${API}/key-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ claim }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Make the account. Called with the words the backup step just checked. */
export async function createAccountWithWords(keyId: string, mnemonic: string, displayName: string): Promise<void> {
  const grant = await proofFor(mnemonic);
  await redeem(await post('key-signup', { grant, display_name: displayName }));
  remember(keyId);
}

/** Sign in with the key kept on this phone (Face ID, or its password). */
export async function signInWithThisPhone(password?: string): Promise<void> {
  const k = signInKeyOnThisPhone();
  if (!k) throw new Error('There is no sign-in key on this phone. Sign in with your 24 words.');
  const mnemonic = await revealMnemonic(k.keyId, password);
  const grant = await proofFor(mnemonic);
  await redeem(await post('wallet-signin-verify', { grant }));
}

/**
 * Sign in by typing the 24 words (a new phone, or a cleared browser).
 * With a password, the words are also kept on this phone as a real-bitcoin
 * key (password-protected; Face ID can be added after) and remembered as
 * the sign-in key, so next time is one tap. Without one, nothing is kept.
 */
export async function signInWithWords(words: string, keepWithPassword?: string): Promise<{ kept: LocalKey | null }> {
  const seen = inspectRecoveryWords(words);
  if (seen.unknown.length > 0) throw new Error(`Word ${seen.unknown[0].position} ("${seen.unknown[0].word}") is not a recovery word.`);
  if (!seen.lengthOk || !seen.valid) throw new Error('These words are not a valid recovery phrase. Check them against your written copy.');
  const mnemonic = seen.words.join(' ');
  const grant = await proofFor(mnemonic);
  await redeem(await post('wallet-signin-verify', { grant }));

  // Already on this phone (same words under a vault key)? Use that one.
  // Matched by public key worked out from the typed words -- nothing on
  // this phone is unlocked to check, so no Face ID or password prompt.
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  for (const k of listKeys()) {
    if (k.origin !== 'software' || k.status !== 'active' || !k.derivationPath) continue;
    try {
      const pub = root.derive(k.derivationPath).deriveChild(0).deriveChild(0).publicKey;
      if (pub && hex(pub) === k.pubkey) { remember(k.keyId); return { kept: k }; }
    } catch { /* a path this seed cannot take */ }
  }
  if (!keepWithPassword) return { kept: null };
  const { key } = await restoreKeyFromWords({ label: 'My key', network: 'mainnet', persona: 'Me', words: mnemonic, password: keepWithPassword });
  remember(key.keyId);
  return { kept: key };
}
