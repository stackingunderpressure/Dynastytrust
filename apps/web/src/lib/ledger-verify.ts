/**
 * ledger-verify.ts -- the member's OWN check of a vault's sealed record.
 *
 * The server (netlify/functions/_ledger.js, _anchor.js, _ots.js) seals
 * every vault action into a hash chain and stamps the chain into
 * Bitcoin through OpenTimestamps. A member must not have to take the
 * server's word that the chain is intact, so this file re-does the
 * whole check inside the browser from the raw rows:
 *
 *   1. every entry's hash is recomputed from its contents,
 *   2. every entry chains from the one before it (the first from zeros),
 *   3. every stamp points at an entry that is still there, unchanged,
 *   4. every Bitcoin proof is replayed step by step and compared with
 *      the real block, looked up from two independent sources.
 *
 * It is a second, independent implementation on purpose (the server's
 * uses Node's crypto and Buffer; this one uses @noble/hashes and
 * Uint8Array). scripts/test-ledger-verify.mjs holds the two to the same
 * answers, word for word, on honest and tampered records, and against
 * the OpenTimestamps reference client's own proof and its real block.
 *
 * Pure except for `fetchMerkleRoots`, which takes its `fetch` as an
 * argument so the tests run offline.
 */
import { sha256 } from '@noble/hashes/sha256';
import { sha1 } from '@noble/hashes/sha1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { EXPLORER, SECOND_TIP_SOURCE } from '../config';

export interface LedgerEntry {
  vault_id: string;
  seq: number;
  recorded_at: string;
  actor_user_id: string | null;
  event_type: string;
  payload?: unknown;
  payload_canon: string;
  prev_hash: string;
  entry_hash: string;
}

export interface LedgerAnchor {
  seq: number;
  entry_hash: string;
  digest: string;
  calendar: string;
  kind: 'pending' | 'bitcoin';
  commitment: string;
  proof_b64: string;
  bitcoin_height: number | null;
  created_at?: string;
  reason?: string | null;
}

export type LedgerCheck =
  | { ok: true; count: number; tip: string }
  | { ok: false; brokenAt: number; reason: string };

export interface AnchorCheck {
  ok: boolean;
  /** Highest entry that holds a valid calendar receipt. */
  anchoredThrough: number;
  /** Highest entry proven in a Bitcoin block. */
  confirmedThrough: number;
  bitcoinHeight: number | null;
  /** False when no block could be looked up at all. */
  blocksChecked: boolean;
  /** Bitcoin proofs whose block this check did not look up. */
  blocksUnchecked: number;
  problems: string[];
}

export const LEDGER_GENESIS = '0'.repeat(64);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const toHex = (b: Uint8Array): string => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Error('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Canonical JSON: object keys sorted, no whitespace, no undefined. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** sha256 over the exact newline-joined fields the database hashes. */
export function ledgerEntryHash(e: Pick<LedgerEntry, 'prev_hash' | 'vault_id' | 'seq' | 'recorded_at' | 'actor_user_id' | 'event_type' | 'payload_canon'>): string {
  const input = [e.prev_hash, e.vault_id, String(e.seq), e.recorded_at, e.actor_user_id ?? '', e.event_type, e.payload_canon].join('\n');
  return toHex(sha256(utf8(input)));
}

/** Re-walk the chain. Entries may arrive in any order. */
export function verifyLedger(entries: readonly LedgerEntry[]): LedgerCheck {
  const rows = [...entries].sort((a, b) => Number(a.seq) - Number(b.seq));
  let prev = LEDGER_GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    const at = Number(e.seq);
    if (at !== i + 1) return { ok: false, brokenAt: i + 1, reason: `entry ${i + 1} is missing or out of order (found ${at})` };
    if (e.prev_hash !== prev) return { ok: false, brokenAt: at, reason: `entry ${at} does not chain from entry ${at - 1}` };
    if (e.entry_hash !== ledgerEntryHash(e)) return { ok: false, brokenAt: at, reason: `entry ${at} was altered: its contents no longer match its hash` };
    if (e.payload !== undefined && canonicalJson(e.payload) !== e.payload_canon) {
      return { ok: false, brokenAt: at, reason: `entry ${at}: the displayed details differ from the details that were sealed` };
    }
    prev = e.entry_hash;
  }
  return { ok: true, count: rows.length, tip: prev };
}

// ---- OpenTimestamps: replaying a proof --------------------------------

const TAG_PENDING = '83dfe30d2ef90c8e';
const TAG_BITCOIN = '0588960d73d71901';
const MAX_MSG = 4096;
const MAX_OPS = 2000;

export type OtsAttestation =
  | { kind: 'bitcoin'; height: number; commitment: string }
  | { kind: 'pending'; uri: string; commitment: string }
  | { kind: 'unknown'; commitment: string };

