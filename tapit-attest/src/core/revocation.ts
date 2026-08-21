/**
 * The revocation state machine.
 *
 * Every attestation has a lifecycle:
 *
 *     pending --(finality window elapses)--> final
 *        |
 *        +-----(revoked within the window)--> void
 *
 *  - pending : issued, inside its tier's finality window, still
 *              retractable.
 *  - final   : the window elapsed with no revocation; settled.
 *  - void    : revoked by a `meta` / revocation attestation before
 *              it could finalize.
 *
 * The window length is a tier dial (`finalityWindowMs`), so the same
 * machine drives routine and high-stakes attestations -- only the
 * number differs. A `final` attestation cannot be voided here;
 * challenging a settled attestation is REPUDIATION, a named v1.1
 * slot, not revocation.
 */

import { metaAttestation } from './builders.js';
import { signEnvelope, verifyEnvelope } from './sign.js';
import { findLeafValue } from './field-tree.js';
import { tierConfig, type TierConfig, type TierName } from './tiers.js';
import type { AttestationEnvelope } from './envelope.js';

export type RevocationStatus = 'pending' | 'final' | 'void';

export interface CreateRevocationOptions {
  /** envelopeId of the attestation being revoked. */
  readonly targetId: string;
  /** Subject id -- normally the revoked attestation's subject. */
  readonly subject: string;
  /** Private key of an authorized revoker. */
  readonly privateKey: string | Uint8Array;
  /** Optional human-readable reason recorded in the claim. */
  readonly reason?: string;
  readonly tier?: TierName;
  readonly issuedAt?: string;
}

/** Build and sign a `meta` / revocation attestation for a target. */
export function createRevocation(opts: CreateRevocationOptions): AttestationEnvelope {
  const draft = metaAttestation({
    op: 'revocation',
    subject: opts.subject,
    tier: opts.tier ?? 'notable',
    issuedAt: opts.issuedAt,
    fields: {
      target: opts.targetId,
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  });
  return signEnvelope(draft, opts.privateKey, { role: 'revoker' });
}

/** The targetId a revocation attestation points at, or null. */
export function revocationTarget(env: AttestationEnvelope): string | null {
  if (env.kind !== 'meta') return null;
  if (findLeafValue(env.claim, ['claim', 'op']) !== 'revocation') return null;
  const target = findLeafValue(env.claim, ['claim', 'payload', 'target']);
  return typeof target === 'string' && target.length > 0 ? target : null;
}

interface LedgerEntry {
  readonly config: TierConfig;
  readonly issuedAtMs: number;
  readonly authorizedRevokers: ReadonlySet<string>;
  revokedAtMs: number | null;
}

/**
 * Tracks the lifecycle state of a set of attestations.
 *
 * Storage-agnostic: the ledger holds only ids, tiers, timestamps, and
 * the standing revoker set. Persist or rebuild it from whatever store
 * you use (see sync.ts).
 */
export class RevocationLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  /**
   * Register an attestation as `pending`. Idempotent per id.
   *
   * `authorizedRevokers` is the set of x-only pubkeys (hex) with
   * standing to void this attestation -- normally the attestation's
   * own signer(s) (self-revocation), but a caller may pass any
   * separately-authorized revoker role it tracks. A revocation whose
   * signer is not in this set is rejected by `applyRevocation`.
   */
  register(
    targetId: string,
    tier: TierName,
    issuedAt: string,
    authorizedRevokers: readonly string[],
  ): void {
    if (this.entries.has(targetId)) return;
    const ms = Date.parse(issuedAt);
    if (Number.isNaN(ms)) throw new Error('issuedAt is not a valid timestamp');
    if (authorizedRevokers.length === 0) {
      throw new Error('authorizedRevokers must be non-empty -- an attestation with no standing revoker can never be voided');
    }
    this.entries.set(targetId, {
      config: tierConfig(tier),
      issuedAtMs: ms,
      authorizedRevokers: new Set(authorizedRevokers),
      revokedAtMs: null,
    });
  }

  /** Current lifecycle status of an attestation at time `now`. */
  statusOf(targetId: string, now: Date = new Date()): RevocationStatus {
    const entry = this.entries.get(targetId);
    if (!entry) throw new Error(`unknown attestation: ${targetId}`);
    if (entry.revokedAtMs !== null) return 'void';
    const elapsed = now.getTime() - entry.issuedAtMs;
    return elapsed >= entry.config.finalityWindowMs ? 'final' : 'pending';
  }

  /**
   * Apply a revocation attestation. The target must be registered
   * and still `pending`; revoking a `final` attestation is rejected.
   * Returns the new status (`void`).
   */
  applyRevocation(
    revocation: AttestationEnvelope,
    now: Date = new Date(),
  ): RevocationStatus {
    const targetId = revocationTarget(revocation);
    if (!targetId) throw new Error('not a revocation attestation');
    const verified = verifyEnvelope(revocation);
    if (!verified.valid) {
      throw new Error('revocation attestation has no valid signature');
    }
    const entry = this.entries.get(targetId);
    if (!entry) throw new Error(`unknown attestation: ${targetId}`);
    const hasStanding = verified.validSigners.some((signer) =>
      entry.authorizedRevokers.has(signer),
    );
    if (!hasStanding) {
      throw new Error('revocation signer is not an authorized revoker for this attestation');
    }
    const status = this.statusOf(targetId, now);
    if (status === 'void') return 'void';
    if (status === 'final') {
      throw new Error('cannot revoke a final attestation (see repudiation, v1.1)');
    }
    entry.revokedAtMs = now.getTime();
    return 'void';
  }

  /** Ids currently in the given status at time `now`. */
  idsByStatus(status: RevocationStatus, now: Date = new Date()): string[] {
    const out: string[] = [];
    for (const id of this.entries.keys()) {
      if (this.statusOf(id, now) === status) out.push(id);
    }
    return out;
  }
}

/**
 * v1.1+ SLOT -- repudiation handling.
 *
 * Repudiation challenges a `final` attestation (fraud, coercion,
 * key compromise discovered late). It needs its own dispute flow and
 * is intentionally NOT part of the v1 revocation machine.
 */
export function repudiate(_targetId: string): never {
  throw new Error('repudiate: v1.1 slot, not implemented in v1');
}
