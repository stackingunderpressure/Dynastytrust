/**
 * Per-kind draft builders.
 *
 * These are conveniences, not new shapes -- every builder returns a
 * plain `AttestationEnvelope` draft. The kind is set, the claim is
 * built as a field tree, and the tier is left as a dial the caller
 * picks. Generalized straight from DynastyTrust's four governance
 * flows (see kinds.ts for the mapping).
 */

import { createDraft, type AttestationEnvelope } from './envelope.js';
import { branch, leaf, treeFromObject, type FieldNode } from './field-tree.js';
import type { AttestationKind } from './kinds.js';
import type { TierName } from './tiers.js';

export interface BuildOptions {
  readonly subject: string;
  readonly tier: TierName;
  /** Claim payload -- object form is converted to a field tree. */
  readonly fields: Record<string, unknown>;
  readonly issuedAt?: string;
}

function build(kind: AttestationKind, opts: BuildOptions): AttestationEnvelope {
  const claim: FieldNode = treeFromObject('claim', opts.fields);
  return createDraft({
    kind,
    tier: opts.tier,
    subject: opts.subject,
    claim,
    issuedAt: opts.issuedAt,
  });
}

/** identity -- binds a public key to who it belongs to. */
export function identityAttestation(opts: BuildOptions): AttestationEnvelope {
  return build('identity', opts);
}

/** relationship -- a recurring, corroborated relationship / continuity. */
export function relationshipAttestation(opts: BuildOptions): AttestationEnvelope {
  return build('relationship', opts);
}

/** credential -- something done or earned. */
export function credentialAttestation(opts: BuildOptions): AttestationEnvelope {
  return build('credential', opts);
}

/**
 * prediction -- a future outcome. A prediction is only meaningful
 * once anchored, so it is worth anchoring (see anchor.ts) before the
 * `resolvesAt` time it claims.
 */
export function predictionAttestation(
  opts: BuildOptions & { resolvesAt: string },
): AttestationEnvelope {
  return build('prediction', {
    ...opts,
    fields: { ...opts.fields, resolvesAt: opts.resolvesAt },
  });
}

/** agreement -- a multi-party mutual commitment (co-sign with signEnvelope). */
export function agreementAttestation(opts: BuildOptions): AttestationEnvelope {
  return build('agreement', opts);
}

export type MetaOp = 'revocation' | 'repudiation' | 'key_succession';

/** meta -- a claim about a claim or a key (revocation, succession...). */
export function metaAttestation(
  opts: BuildOptions & { op: MetaOp },
): AttestationEnvelope {
  const inner = treeFromObject('payload', opts.fields);
  const claim = branch('claim', [leaf('op', opts.op), inner]);
  return createDraft({
    kind: 'meta',
    tier: opts.tier,
    subject: opts.subject,
    claim,
    issuedAt: opts.issuedAt,
  });
}