/** The digest that is stamped for one position of one vault's record. */
export function anchorDigest(a: { vaultId: string; seq: number; entryHash: string }): Uint8Array {
  return sha256(utf8(`DT-LEDGER-ANCHOR-v1\n${a.vaultId}\n${a.seq}\n${a.entryHash}`));
}

interface Reader {
  done(): boolean;
  byte(): number;
  bytes(n: number): Uint8Array;
  varuint(): number;
  varbytes(max?: number): Uint8Array;
}

function reader(buf: Uint8Array): Reader {
  let p = 0;
  const need = (n: number) => { if (p + n > buf.length) throw new Error('OTS proof is truncated'); };
  const r: Reader = {
    done: () => p >= buf.length,
    byte() { need(1); return buf[p++]; },
    bytes(n) { need(n); const out = buf.subarray(p, p + n); p += n; return out; },
    varuint() {
      let v = 0, shift = 0;
      for (;;) {
        const b = r.byte();
        v += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 49) throw new Error('OTS varuint too large');
      }
      return v;
    },
    varbytes(max = MAX_MSG) {
      const n = r.varuint();
      if (n > max) throw new Error('OTS field too long');
      return r.bytes(n);
    },
  };
  return r;
}

function applyOp(tag: number, msg: Uint8Array, r: Reader): Uint8Array {
  let out: Uint8Array;
  switch (tag) {
    case 0x08: out = sha256(msg); break;
    case 0x02: out = sha1(msg); break;
    case 0x03: out = ripemd160(msg); break;
    case 0xf0: out = concat(msg, r.varbytes()); break; // append
    case 0xf1: out = concat(r.varbytes(), msg); break; // prepend
    default: throw new Error(`OTS proof uses an unsupported operation 0x${tag.toString(16)}`);
  }
  if (out.length > MAX_MSG) throw new Error('OTS intermediate value too long');
  return out;
}

/** Replay a proof from `startMsg`; return every attestation it reaches. */
export function readAttestations(startMsg: Uint8Array, proofBytes: Uint8Array): OtsAttestation[] {
  const r = reader(proofBytes);
  const found: OtsAttestation[] = [];
  let ops = 0;
  const step = (tag: number, msg: Uint8Array, depth: number): void => {
    if (++ops > MAX_OPS) throw new Error('OTS proof has too many operations');
    if (tag === 0x00) {
      const kindTag = toHex(r.bytes(8));
      const payload = reader(r.varbytes(8192));
      if (kindTag === TAG_BITCOIN) found.push({ kind: 'bitcoin', height: payload.varuint(), commitment: toHex(msg) });
      else if (kindTag === TAG_PENDING) found.push({ kind: 'pending', uri: new TextDecoder().decode(payload.varbytes(1000)), commitment: toHex(msg) });
      else found.push({ kind: 'unknown', commitment: toHex(msg) });
      return;
    }
    walk(applyOp(tag, msg, r), depth + 1);
  };
  const walk = (msg: Uint8Array, depth: number): void => {
    if (depth > 256) throw new Error('OTS proof nests too deeply');
    let tag = r.byte();
    while (tag === 0xff) { // a fork: one branch here, more to follow
      step(r.byte(), msg, depth);
      tag = r.byte();
    }
    step(tag, msg, depth);
  };
  walk(startMsg, 0);
  if (!r.done()) throw new Error('OTS proof has trailing bytes');
  return found;
}

/** Is this Bitcoin attestation really that block's merkle root?
 *  `merkleRootHex` is the root as block explorers print it. */
export function matchesBlock(att: OtsAttestation | undefined, merkleRootHex: string | null | undefined): boolean {
  if (att?.kind !== 'bitcoin' || !/^[0-9a-f]{64}$/i.test(merkleRootHex || '')) return false;
  const internal = toHex(fromHex(merkleRootHex as string).reverse());
  return att.commitment === internal;
}

/**
 * Check a vault's stamps against its entries. Same rules, same words,
 * as the server's verifyAnchors. `merkleRoots` maps a block height to
 * that block's merkle root: a height with no key was not looked up
 * (counted in blocksUnchecked); a key with an empty value means the
 * lookup failed, which is a problem; null means no block was checked.
 */
