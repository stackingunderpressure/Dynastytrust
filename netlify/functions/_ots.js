/**
 * _ots.js -- OpenTimestamps, the small part we need, with no dependency.
 *
 * An OpenTimestamps proof is a short list of operations (append these
 * bytes, prepend those, SHA-256 the result ...) that leads from OUR
 * 32-byte digest to a value committed in a Bitcoin block's merkle root.
 * Anyone can replay the operations and compare the result with the
 * block header: if they match, our digest existed before that block was
 * mined, and nobody -- not this server, not the calendar -- can make a
 * different digest fit afterwards.
 *
 * We deliberately do not use the `opentimestamps` npm package: it drags
 * in the deprecated `request` library (two critical advisories, removed
 * 2026-11-10). The wire format is small and stable; this file parses it,
 * and scripts/test-ots.mjs proves the parser against the reference
 * client's own published proof and its real Bitcoin block.
 *
 * Privacy: a calendar only ever receives a 32-byte hash. No vault name,
 * member, amount or address leaves this server.
 */
import { createHash } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");

export const OTS_FILE_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const TAG_PENDING = "83dfe30d2ef90c8e";
const TAG_BITCOIN = "0588960d73d71901";
const MAX_MSG = 4096;      // the format's own limit on an intermediate value
const MAX_OPS = 2000;      // far beyond any real proof (a few dozen)

/** Domain-separated digest that is submitted for one ledger position. */
export function anchorDigest({ vaultId, seq, entryHash }) {
  return sha256(Buffer.from(`DT-LEDGER-ANCHOR-v1\n${vaultId}\n${seq}\n${entryHash}`, "utf8"));
}

function reader(buf) {
  let p = 0;
  const need = (n) => { if (p + n > buf.length) throw new Error("OTS proof is truncated"); };
  return {
    done: () => p >= buf.length,
    byte() { need(1); return buf[p++]; },
    bytes(n) { need(n); const out = buf.subarray(p, p + n); p += n; return out; },
    varuint() {
      let v = 0, shift = 0;
      for (;;) {
        const b = this.byte();
        v += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 49) throw new Error("OTS varuint too large");
      }
      return v;
    },
    varbytes(max = MAX_MSG) { const n = this.varuint(); if (n > max) throw new Error("OTS field too long"); return this.bytes(n); },
  };
}

function applyOp(tag, msg, r) {
  let out;
  switch (tag) {
    case 0x08: out = sha256(msg); break;
    case 0x02: out = createHash("sha1").update(msg).digest(); break;
    case 0x03: out = createHash("ripemd160").update(msg).digest(); break;
    case 0xf0: out = Buffer.concat([msg, r.varbytes()]); break;          // append
    case 0xf1: out = Buffer.concat([r.varbytes(), msg]); break;          // prepend
    default: throw new Error(`OTS proof uses an unsupported operation 0x${tag.toString(16)}`);
  }
  if (out.length > MAX_MSG) throw new Error("OTS intermediate value too long");
  return out;
}

/**
 * Replay a timestamp fragment starting from `startMsg`. Returns every
 * attestation it reaches: { kind: 'bitcoin', height, commitment } or
 * { kind: 'pending', uri, commitment } or { kind: 'unknown', commitment },
 * where `commitment` is the value the operations produced at that point.
 */
export function readAttestations(startMsg, proofBytes) {
  const r = reader(Buffer.from(proofBytes));
  const found = [];
  let ops = 0;
  const walk = (msg, depth) => {
    if (depth > 256) throw new Error("OTS proof nests too deeply");
    let tag = r.byte();
    while (tag === 0xff) {           // a fork: one branch here, more to follow
      step(r.byte(), msg, depth);
      tag = r.byte();
    }
    step(tag, msg, depth);
  };
  const step = (tag, msg, depth) => {
    if (++ops > MAX_OPS) throw new Error("OTS proof has too many operations");
    if (tag === 0x00) {
      const kindTag = hex(r.bytes(8));
      const payload = reader(r.varbytes(8192));
      if (kindTag === TAG_BITCOIN) found.push({ kind: "bitcoin", height: payload.varuint(), commitment: hex(msg) });
      else if (kindTag === TAG_PENDING) found.push({ kind: "pending", uri: payload.varbytes(1000).toString("utf8"), commitment: hex(msg) });
      else found.push({ kind: "unknown", commitment: hex(msg) });
      return;
    }
    walk(applyOp(tag, msg, r), depth + 1);
  };
  walk(Buffer.from(startMsg), 0);
  if (!r.done()) throw new Error("OTS proof has trailing bytes");
  return found;
}

