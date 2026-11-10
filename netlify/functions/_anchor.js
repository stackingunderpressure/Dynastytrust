/**
 * _anchor.js -- anchoring a vault's ledger to Bitcoin via OpenTimestamps.
 *
 * WHEN (operator's choice, 2026-11-10): immediately at the moments that
 * matter -- a vault is finalized, a spend is broadcast, a member joins
 * or leaves -- and once a day for everything else.
 *
 * `verifyAnchors` is pure and is what a member's own check runs: every
 * anchor must point at an entry that is STILL in the ledger, at that
 * position, with that hash. A ledger whose tail was cut off, or that
 * was swapped for another consistent chain, fails here.
 */
import { anchorDigest, submitToCalendar, fetchUpgrade, readAttestations, matchesBlock, CALENDARS } from "./_ots.js";
import { MEMPOOL, SECOND_SOURCE } from "./_chain.js";

/** Ledger events that are anchored the moment they are sealed: the
 *  vault coming into being, its script being finalized, a spend going
 *  out, and the membership changing. (proposals.js records a status
 *  change under the status's own name, hence "broadcast".) */
export const MILESTONE_EVENTS = new Set([
  "created", "draft_compiled", "broadcast", "member_joined", "member_removed",
  "rotated_to_successor", "rotated_from_predecessor", "deleted",
]);
export function isMilestone(eventType) {
  return MILESTONE_EVENTS.has(eventType);
}

/**
 * Pure. Check a vault's anchors against its ledger entries.
 * Returns { ok, anchoredThrough, confirmedThrough, bitcoinHeight, problems }.
 *  - anchoredThrough: highest position with a valid calendar receipt
 *  - confirmedThrough: highest position proven in a Bitcoin block
 * A problem means the ledger no longer contains what was anchored, or
 * an anchor row is not what it claims.
 *
 * A Bitcoin proof only counts when the whole path holds:
 *   our digest --(receipt)--> the calendar's commitment
 *              --(upgrade)--> a value at the claimed block height
 * and, when `merkleRoots` ({ [height]: merkle root as explorers print
 * it }) is supplied, that value IS that block's merkle root. Without
 * `merkleRoots` the block itself is not checked and `blocksChecked` is
 * false -- the caller must say so rather than show a green tick.
 */
export function verifyAnchors(entries, anchors, merkleRoots = null) {
  const bySeq = new Map((entries ?? []).map((e) => [Number(e.seq), e]));
  const problems = [];
  let anchoredThrough = 0, confirmedThrough = 0, bitcoinHeight = null;
  const receipts = new Set(); // `${seq}:${commitment}` proven to follow from our digest
  const base = (a) => {
    const seq = Number(a.seq);
    const e = bySeq.get(seq);
    if (!e) { problems.push(`entry ${seq} was anchored to Bitcoin but is no longer in the ledger`); return null; }
    if (e.entry_hash !== a.entry_hash) { problems.push(`entry ${seq} is not the entry that was anchored`); return null; }
    const digest = anchorDigest({ vaultId: e.vault_id, seq, entryHash: e.entry_hash });
    if (digest.toString("hex") !== a.digest) { problems.push(`anchor for entry ${seq} was made over a different digest`); return null; }
    return { seq, digest };
  };
  const read = (start, a, seq) => {
    try { return readAttestations(start, Buffer.from(a.proof_b64, "base64")); }
    catch (err) { problems.push(`anchor proof for entry ${seq} is unreadable: ${err.message}`); return null; }
  };
  for (const a of (anchors ?? []).filter((x) => x.kind === "pending")) {
    const b = base(a); if (!b) continue;
    const atts = read(b.digest, a, b.seq); if (!atts) continue;
    if (!atts.some((t) => t.kind === "pending" && t.commitment === a.commitment)) {
      problems.push(`anchor receipt for entry ${b.seq} does not lead to its recorded commitment`);
      continue;
    }
    receipts.add(`${b.seq}:${a.commitment}`);
    anchoredThrough = Math.max(anchoredThrough, b.seq);
  }
  for (const a of (anchors ?? []).filter((x) => x.kind === "bitcoin")) {
    const b = base(a); if (!b) continue;
    if (!receipts.has(`${b.seq}:${a.commitment}`)) {
      problems.push(`Bitcoin proof for entry ${b.seq} does not connect to a receipt for this ledger`);
      continue;
    }
    const atts = read(Buffer.from(a.commitment, "hex"), a, b.seq); if (!atts) continue;
    const att = atts.find((t) => t.kind === "bitcoin" && t.height === a.bitcoin_height);
    if (!att) { problems.push(`Bitcoin proof for entry ${b.seq} does not reach block ${a.bitcoin_height}`); continue; }
    if (merkleRoots) {
      const root = merkleRoots[a.bitcoin_height];
      if (!root) { problems.push(`Bitcoin block ${a.bitcoin_height} could not be looked up to check entry ${b.seq}`); continue; }
      if (!matchesBlock(att, root)) { problems.push(`Bitcoin proof for entry ${b.seq} is not in block ${a.bitcoin_height}`); continue; }
    }
    if (b.seq > confirmedThrough) { confirmedThrough = b.seq; bitcoinHeight = a.bitcoin_height; }
  }
  return { ok: problems.length === 0, anchoredThrough, confirmedThrough, bitcoinHeight, blocksChecked: !!merkleRoots, problems };
}

