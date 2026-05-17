/**
 * Timestamp anchoring.
 *
 * Anchoring stamps the attestation digest into Bitcoin via
 * OpenTimestamps. It proves the attestation existed no later than
 * a given block -- the load-bearing property for `prediction`
 * attestations, which are worthless if they can be backdated.
 *
 * The OpenTimestamps workflow -- stamp, upgrade, verify -- is
 * modelled as the `OtsProvider` interface so the core stays
 * offline-testable and storage/network-agnostic. `MockOtsProvider`
 * is a deterministic in-memory provider for tests. The real
 * Bitcoin-backed provider lives in `anchor/opentimestamps-provider.ts`.
 */

import { taggedHash, TAGS } from '../internal/hash.js';
import { bytesEqual, fromHex, toHex } from '../internal/hex.js';
import { attestationDigest, type Anchor, type AttestationEnvelope } from './envelope.js';

export interface AnchorConfirmation {
  /** Bitcoin block height the digest is committed under. */
  readonly bitcoinHeight: number;
}

/**
 * Abstraction over an OpenTimestamps client.
 *
 *  stamp   -- submit a digest, get back a (pending) proof
 *  upgrade -- pull a calendar attestation into the proof once mined
 *  verify  -- confirm a proof commits the digest, return the height
 */
export interface OtsProvider {
  stamp(digest: Uint8Array): Promise<Uint8Array>;
  upgrade(proof: Uint8Array): Promise<Uint8Array>;
  verify(digest: Uint8Array, proof: Uint8Array): Promise<AnchorConfirmation | null>;
}

/** Attach a (pending) anchor to an envelope. Returns a new envelope. */
export async function anchorAttestation(
  env: AttestationEnvelope,
  provider: OtsProvider,
): Promise<AttestationEnvelope> {
  const digest = attestationDigest(env);
  const proof = await provider.stamp(digest);
  const anchor: Anchor = {
    type: 'opentimestamps',
    digest: toHex(digest),
    proof: toHex(proof),
    status: 'pending',
  };
  return { ...env, anchor };
}

/**
 * Upgrade a pending anchor: pull the calendar attestation and, if
 * the digest is now confirmed in a block, mark the anchor complete.
 */
export async function refreshAnchor(
  env: AttestationEnvelope,
  provider: OtsProvider,
): Promise<AttestationEnvelope> {
  if (!env.anchor || env.anchor.proof === null) {
    throw new Error('envelope has no pending anchor to refresh');
  }
  const digest = attestationDigest(env);
  const upgraded = await provider.upgrade(fromHex(env.anchor.proof));
  const confirmation = await provider.verify(digest, upgraded);
  const anchor: Anchor = confirmation
    ? {
        type: 'opentimestamps',
        digest: toHex(digest),
        proof: toHex(upgraded),
        status: 'complete',
        bitcoinHeight: confirmation.bitcoinHeight,
      }
    : {
        type: 'opentimestamps',
        digest: toHex(digest),
        proof: toHex(upgraded),
        status: 'pending',
      };
  return { ...env, anchor };
}

export interface AnchorVerification {
  readonly present: boolean;
  /** True only when the proof actually commits the attestation digest. */
  readonly valid: boolean;
  readonly status: Anchor['status'] | null;
  readonly bitcoinHeight: number | null;
}

/** Verify that an envelope's anchor genuinely commits its digest. */
export async function verifyAnchor(
  env: AttestationEnvelope,
  provider: OtsProvider,
): Promise<AnchorVerification> {
  if (!env.anchor) {
    return { present: false, valid: false, status: null, bitcoinHeight: null };
  }
  const digest = attestationDigest(env);
  if (env.anchor.digest !== toHex(digest)) {
    return { present: true, valid: false, status: env.anchor.status, bitcoinHeight: null };
  }
  if (env.anchor.proof === null) {
    return { present: true, valid: false, status: env.anchor.status, bitcoinHeight: null };
  }
  const confirmation = await provider.verify(digest, fromHex(env.anchor.proof));
  return {
    present: true,
    valid: confirmation !== null,
    status: env.anchor.status,
    bitcoinHeight: confirmation?.bitcoinHeight ?? null,
  };
}

/**
 * Deterministic in-memory OtsProvider for tests and local dev.
 *
 * NOT a real timestamp: it does not touch Bitcoin. A "proof" is just
 * `taggedHash(anchor, digest)`, and `upgrade` is a no-op. It exists
 * so sign/verify/anchor round-trips run offline and reproducibly.
 */
export class MockOtsProvider implements OtsProvider {
  constructor(private readonly fixedHeight = 840_000) {}

  private proofFor(digest: Uint8Array): Uint8Array {
    return taggedHash(TAGS.anchor, digest);
  }

  stamp(digest: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(this.proofFor(digest));
  }

  upgrade(proof: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(proof);
  }

  verify(digest: Uint8Array, proof: Uint8Array): Promise<AnchorConfirmation | null> {
    const ok = bytesEqual(proof, this.proofFor(digest));
    return Promise.resolve(ok ? { bitcoinHeight: this.fixedHeight } : null);
  }
}
