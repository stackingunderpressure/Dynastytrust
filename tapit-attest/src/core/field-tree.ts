import type {
  Attestation,
  AttestationKind,
  FieldBranch,
  FieldLeaf,
  FieldNode,
  FieldValue,
  Signature,
  TierName,
} from '../types.js';
import {
  bytesToHex,
  canonicalJson,
  concatBytes,
  hexToBytes,
  taggedHash,
  utf8ToBytes,
} from '../internal.js';
import { metaHash } from './envelope.js';
import { verifySignature, type SignerResult } from './keys.js';

export function leaf(name: string, value: FieldValue): FieldLeaf {
  return { node: 'leaf', name, value };
}

export function branch(name: string, children: FieldNode[]): FieldBranch {
  return { node: 'branch', name, children };
}

/**
 * Build a field tree from a plain object. Nested objects become branches,
 * scalars become leaves, arrays are stored as canonical JSON in a leaf.
 * Keys are sorted at every depth so the same object always yields the
 * same tree — and therefore the same Merkle root.
 */
export function treeFromObject(name: string, obj: Record<string, unknown>): FieldBranch {
  const children: FieldNode[] = [];
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (Array.isArray(value)) {
      children.push(leaf(key, canonicalJson(value)));
    } else if (value !== null && typeof value === 'object') {
      children.push(treeFromObject(key, value as Record<string, unknown>));
    } else if (value === null || value === undefined) {
      children.push(leaf(key, ''));
    } else {
      children.push(leaf(key, value as FieldValue));
    }
  }
  return branch(name, children);
}

function leafHash(node: FieldLeaf): Uint8Array {
  return taggedHash(
    'tapit/leaf',
    utf8ToBytes(canonicalJson({ name: node.name, value: node.value })),
  );
}

function branchHash(node: FieldBranch): Uint8Array {
  const childHashes = node.children.map(nodeHash);
  return taggedHash('tapit/branch', utf8ToBytes(node.name), concatBytes(...childHashes));
}

function nodeHash(node: FieldNode): Uint8Array {
  return node.node === 'leaf' ? leafHash(node) : branchHash(node);
}

/**
 * The Merkle root of a field tree. Every signer signs a digest that
 * commits to this root, so changing any field — name or value, at any
 * depth — invalidates every signature.
 */
export function fieldTreeRoot(root: FieldBranch): Uint8Array {
  return branchHash(root);
}

/**
 * Resolve a leaf value by path. Path is slash-delimited (`fields/label`)
 * or an array of segment names. Returns undefined if the path misses or
 * lands on a branch.
 */
export function findLeafValue(
  root: FieldBranch,
  path: string | string[],
): FieldValue | undefined {
  const segments = Array.isArray(path) ? path : path.split('/').filter(Boolean);
  let current: FieldNode = root;
  for (const segment of segments) {
    if (current.node !== 'branch') return undefined;
    const next: FieldNode | undefined = current.children.find((c) => c.name === segment);
    if (!next) return undefined;
    current = next;
  }
  return current.node === 'leaf' ? current.value : undefined;
}

// -----------------------------------------------------------------------------
// Selective leaf disclosure (DESIGN.md Phase 4).
//
// "Prove I'm over 21 without revealing my birthday." The wallet picks a
// single leaf out of an attestation's claim tree and produces a proof
// bundle that lets a third party verify the leaf is bound to the signed
// envelope WITHOUT ever revealing the rest of the claim. The bundle
// carries the envelope's meta-fields (v/kind/tier/subject/issuedAt — so
// the verifier can recompute metaHash), the disclosed leaf node, a
// sibling-hash list walked from leaf-up-to-root so the verifier can
// reconstruct the Merkle root, and the envelope's signatures so the
// verifier can check the math.
//
// The verifier reconstructs the claim root from the leaf + siblings,
// computes attestationDigest = taggedHash('tapit/root', metaHash ||
// claimRoot), and validates each signature. Quorum-of-good applies
// exactly as for verifyEnvelope.
// -----------------------------------------------------------------------------

export interface DisclosureStep {
  /** The branch name at this level. */
  branchName: string;
  /** Position of the path child in this branch's children list. */
  pathIndex: number;
  /** Sibling node hashes (hex) in their original order; the pathIndex
   *  slot is omitted so the verifier knows where the path child goes. */
  siblingHashes: string[];
}

export interface DisclosureMeta {
  v: 1;
  kind: AttestationKind;
  tier: TierName;
  subject: string;
  issuedAt: string;
}

