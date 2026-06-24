/**
 * Dependency-free OpenTimestamps proof codec.
 *
 * Parses and re-serializes `.ots` detached-timestamp proofs and the
 * recursive timestamp trees inside them, with no npm `opentimestamps`
 * dependency. This is the machinery `OpenTimestampsProvider` uses to find
 * a pending proof's commitment — the value that must be queried against
 * the calendar's `/timestamp/<commitment>` endpoint to upgrade it — and
 * to read the Bitcoin block height out of a Bitcoin attestation once the
 * timestamp confirms.
 *
 * The proof file layout:
 *   MAGIC(31) | version:varint | file-hash-op:byte | file-digest:bytes
 *   | timestamp
 *
 * A timestamp is a recursive tree. Each node carries a running message
 * (the digest committed at that node) and a list of items. An item is
 * either an attestation (a leaf claim — pending calendar, Bitcoin block,
 * or an unknown type) or an operation (sha256 / ripemd160 / append /
 * prepend) whose result is itself a child timestamp. On the wire every
 * item except the last is preceded by a 0xff fork byte.
 *
 * Scope boundary: this codec reads proof structure and extracts the
 * Bitcoin block height from a Bitcoin attestation. It does NOT
 * independently re-validate that the attested commitment is actually
 * contained in that Bitcoin block — full trustless verification needs a
 * Bitcoin node or block explorer and is deliberately out of scope.
 */
import { sha256, bytesToHex, concatBytes, utf8ToBytes } from '../internal.js';
import { ripemd160 } from '@noble/hashes/ripemd160';

/** 31-byte `.ots` file magic. */
const PROOF_MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61,
  0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf,
  0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);

const ATTESTATION_MARKER = 0x00;
const FORK_MARKER = 0xff;

