// GET  /api/vault-addresses?vault_id=<uuid>  (signed in; owner or member)
//   -> { ok, next: { 0: n, 1: m } } -- the next index each branch will hand
//   out, so a Tapit membership request can list the vault's NEXT change
//   addresses (docs/tapit-review-modes-build-note.md). Reads only.
// GET  /api/vault-addresses?vault_id=<uuid>&list=1 -> { ok, addresses: [{
//   index, address, label, paid }] } newest first (receive addresses issued).
// POST /api/vault-addresses  { vault_id, label?, mode? }
//   mode "current" (default, 2026-11-24): the newest issued receive address
//   never paid, shown again, until it is paid -- only then a new one. mode
//   "new": a new one even so ("I need a different one"), refused once
//   GAP_LIMIT addresses in a row are unpaid. Paid = any history on chain.
//   docs/receive-address-reuse-until-paid-build-note.md.
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
import { canSeeVault, nextIndexes, vaultUsed } from "./_vault-coins.js";
import { userServersFrom } from "./_electrum.js";
import { GAP_LIMIT, currentUnpaid, reusableChange, unpaidRun } from "./_receive-choice.js";

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

  // The addresses already issued, and which have ever been paid (the
  // person's own Electrum server if their device sent one).
  const mode = body.mode === "new" ? "new" : "current";
  let issued, used, next;
  try {
    ({ issued, next } = await issuedReceive(supabase, vaultId));
    // Address 0 (the vault's own) is looked up too, even before it is
    // recorded: until it is paid, it is the one to give out.
    const watch = issued.some((a) => a.idx === 0) ? issued : [{ idx: 0, address: vault.address, label: null }, ...issued];
    used = await vaultUsed(vault.network, watch.map((a) => ({ branch: RECEIVE, index: a.idx, address: a.address })), userServersFrom(event));
  } catch (e) {
    return json(502, { error: `Could not check which addresses have been paid: ${e.message}` });
  }
  if (mode === "current") {
    // Operator, 2026-11-25: "Copy address should pick the correct one and
    // make it known each un used it's copying." The vault's own address
    // while it has never been paid; then the newest one given out and not
    // paid; only then a new one.
    if (!used.has(vault.address) && !issued.some((a) => a.idx > 0)) {
      return json(200, { ok: true, index: 0, address: vault.address, label: null, reused: false, first: true, unpaid_run: unpaidRun(next, issued, used) });
    }
    const cur = currentUnpaid(issued, used);
    if (cur) {
      // Same address again; a label typed now is kept if it had none.
      if (label && !cur.label) await supabase.from("vault_addresses").update({ label }).eq("vault_id", vaultId).eq("branch", RECEIVE).eq("idx", cur.idx);
      return json(200, { ok: true, index: cur.idx, address: cur.address, label: cur.label || label, reused: true, unpaid_run: unpaidRun(next, issued, used) });
    }
  } else if (unpaidRun(next, issued, used) >= GAP_LIMIT) {
    return json(409, {
      error: `There are already ${GAP_LIMIT} unpaid addresses in a row. Another one could be missed by a wallet restoring this vault, which stops looking after ${GAP_LIMIT} empty addresses. Use one from the list, or wait until one is paid.`,
    });
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

  const after = [...issued, { idx: index, address: derived.address, label }];
  return json(200, { ok: true, index, address: derived.address, label, reused: false, unpaid_run: unpaidRun(index + 1, after, used) });
}

/** A v2 vault's issued receive addresses and its next receive number. */
async function issuedReceive(supabase, vaultId) {
  const { data, error } = await supabase
    .from("vault_addresses")
    .select("idx, address, label")
    .eq("vault_id", vaultId)
    .eq("branch", RECEIVE)
    .order("idx", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);
  const next = (await nextIndexes(supabase, vaultId))[RECEIVE];
  return { issued: data ?? [], next };
}

async function nextIndexesFor(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  const vaultId = event.queryStringParameters?.vault_id;
  if (typeof vaultId !== "string" || !/^[0-9a-f-]{36}$/i.test(vaultId)) return json(400, { error: "vault_id is required" });
  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase.from("vaults").select("id, user_id, network, descriptor_version").eq("id", vaultId).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!vault || !(await canSeeVault(supabase, vault, u.userId))) return json(404, { error: "Vault not found" });
  if (vault.descriptor_version !== 2) return json(400, { error: "This vault has one fixed address." });
  if (event.queryStringParameters?.list === "1") {
    let issued, used, next;
    try {
      ({ issued, next } = await issuedReceive(supabase, vaultId));
      used = await vaultUsed(vault.network, issued.map((a) => ({ branch: RECEIVE, index: a.idx, address: a.address })), userServersFrom(event));
    } catch (e) {
      return json(502, { error: `Could not check which addresses have been paid: ${e.message}` });
    }
    return json(200, {
      ok: true,
      unpaid_run: unpaidRun(next, issued, used),
      gap_limit: GAP_LIMIT,
      addresses: issued.filter((a) => a.idx > 0).reverse().map((a) => ({ index: a.idx, address: a.address, label: a.label, paid: used.has(a.address) })),
    });
  }
  // Where a Tapit member's change list must start: the lowest change
  // address a spend may still use -- one issued but never paid (a spend
  // never sent; _ranged-spend.js reuses it) -- else the next new one.
  const next = await nextIndexes(supabase, vaultId);
  let change_from = next[1];
  const { data: issuedChange, error: cErr } = await supabase
    .from("vault_addresses").select("idx, address").eq("vault_id", vaultId).eq("branch", 1).order("idx", { ascending: true }).limit(5000);
  if (cErr) return json(500, { error: cErr.message });
  if (issuedChange?.length) {
    try {
      const used = await vaultUsed(vault.network, issuedChange.map((a) => ({ branch: 1, index: a.idx, address: a.address })), userServersFrom(event));
      const reuse = reusableChange(issuedChange, used);
      if (reuse) change_from = reuse.idx;
    } catch (e) {
      return json(502, { error: `Could not check the change addresses: ${e.message}` });
    }
  }
  return json(200, { ok: true, next, change_from });
}