export interface DisclosureProofBundle {
  v: 1;
  meta: DisclosureMeta;
  /** The disclosed leaf — name + value visible to the verifier. */
  leaf: FieldLeaf;
  /** Walk from root branch downward; the last step is the leaf's
   *  containing branch. */
  steps: DisclosureStep[];
  /** Envelope's signatures, copied verbatim. */
  signatures: Signature[];
}

/**
 * Produce a disclosure proof for one leaf of an attestation's claim tree.
 * Path is slash-delimited or an array; it must terminate at a leaf node.
 * Throws if the path misses, lands on a branch, or attempts a zero-segment
 * path.
 */
export function disclosureProof(
  attestation: Attestation,
  leafPath: string | string[],
): DisclosureProofBundle {
  const segments = Array.isArray(leafPath)
    ? leafPath
    : leafPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('disclosureProof: leafPath must have at least one segment');
  }

  const steps: DisclosureStep[] = [];
  let current: FieldBranch = attestation.claim;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const childIndex = current.children.findIndex((c) => c.name === segment);
    if (childIndex < 0) {
      throw new Error(`disclosureProof: path segment "${segment}" not found`);
    }
    const child = current.children[childIndex];
    if (!child) {
      throw new Error(`disclosureProof: path segment "${segment}" missing child`);
    }

    const siblingHashes = current.children
      .map((c, idx) => (idx === childIndex ? null : bytesToHex(nodeHash(c))))
      .filter((h): h is string => h !== null);
    steps.push({
      branchName: current.name,
      pathIndex: childIndex,
      siblingHashes,
    });

    const isLast = i === segments.length - 1;
    if (isLast) {
      if (child.node !== 'leaf') {
        throw new Error('disclosureProof: path must terminate at a leaf');
      }
      return {
        v: 1,
        meta: {
          v: attestation.v,
          kind: attestation.kind,
          tier: attestation.tier,
          subject: attestation.subject,
          issuedAt: attestation.issuedAt,
        },
        leaf: child,
        steps,
        signatures: [...attestation.signatures],
      };
    }
    if (child.node !== 'branch') {
      throw new Error(
        `disclosureProof: path segment "${segment}" is a leaf but path continues`,
      );
    }
    current = child;
  }
  throw new Error('disclosureProof: unreachable');
}

export interface DisclosureVerifyResult {
  /** True if the proof structurally valid AND at least one signature
   *  verifies against the recomputed attestation digest. */
  valid: boolean;
  /** Hex of the recomputed attestation digest. */
  digest: string;
  /** Per-signer verification result. */
  signers: SignerResult[];
  errors: string[];
}

function recomputeClaimRoot(proof: DisclosureProofBundle): Uint8Array {
  // Start with the disclosed leaf's hash; walk back up by reconstructing
  // each branch hash with the path-child at pathIndex and the siblings
  // in their recorded order. Steps were recorded from root downward,
  // so we walk them in reverse.
  let current: Uint8Array = leafHash(proof.leaf);
  for (let i = proof.steps.length - 1; i >= 0; i--) {
    const step = proof.steps[i];
    if (!step) throw new Error('verifyDisclosureProof: missing step');
    if (step.pathIndex < 0 || step.pathIndex > step.siblingHashes.length) {
      throw new Error(`verifyDisclosureProof: pathIndex out of range at step ${i}`);
    }
    const childHashes: Uint8Array[] = [];
    let siblingIdx = 0;
    const total = step.siblingHashes.length + 1;
    for (let j = 0; j < total; j++) {
      if (j === step.pathIndex) {
        childHashes.push(current);
      } else {
        const hex = step.siblingHashes[siblingIdx];
        if (typeof hex !== 'string') {
          throw new Error('verifyDisclosureProof: missing sibling hash');
        }
        childHashes.push(hexToBytes(hex));
        siblingIdx++;
      }
    }
    current = taggedHash(
      'tapit/branch',
      utf8ToBytes(step.branchName),
      concatBytes(...childHashes),
    );
  }
  return current;
}

/**
 * Verify a disclosure proof bundle. Recomputes the claim root from the
 * leaf + sibling hashes, recomputes the canonical attestation digest
 * using the same metaHash and root-tag the signer used, and runs each
 * carried signature against that digest with quorum-of-good semantics —
 * at least one valid signature is enough; bad signatures are reported
 * but never poison a genuine proof.
 */