export function verifyAnchors(
  entries: readonly LedgerEntry[],
  anchors: readonly LedgerAnchor[],
  merkleRoots: Record<number, string | null> | null = null,
): AnchorCheck {
  const bySeq = new Map(entries.map(e => [Number(e.seq), e]));
  const problems: string[] = [];
  let anchoredThrough = 0, confirmedThrough = 0, blocksUnchecked = 0;
  let bitcoinHeight: number | null = null;
  const receipts = new Set<string>();
  const base = (a: LedgerAnchor): { seq: number; digest: Uint8Array } | null => {
    const seq = Number(a.seq);
    const e = bySeq.get(seq);
    if (!e) { problems.push(`entry ${seq} was anchored to Bitcoin but is no longer in the ledger`); return null; }
    if (e.entry_hash !== a.entry_hash) { problems.push(`entry ${seq} is not the entry that was anchored`); return null; }
    const digest = anchorDigest({ vaultId: e.vault_id, seq, entryHash: e.entry_hash });
    if (toHex(digest) !== a.digest) { problems.push(`anchor for entry ${seq} was made over a different digest`); return null; }
    return { seq, digest };
  };
  const read = (start: Uint8Array, a: LedgerAnchor, seq: number): OtsAttestation[] | null => {
    try { return readAttestations(start, fromBase64(a.proof_b64)); }
    catch (err) {
      problems.push(`anchor proof for entry ${seq} is unreadable: ${err instanceof Error ? err.message : 'bad proof'}`);
      return null;
    }
  };
  for (const a of anchors.filter(x => x.kind === 'pending')) {
    const b = base(a); if (!b) continue;
    const atts = read(b.digest, a, b.seq); if (!atts) continue;
    if (!atts.some(t => t.kind === 'pending' && t.commitment === a.commitment)) {
      problems.push(`anchor receipt for entry ${b.seq} does not lead to its recorded commitment`);
      continue;
    }
    receipts.add(`${b.seq}:${a.commitment}`);
    anchoredThrough = Math.max(anchoredThrough, b.seq);
  }
  for (const a of anchors.filter(x => x.kind === 'bitcoin')) {
    const b = base(a); if (!b) continue;
    if (!receipts.has(`${b.seq}:${a.commitment}`)) {
      problems.push(`Bitcoin proof for entry ${b.seq} does not connect to a receipt for this ledger`);
      continue;
    }
    let start: Uint8Array;
    try { start = fromHex(a.commitment); }
    catch { problems.push(`anchor proof for entry ${b.seq} is unreadable: bad commitment`); continue; }
    const atts = read(start, a, b.seq); if (!atts) continue;
    const att = atts.find(t => t.kind === 'bitcoin' && t.height === a.bitcoin_height);
    if (!att) { problems.push(`Bitcoin proof for entry ${b.seq} does not reach block ${a.bitcoin_height}`); continue; }
    if (merkleRoots) {
      const h = a.bitcoin_height as number;
      if (!Object.hasOwn(merkleRoots, h)) {
        blocksUnchecked++;
      } else {
        const root = merkleRoots[h];
        if (!root) { problems.push(`Bitcoin block ${h} could not be looked up to check entry ${b.seq}`); continue; }
        if (!matchesBlock(att, root)) { problems.push(`Bitcoin proof for entry ${b.seq} is not in block ${h}`); continue; }
      }
    }
    if (b.seq > confirmedThrough) { confirmedThrough = b.seq; bitcoinHeight = a.bitcoin_height; }
  }
  return { ok: problems.length === 0, anchoredThrough, confirmedThrough, bitcoinHeight, blocksChecked: !!merkleRoots, blocksUnchecked, problems };
}

// ---- Looking the real blocks up ---------------------------------------

/** How many of the newest stamped blocks a check looks up. The newest
 *  proof covers everything before it through the hash chain, so older
 *  blocks add dating detail, not safety. */
export const MAX_BLOCK_LOOKUPS = 12;

