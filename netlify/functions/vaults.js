import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// Defense-in-depth for the compromised-coordinator threat model: the
// isBloc and legacy branches below persist a client-supplied
// {address, descriptor, miniscript_policy} triple with no derivation
// binding them together. Full descriptor->address re-derivation is a
// larger undertaking; this closes the simplest and most dangerous
// form of the gap -- a malformed, wrong-network, or outright garbage
// address being persisted with zero validation. If the compiler is
// unreachable, this fails OPEN (returns true) rather than blocking
// vault creation entirely on an unrelated outage -- the caller already
// got this same address from a real /api/compile response moments
// earlier in the normal flow, so an outage here is not the same class
// of risk as never validating at all.
async function looksLikeAValidAddress(address, network) {
  if (!COMPILER_URL) return true;
  try {
    const res = await fetch(`${COMPILER_URL.replace(/\/$/, "")}/validate-address`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify({ address, network }),
    });
    if (!res.ok) return true;
    const data = await res.json();
    return data.ok ? data.valid : true;
  } catch {
    return true;
  }
}

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, protector_keys, protector_quorum, protector_after, consent_keys, consent_quorum, archived, status, planned_founder_count, planned_heir_count, trust_doc, predecessor_id, duress, bloc_policy, leaf_scripts, backup_keys, backup_quorum, second_heir_keys, second_heir_quorum, second_inheritance_after, key_labels";

// key_labels is keyed off whatever string actually appears in
// vaults.founder_keys/heir_keys/etc -- keyStoreValue() in
// vaults-compile.js stores the real xpub when a key has one (hardware/
// software keys), or the bare compressed pubkey hex when it doesn't
// (Tapit-origin keys, keystore.ts's importTapitPubkey). Deliberately
// NOT restricted to a hex-pubkey shape -- an xpub is ~111 base58
// characters, not hex, and rejecting it here would make every
// hardware/software-keyed founder's slot unlabelable while only
// Tapit-shaped keys worked. This just needs to be the same non-empty
// string the frontend already has on hand from that array.
function isValidKeyIdentifier(s) {
  return typeof s === "string" && s.trim().length > 0 && s.trim().length <= 130;
}

