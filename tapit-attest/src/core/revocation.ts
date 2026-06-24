import type { Attestation, TierName } from '../types.js';
import { createDraft, envelopeId } from './envelope.js';
import { findLeafValue } from './field-tree.js';
import { signEnvelope, verifyEnvelope } from './keys.js';

export type RevocationState = 'pending' | 'final' | 'void';

export interface RevocationInput {
  /** envelopeId of the attestation being revoked. */
  targetId: string;
  reason: string;
  /** Private key of the revoker. */
  revokerPrivateKey: string;
  /** Tier of the revocation itself; defaults to 'notable'. */
  tier?: TierName;
  /** ISO 8601; defaults to now. */
  issuedAt?: string;
}

/**
 * A revocation is itself an attestation — kind 'meta', subject = the
 * revoked envelope's id. One primitive, no special shape.
 */
export function createRevocation(input: RevocationInput): Attestation {
  const draft = createDraft({
    kind: 'meta',
    tier: input.tier ?? 'notable',
    subject: input.targetId,
    issuedAt: input.issuedAt,
    fields: { action: 'revoke', reason: input.reason },
  });
  return signEnvelope(draft, input.revokerPrivateKey);
}

/** True when an attestation is a revocation produced by `createRevocation`. */
export function isRevocation(a: Attestation): boolean {
  return a.kind === 'meta' && findLeafValue(a.claim, 'action') === 'revoke';
}

interface LedgerEntry {
  revocation: Attestation;
  state: RevocationState;
}

/**
 * Tracks revocations and resolves the current state of any target.
 *
 * v1 state machine: a revocation is `pending` when recorded, moves to
 * `final` once `finalize` is called (e.g. its tier finality window
 * elapsed), or to `void` if it is withdrawn / superseded. Challenging a
 * *finalized* attestation is the v1.1 `repudiate` slot.
 */
export class RevocationLedger {
  /** Keyed by the revocation's own envelopeId. */
  private readonly entries = new Map<string, LedgerEntry>();

  /** Record a revocation. Returns its envelopeId. Idempotent. */
  record(revocation: Attestation): string {
    if (!isRevocation(revocation)) throw new Error('not a revocation attestation');
    if (!verifyEnvelope(revocation).valid) throw new Error('revocation has invalid signatures');
    const id = envelopeId(revocation);
    if (!this.entries.has(id)) this.entries.set(id, { revocation, state: 'pending' });
    return id;
  }

  /** Move a pending revocation to `final`. */
  finalize(revocationId: string): void {
    const entry = this.requireEntry(revocationId);
    if (entry.state === 'void') throw new Error('cannot finalize a void revocation');
    entry.state = 'final';
  }

  /** Move a pending revocation to `void` (withdrawn / superseded). */
  void(revocationId: string): void {
    const entry = this.requireEntry(revocationId);
    if (entry.state === 'final') throw new Error('cannot void a finalized revocation');
    entry.state = 'void';
  }

  /** State of a single revocation record. */
  revocationState(revocationId: string): RevocationState {
    return this.requireEntry(revocationId).state;
  }

  /** True if `targetId` has any non-void revocation against it. */
  isRevoked(targetId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.state !== 'void' && entry.revocation.subject === targetId) return true;
    }
    return false;
  }

  /**
   * Strongest revocation state against a target: `final` beats `pending`,
   * `pending` beats `void`. Returns `void` when no live revocation exists.
   */
  targetState(targetId: string): RevocationState {
    let strongest: RevocationState = 'void';
    for (const entry of this.entries.values()) {
      if (entry.revocation.subject !== targetId) continue;
      if (entry.state === 'final') return 'final';
      if (entry.state === 'pending') strongest = 'pending';
    }
    return strongest;
  }

  /** All recorded revocations. */
  list(): Attestation[] {
    return [...this.entries.values()].map((entry) => entry.revocation);
  }

  private requireEntry(id: string): LedgerEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown revocation: ${id}`);
    return entry;
  }
}

/**
 * v1.1 SLOT — repudiation. Challenging a FINALIZED attestation needs its
 * own dispute flow (weighted-consensus reinterpretation, the annotation
 * itself permanent). v1's state machine only covers pending→final and
 * pending→void.
 */
export function repudiate(): never {
  throw new Error('repudiate is a v1.1 slot — not implemented in v1');
}
