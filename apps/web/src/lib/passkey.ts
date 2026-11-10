/**
 * passkey.ts -- the WebAuthn half of passkey-protected keys.
 *
 * A passkey with the PRF extension gives the browser a 32-byte secret
 * that only exists while the person's device (Face ID, fingerprint,
 * security key) says yes. keystore.ts wraps a key's mnemonic with that
 * secret instead of with a typed password, so there is no password to
 * phish, guess, or capture as it is typed.
 *
 * Nothing here touches a server: the credential lives in the device's
 * authenticator, the challenge is local random (we are not proving
 * identity to anyone, only asking the authenticator to evaluate PRF),
 * and the secret never leaves this function's caller.
 *
 * UNVERIFIED on real hardware when written (2026-11-10): no sandbox can
 * show a passkey prompt. keystore.ts's protectKeyWithPasskey therefore
 * proves the round trip on the device itself before it removes the
 * password.
 */

export interface PrfProvider {
  /** Create a passkey that supports PRF. Rejects if it does not. */
  create(label: string): Promise<{ credentialIdB64: string }>;
  /** The 32-byte secret for (credential, salt). Same inputs, same
   *  secret, every time -- that determinism is what makes it a key. */
  evaluate(credentialIdB64: string, saltB64: string): Promise<Uint8Array>;
}

function b64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && typeof navigator.credentials?.create === 'function';
}

const NO_PRF =
  'This device or browser cannot protect a key with a passkey (it lacks the passkey "PRF" feature). The key keeps its password.';

export const webauthnPrf: PrfProvider = {
  async create(label) {
    if (!passkeysAvailable()) throw new Error(NO_PRF);
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'DynastyTrust', id: window.location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: `DynastyTrust key: ${label}`,
          displayName: `DynastyTrust key: ${label}`,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        timeout: 120_000,
        extensions: { prf: {} },
      } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error('Passkey creation was cancelled.');
    const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
    if (!ext.prf?.enabled) throw new Error(NO_PRF);
    return { credentialIdB64: b64(new Uint8Array(cred.rawId)) };
  },

  async evaluate(credentialIdB64, saltB64) {
    if (!passkeysAvailable()) throw new Error(NO_PRF);
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: window.location.hostname,
        allowCredentials: [{ type: 'public-key', id: unb64(credentialIdB64) }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: unb64(saltB64) } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    if (!assertion) throw new Error('Passkey prompt was cancelled.');
    const ext = assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
    const first = ext.prf?.results?.first;
    if (!first) throw new Error(NO_PRF);
    const out = new Uint8Array(first);
    if (out.length !== 32) throw new Error('Passkey returned an unexpected secret length.');
    return out;
  },
};
