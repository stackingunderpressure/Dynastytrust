import type { Attestation, AttestationKind, FieldBranch, TierName } from '../types.js';
import { bytesToHex, canonicalJson, concatBytes, isHex, taggedHash, utf8ToBytes } from '../internal.js';
import { fieldTreeRoot, treeFromObject } from './field-tree.js';

const KINDS: readonly AttestationKind[] = [
  'identity',
  'relationship',
  'credential',
  'prediction',
  'agreement',
  'journal',
  'meta',
];
const TIERS: readonly TierName[] = ['routine', 'notable', 'high_stakes'];

export interface DraftInput {
  kind: AttestationKind;
  tier: TierName;
  subject: string;
  /** A plain object (converted to a field tree) or a prebuilt FieldBranch. */
  fields: Record<string, unknown> | FieldBranch;
  /** ISO 8601; defaults to now. */
  issuedAt?: string;
}

function isFieldBranch(value: unknown): value is FieldBranch {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FieldBranch).node === 'branch'
  );
}

/** Create an unsigned attestation (a draft). Sign it with `signEnvelope`. */
export function createDraft(input: DraftInput): Attestation {
  if (!KINDS.includes(input.kind)) throw new Error(`unknown kind: ${String(input.kind)}`);
  if (!TIERS.includes(input.tier)) throw new Error(`unknown tier: ${String(input.tier)}`);
  if (typeof input.subject !== 'string' || input.subject.length === 0) {
    throw new Error('subject must be a non-empty string');
  }
  const claim = isFieldBranch(input.fields)
    ? input.fields
    : treeFromObject('claim', input.fields);
  return {
    v: 1,
    kind: input.kind,
    tier: input.tier,
    subject: input.subject,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    claim,
    signatures: [],
  };
}

/**
 * metaHash = taggedHash(meta, canonicalJson{v,kind,tier,subject,issuedAt}).
 *
 * Exported so the selective-disclosure verifier in `field-tree.ts` can
 * recompute the canonical attestation digest from just the meta-fields
 * plus a recovered claim root, without depending on the rest of the
 * claim tree. Same function the signer used; same bytes go into the
 * `tapit/root` tagged hash.
 */
export function metaHash(a: {
  v: 1;
  kind: AttestationKind;
  tier: TierName;
  subject: string;
  issuedAt: string;
}): Uint8Array {
  return taggedHash(
    'tapit/meta',
    utf8ToBytes(
      canonicalJson({
        v: a.v,
        kind: a.kind,
        tier: a.tier,
        subject: a.subject,
        issuedAt: a.issuedAt,
      }),
    ),
  );
}

/**
 * digest = taggedHash(root, metaHash || fieldTreeRoot(claim)).
 * Every signer signs this; the anchor stamps this. Changing the subject,
 * tier, timestamp, or any claim field invalidates every signature.
 */
export function attestationDigest(a: Attestation): Uint8Array {
  return taggedHash('tapit/root', concatBytes(metaHash(a), fieldTreeRoot(a.claim)));
}

/**
 * Stable content address: the digest as hex. Independent of signatures
 * and anchor, so an envelope keeps its id as it gains signatures.
 */
export function envelopeId(a: Attestation): string {
  return bytesToHex(attestationDigest(a));
}

/** Canonical serialization of the whole envelope — signatures + anchor included. */
export function canonicalEnvelope(a: Attestation): string {
  return canonicalJson(a);
}

function assertNode(value: unknown, expect: 'leaf' | 'branch' | 'any', path: string): void {
  const node = value as Record<string, unknown> | null;
  if (!node || typeof node !== 'object') {
    throw new Error(`${path}: field node must be an object`);
  }
  if (node.node === 'leaf') {
    if (expect === 'branch') throw new Error(`${path}: expected a branch, found a leaf`);
    if (typeof node.name !== 'string') throw new Error(`${path}: leaf name must be a string`);
    const valueType = typeof node.value;
    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
      throw new Error(`${path}: leaf value must be string, number, or boolean`);
    }
  } else if (node.node === 'branch') {
    if (expect === 'leaf') throw new Error(`${path}: expected a leaf, found a branch`);
    if (typeof node.name !== 'string') throw new Error(`${path}: branch name must be a string`);
    if (!Array.isArray(node.children)) throw new Error(`${path}: branch children must be an array`);
    (node.children as unknown[]).forEach((child, i) => assertNode(child, 'any', `${path}/${i}`));
  } else {
    throw new Error(`${path}: field node must have node 'leaf' or 'branch'`);
  }
}

function assertAnchor(value: unknown): void {
  const anchor = value as Record<string, unknown> | null;
  if (!anchor || typeof anchor !== 'object') throw new Error('anchor must be an object');
  if (typeof anchor.provider !== 'string') throw new Error('anchor.provider must be a string');
  if (!isHex(anchor.digest, 32)) throw new Error('anchor.digest must be 32-byte hex');
  if (typeof anchor.proof !== 'string') throw new Error('anchor.proof must be a string');
  if (anchor.status !== 'pending' && anchor.status !== 'confirmed') {
    throw new Error("anchor.status must be 'pending' or 'confirmed'");
  }
  if (typeof anchor.stampedAt !== 'string') throw new Error('anchor.stampedAt must be a string');
}

/**
 * Structural validation. Throws on the first problem found. Useful as a
 * guard on untrusted input (parsed JSON) before it is treated as an
 * Attestation — narrows the type on success.
 */
export function assertWellFormed(value: unknown): asserts value is Attestation {
  const a = value as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    throw new Error('attestation must be an object');
  }
  if (a.v !== 1) throw new Error('unsupported attestation version');
  if (typeof a.kind !== 'string' || !KINDS.includes(a.kind as AttestationKind)) {
    throw new Error(`unknown kind: ${String(a.kind)}`);
  }
  if (typeof a.tier !== 'string' || !TIERS.includes(a.tier as TierName)) {
    throw new Error(`unknown tier: ${String(a.tier)}`);
  }
  if (typeof a.subject !== 'string' || a.subject.length === 0) {
    throw new Error('subject must be a non-empty string');
  }
  if (typeof a.issuedAt !== 'string' || Number.isNaN(Date.parse(a.issuedAt))) {
    throw new Error('issuedAt must be an ISO 8601 timestamp');
  }
  assertNode(a.claim, 'branch', 'claim');
  if (!Array.isArray(a.signatures)) throw new Error('signatures must be an array');
  for (const entry of a.signatures as unknown[]) {
    const sig = entry as Record<string, unknown> | null;
    if (!isHex(sig?.signer, 32)) throw new Error('signature.signer must be 32-byte hex');
    if (!isHex(sig?.sig, 64)) throw new Error('signature.sig must be 64-byte hex');
  }
  if (a.anchor !== undefined && a.anchor !== null) assertAnchor(a.anchor);
}
