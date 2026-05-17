/**
 * The claim field tree.
 *
 * Every attestation's payload is a tree of named fields. A leaf
 * holds a scalar; a branch holds an ordered list of child nodes.
 * Each node hashes to 32 bytes, and the tree's root hash is what
 * the signature ultimately commits to.
 *
 * Why a tree and not a flat object: it makes field-level selective
 * disclosure possible later -- you reveal a subtree plus the sibling
 * hashes on its path to the root, and a verifier can confirm the
 * revealed fields belong to the signed root WITHOUT seeing the rest.
 * v1 only computes the full root. The proof-generation half is a
 * named v1.1 slot (see `disclosureProof` below and the README).
 *
 * The tree shape is MANDATORY in v1 even though disclosure ships
 * later: building every attestation as a tree now means no envelope
 * has to be re-signed when disclosure arrives.
 */

import { taggedHash, TAGS } from '../internal/hash.js';
import { canonicalJson } from '../internal/canonical.js';
import { toHex, u32, utf8 } from '../internal/hex.js';

export type FieldScalar = string | number | boolean | null;

export interface FieldLeaf {
  readonly kind: 'leaf';
  readonly name: string;
  readonly value: FieldScalar;
}

export interface FieldBranch {
  readonly kind: 'branch';
  readonly name: string;
  readonly children: readonly FieldNode[];
}

export type FieldNode = FieldLeaf | FieldBranch;

export function leaf(name: string, value: FieldScalar): FieldLeaf {
  return { kind: 'leaf', name, value };
}

export function branch(name: string, children: readonly FieldNode[]): FieldBranch {
  return { kind: 'branch', name, children };
}

/**
 * Build a field tree from a plain object. Nested objects become
 * branches, scalars become leaves. Arrays are rejected: model
 * ordered collections as a branch with indexed child names so the
 * structure stays explicit and hashable.
 */
export function treeFromObject(name: string, obj: Record<string, unknown>): FieldBranch {
  const children: FieldNode[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        throw new Error(`field "${key}": arrays are not supported, use an indexed branch`);
      }
      children.push(treeFromObject(key, v as Record<string, unknown>));
    } else {
      children.push(leaf(key, v as FieldScalar));
    }
  }
  return branch(name, children);
}

function hashNode(node: FieldNode): Uint8Array {
  const nameBytes = utf8(node.name);
  if (node.kind === 'leaf') {
    const valueBytes = utf8(canonicalJson(node.value));
    return taggedHash(
      TAGS.leaf,
      u32(nameBytes.length),
      nameBytes,
      u32(valueBytes.length),
      valueBytes,
    );
  }
  const childHashes = node.children.map(hashNode);
  return taggedHash(
    TAGS.branch,
    u32(nameBytes.length),
    nameBytes,
    u32(childHashes.length),
    ...childHashes,
  );
}

/** Recompute the 32-byte Merkle root of a field tree, as hex. */
export function fieldTreeRoot(root: FieldNode): string {
  return toHex(hashNode(root));
}

/** Count every node in the tree -- handy for size limits / display. */
export function countNodes(node: FieldNode): number {
  if (node.kind === 'leaf') return 1;
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

/**
 * Read a leaf value by name path. The first path element must match
 * `root.name`; the rest descend through branch children. Returns
 * `undefined` if the path does not resolve to a leaf.
 */
export function findLeafValue(
  root: FieldNode,
  path: readonly string[],
): FieldScalar | undefined {
  if (path.length === 0 || root.name !== path[0]) return undefined;
  let node: FieldNode = root;
  for (let i = 1; i < path.length; i++) {
    if (node.kind === 'leaf') return undefined;
    const next = node.children.find((c) => c.name === path[i]);
    if (!next) return undefined;
    node = next;
  }
  return node.kind === 'leaf' ? node.value : undefined;
}

/**
 * v1.1+ SLOT -- field-level selective disclosure.
 *
 * Will return a proof that a named subtree belongs to a signed
 * root, carrying only the sibling hashes on the path. Intentionally
 * unimplemented in v1; the tree shape above already supports it.
 */
export function disclosureProof(_root: FieldNode, _path: readonly string[]): never {
  throw new Error('disclosureProof: v1.1 slot, not implemented in v1');
}
