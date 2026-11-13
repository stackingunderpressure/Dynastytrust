// Face ID sign-in on this phone (operator, 2026-11-13: "user name password
// with Face ID right after"; chip: keep the password under Face ID).
//
// Right after a password sign-in the app offers, once, to keep that
// password on this phone locked under the device's Face ID passkey -- the
// same proven passkey the Bitcoin keys, the messaging key and saved
// secrets use (keystore.provenPasskeySecret). Next time the sign-in page
// shows "Sign in with Face ID": one prompt opens the password and signs in
// with Supabase's own password check. Nothing readable is stored. Until the
// person answers the offer, the password lives in this module's memory
// only, and it is dropped the moment they answer or the page reloads.

import { supabase } from './supabase';
import { decryptWithPrfSecret, encryptWithPrfSecret, provenPasskeySecret, type PasskeyBlob } from './keystore';
import { passkeysAvailable, webauthnPrf, type PrfProvider } from './passkey';

const STORE = 'dt:faceIdSignIn:v1';
/** Fired on window when Face ID sign-in is turned on or off, so any
 *  screen already showing its state redraws. */
export const FACE_ID_SIGNIN_CHANGED = 'dt:faceid-signin-changed';
const changed = () => { try { window.dispatchEvent(new Event(FACE_ID_SIGNIN_CHANGED)); } catch { /* no window (tests) */ } };

interface Saved { address: string; label: string; blob: PasskeyBlob }

let justSignedIn: { address: string; label: string; password: string } | null = null;

/** Called by the sign-in page after a password sign-in succeeded. */
export function offerFaceIdFor(address: string, label: string, password: string): void {
  const s = savedFaceIdSignIn();
  if (s && s.address === address) return; // already on for this account
  justSignedIn = passkeysAvailable() ? { address, label, password } : null;
}

/** The pending offer (no password exposed), or null. */
export function pendingFaceIdOffer(): { label: string } | null {
  return justSignedIn ? { label: justSignedIn.label } : null;
}

export function declineFaceIdOffer(): void {
  justSignedIn = null;
}

/** Lock the just-used password under Face ID (two or three prompts). */
export async function acceptFaceIdOffer(prf: PrfProvider = webauthnPrf): Promise<void> {
  const j = justSignedIn;
  if (!j) throw new Error('Sign in with your password again to turn on Face ID.');
  const { credentialIdB64, prfSaltB64, secret } = await provenPasskeySecret(prf);
  const blob = await encryptWithPrfSecret(j.password, secret, credentialIdB64, prfSaltB64);
  if ((await decryptWithPrfSecret(blob, secret)) !== j.password) throw new Error('Face ID protection failed its own check. Nothing was saved.');
  localStorage.setItem(STORE, JSON.stringify({ address: j.address, label: j.label, blob } satisfies Saved));
  justSignedIn = null;
  changed();
}

export function savedFaceIdSignIn(): { address: string; label: string } | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    return typeof v.address === 'string' && typeof v.label === 'string' && v.blob ? { address: v.address, label: v.label } : null;
  } catch {
    return null;
  }
}

export function forgetFaceIdSignIn(): void {
  localStorage.removeItem(STORE);
  changed();
}

/** One Face ID prompt, then Supabase's own password sign-in. */
export async function signInWithFaceId(prf: PrfProvider = webauthnPrf): Promise<void> {
  const raw = localStorage.getItem(STORE);
  if (!raw) throw new Error('Face ID sign-in is not set up on this phone.');
  const saved = JSON.parse(raw) as Saved;
  const secret = await prf.evaluate(saved.blob.credentialIdB64, saved.blob.prfSaltB64);
  let password: string;
  try {
    password = await decryptWithPrfSecret(saved.blob, secret);
  } catch {
    throw new Error('Face ID could not open your saved password. Sign in with your password.');
  }
  const { error } = await supabase.auth.signInWithPassword({ email: saved.address, password });
  if (error) {
    if (/invalid login credentials/i.test(error.message)) {
      forgetFaceIdSignIn();
      throw new Error('Your password has changed since Face ID was turned on. Sign in with the new password once, and turn Face ID on again.');
    }
    throw new Error(error.message);
  }
}
