import { schnorr } from '@noble/curves/secp256k1';
import type { Signature } from '../types.js';
import { bytesToHex, canonicalJson, hexToBytes, isHex, taggedHash, utf8ToBytes } from '../internal.js';

/**
 * One link in a key-succession chain. Each link retires `fromKey` in
 * favour of `toKey` and references the hash of the previous link's
 * record — a hash-linked chain (K1 → K2 → K3). Altering or removing an
 * old link breaks every hash after it: tamper-evident lineage.
 */
export interface SuccessionLink {
  v: 1;
  /** x-only public key being retired. */
  fromKey: string;
  /** x-only public key taking over. */
  toKey: string;
  /** Hex hash of the previous link's record; '' for the genesis link. */
  prevHash: string;
  /** ISO 8601. */
  issuedAt: string;
  /** At minimum the retiring key signs; the new key / vouchers may co-sign. */
  signatures: Signature[];
}

type SuccessionBase = Pick<SuccessionLink, 'v' | 'fromKey' | 'toKey' | 'prevHash' | 'issuedAt'>;

function baseOf(link: SuccessionLink): SuccessionBase {
  return {
    v: link.v,
    fromKey: link.fromKey,
    toKey: link.toKey,
    prevHash: link.prevHash,
    issuedAt: link.issuedAt,
  };
}

/** The digest the retiring key (and any co-signers) sign. */
function linkDigest(base: SuccessionBase): Uint8Array {
  return taggedHash('tapit/succession', utf8ToBytes(canonicalJson(base)));
}

/** Hash of a complete link record — what the *next* link references as `prevHash`. */
export function successionLinkHash(link: SuccessionLink): string {
  return bytesToHex(taggedHash('tapit/succession-record', utf8ToBytes(canonicalJson(link))));
}

export interface SuccessionInput {
  /** Private key of the key being retired — it must sign the link. */
  fromPrivateKey: string;
  /** x-only public key taking over. */
  toKey: string;
  /** The previous link, omitted for the genesis link. */
  previous?: SuccessionLink;
  /** ISO 8601; defaults to now. */
  issuedAt?: string;
  /** Optional co-signers (the new key, vouchers) — private keys. */
  coSignPrivateKeys?: string[];
}

/** Create a signed succession link. */
export function createSuccessionLink(input: SuccessionInput): SuccessionLink {
  if (!isHex(input.fromPrivateKey, 32)) throw new Error('fromPrivateKey must be 32-byte hex');
  if (!isHex(input.toKey, 32)) throw new Error('toKey must be 32-byte hex');
  const fromPriv = hexToBytes(input.fromPrivateKey);
  const fromKey = bytesToHex(schnorr.getPublicKey(fromPriv));
  if (input.previous && input.previous.toKey !== fromKey) {
    throw new Error("fromKey must equal the previous link's toKey");
  }
  const base: SuccessionBase = {
    v: 1,
    fromKey,
    toKey: input.toKey,
    prevHash: input.previous ? successionLinkHash(input.previous) : '',
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  const digest = linkDigest(base);
  const signatures: Signature[] = [
    { signer: fromKey, sig: bytesToHex(schnorr.sign(digest, fromPriv)) },
  ];
  for (const coSignKey of input.coSignPrivateKeys ?? []) {
    if (!isHex(coSignKey, 32)) throw new Error('coSignPrivateKey must be 32-byte hex');
    const coPriv = hexToBytes(coSignKey);
    const signer = bytesToHex(schnorr.getPublicKey(coPriv));
    if (!signatures.some((s) => s.signer === signer)) {
      signatures.push({ signer, sig: bytesToHex(schnorr.sign(digest, coPriv)) });
    }
  }
  return { ...base, signatures };
}

export interface SuccessionVerifyResult {
  valid: boolean;
  /** The active key at the end of a valid chain; null if the chain is invalid. */
  currentKey: string | null;
  errors: string[];
}

function safeVerify(sig: string, digest: Uint8Array, publicKey: string): boolean {
  if (!isHex(sig, 64) || !isHex(publicKey, 32)) return false;
  try {
    return schnorr.verify(hexToBytes(sig), digest, hexToBytes(publicKey));
  } catch {
    return false;
  }
}

/**
 * Verify a key-succession chain end to end: every link is signed by its
 * retiring key, every co-signature is valid, every `prevHash` matches the
 * prior link's record, and each link's `fromKey` is the prior link's
 * `toKey`. This is what proves reputation earned under an old key carries
 * forward to a new one.
 */
export function verifySuccessionChain(chain: SuccessionLink[]): SuccessionVerifyResult {
  const errors: string[] = [];
  if (chain.length === 0) {
    return { valid: false, currentKey: null, errors: ['empty succession chain'] };
  }
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];
    const digest = linkDigest(baseOf(link));
    const fromSig = link.signatures.find((s) => s.signer === link.fromKey);
    if (!fromSig) {
      errors.push(`link ${i}: not signed by the retiring key`);
    } else if (!safeVerify(fromSig.sig, digest, link.fromKey)) {
      errors.push(`link ${i}: invalid retiring-key signature`);
    }
    for (const s of link.signatures) {
      if (!safeVerify(s.sig, digest, s.signer)) {
        errors.push(`link ${i}: invalid signature from ${s.signer}`);
      }
    }
    if (i === 0) {
      if (link.prevHash !== '') errors.push('link 0: genesis link must have an empty prevHash');
    } else {
      if (link.prevHash !== successionLinkHash(chain[i - 1])) {
        errors.push(`link ${i}: prevHash does not match the previous link`);
      }
      if (link.fromKey !== chain[i - 1].toKey) {
        errors.push(`link ${i}: fromKey does not match the previous link's toKey`);
      }
    }
  }
  const valid = errors.length === 0;
  return { valid, currentKey: valid ? chain[chain.length - 1].toKey : null, errors };
}