/** The newest distinct Bitcoin heights among a vault's stamps. */
export function heightsToCheck(anchors: readonly LedgerAnchor[], max = MAX_BLOCK_LOOKUPS): number[] {
  const hs = anchors
    .filter(a => a.kind === 'bitcoin' && Number.isInteger(a.bitcoin_height))
    .map(a => a.bitcoin_height as number);
  return [...new Set(hs)].sort((a, b) => b - a).slice(0, max);
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/**
 * Merkle root of each block, from mempool.space AND blockstream.info,
 * which must agree. OpenTimestamps stamps into Bitcoin MAINNET whatever
 * network the vault itself lives on. Throws if either source is
 * unreachable or they disagree -- the caller then reports that the
 * blocks were not checked instead of showing a green tick.
 */
export async function fetchMerkleRoots(heights: readonly number[], fetchImpl: FetchLike = fetch): Promise<Record<number, string>> {
  const one = async (base: string, height: number): Promise<string> => {
    const h = await fetchImpl(`${base}/block-height/${height}`);
    if (!h.ok) throw new Error(`block ${height} lookup ${h.status}`);
    const hash = (await h.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`block ${height} lookup returned no block hash`);
    const b = await fetchImpl(`${base}/block/${hash}`);
    if (!b.ok) throw new Error(`block ${hash} lookup ${b.status}`);
    const body = (await b.json()) as { merkle_root?: unknown };
    if (typeof body.merkle_root !== 'string' || !/^[0-9a-f]{64}$/.test(body.merkle_root)) {
      throw new Error(`block ${height} lookup returned no merkle root`);
    }
    return body.merkle_root;
  };
  const out: Record<number, string> = {};
  for (const height of heights) {
    const [a, b] = await Promise.all([one(EXPLORER.bitcoin.api, height), one(SECOND_TIP_SOURCE.bitcoin, height)]);
    if (a !== b) throw new Error(`chain sources disagree on block ${height}`);
    out[height] = a;
  }
  return out;
}

// ---- Plain words -------------------------------------------------------

const EVENT_WORDS: Record<string, string> = {
  created: 'Vault created',
  draft_compiled: 'Vault finalized -- its Bitcoin address was fixed',
  terms_accepted: 'Terms accepted',
  invite_created: 'Invite sent',
  member_joined: 'Member joined',
  member_removed: 'Member removed',
  key_confirmed: "A member's key confirmed by the owner",
  psbt_generated: 'Spend proposed',
  psbt_merged: 'Signatures combined',
  signed: 'Spend signed',
  broadcast: 'Spend sent to the Bitcoin network',
  cancelled: 'Spend cancelled',
  voted_approve: 'Voted to approve',
  voted_abstain: 'Abstained',
  voted_decline: 'Voted to decline',
  request_created: 'Distribution requested',
  request_approved: 'Request approved',
  request_declined: 'Request declined',
  request_fulfilled: 'Request fulfilled',
  request_cancelled: 'Request cancelled',
  stipend_created: 'Scheduled payment set up',
  distribution_wallet_created: 'Distribution wallet created',
  message_sent: 'Message sent',
  attestation_trust_doc: 'Trust document signed',
  attestation_proof_of_life: 'Checked in (proof of life)',
  attestation_death_declaration: 'Death declaration signed',
  attestation_descriptor: 'Vault descriptor attested',
  attestation_revoked: 'Attestation revoked',
  rotated_to_successor: 'Vault rotated to a successor vault',
  rotated_from_predecessor: 'Vault rotated from an earlier vault',
  deleted: 'Vault deleted',
  invite_revoked: 'Invite withdrawn',
  grant_sent: 'Membership offered',
  grant_accepted: 'Membership accepted',
  grant_declined: 'Membership declined',
  grant_left: 'Member stepped away',
  duress_raised: 'Duress alarm raised',
  duress_cleared: 'Duress alarm cleared by the owner',
  vault_renamed: 'Vault renamed',
  vault_archived: 'Vault archived',
  vault_unarchived: 'Vault brought back from the archive',
  trust_doc_updated: 'Trust document changed',
  halt_on: 'Vault halted -- signing paused',
  halt_off: 'Halt lifted -- signing allowed again',
  key_label_changed: 'A key was renamed',
  key_origins_repaired: "A key's hardware wallet details were changed",
};

/** What an entry says, in the member's words; unknown kinds are shown
 *  as recorded rather than guessed at. */
export function ledgerEventWords(eventType: string): string {
  return EVENT_WORDS[eventType] ?? eventType.replace(/_/g, ' ');
}

/** Where one entry stands: proven in Bitcoin, receipt held, or waiting. */
export function entryStanding(seq: number, check: Pick<AnchorCheck, 'anchoredThrough' | 'confirmedThrough'>): 'bitcoin' | 'receipt' | 'waiting' {
  if (seq <= check.confirmedThrough) return 'bitcoin';
  if (seq <= check.anchoredThrough) return 'receipt';
  return 'waiting';
}

/** The file a member can keep: every row needed to repeat this check
 *  with nothing from DynastyTrust but this description. */
export function ledgerExportFile(vaultId: string, entries: readonly LedgerEntry[], anchors: readonly LedgerAnchor[], exportedAt: string): string {
  return JSON.stringify({
    format: 'dynastytrust-sealed-record-v1',
    vault_id: vaultId,
    exported_at: exportedAt,
    how_to_check: [
      'Each entry_hash is SHA-256 of these fields joined by newlines: prev_hash, vault_id, seq, recorded_at, actor_user_id (empty if none), event_type, payload_canon.',
      'The first entry has a prev_hash of 64 zeros; every later prev_hash is the entry_hash before it.',
      'Each anchor digest is SHA-256 of the text: DT-LEDGER-ANCHOR-v1, vault_id, seq, entry_hash, joined by newlines.',
      'A pending anchor proof_b64 is an OpenTimestamps proof from that digest to commitment; a bitcoin anchor proof_b64 continues from commitment to the merkle root of Bitcoin mainnet block bitcoin_height.',
    ],
    entries,
    anchors,
  }, null, 2);
}