// Case-fold ONLY a hex pubkey (case-insensitive by convention, and
// every other reader in this codebase compares hex lowercased). An
// xpub/ypub/zpub is base58 and CASE-SENSITIVE -- lowercasing one would
// corrupt it as a lookup key, silently breaking the match against
// vaults.founder_keys/heir_keys the next time this vault loads.
function normalizeKeyIdentifier(s) {
  const trimmed = s.trim();
  return /^[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // ── GET /api/vaults ──────────────────────────────────────────
  // Returns every vault the caller is an active member of (owner
  // rows are seeded by a trigger so creators are included too).
  if (event.httpMethod === "GET") {
    const showArchived = event.queryStringParameters?.archived === "true";

    const { data: memberships, error: mErr } = await supabase
      .from("vault_members")
      .select("vault_id, role")
      .eq("user_id", u.userId)
      .eq("status", "active");
    if (mErr) return json(500, { error: mErr.message });

    const vaultIds = (memberships ?? []).map(m => m.vault_id);
    if (vaultIds.length === 0) return json(200, { ok: true, vaults: [] });
    const roleById = new Map((memberships ?? []).map(m => [m.vault_id, m.role]));

    let query = supabase
      .from("vaults")
      .select(VAULT_FIELDS)
      .in("id", vaultIds)
      .order("created_at", { ascending: false });

    if (!showArchived) query = query.eq("archived", false);

    const { data, error } = await query;
    if (error) return json(500, { error: error.message });
    // Attach the caller's role in each vault so the Dashboard can
    // render a role-aware view without an N+1 fetch.
    const vaults = (data ?? []).map(v => ({ ...v, my_role: roleById.get(v.id) ?? null }));
    return json(200, { ok: true, vaults });
  }

  // ── POST /api/vaults ─────────────────────────────────────────
  // Three modes:
  //   { mode: "draft", name, network, address_type, founder_quorum,
  //     heir_quorum, recovery_after, inheritance_after,
  //     planned_founder_count, planned_heir_count }
  //       -- creates a shape-only vault; address/descriptor null.
  //       -- members fill slots via invites; owner compiles when
  //          every slot has an xpub.
  //   { mode: "bloc", address, descriptor, miniscript_policy, bloc_policy, ... }
  //       -- persists a compiled Dynasty Bloc vault (023_bloc_vaults.sql
  //          added the bloc_policy column for exactly this; it was never
  //          wired to a save path until now). Bloc vaults are
  //          single-owner-held (no vault_members), and the
  //          founders/heirs columns are meaningless for this shape --
  //          left at their table defaults, unused.
  //   Legacy mode (no `mode` field, or mode: "compiled"):
  //       -- the existing "I compiled this already, save it" path.
  //       -- requires address, descriptor, miniscript_policy.
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const network = body.network || "testnet";
    if (!["testnet", "signet", "bitcoin"].includes(network)) {
      return json(400, { error: "Invalid network. Use 'testnet', 'signet', or 'bitcoin'" });
    }

    const address_type = body.address_type || "tr_multileaf";
    if (!["wsh", "tr", "tr_multileaf"].includes(address_type)) {
      return json(400, { error: "Invalid address_type" });
    }

    const isDraft = body.mode === "draft";
    const isBloc = body.mode === "bloc";
    const isBlocDraft = body.mode === "bloc-draft";
    let insertRow;

    if (isBlocDraft) {
      // Shape-only Bloc vault: the operator picked "pass it to my kids"
      // and tuned quorums/timelocks, but hasn't filled every parent/kid
      // key slot yet. Mirrors the standard draft path (address/descriptor
      // null, status "draft") so a vault can exist as a real, revisitable
      // row before every signer's key is in hand. bloc_policy stores
      // whatever's already known (partial pubkey/xpub arrays are fine --
      // compiling for real later requires the full set, checked at that
      // point, not here).
      const bloc_policy = body.bloc_policy && typeof body.bloc_policy === "object" ? body.bloc_policy : {};
      insertRow = {
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address_type,
        address: null,
        descriptor: null,
        miniscript_policy: null,
        bloc_policy,
        status: "draft",
      };
    } else if (isBloc) {
      const { address, descriptor, miniscript_policy, bloc_policy } = body;
      if (!address) return json(400, { error: "Missing: address" });
      if (!descriptor) return json(400, { error: "Missing: descriptor" });
      if (!miniscript_policy) return json(400, { error: "Missing: miniscript_policy" });
      if (!bloc_policy || typeof bloc_policy !== "object") {
        return json(400, { error: "Missing: bloc_policy" });
      }
      const required = [
        "parent_pubkeys", "kid_pubkeys", "parent_xpubs", "kid_xpubs",
        "parents_together_quorum", "coparent_quorum", "kids_with_parent_quorum",
        "parent_solo_quorum", "kids_decay_start_quorum", "kids_decay_floor_quorum",
        "parent_solo_after", "kids_decay_start_after", "kids_decay_step_blocks",
      ];
      const missing = required.filter(k => bloc_policy[k] === undefined || bloc_policy[k] === null);
      if (missing.length) {
        return json(400, { error: `bloc_policy missing: ${missing.join(", ")}` });
      }
      if (!(await looksLikeAValidAddress(address, network))) {
        return json(400, { error: `address does not look like a valid ${network} address` });
      }

      insertRow = {
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address,
        descriptor,
        miniscript_policy,
        address_type,
        // key_origins (fingerprint + derivation_path per signer) travels
        // inside bloc_policy -- Bloc vaults have no vault_members table
        // to carry it separately the way the standard shape does.
        bloc_policy,
        status: "compiled",
      };
    } else if (isDraft) {
      const planned_founder_count = body.planned_founder_count;
      const planned_heir_count = body.planned_heir_count ?? 0;
      if (!planned_founder_count || planned_founder_count < 1) {
        return json(400, { error: "planned_founder_count must be >= 1" });
      }
      if (planned_heir_count < 0) {
        return json(400, { error: "planned_heir_count cannot be negative" });
      }

      insertRow = {
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address_type,
        address: null,
        descriptor: null,
        miniscript_policy: null,
        founder_quorum: body.founder_quorum ?? planned_founder_count,
        heir_quorum: body.heir_quorum ?? Math.max(1, planned_heir_count),
        recovery_quorum: body.recovery_quorum ?? null,
        recovery_after: body.recovery_after ?? 26000,
        inheritance_after: body.inheritance_after ?? 52560,
        protector_keys: [],
        protector_quorum: body.protector_quorum ?? null,
        protector_after: body.protector_after ?? null,
        consent_keys: [],
        consent_quorum: body.consent_quorum ?? null,
        backup_keys: [],
        backup_quorum: body.backup_quorum ?? null,
        second_heir_keys: [],
        second_heir_quorum: body.second_heir_quorum ?? null,
        second_inheritance_after: body.second_inheritance_after ?? null,
        founder_keys: [],
        heir_keys: [],
        status: "draft",
        planned_founder_count,
        planned_heir_count,
      };
    } else {
      const { address, descriptor, miniscript_policy } = body;
      if (!address) return json(400, { error: "Missing: address" });
      if (!descriptor) return json(400, { error: "Missing: descriptor" });
      if (!miniscript_policy) return json(400, { error: "Missing: miniscript_policy" });
      if (!(await looksLikeAValidAddress(address, network))) {
        return json(400, { error: `address does not look like a valid ${network} address` });
      }

      // The vault address was already compiled by /api/compile,
      // which converted any relative block offsets into absolute
      // CLTV heights (tip + offset) and returned them in the
      // response. The client MUST pass those absolute values back
      // here so the DB matches what the Taproot tree actually
      // bakes in. Passing a relative offset here (or fetching a
      // fresh tip and re-converting) would give a value that
      // differs from what the address was compiled against, and
      // /api/psbt-binary's tree rebuild would produce a different
      // merkle root -- "Control block verification failed at
      // index 0" on finalize.
      insertRow = {
        user_id: u.userId,
        name: body.name || "Vault",
        network,
        address,
        descriptor,
        miniscript_policy,
        address_type,
        founder_quorum: body.founder_quorum ?? 2,
        heir_quorum: body.heir_quorum ?? 2,
        recovery_quorum: body.recovery_quorum ?? null,
        recovery_after: body.recovery_after ?? 0,
        inheritance_after: body.inheritance_after ?? 0,
        protector_keys: body.protector_keys ?? [],
        protector_quorum: body.protector_quorum ?? null,
        protector_after: body.protector_after ?? null,
        consent_keys: body.consent_keys ?? [],
        consent_quorum: body.consent_quorum ?? null,
        backup_keys: body.backup_keys ?? [],
        backup_quorum: body.backup_quorum ?? null,
        second_heir_keys: body.second_heir_keys ?? [],
        second_heir_quorum: body.second_heir_quorum ?? null,
        second_inheritance_after: body.second_inheritance_after ?? null,
        founder_keys: body.founder_keys ?? [],
        heir_keys: body.heir_keys ?? [],
        status: "compiled",
      };
    }

    const { data, error } = await supabase
      .from("vaults")
      .insert(insertRow)
      .select(VAULT_FIELDS)
      .single();

    if (error) return json(500, { error: error.message });

    await supabase.from("vault_events").insert({
      vault_id: data.id,
      user_id: u.userId,
      event_type: isDraft || isBlocDraft ? "draft_created" : "created",
      metadata: isDraft
        ? {
            address_type,
            network,
            planned_founder_count: insertRow.planned_founder_count,
            planned_heir_count: insertRow.planned_heir_count,
          }
        : { address_type, network },
    });

    // Record explicit terms-of-service acceptance alongside the
    // vault creation. The client passes the version string it saw
    // in the UI; the server timestamps it. This gives us a durable
    // audit trail tied to a specific user and vault_id without
    // adding a separate table.
    if (body.terms_accepted_version) {
      await supabase.from("vault_events").insert({
        vault_id: data.id,
        user_id: u.userId,
        event_type: "terms_accepted",
        metadata: {
          terms_version: String(body.terms_accepted_version),
          user_agent: event.headers?.["user-agent"] || null,
        },
      });
    }

    return json(201, { ok: true, vault: data });
  }

  // ── PATCH /api/vaults?id=<uuid> ──────────────────────────────
  if (event.httpMethod === "PATCH") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    // key_label is a structured merge (upsert-by-pubkey into key_labels),
    // not a plain column overwrite, so it's handled separately from the
    // simple `allowed` passthrough below -- see its own block further
    // down. (2026-08-15, operator: "make sure that each spot of every
    // vault and every key has a spot to assign that label to it".)
    if (body.key_label !== undefined) {
      const { pubkey, label } = body.key_label || {};
      if (!isValidKeyIdentifier(pubkey)) {
        return json(400, { error: "key_label.pubkey must be a non-empty pubkey or xpub string, 130 characters or fewer" });
      }
      if (label != null && (typeof label !== "string" || label.length > 60)) {
        return json(400, { error: "key_label.label must be a string of 60 characters or fewer, or null to clear it" });
      }
      const cleanPubkey = normalizeKeyIdentifier(pubkey);
      const cleanLabel = typeof label === "string" ? label.trim() : "";

      const { data: existing, error: fetchErr } = await supabase
        .from("vaults")
        .select("key_labels, user_id")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) return json(500, { error: fetchErr.message });
      if (!existing) return json(404, { error: "Vault not found" });
      if (existing.user_id !== u.userId) return json(403, { error: "Only the owner can label keys" });

      const current = Array.isArray(existing.key_labels) ? existing.key_labels : [];
      const withoutThisKey = current.filter((entry) => normalizeKeyIdentifier(entry?.pubkey ?? "") !== cleanPubkey);
      const nextLabels = cleanLabel
        ? [...withoutThisKey, { pubkey: cleanPubkey, label: cleanLabel }]
        : withoutThisKey; // empty/null label clears it, reverting to the default

      const { data, error } = await supabase
        .from("vaults")
        .update({ key_labels: nextLabels })
        .eq("id", id)
        .eq("user_id", u.userId)
        .select(VAULT_FIELDS)
        .single();
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true, vault: data });
    }

    const allowed = ["name", "archived", "trust_doc", "duress", "network"];
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k))
    );

    if (Object.keys(updates).length === 0) {
      return json(400, { error: "No updatable fields provided (allowed: name, archived, duress, network, key_label)" });
    }

    // Network is only safe to change while the vault is still a draft --
    // once compiled, the address/descriptor are already derived FOR that
    // network, and swapping the label afterward without recompiling would
    // silently point the app at the wrong chain for an address that's
    // real, funded money on the OTHER one. Operator, 2026-08-15: "you
    // should pick the network upfront... can't do it when managing keys."
    // The wizard's Keys step lets an owner fix a wrong network before any
    // keys are added; this guard is what makes that safe to expose.
    if (updates.network) {
      if (!["testnet", "signet", "bitcoin"].includes(updates.network)) {
        return json(400, { error: "network must be testnet, signet, or bitcoin" });
      }
      const { data: existing, error: fetchErr } = await supabase
        .from("vaults")
        .select("status, user_id")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) return json(500, { error: fetchErr.message });
      if (!existing) return json(404, { error: "Vault not found" });
      if (existing.user_id !== u.userId) return json(403, { error: "Not your vault" });
      if (existing.status !== "draft") {
        return json(400, { error: "Network can only be changed while the vault is still a draft, before it's compiled." });
      }
    }

    const { data, error } = await supabase
      .from("vaults")
      .update(updates)
      .eq("id", id)
      .eq("user_id", u.userId)
      .select(VAULT_FIELDS)
      .single();

    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: "Vault not found" });

    return json(200, { ok: true, vault: data });
  }

  // -- DELETE /api/vaults?id=<uuid>
  // Owner only. Cascades through vault_members, proposals, etc via
  // ON DELETE CASCADE on the schema. Use archive for soft-delete;
  // this is for drafts or genuinely abandoned vaults.
  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    const { data: existing } = await supabase
      .from("vaults")
      .select("id, user_id, name")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return json(404, { error: "Vault not found" });
    if (existing.user_id !== u.userId) {
      return json(403, { error: "Only the primary trustee can delete this vault" });
    }

    const { error: delErr } = await supabase
      .from("vaults")
      .delete()
      .eq("id", id);
    if (delErr) return json(500, { error: delErr.message });

    await supabase.from("vault_events").insert({
      vault_id: id,
      user_id: u.userId,
      event_type: "deleted",
      metadata: { name: existing.name },
    }).then(() => {}, () => { /* event table may cascade-delete too */ });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