/** Split a detached .ots FILE into its digest and timestamp fragment. */
export function readOtsFile(fileBytes) {
  const buf = Buffer.from(fileBytes);
  if (buf.length < OTS_FILE_MAGIC.length + 2 || !buf.subarray(0, OTS_FILE_MAGIC.length).equals(OTS_FILE_MAGIC)) {
    throw new Error("not an OpenTimestamps proof file");
  }
  const r = reader(buf.subarray(OTS_FILE_MAGIC.length));
  if (r.varuint() !== 1) throw new Error("unsupported OpenTimestamps file version");
  if (r.byte() !== 0x08) throw new Error("only SHA-256 file digests are supported");
  const digest = Buffer.from(r.bytes(32));
  const rest = buf.subarray(buf.length - (buf.length - OTS_FILE_MAGIC.length - 2 - 32));
  return { digest, proof: rest };
}

/** Wrap a digest + fragment as a standard detached .ots file, so any
 *  OpenTimestamps tool (`ots verify`) can check it without us. */
export function toOtsFile(digest, proofBytes) {
  return Buffer.concat([OTS_FILE_MAGIC, Buffer.from([0x01, 0x08]), Buffer.from(digest), Buffer.from(proofBytes)]);
}

/**
 * Does a Bitcoin attestation really sit in that block? `merkleRootHex`
 * is the block's merkle root as explorers print it (byte-reversed from
 * the header's internal order, which is what the proof commits to).
 */
export function matchesBlock(attestation, merkleRootHex) {
  if (attestation?.kind !== "bitcoin" || !/^[0-9a-f]{64}$/i.test(merkleRootHex || "")) return false;
  const internal = Buffer.from(merkleRootHex, "hex").reverse().toString("hex");
  return attestation.commitment === internal;
}

export const CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
];

async function fetchBytes(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: "application/vnd.opentimestamps.v1", "user-agent": "dynastytrust-ledger", ...(init?.headers ?? {}) } });
    if (!res.ok) return { status: res.status, bytes: null };
    return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
  } finally {
    clearTimeout(t);
  }
}

/** Submit a digest to one calendar. Returns the pending fragment, having
 *  checked it parses and really commits to OUR digest's path. */
export async function submitToCalendar(digest, calendarUrl, timeoutMs = 6000) {
  const { status, bytes } = await fetchBytes(`${calendarUrl}/digest`, { method: "POST", body: Buffer.from(digest), headers: { "content-type": "application/x-www-form-urlencoded" } }, timeoutMs);
  if (!bytes) throw new Error(`calendar ${calendarUrl} answered ${status}`);
  if (bytes.length > 10_000) throw new Error("calendar response too large");
  const atts = readAttestations(digest, bytes);
  const pending = atts.find((a) => a.kind === "pending");
  if (!pending) throw new Error("calendar response carries no pending attestation");
  return { proof: bytes, commitment: pending.commitment };
}

/** Ask a calendar whether a pending commitment has reached Bitcoin yet.
 *  Returns null while it has not, else the upgrade fragment (which
 *  starts from the COMMITMENT, not from our digest). */
export async function fetchUpgrade(commitmentHex, calendarUrl, timeoutMs = 8000) {
  const { status, bytes } = await fetchBytes(`${calendarUrl}/timestamp/${commitmentHex}`, { method: "GET" }, timeoutMs);
  if (status === 404 || !bytes) return null;
  if (bytes.length > 20_000) throw new Error("calendar upgrade too large");
  const atts = readAttestations(Buffer.from(commitmentHex, "hex"), bytes);
  const btc = atts.filter((a) => a.kind === "bitcoin");
  if (btc.length === 0) return null;
  return { proof: bytes, attestations: btc };
}