export function verifyDisclosureProof(
  proof: DisclosureProofBundle,
): DisclosureVerifyResult {
  const errors: string[] = [];
  let claimRoot: Uint8Array;
  try {
    claimRoot = recomputeClaimRoot(proof);
  } catch (err) {
    return {
      valid: false,
      digest: '',
      signers: [],
      errors: [err instanceof Error ? err.message : 'malformed proof'],
    };
  }
  const meta = metaHash(proof.meta);
  const digestBytes = taggedHash('tapit/root', concatBytes(meta, claimRoot));
  const signers: SignerResult[] = proof.signatures.map((s) => ({
    signer: s.signer,
    valid: verifySignature(digestBytes, s.sig, s.signer),
  }));
  const validSet = new Set(
    signers.filter((s) => s.valid).map((s) => s.signer),
  );
  for (const s of signers) {
    if (!s.valid && !validSet.has(s.signer)) {
      errors.push(`invalid signature from ${s.signer}`);
    }
  }
  if (proof.signatures.length === 0) {
    errors.push('proof has no signatures');
  }
  return {
    valid: validSet.size > 0,
    digest: bytesToHex(digestBytes),
    signers,
    errors,
  };
}

// ----- multi-field disclosure (pruned Merkle multi-proof) ---------------
//
// A multi-disclosure bundle carries N leaf values along with the minimum
// Merkle structure needed to recompute the same claim root the signer
// signed. Branches on the spanning subtree of the disclosed leaves keep
// their disclosed children inline and replace non-disclosed siblings with
// just their node hashes; branches entirely outside the spanning subtree
// are never reached. The verifier recomputes the root top-down using the
// same leafHash / branchHash functions the signer used, then runs the
// existing signature check.
//
// Wire shape design:
//   ProofChild = a leaf with full content
//              | a branch with full child list (children are ProofChild)
//              | a hashed-out subtree (just its node hash)
// Bundle.root is always a 'branch' ProofChild matching the original
// attestation.claim root. paths is informational — the verifier never
// needs it, but the wallet UI can use it to label the disclosed leaves
// without walking the pruned tree.

export type ProofChild =
  | { node: 'leaf'; name: string; value: FieldValue }
  | { node: 'branch'; name: string; children: ProofChild[] }
  | { node: 'hashed'; name: string; hash: string };

export interface MultiDisclosureProofBundle {
  v: 1;
  meta: DisclosureMeta;
  /** The paths disclosed by this bundle, slash-delimited. Convenience
   *  for callers; verification does not depend on it. */
  paths: string[];
  /** The pruned claim tree. Always a 'branch' node corresponding to
   *  attestation.claim. */
  root: ProofChild;
  signatures: Signature[];
}

function pruneNode(
  node: FieldNode,
  keep: Set<FieldNode>,
): ProofChild {
  if (node.node === 'leaf') {
    if (!keep.has(node)) {
      return { node: 'hashed', name: node.name, hash: bytesToHex(leafHash(node)) };
    }
    return { node: 'leaf', name: node.name, value: node.value };
  }
  // branch: include children in original order; recurse into kept
  // children, hash the rest. If the branch itself is not kept, hash
  // the whole subtree.
  if (!keep.has(node)) {
    return { node: 'hashed', name: node.name, hash: bytesToHex(branchHash(node)) };
  }
  const children: ProofChild[] = node.children.map((child) =>
    pruneNode(child, keep),
  );
  return { node: 'branch', name: node.name, children };
}

function markSpanningTree(
  root: FieldBranch,
  segments: string[],
  keep: Set<FieldNode>,
): void {
  let current: FieldNode = root;
  keep.add(current);
  for (const segment of segments) {
    if (current.node !== 'branch') {
      throw new Error(
        `multiDisclosureProof: path segment "${segment}" continues past a leaf`,
      );
    }
    const next: FieldNode | undefined = current.children.find(
      (c) => c.name === segment,
    );
    if (!next) {
      throw new Error(`multiDisclosureProof: path segment "${segment}" not found`);
    }
    keep.add(next);
    current = next;
  }
  if (current.node !== 'leaf') {
    throw new Error('multiDisclosureProof: each path must terminate at a leaf');
  }
}

/**
 * Produce a multi-leaf disclosure proof. Same security model as
 * disclosureProof, just amortizing the Merkle path overhead across N
 * leaves — non-disclosed siblings appear as a single hash, regardless
 * of how big the subtree below them is. Paths are slash-delimited or
 * arrays; each must terminate at a leaf. Duplicate paths are reduced
 * to one disclosure.
 */
