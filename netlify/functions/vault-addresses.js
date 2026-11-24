// GET  /api/vault-addresses?vault_id=<uuid>  (signed in; owner or member)
//   -> { ok, next: { 0: n, 1: m } } -- the next index each branch will hand
//   out, so a Tapit membership request can list the vault's NEXT change
//   addresses (docs/tapit-review-modes-build-note.md). Reads only.
// POST /api/vault-addresses  { vault_id, label? }
// Hands out the next receive address of a v2 (ranged) vault.
// Plan: docs/ranged-addresses-slice2-build-note.md (operator's OK 2026-11-19).
//
// Order, each step refusing before the next:
//   1. signed in; the caller owns the vault or is an active member;
//   2. the vault is compiled and is v2 (a v1 vault has one fixed address);
//   3. its STORED descriptors rebuild a vault whose receive/0 is the vault's
//      own address -- so every address handed out comes from the compiled
//      vault, never from anything else;
//   4. reserve the next receive index (one row-locked statement in the
//      database; concurrent callers each get a different number) -- index 0
//      is the vault's own address, recorded and skipped, never handed out;
//   5. derive that index with the Rust (compiler wasm) and record it. The
//      database refuses a row whose descriptor checksum is not the vault's,
//      an index never reserved, or a repeat of an index or address.
// An index reserved but not recorded (a failure after step 4) is burned,
// never handed out again.

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { overLimit, TOO_MANY } from "./_rate-limit.js";
import { rangedAddress } from "./_ranged-wasm.js";
import { canSeeVault, nextIndexes } from "./_vault-coins.js";

const RECEIVE = 0;

export async function handler(event) {
  if (event.httpMethod === "GET") return nextIndexesFor(event);
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const vaultId = body.vault_id;
  if (typeof vaultId !== "string" || !/^[0-9a-f-]{36}$/i.test(vaultId)) return json(400, { error: "vault_id is required" });
  // A label sealed with the vault key (zk1:, lib/vault-keyring.ts) is kept
  // whole -- the server never reads it; a plain one is cut to 80 characters.
  const rawLabel = typeof body.label === "string" ? body.label.trim() : "";
  const label = rawLabel.startsWith("zk1:")
    ? (rawLabel.length <= 400 ? rawLabel : null)
    : rawLabel.slice(0, 80) || null;
  if (rawLabel.startsWith("zk1:") && !label) return json(400, { error: "That label is too long." });

  const supabase = getSupabaseAdmin();
  if (await overLimit(supabase, { name: "vault-address", event, max: 60, windowSeconds: 3600 })) return json(429, { error: TOO_MANY });

  // 1-2. The vault, and who may ask.
  const { data: vault, error: vErr } = await supabase
    .from("vaults")
    .select("id, user_id, status, network, address, descriptor_version, descriptor_multipath, descriptor_receive, descriptor_change")
    .eq("id", vaultId)
    .maybeSingle();
  if (vErr) {
    // The columns arrive with 20261119000000_ranged_addresses.sql; until it
    // has run, say so instead of a database message.
    if (/descriptor_version|does not exist/i.test(vErr.message)) return json(503, { error: "New addresses are not available yet." });
    return json(500, { error: vErr.message });
  }
  if (!vault) return json(404, { error: "Vault not found" });
  if (vault.user_id !== u.userId) {
    const { data: member, error: mErr } = await supabase
      .from("vault_members")
      .select("id")
      .eq("vault_id", vaultId)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (mErr) return json(500, { error: mErr.message });
    if (!member) return json(403, { error: "Only this vault's owner and members can get its addresses" });
  }
  if (vault.status === "draft") return json(400, { error: "This vault is not finished yet, so it has no addresses." });
  if (vault.descriptor_version !== 2) {
    return json(400, { error: "This vault has one fixed address, which it always uses.", address: vault.address });
  }

  // 3. The stored descriptors must rebuild THIS vault.
  let zero;
  try {
    zero = rangedAddress(vault, RECEIVE, 0);
  } catch (e) {
    return json(500, { error: `This vault's stored descriptor could not be read, so no address was issued: ${e.message}` });
  }
  if (zero.address !== vault.address) {
    return json(500, { error: "This vault's stored descriptor does not match its address. No address was issued -- please contact support." });
  }

  // 4-5. Reserve, derive, record. Receive address 0 IS the vault's own
  // address (shown when it was made, and for its first deposit), so it is
  // never handed out as new: when the reservation lands on 0, that address
  // is recorded as issued (no label) and the next one is reserved.
  const reserveAndRecord = async (rowLabel) => {
    const { data: index, error: rErr } = await supabase.rpc("reserve_vault_address_index", { p_vault_id: vaultId, p_branch: RECEIVE });
    if (rErr || !Number.isInteger(index)) return { status: 500, error: `Could not reserve an address: ${rErr?.message || "no index"}` };
    let derived;
    try {
      derived = rangedAddress(vault, RECEIVE, index);
    } catch (e) {
      return { status: 500, error: `Address ${index} could not be derived; nothing was recorded: ${e.message}` };
    }
    const { error: iErr } = await supabase.from("vault_addresses").insert({
      vault_id: vaultId,
      branch: RECEIVE,
      idx: index,
      address: derived.address,
      script_pubkey: derived.script_pubkey,
      descriptor_checksum: derived.descriptor_checksum,
      issued_by: u.userId,
      label: index === 0 ? null : rowLabel,
    });
    if (iErr) return { status: 500, error: `The address could not be recorded, so it was not issued: ${iErr.message}` };
    return { index, derived };
  };
  let got = await reserveAndRecord(label);
  if (!got.error && got.index === 0) got = await reserveAndRecord(label);
  if (got.error) return json(got.status, { error: got.error });
  const { index, derived } = got;

  return json(200, { ok: true, index, address: derived.address, label });
}

async function nextIndexesFor(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const vaultId = event.queryStringParameters?.vault_id;
  if (typeof vaultId !== "string" || !/^[0-9a-f-]{36}$/i.test(vaultId)) return json(400, { error: "vault_id is required" });
  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase.from("vaults").select("id, user_id, descriptor_version").eq("id", vaultId).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!vault || !(await canSeeVault(supabase, vault, u.userId))) return json(404, { error: "Vault not found" });
  if (vault.descriptor_version !== 2) return json(400, { error: "This vault has one fixed address." });
  return json(200, { ok: true, next: await nextIndexes(supabase, vaultId) });
}
