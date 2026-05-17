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

export type AttestationType =
  | 'trust_doc'
  | 'proof_of_life'
  | 'death_declaration'
  | 'descriptor';

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

/**
 * Hash the compiled vault descriptor for attestation.
 *
 * The digest covers the exact descriptor string plus the address it
 * derived to. Either field changing invalidates every prior signature,
 * which is the point: if the server swaps the vault's address under
 * the members, their attestation counts drop to zero and the UI
 * flags the vault as "descriptor changed -- re-attest before spending".
 *
 * The address is included even though it is deterministic from the
 * descriptor, as a defence against a malicious server showing a
 * different address string in the UI than the descriptor compiles to.
 */
export function descriptorAttestationHash(
  descriptor: string,
  address: string,
): string {
  const msg = descriptor.trim() + '|' + address.trim();
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

/**
 * Recompute the target_hash a stored attestation should carry, from
 * its own (unsigned) target_data.
 *
 * The Schnorr signature commits only to (attestation_type,
 * target_hash) -- see buildDigest. target_data is persisted next to
 * the row but is NOT in the digest, so on its own it is forgeable in
 * transit. target_hash, however, IS in the digest, and it is derived
 * from the very facts target_data describes. Recomputing the hash
 * from target_data and comparing it to the signed target_hash makes
 * target_data tamper-evident: an attacker who edits target_data
 * cannot also change target_hash without invalidating the signature.
 *
 * Returns null when target_data lacks the fields required for its
 * type (treated as a verification failure by callers).
 */
export function recomputeTargetHash(
  attestationType: AttestationType,
  targetData: Record<string, unknown>,
  vaultId: string,
): string | null {
  const asString = (v: unknown): string | null =>
    typeof v === 'string' ? v : null;

  switch (attestationType) {
    case 'trust_doc':
      if (!('trust_doc_snapshot' in targetData)) return null;
      return trustDocHash(targetData.trust_doc_snapshot);
    case 'descriptor': {
      const descriptor = asString(targetData.descriptor);
      const address = asString(targetData.address);
      if (descriptor === null || address === null) return null;
      return descriptorAttestationHash(descriptor, address);
    }
    case 'proof_of_life': {
      const signedAt = asString(targetData.signed_at);
      if (signedAt === null) return null;
      return proofOfLifeHash(vaultId, signedAt, asString(targetData.note) ?? '');
    }
    case 'death_declaration': {
      const subject = asString(targetData.subject_user_id);
      const effectiveDate = asString(targetData.effective_date);
      if (subject === null || effectiveDate === null) return null;
      return deathDeclarationHash(vaultId, subject, effectiveDate);
    }
  }
  return null;
}

/**
 * Full verification of a stored attestation record.
 *
 * verifyAttestation() alone proves only that the signature commits
 * to (attestation_type, target_hash). A governance decision that
 * also reads target_data -- the death-declaration subject -- or that
 * counts attestations toward a threshold ("X of N attested") must
 * additionally confirm target_data was not tampered after signing.
 * This binds the two: the signature must verify AND target_data must
 * still hash to the signed target_hash.
 *
 * Use this, not verifyAttestation(), wherever an attestation feeds a
 * threshold or governance decision.
 */
export function verifyAttestationRecord(opts: {
  attestationType: AttestationType;
  targetHash: string;
  targetData: Record<string, unknown>;
  signature: string;
  pubkey: string;
  vaultId: string;
}): boolean {
  if (
    !verifyAttestation({
      attestationType: opts.attestationType,
      targetHash: opts.targetHash,
      signature: opts.signature,
      pubkey: opts.pubkey,
    })
  ) {
    return false;
  }
  const expected = recomputeTargetHash(
    opts.attestationType,
    opts.targetData,
    opts.vaultId,
  );
  return expected !== null && expected === opts.targetHash;
}

/**
 * The persisted shape of an attestation, as the governance UI
 * receives it. Field names are snake_case so this lines up
 * structurally with a server `vault_attestations` row.
 */
export interface AttestationRow {
  attestation_type: AttestationType;
  target_hash: string;
  target_data: Record<string, unknown>;
  signature: string;
  pubkey: string;
}

/**
 * Reduce attestation rows to those that may count toward a
 * governance threshold.
 *
 * A row survives only if BOTH hold:
 *   1. verifyAttestationRecord passes -- the signature is valid and
 *      target_data still hashes to the signed target_hash.
 *   2. its signer pubkey is in `authorizedPubkeys` -- the vault's
 *      pre-registered members / designated witnesses.
 *
 * Condition 2 is NOT optional. verifyAttestationRecord proves a
 * record is internally consistent and SIGNED, but a signature is
 * cheap: anyone can mint a fresh keypair and sign a genuine-looking
 * attestation pointing at any target_hash. Without the authorized-
 * pubkey gate, a "distinct valid signatures" counter is inflatable
 * by an attacker who simply generates keys. The gate is what ties a
 * counted attestation to a real, authorized signer.
 *
 * Rows are returned in input order; de-duplication per signer is
 * left to the caller (proof-of-life keeps every check-in, the
 * quorum counters keep one per signer).
 */
export function authorizedAttestations<T extends AttestationRow>(
  rows: readonly T[],
  authorizedPubkeys: Iterable<string>,
  vaultId: string,
): T[] {
  const allowed =
    authorizedPubkeys instanceof Set
      ? (authorizedPubkeys as Set<string>)
      : new Set(authorizedPubkeys);
  const kept: T[] = [];
  for (const row of rows) {
    if (!allowed.has(row.pubkey)) continue;
    if (
      !verifyAttestationRecord({
        attestationType: row.attestation_type,
        targetHash: row.target_hash,
        targetData: row.target_data,
        signature: row.signature,
        pubkey: row.pubkey,
        vaultId,
      })
    ) {
      continue;
    }
    kept.push(row);
  }
  return kept;
}
