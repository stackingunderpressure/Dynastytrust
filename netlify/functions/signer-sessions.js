/**
 * signer-sessions.js -- per-member partial signatures on a proposal
 *
 * GET  /api/signer-sessions?proposal_id=<uuid>
 *        List existing partial signatures (visible to any vault
 *        member).
 *
 * POST /api/signer-sessions
 *        Body: { proposal_id, psbt_partial_hex, fingerprint, label? }
 *        Record the caller's partial signature. Uses the member
 *        row implied by (vault_id, user_id). Idempotent: if the
 *        caller already has a session for this proposal, the new
 *        PSBT replaces the old one.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { recordEvent } from "./_ledger.js";
import { canMutate } from "./_authz.js";
import { verifySignedPsbt, signersOnEveryInput } from "./_psbt-verify.js";
import { findSpendingPath, signerCapacity } from "./_vault-shape.js";

// The vault fields getSpendingPaths reads (same list as psbt-merge.js).
const VAULT_SHAPE_FIELDS =
  "id, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, backup_quorum, backup_keys, second_heir_quorum, second_heir_keys, second_inheritance_after, leaves, founder_keys, heir_keys, consent_keys, consent_quorum";

// Roles signer_sessions.signer_role accepted before
// 20261112230000_signer_role_real.sql. Used only if the database still
// holds the old constraint (the code reaching production before the
// migration), so a signature is never lost over its label.
const legacySignerRole = (role) => (role === "heir" ? "heir" : "founder");

const FIELDS =
  "id, created_at, proposal_id, signer_index, signer_role, label, signed, signed_at, fingerprint, member_id, psbt_partial_hex";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const proposalId = event.queryStringParameters?.proposal_id;
    if (!proposalId) return json(400, { error: "Missing: proposal_id" });

    const { data: proposal, error: pErr } = await supabase
      .from("proposals")
      .select("vault_id")
      .eq("id", proposalId)
      .maybeSingle();
    if (pErr) return json(500, { error: pErr.message });
    if (!proposal) return json(404, { error: "Proposal not found" });

    const { data: membership } = await supabase
      .from("vault_members")
      .select("id")
      .eq("vault_id", proposal.vault_id)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) return json(403, { error: "Not a member of this vault" });

    const { data, error } = await supabase
      .from("signer_sessions")
      .select(FIELDS)
      .eq("proposal_id", proposalId)
      .order("created_at", { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, sessions: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { proposal_id, psbt_partial_hex, label } = body;
    if (!proposal_id) return json(400, { error: "Missing: proposal_id" });
    if (!psbt_partial_hex) return json(400, { error: "Missing: psbt_partial_hex" });

    const { data: proposal, error: pErr } = await supabase
      .from("proposals")
      .select("vault_id, psbt_hex, path")
      .eq("id", proposal_id)
      .maybeSingle();
    if (pErr) return json(500, { error: pErr.message });
    if (!proposal) return json(404, { error: "Proposal not found" });

    // A "signature" is only recorded if the PSBT really is this
    // proposal's transaction and really carries a valid signature.
    const sigCheck = verifySignedPsbt({ psbtHex: psbt_partial_hex, proposalPsbtHex: proposal.psbt_hex });
    if (!sigCheck.ok) return json(400, { error: `Signature rejected: ${sigCheck.error}` });

    const { data: member } = await supabase
      .from("vault_members")
      .select("id, fingerprint, label, role")
      .eq("vault_id", proposal.vault_id)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!member) return json(403, { error: "Not a member of this vault" });
    if (!canMutate(member.role)) return json(403, { error: "View-only members cannot record a signature" });

    // Upsert by (proposal_id, member_id). Existing row -> replace the
    // partial PSBT so re-signing after a fix replaces the stale one.
    const { data: existing } = await supabase
      .from("signer_sessions")
      .select("id, signer_index")
      .eq("proposal_id", proposal_id)
      .eq("member_id", member.id)
      .maybeSingle();

    // fingerprint is always the caller's OWN registered member row --
    // never request-supplied (Kimi K3 scan #144). Accepting a
    // client-chosen fingerprint let a signer record their partial
    // signature under another member's fingerprint, making a proposal
    // look signed by a co-signer who never signed.
    // In what capacity each key that signed did so on this path: a key
    // every spend needs, one of the consent group, or an ordinary signer.
    // Read from the vault's own policy and the keys whose signatures
    // verified above -- never from anything the request says.
    let signedAs = [];
    try {
      const { data: vault } = await supabase.from("vaults").select(VAULT_SHAPE_FIELDS).eq("id", proposal.vault_id).maybeSingle();
      const path = vault && proposal.path ? findSpendingPath(vault, proposal.path) : null;
      signedAs = signersOnEveryInput(psbt_partial_hex).map((key) => ({ key, as: signerCapacity(path, key) }));
    } catch (e) {
      console.error(`[signer-sessions] could not work out signer capacity: ${e?.message || e}`);
    }

    const row = {
      proposal_id,
      member_id: member.id,
      signer_role: member.role,
      label: label ?? member.label ?? null,
      fingerprint: member.fingerprint ?? null,
      psbt_partial_hex,
      signed: true,
      signed_at: new Date().toISOString(),
    };

    // signer_index is not-null in the existing schema -- use the
    // current count as a stable per-proposal index.
    let signerIndex = null;
    if (!existing) {
      const { count } = await supabase
        .from("signer_sessions")
        .select("*", { count: "exact", head: true })
        .eq("proposal_id", proposal_id);
      signerIndex = count ?? 0;
    }
    const save = (r) => existing
      ? supabase.from("signer_sessions").update(r).eq("id", existing.id).select(FIELDS).single()
      : supabase.from("signer_sessions").insert({ ...r, signer_index: signerIndex }).select(FIELDS).single();

    let { data, error } = await save(row);
    if (error && error.code === "23514" && /signer_role/.test(error.message || "")) {
      // The old two-role constraint is still in place. Keep the signature;
      // the sealed entry below still names the real role.
      console.error(`[signer-sessions] signer_role '${row.signer_role}' refused by the old constraint; saved as '${legacySignerRole(member.role)}'`);
      ({ data, error } = await save({ ...row, signer_role: legacySignerRole(member.role) }));
    }
    if (error) return json(500, { error: error.message });

    await recordEvent(supabase, {
      vault_id: proposal.vault_id,
      user_id: u.userId,
      event_type: "signed",
      metadata: { proposal_id, member_id: member.id, fingerprint: row.fingerprint, role: member.role, path: proposal.path ?? null, signed_as: signedAs },
    });

    return json(200, { ok: true, session: data });
  }

  return json(405, { error: "Method not allowed" });
}
