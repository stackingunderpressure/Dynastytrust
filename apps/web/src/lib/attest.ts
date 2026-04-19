/**
 * attest.ts -- Schnorr-signed governance attestations.
 *
 * Reuses the member's Bitcoin signing key (the same /0/0 child that
 * signs PSBTs) but under a domain-separated tag, so no signature
 * here can ever be replayed against a Bitcoin transaction sighash.
 *
 * Tag format:
 *   SHA256("DT-ATT-v1" || attestation_type || 0x00 || target_hash)
 *
 * target_hash is a 32-byte SHA-256 computed in the browser for the
 * specific attestation type (see helpers below). The server stores
 * the hash + signature + pubkey. Verification runs client-side.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';

export type AttestationType = 'trust_doc' | 'proof_of_life' | 'death_declaration';

const TAG = 'DT-ATT-v1';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** Stable string form of a JSON value -- keys sorted, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** Hash the current trust_doc object for attestation. */
export function trustDocHash(doc: unknown): string {
  const canonical = canonicalJson(doc ?? {});
  return toHex(sha256(new TextEncoder().encode(canonical)));
}

/** Hash for a proof-of-life check-in at a given ISO timestamp. */
export function proofOfLifeHash(vaultId: string, signedAtIso: string, note = ''): string {
  const msg = vaultId + '|' + signedAtIso + '|' + note;
  return toHex(sha256(new TextEncoder().encode(msg)));
}

/** Hash for a death declaration of a subject. */
export function deathDeclarationHash(
  vaultId: string,
  subjectUserId: string,
  effectiveDateIso: string,
): string {
  const msg = vaultId + '|' + subjectUserId + '|' + effectiveDateIso;
  return toHex(sha256(new TextEncoder().encode(msg)));
}

/**
 * Build the final signing digest: tag + type + 0x00 + target_hash.
 * Domain separation prevents reuse against Bitcoin sighashes.
 */
function buildDigest(type: AttestationType, targetHashHex: string): Uint8Array {
  const tagBytes = new TextEncoder().encode(TAG);
  const typeBytes = new TextEncoder().encode(type);
  const sep = new Uint8Array([0x00]);
  const target = fromHex(targetHashHex);
  return sha256(concat(tagBytes, typeBytes, sep, target));
}

/**
 * Sign an attestation with the member's Bitcoin key. The browser
 * derives the same /0/0 child used for PSBT signing so the pubkey
 * matches vault_members.pubkey.
 */
export function signAttestation(opts: {
  mnemonic: string;
  derivationPath: string;
  network: 'testnet' | 'signet' | 'mainnet';
  attestationType: AttestationType;
  targetHash: string;
}): { signature: string; pubkey: string } {
  const versions = opts.network === 'mainnet'
    ? { private: 0x0488ade4, public: 0x0488b21e }
    : { private: 0x04358394, public: 0x043587cf };

  const seed = mnemonicToSeedSync(opts.mnemonic);
  const root = HDKey.fromMasterSeed(seed, versions);
  const account = root.derive(opts.derivationPath);
  const child00 = account.deriveChild(0).deriveChild(0);
  if (!child00.privateKey) throw new Error('Could not derive private key');

  const privKey = child00.privateKey;
  const pubKey = secp256k1.getPublicKey(privKey, true);
  const xOnly = pubKey.slice(1);

  const digest = buildDigest(opts.attestationType, opts.targetHash);
  const sig = schnorr.sign(digest, privKey);

  return { signature: toHex(sig), pubkey: toHex(xOnly) };
}

/** Verify an attestation signature. */
export function verifyAttestation(opts: {
  attestationType: AttestationType;
  targetHash: string;
  signature: string;
  pubkey: string;
}): boolean {
  try {
    const digest = buildDigest(opts.attestationType, opts.targetHash);
    return schnorr.verify(fromHex(opts.signature), digest, fromHex(opts.pubkey));
  } catch {
    return false;
  }
}
