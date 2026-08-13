/**
 * face-gate.ts -- Face ID / Touch ID gate for SentSecretsPanel's Reveal
 * flow (2026-08-13, operator: "Needs to be a face lock gate not a memory
 * thing" -- typing the password every time to reveal a saved secret like
 * the circle safety phrase was the friction; he doesn't want to have to
 * remember it).
 *
 * Important: this is NOT hardware-bound encryption. The password is
 * still the real PBKDF2 input for the AES-GCM key that decrypts the
 * secret (sent-secrets.ts); Face ID does not and cannot replace that
 * without re-encrypting every secret under a WebAuthn PRF-derived key
 * (device-bound, no cross-device recovery, inconsistent browser
 * support -- a materially different and much bigger feature, not what
 * was asked for here). What this module actually does: once the owner
 * types the password successfully, it's cached in this browser's
 * localStorage, and a platform-authenticator (Face ID/Touch ID) WebAuthn
 * credential gates *retrieval* of that cached password on every reveal
 * after the first. The biometric ceremony proves presence to the
 * browser; it is not itself an encryption boundary -- anyone with
 * script-level access to this origin's storage (an XSS bug, or a
 * jailbroken/already-unlocked device with devtools) could still read
 * the cached password directly without ever triggering Face ID. That's
 * a real, permanent weakening of the previous "nothing is ever
 * persisted, only held in memory for one decrypt" posture, accepted
 * knowingly in exchange for not having to retype the password. The
 * typed-password path never goes away -- it's the fallback whenever
 * Face ID isn't available, declines, or the cache is empty.
 *
 * No server round-trip: registration/verification challenges are local
 * random bytes, never sent anywhere or checked server-side. Nothing
 * here authenticates the owner to DynastyTrust's backend -- it only
 * gates a local cache on this device.
 */

const CREDENTIAL_ID_KEY = 'dt:faceGateCredentialId';
const CACHED_PW_PREFIX = 'dt:sentSecretPw:';

function b64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  // Explicit Uint8Array<ArrayBuffer> return type (not bare Uint8Array,
  // which this project's TS/DOM-lib versions default to the wider
  // Uint8Array<ArrayBufferLike>) -- WebAuthn's BufferSource params
  // reject ArrayBufferLike.
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export async function isFaceGateSupported(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
    if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function hasFaceGateCredential(): boolean {
  return !!localStorage.getItem(CREDENTIAL_ID_KEY);
}

/** One-time setup: registers a platform-authenticator (Face ID/Touch ID)
 *  credential and remembers its id. Best-effort -- returns false on any
 *  failure (declined, unsupported, cancelled) rather than throwing, so
 *  callers can just keep using the password prompt. */
export async function registerFaceGate(): Promise<boolean> {
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'DynastyTrust', id: window.location.hostname },
        user: { id: userId, name: 'sent-secrets-reveal', displayName: 'Reveal saved secrets' },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },
          { alg: -257, type: 'public-key' },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60_000,
        attestation: 'none',
      },
    }) as PublicKeyCredential | null;
    if (!credential) return false;
    localStorage.setItem(CREDENTIAL_ID_KEY, b64(new Uint8Array(credential.rawId)));
    return true;
  } catch {
    return false;
  }
}

/** Prompts Face ID/Touch ID against the registered credential. Returns
 *  whether the user verified -- false (never throws) on cancel, no
 *  credential registered, or the authenticator being unavailable. */
export async function verifyFaceGate(): Promise<boolean> {
  const credIdB64 = localStorage.getItem(CREDENTIAL_ID_KEY);
  if (!credIdB64) return false;
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: unb64(credIdB64), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return !!assertion;
  } catch {
    return false;
  }
}

export function getCachedSecretPassword(secretId: string): string | null {
  return localStorage.getItem(CACHED_PW_PREFIX + secretId);
}

export function setCachedSecretPassword(secretId: string, password: string): void {
  localStorage.setItem(CACHED_PW_PREFIX + secretId, password);
}

export function clearCachedSecretPassword(secretId: string): void {
  localStorage.removeItem(CACHED_PW_PREFIX + secretId);
}
