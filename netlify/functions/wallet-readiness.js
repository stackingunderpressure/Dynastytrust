/**
 * wallet-readiness.js -- the green/red peer readiness surface.
 *
 * GET  /api/wallet-readiness   (JWT)
 *        -> { me: { readiness, reason }, peers: [...], flags: [...] }
 *        my own readiness plus every co-member of a shared vault, so the
 *        group can see who is green / red, plus the recent flag trail.
 *
 * POST /api/wallet-readiness   (JWT)
 *        body: { subject_user_id, vault_id, kind: 'flag'|'clear', reason? }
 *        a peer raises or clears a red flag on another member of a shared
 *        vault. Writes the append-only member_flags trail and updates the
 *        subject's current readiness on wallet_identities.
 *
 * GREEN/RED is GUIDANCE ONLY: readiness drives the UI's sweep / readiness
 * prompts, never a hard block on login, signing, quorum, or base spend.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

// Active vault ids the user belongs to.
async function myVaultIds(supabase, userId) {
  const { data, error } = await supabase
    .from("vault_members")
    .select("vault_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((r) => r.vault_id))];
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    // My own readiness (null when I have no bound wallet).
    const { data: mine, error: mineErr } = await supabase
      .from("wallet_identities")
      .select("readiness, readiness_reason")
      .eq("user_id", u.userId)
      .maybeSingle();
    if (mineErr) return json(500, { error: mineErr.message });

    const me = {
      linked: !!mine,
      readiness: mine?.readiness ?? "green",
      reason: mine?.readiness_reason ?? null,
    };

    let vaultIds;
    try {
      vaultIds = await myVaultIds(supabase, u.userId);
    } catch (e) {
      return json(500, { error: e.message });
    }

    if (vaultIds.length === 0) {
      return json(200, { ok: true, me, peers: [], flags: [] });
    }

    // Co-members of my vaults (excluding me).
    const { data: members, error: memErr } = await supabase
      .from("vault_members")
      .select("user_id, vault_id, label")
      .in("vault_id", vaultIds)
      .eq("status", "active")
      .neq("user_id", u.userId);
    if (memErr) return json(500, { error: memErr.message });

    const peerIds = [...new Set((members ?? []).map((m) => m.user_id))];
    let readinessById = {};
    if (peerIds.length) {
      const { data: ids, error: idErr } = await supabase
        .from("wallet_identities")
        .select("user_id, readiness, readiness_reason")
        .in("user_id", peerIds);
      if (idErr) return json(500, { error: idErr.message });
      readinessById = Object.fromEntries(
        (ids ?? []).map((r) => [r.user_id, r]),
      );
    }

    const peers = (members ?? []).map((m) => {
      const r = readinessById[m.user_id];
      return {
        user_id: m.user_id,
        vault_id: m.vault_id,
        label: m.label ?? null,
        linked: !!r,
        readiness: r?.readiness ?? "green",
        reason: r?.readiness_reason ?? null,
      };
    });

    // Recent flag trail across my vaults.
    const { data: flags } = await supabase
      .from("member_flags")
      .select("id, created_at, vault_id, subject_user_id, actor_user_id, kind, reason")
      .in("vault_id", vaultIds)
      .order("created_at", { ascending: false })
      .limit(50);

    return json(200, { ok: true, me, peers, flags: flags ?? [] });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { subject_user_id, vault_id, kind, reason } = body;
    if (kind !== "flag" && kind !== "clear") {
      return json(400, { error: "kind must be 'flag' or 'clear'" });
    }
    if (!subject_user_id || !vault_id) {
      return json(400, { error: "Missing: subject_user_id, vault_id" });
    }

    // Both the actor and the subject must be active members of this vault.
    const { data: pair, error: pairErr } = await supabase
      .from("vault_members")
      .select("user_id")
      .eq("vault_id", vault_id)
      .eq("status", "active")
      .in("user_id", [u.userId, subject_user_id]);
    if (pairErr) return json(500, { error: pairErr.message });
    const present = new Set((pair ?? []).map((r) => r.user_id));
    if (!present.has(u.userId) || !present.has(subject_user_id)) {
      return json(403, { error: "You and that member must share this vault" });
    }

    // Append the trail row.
    const { error: flagErr } = await supabase.from("member_flags").insert({
      vault_id,
      subject_user_id,
      actor_user_id: u.userId,
      kind,
      reason: reason ?? null,
    });
    if (flagErr) return json(500, { error: flagErr.message });

    // Update the subject's current readiness, if they have a bound wallet.
    const { data: subjectIdentity } = await supabase
      .from("wallet_identities")
      .select("user_id")
      .eq("user_id", subject_user_id)
      .maybeSingle();

    let readinessUpdated = false;
    if (subjectIdentity) {
      const { error: upErr } = await supabase
        .from("wallet_identities")
        .update({
          readiness: kind === "flag" ? "red" : "green",
          readiness_reason: kind === "flag" ? reason ?? null : null,
          readiness_updated_at: new Date().toISOString(),
        })
        .eq("user_id", subject_user_id);
      if (upErr) return json(500, { error: upErr.message });
      readinessUpdated = true;
    }

    return json(200, {
      ok: true,
      kind,
      readiness: kind === "flag" ? "red" : "green",
      readiness_updated: readinessUpdated,
    });
  }

  return json(405, { error: "Method not allowed" });
}