/**
 * Submit a vault's current ledger tip to the calendars (if that
 * position is not already anchored) and store each receipt.
 * Returns { seq, submitted } or null when the ledger is empty.
 */
export async function anchorTip(supabase, vaultId, reason, { calendars = CALENDARS, submit = submitToCalendar } = {}) {
  const { data: tip, error } = await supabase
    .from("vault_ledger").select("seq, entry_hash").eq("vault_id", vaultId)
    .order("seq", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`anchor: ledger tip read failed: ${error.message}`);
  if (!tip) return null;
  const { data: have } = await supabase
    .from("vault_ledger_anchors").select("calendar").eq("vault_id", vaultId).eq("seq", tip.seq).eq("kind", "pending");
  const done = new Set((have ?? []).map((r) => r.calendar));
  const digest = anchorDigest({ vaultId, seq: Number(tip.seq), entryHash: tip.entry_hash });
  let submitted = 0;
  await Promise.all(calendars.filter((c) => !done.has(c)).map(async (calendar) => {
    try {
      const { proof, commitment } = await submit(digest, calendar);
      const { error: insErr } = await supabase.from("vault_ledger_anchors").insert({
        vault_id: vaultId, seq: tip.seq, entry_hash: tip.entry_hash, digest: digest.toString("hex"),
        calendar, kind: "pending", commitment, proof_b64: Buffer.from(proof).toString("base64"), reason,
      });
      if (insErr) throw new Error(insErr.message);
      submitted++;
    } catch (e) {
      console.error(`[anchor] ${calendar} failed for vault ${vaultId} seq ${tip.seq}: ${e?.message || e}`);
    }
  }));
  return { seq: Number(tip.seq), submitted };
}

export async function merkleRootAt(network, height) {
  // Two independent sources must agree on the block before a proof is
  // recorded as confirmed (same rule as the chain tip for timelocks).
  const roots = [];
  for (const base of [MEMPOOL[network], SECOND_SOURCE[network]]) {
    const h = await fetch(`${base}/block-height/${height}`);
    if (!h.ok) throw new Error(`block ${height} lookup ${h.status}`);
    const hash = (await h.text()).trim();
    const b = await fetch(`${base}/block/${hash}`);
    if (!b.ok) throw new Error(`block ${hash} lookup ${b.status}`);
    roots.push((await b.json()).merkle_root);
  }
  if (roots[0] !== roots[1]) throw new Error(`chain sources disagree on block ${height}`);
  return roots[0];
}

/**
 * For pending anchors that have no Bitcoin row yet: ask the calendar
 * whether the commitment has been mined, check the proof against the
 * real block (two sources), and store it. OpenTimestamps anchors to
 * Bitcoin MAINNET whatever network the vault itself is on.
 */
export async function upgradePending(supabase, { limit = 50, upgrade = fetchUpgrade, rootAt = merkleRootAt } = {}) {
  const { data: pend, error } = await supabase
    .from("vault_ledger_anchors").select("vault_id, seq, entry_hash, digest, calendar, commitment")
    .eq("kind", "pending").order("created_at", { ascending: true }).limit(500);
  if (error) throw new Error(`anchor: pending read failed: ${error.message}`);
  const { data: confirmed } = await supabase
    .from("vault_ledger_anchors").select("vault_id, seq, calendar").eq("kind", "bitcoin").limit(5000);
  const have = new Set((confirmed ?? []).map((r) => `${r.vault_id}:${r.seq}:${r.calendar}`));
  let upgraded = 0, stillPending = 0;
  for (const p of (pend ?? []).filter((r) => !have.has(`${r.vault_id}:${r.seq}:${r.calendar}`)).slice(0, limit)) {
    try {
      const up = await upgrade(p.commitment, p.calendar);
      if (!up) { stillPending++; continue; }
      const att = up.attestations[0];
      const root = await rootAt("bitcoin", att.height);
      if (!matchesBlock(att, root)) throw new Error(`proof does not match Bitcoin block ${att.height}`);
      const { error: insErr } = await supabase.from("vault_ledger_anchors").insert({
        vault_id: p.vault_id, seq: p.seq, entry_hash: p.entry_hash, digest: p.digest, calendar: p.calendar,
        kind: "bitcoin", commitment: p.commitment, proof_b64: Buffer.from(up.proof).toString("base64"),
        bitcoin_height: att.height, reason: "upgrade",
      });
      if (insErr) throw new Error(insErr.message);
      upgraded++;
    } catch (e) {
      console.error(`[anchor] upgrade failed for vault ${p.vault_id} seq ${p.seq} at ${p.calendar}: ${e?.message || e}`);
    }
  }
  return { upgraded, stillPending };
}

/** Anchor every vault whose latest entry is not yet anchored. */
export async function anchorAllUnanchored(supabase, opts) {
  const { data: tips, error } = await supabase.rpc("vault_ledger_unanchored_tips");
  if (error) throw new Error(`anchor: tips read failed: ${error.message}`);
  let anchored = 0;
  for (const t of tips ?? []) {
    const r = await anchorTip(supabase, t.vault_id, "daily", opts);
    if (r?.submitted) anchored++;
  }
  return { vaults: (tips ?? []).length, anchored };
}