export function multiDisclosureProof(
  attestation: Attestation,
  leafPaths: ReadonlyArray<string | string[]>,
): MultiDisclosureProofBundle {
  if (leafPaths.length === 0) {
    throw new Error('multiDisclosureProof: leafPaths must not be empty');
  }
  const keep = new Set<FieldNode>();
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of leafPaths) {
    const segments = Array.isArray(raw) ? raw : raw.split('/').filter(Boolean);
    if (segments.length === 0) {
      throw new Error('multiDisclosureProof: each leafPath must have at least one segment');
    }
    const joined = segments.join('/');
    if (seen.has(joined)) continue;
    seen.add(joined);
    markSpanningTree(attestation.claim, segments, keep);
    normalized.push(joined);
  }
  const root = pruneNode(attestation.claim, keep);
  return {
    v: 1,
    meta: {
      v: attestation.v,
      kind: attestation.kind,
      tier: attestation.tier,
      subject: attestation.subject,
      issuedAt: attestation.issuedAt,
    },
    paths: normalized,
    root,
    signatures: [...attestation.signatures],
  };
}

function recomputeProofChildHash(node: ProofChild): Uint8Array {
  if (node.node === 'hashed') {
    return hexToBytes(node.hash);
  }
  if (node.node === 'leaf') {
    return leafHash({ node: 'leaf', name: node.name, value: node.value });
  }
  const childHashes = node.children.map(recomputeProofChildHash);
  return taggedHash(
    'tapit/branch',
    utf8ToBytes(node.name),
    concatBytes(...childHashes),
  );
}

/**
 * Walk the pruned proof tree to enumerate every disclosed leaf with
 * its slash-delimited path. The bundle's `paths` field is informational;
 * this is the authoritative read of what the proof actually discloses,
 * recovered from the tree structure itself.
 */
export function disclosedLeavesOf(
  bundle: MultiDisclosureProofBundle,
): ReadonlyArray<{ path: string; name: string; value: FieldValue }> {
  const out: { path: string; name: string; value: FieldValue }[] = [];
  function walk(node: ProofChild, parentPath: string[]): void {
    if (node.node === 'leaf') {
      out.push({
        path: parentPath.concat(node.name).join('/'),
        name: node.name,
        value: node.value,
      });
      return;
    }
    if (node.node === 'hashed') return;
    for (const child of node.children) {
      walk(child, parentPath.concat(node.name));
    }
  }
  // The root branch's name appears in the parent path of its children
  // but not as a path segment itself — paths in disclosureProof are
  // root-relative (e.g. 'fields/label' not 'claim/fields/label').
  if (bundle.root.node === 'branch') {
    for (const child of bundle.root.children) walk(child, []);
  }
  return out;
}

/**
 * Verify a multi-disclosure proof bundle. Recomputes the claim root
 * from the pruned tree, recomputes the canonical attestation digest,
 * and runs the carried signatures against it with the same
 * quorum-of-good semantics as verifyDisclosureProof.
 */
export function verifyMultiDisclosureProof(
  bundle: MultiDisclosureProofBundle,
): DisclosureVerifyResult {
  const errors: string[] = [];
  let claimRoot: Uint8Array;
  try {
    if (bundle.root.node !== 'branch') {
      throw new Error('verifyMultiDisclosureProof: root must be a branch');
    }
    claimRoot = recomputeProofChildHash(bundle.root);
  } catch (err) {
    return {
      valid: false,
      digest: '',
      signers: [],
      errors: [err instanceof Error ? err.message : 'malformed proof'],
    };
  }
  const meta = metaHash(bundle.meta);
  const digestBytes = taggedHash('tapit/root', concatBytes(meta, claimRoot));
  const signers: SignerResult[] = bundle.signatures.map((s) => ({
    signer: s.signer,
    valid: verifySignature(digestBytes, s.sig, s.signer),
  }));
  const validSet = new Set(
    signers.filter((s) => s.valid).map((s) => s.signer),
  );
  for (const s of signers) {
    if (!s.valid && !validSet.has(s.signer)) {
      errors.push(`invalid signature from ${s.signer}`);
    }
  }
  if (bundle.signatures.length === 0) {
    errors.push('proof has no signatures');
  }
  return {
    valid: validSet.size > 0,
    digest: bytesToHex(digestBytes),
    signers,
    errors,
  };
}
