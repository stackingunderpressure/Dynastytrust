/**
 * _ledger.js -- the vault's tamper-evident record.
 *
 * Every action on a vault is appended to `vault_ledger` as an entry that
 * carries the hash of the entry before it, so altering, removing or
 * reordering any earlier entry breaks every hash after it. The database
 * refuses UPDATE and DELETE on that table for every role and recomputes
 * each hash itself (supabase/migrations/20261110230000_vault_ledger.sql).
 *
 * The pure parts here -- canonical JSON, the entry hash, and
 * verifyLedger -- have no dependencies beyond SHA-256, so the browser,
 * a test, or a stranger with a copy of the rows can re-check the chain
 * without trusting this server. Keep the hash input byte-for-byte in
 * step with the SQL function `append_vault_ledger`.
 */
import { createHash } from "node:crypto";

export const LEDGER_GENESIS = "0".repeat(64);

/** Canonical JSON: object keys sorted, no whitespace, no undefined. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/** sha256 over the exact newline-joined fields the database also hashes. */
export function ledgerEntryHash({ prev_hash, vault_id, seq, recorded_at, actor_user_id, event_type, payload_canon }) {
  const input = [prev_hash, vault_id, String(seq), recorded_at, actor_user_id ?? "", event_type, payload_canon].join("\n");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Re-walk a vault's ledger. `entries` in any order; returns
 * { ok: true, count, tip } or { ok: false, brokenAt, reason }.
 * Checks: seq runs 1..n with no gaps or repeats, each entry chains from
 * the one before (the first from genesis), every stored hash equals the
 * hash of the stored contents, and the stored payload is the canonical
 * text that was hashed.
 */
export function verifyLedger(entries) {
  const rows = [...(entries ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq));
  let prev = LEDGER_GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    const at = Number(e.seq);
    if (at !== i + 1) return { ok: false, brokenAt: i + 1, reason: `entry ${i + 1} is missing or out of order (found ${at})` };
    if (e.prev_hash !== prev) return { ok: false, brokenAt: at, reason: `entry ${at} does not chain from entry ${at - 1}` };
    const expect = ledgerEntryHash(e);
    if (e.entry_hash !== expect) return { ok: false, brokenAt: at, reason: `entry ${at} was altered: its contents no longer match its hash` };
    if (e.payload !== undefined && canonicalJson(e.payload) !== e.payload_canon) {
      return { ok: false, brokenAt: at, reason: `entry ${at}: the displayed details differ from the details that were sealed` };
    }
    prev = e.entry_hash;
  }
  return { ok: true, count: rows.length, tip: prev };
}

/** Build the next entry for a vault given its current tip (pure). */
export function nextLedgerEntry(tip, { vaultId, actorUserId, eventType, payload, recordedAt }) {
  const entry = {
    vault_id: vaultId,
    seq: (tip?.seq ? Number(tip.seq) : 0) + 1,
    prev_hash: tip?.entry_hash ?? LEDGER_GENESIS,
    recorded_at: recordedAt ?? new Date().toISOString(),
    actor_user_id: actorUserId ?? null,
    event_type: eventType,
    payload_canon: canonicalJson(payload ?? {}),
  };
  return { ...entry, entry_hash: ledgerEntryHash(entry) };
}

/**
 * Append one entry to a vault's ledger. Reads the tip, builds the next
 * entry, and asks the database to add it; the database re-checks the
 * link and the hash under a per-vault lock. If another writer got there
 * first it retries from the new tip. Throws if it cannot append.
 */
export async function appendLedger(supabase, { vaultId, actorUserId, eventType, payload }) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: tip, error: tipErr } = await supabase
      .from("vault_ledger")
      .select("seq, entry_hash")
      .eq("vault_id", vaultId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tipErr) throw new Error(`ledger tip read failed: ${tipErr.message}`);
    const e = nextLedgerEntry(tip, { vaultId, actorUserId, eventType, payload });
    const { data, error } = await supabase.rpc("append_vault_ledger", {
      p_vault_id: e.vault_id, p_seq: e.seq, p_prev_hash: e.prev_hash, p_entry_hash: e.entry_hash,
      p_recorded_at: e.recorded_at, p_actor_user_id: e.actor_user_id, p_event_type: e.event_type,
      p_payload_canon: e.payload_canon,
    });
    if (!error) return data;
    lastErr = error;
    if (!/ledger conflict/.test(error.message || "")) break; // only a lost race is worth retrying
  }
  throw new Error(`ledger append failed: ${lastErr?.message || "unknown error"}`);
}

/**
 * Record a vault event: the existing vault_events row (what the app's
 * timeline reads) AND a sealed ledger entry. A ledger failure is logged
 * loudly but does not fail the action it describes -- a spend that
 * already happened must not be reported as failed because bookkeeping
 * hiccuped. The gap is then visible to the operator in the function
 * logs; closing it by failing closed is a decision for a later slice.
 */
export async function recordEvent(supabase, { vault_id, user_id, event_type, metadata }) {
  const res = await supabase.from("vault_events").insert({ vault_id, user_id, event_type, metadata });
  try {
    await appendLedger(supabase, { vaultId: vault_id, actorUserId: user_id, eventType: event_type, payload: metadata ?? {} });
  } catch (e) {
    console.error(`[ledger] NOT SEALED: ${event_type} on vault ${vault_id}: ${e?.message || e}`);
  }
  return res;
}