/** 8-byte attestation type tags. */
const PENDING_TAG = new Uint8Array([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const BITCOIN_TAG = new Uint8Array([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

/** Operation tags. */
const OP_SHA1 = 0x02;
const OP_RIPEMD160 = 0x03;
const OP_SHA256 = 0x08;
const OP_KECCAK256 = 0x67;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;

/** Digest byte length per file-hash operation. */
const DIGEST_LENGTH: Record<number, number> = { 0x02: 20, 0x03: 20, 0x08: 32, 0x67: 32 };

export type OtsOp =
  | { kind: 'sha256' }
  | { kind: 'ripemd160' }
  | { kind: 'append'; arg: Uint8Array }
  | { kind: 'prepend'; arg: Uint8Array };

export type OtsAttestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: Uint8Array; payload: Uint8Array };

export type OtsItem =
  | { item: 'attestation'; attestation: OtsAttestation }
  | { item: 'op'; op: OtsOp; child: OtsTimestamp };

/** A node in the timestamp tree. */
export interface OtsTimestamp {
  /** The digest this node commits — the upgrade commitment for any
   * pending attestation that sits directly in this node. */
  msg: Uint8Array;
  items: OtsItem[];
}

/** A parsed `.ots` detached-timestamp proof. */
export interface OtsProof {
  version: number;
  fileHashOp: number;
  fileDigest: Uint8Array;
  timestamp: OtsTimestamp;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** OpenTimestamps varint: little-endian base-128, MSB = continuation. */
function encodeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ots: cannot encode varint ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

/** A forward-only reader over proof bytes. */
class Cursor {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error('ots: unexpected end of proof');
    return this.bytes[this.pos++];
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error('ots: unexpected end of proof');
    const slice = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new Error('ots: varint too long');
    }
    return result;
  }

  varbytes(): Uint8Array {
    return this.take(this.varint());
  }

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }
}

function applyOp(op: OtsOp, msg: Uint8Array): Uint8Array {
  switch (op.kind) {
    case 'sha256':
      return sha256(msg);
    case 'ripemd160':
      return ripemd160(msg);
    case 'append':
      return concatBytes(msg, op.arg);
    case 'prepend':
      return concatBytes(op.arg, msg);
  }
}

function parseOp(tag: number, cur: Cursor): OtsOp {
  switch (tag) {
    case OP_SHA256:
      return { kind: 'sha256' };
    case OP_RIPEMD160:
      return { kind: 'ripemd160' };
    case OP_APPEND:
      return { kind: 'append', arg: cur.varbytes() };
    case OP_PREPEND:
      return { kind: 'prepend', arg: cur.varbytes() };
    case OP_SHA1:
    case OP_KECCAK256:
      throw new Error(
        `ots: operation 0x${tag.toString(16)} is unsupported — Bitcoin calendar proofs do not use it`,
      );
    default:
      throw new Error(`ots: unknown operation tag 0x${tag.toString(16)}`);
  }
}

function parseAttestation(tag: Uint8Array, payload: Uint8Array): OtsAttestation {
  if (bytesEqual(tag, PENDING_TAG)) {
    const uriBytes = new Cursor(payload).varbytes();
    return { kind: 'pending', uri: new TextDecoder().decode(uriBytes) };
  }
  if (bytesEqual(tag, BITCOIN_TAG)) {
    return { kind: 'bitcoin', height: new Cursor(payload).varint() };
  }
  return { kind: 'unknown', tag, payload };
}

function parseTimestamp(cur: Cursor, msg: Uint8Array): OtsTimestamp {
  const items: OtsItem[] = [];
  for (;;) {
    const tag = cur.byte();
    const isLast = tag !== FORK_MARKER;
    const itemTag = isLast ? tag : cur.byte();
    if (itemTag === ATTESTATION_MARKER) {
      const attTag = cur.take(8);
      const payload = cur.varbytes();
      items.push({ item: 'attestation', attestation: parseAttestation(attTag, payload) });
    } else {
      const op = parseOp(itemTag, cur);
      const child = parseTimestamp(cur, applyOp(op, msg));
      items.push({ item: 'op', op, child });
    }
    if (isLast) break;
  }
  return { msg, items };
}

function serializeAttestation(att: OtsAttestation): { tag: Uint8Array; payload: number[] } {
  if (att.kind === 'pending') {
    const uri = utf8ToBytes(att.uri);
    return { tag: PENDING_TAG, payload: [...encodeVarint(uri.length), ...uri] };
  }
  if (att.kind === 'bitcoin') {
    return { tag: BITCOIN_TAG, payload: encodeVarint(att.height) };
  }
  return { tag: att.tag, payload: [...att.payload] };
}

function serializeOp(op: OtsOp): number[] {
  switch (op.kind) {
    case 'sha256':
      return [OP_SHA256];
    case 'ripemd160':
      return [OP_RIPEMD160];
    case 'append':
      return [OP_APPEND, ...encodeVarint(op.arg.length), ...op.arg];
    case 'prepend':
      return [OP_PREPEND, ...encodeVarint(op.arg.length), ...op.arg];
  }
}

function serializeTimestamp(node: OtsTimestamp): number[] {
  if (node.items.length === 0) throw new Error('ots: cannot serialize an empty timestamp');
  const out: number[] = [];
  node.items.forEach((it, index) => {
    if (index !== node.items.length - 1) out.push(FORK_MARKER);
    if (it.item === 'attestation') {
      const { tag, payload } = serializeAttestation(it.attestation);
      out.push(ATTESTATION_MARKER, ...tag, ...encodeVarint(payload.length), ...payload);
    } else {
      out.push(...serializeOp(it.op), ...serializeTimestamp(it.child));
    }
  });
  return out;
}

/** Parse a `.ots` detached-timestamp proof. Throws on a malformed proof. */
export function parseOtsProof(bytes: Uint8Array): OtsProof {
  const cur = new Cursor(bytes);
  if (!bytesEqual(cur.take(PROOF_MAGIC.length), PROOF_MAGIC)) {
    throw new Error('ots: not an OpenTimestamps proof (bad magic)');
  }
  const version = cur.varint();
  const fileHashOp = cur.byte();
  const digestLength = DIGEST_LENGTH[fileHashOp];
  if (!digestLength) {
    throw new Error(`ots: unsupported file-hash operation 0x${fileHashOp.toString(16)}`);
  }
  const fileDigest = cur.take(digestLength);
  return { version, fileHashOp, fileDigest, timestamp: parseTimestamp(cur, fileDigest) };
}

/** Serialize a parsed proof back to `.ots` bytes. */
export function serializeOtsProof(proof: OtsProof): Uint8Array {
  return Uint8Array.from([
    ...PROOF_MAGIC,
    ...encodeVarint(proof.version),
    proof.fileHashOp,
    ...proof.fileDigest,
    ...serializeTimestamp(proof.timestamp),
  ]);
}

/** Parse a bare timestamp serialization (a calendar response body). */
export function parseTimestampBytes(bytes: Uint8Array, initialMsg: Uint8Array): OtsTimestamp {
  return parseTimestamp(new Cursor(bytes), initialMsg);
}

/** Serialize a bare timestamp (without the proof file header). */
export function serializeTimestampBytes(node: OtsTimestamp): Uint8Array {
  return Uint8Array.from(serializeTimestamp(node));
}

/**
 * Assemble a `.ots` proof from a file digest and a calendar's timestamp
 * response — the SHA-256 stamp path. v1 / OP_SHA256.
 */
export function assembleProof(fileDigest: Uint8Array, calendarTimestamp: Uint8Array): Uint8Array {
  return concatBytes(
    PROOF_MAGIC,
    Uint8Array.from(encodeVarint(1)),
    Uint8Array.from([OP_SHA256]),
    fileDigest,
    calendarTimestamp,
  );
}

/**
 * Every pending attestation in the proof, paired with the node it sits
 * in. `node.msg` is the commitment to query at `<uri>/timestamp/<hex>`.
 */
export function pendingAttestations(
  proof: OtsProof,
): { commitment: Uint8Array; uri: string; node: OtsTimestamp }[] {
  const found: { commitment: Uint8Array; uri: string; node: OtsTimestamp }[] = [];
  const walk = (node: OtsTimestamp): void => {
    for (const it of node.items) {
      if (it.item === 'attestation' && it.attestation.kind === 'pending') {
        found.push({ commitment: node.msg, uri: it.attestation.uri, node });
      } else if (it.item === 'op') {
        walk(it.child);
      }
    }
  };
  walk(proof.timestamp);
  return found;
}

/** The earliest Bitcoin block height attested in the proof, if any. */
export function bitcoinHeight(proof: OtsProof): number | undefined {
  let best: number | undefined;
  const walk = (node: OtsTimestamp): void => {
    for (const it of node.items) {
      if (it.item === 'attestation' && it.attestation.kind === 'bitcoin') {
        best = best === undefined ? it.attestation.height : Math.min(best, it.attestation.height);
      } else if (it.item === 'op') {
        walk(it.child);
      }
    }
  };
  walk(proof.timestamp);
  return best;
}

/**
 * Splice a calendar's upgrade response into a node, in place. The upgrade
 * timestamp shares the node's commitment; its items are appended so the
 * pending attestation is preserved alongside the new (eventually
 * Bitcoin-bearing) path. Exact-duplicate pending attestations are skipped
 * so re-running an upgrade stays idempotent.
 */
export function mergeUpgrade(node: OtsTimestamp, upgrade: OtsTimestamp): void {
  for (const it of upgrade.items) {
    if (it.item === 'attestation' && it.attestation.kind === 'pending') {
      const { uri } = it.attestation;
      const alreadyPresent = node.items.some(
        (existing) =>
          existing.item === 'attestation' &&
          existing.attestation.kind === 'pending' &&
          existing.attestation.uri === uri,
      );
      if (alreadyPresent) continue;
    }
    node.items.push(it);
  }
}

/** Hex of a commitment — convenience for building a `/timestamp/<hex>` URL. */
export function commitmentHex(commitment: Uint8Array): string {
  return bytesToHex(commitment);
}
