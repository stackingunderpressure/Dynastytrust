/**
 * POST /api/vaults-compile
 * Body: { vault_id } -- invite-based (members bring their own xpub via a
 *   claim link), OR { vault_id, direct_keys: { founder_keys, heir_keys,
 *   protector_keys?, consent_keys? } } -- single-owner direct mode, each
 *   entry { pubkey, xpub, fingerprint, derivation_path }, same shape the
 *   Bloc draft path (vaults-compile-bloc.js) already uses. This is for
 *   the common "I'm bringing every key myself, just not all in the same
 *   sitting as Configure" case -- the vault already exists as a real,
 *   revisitable draft row; direct_keys lets the SAME owner finish it
 *   later without needing to invite anyone.
 *
 * Compiles a draft vault into a live, spendable one.
 *
 * Preconditions (enforced):
 *   - caller is the vault owner
 *   - vault.status = 'draft'
 *   - invite-based: active member count with role='founder' and
 *     xpub/pubkey/fingerprint/derivation_path all set >= planned_founder_count
 *     (same for heirs, if planned_heir_count > 0)
 *   - direct_keys: founder_keys.length >= planned_founder_count (same for
 *     heirs, if planned_heir_count > 0) -- no vault_members lookup at all
 *
 * Flow:
 *   1. load vault (+ active members, unless direct_keys given)
 *   2. forward each key's pubkey hex + quorums + timelocks to the
 *      Fly.io compiler
 *   3. post-process the returned descriptor into Nunchuk key-origin
 *      form pk([fp/path]xpub/0/0) using the xpubs
 *   4. UPDATE vaults SET address, descriptor, miniscript_policy,
 *      founder_keys, heir_keys, status='compiled'
 *   5. log 'draft_compiled' event
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { pubkeyFromXpub } from "./_xpub.js";
import { fetchTipHeight, relativeToAbsolute } from "./_chain.js";
import { fetchCompiler, compilerFailureReason } from "./_compiler.js";

const COMPILER_URL = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// Mirrors protocol/src/policy_compiler.rs's MIN_RECOVERY_BLOCKS -- see
// compile.js for why this must be checked here, against the raw
// relative offset, rather than relying on the Rust compiler's own
// verify(), which only ever sees the value after tip+offset conversion.
const MIN_RECOVERY_BLOCKS = 26_000;

const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, protector_keys, protector_quorum, protector_after, consent_keys, consent_quorum, archived, status, planned_founder_count, planned_heir_count, trust_doc, predecessor_id, leaf_scripts, backup_keys, backup_quorum, second_heir_keys, second_heir_quorum, second_inheritance_after, key_origins";

// Replace every occurrence of a raw pubkey hex in the descriptor
// with its Nunchuk-format key origin expression. Pure string work,
// same algorithm as the browser's upgradeDescriptor.
//
// Fixed at /0/0, not a `/0/*` wildcard range (matches the 2026-08-06
// fix in apps/web/src/lib/descriptor-keys.ts -- see that file's header
// comment for the full rationale). This function is the one that
// actually wins for every vault compiled through this endpoint: it
// runs BEFORE the browser ever sees the descriptor and consumes the
// raw pubkey substrings the browser's own upgradeDescriptor searches
// for, so the browser's /0/0 fix was silently a no-op here the whole
// time this function still said /0/*. A ranged descriptor lets
// Nunchuk/Sparrow offer a second receive address at index 1+ that our
// own compiler has no way to build a spend for (it only ever knows the
// exact /0/0 key baked into the leaf script) -- funds sent there would
// be spendable by the hardware wallet directly but invisible to this
// app's own coordinator.
function upgradeDescriptor(descriptor, origins) {
  let out = descriptor;
  for (const { pubkey, fingerprint, derivation_path, xpub } of origins) {
    if (!pubkey || !fingerprint || !derivation_path || !xpub) continue;
    const cleanPath = derivation_path.replace(/^m\//, "");
    const keyExpr = `[${fingerprint}/${cleanPath}]${xpub}/0/0`;
    out = out.split(pubkey).join(keyExpr);
  }
  return out;
}

export async function handler(event) {
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
  if (!vaultId) return json(400, { error: "Missing: vault_id" });

  if (!COMPILER_URL) {
    return json(503, {
      error: "Compiler service not configured.",
      hint: "Set COMPILER_URL in Netlify env vars.",
    });
  }

  const supabase = getSupabaseAdmin();

  // Load vault and verify ownership + draft status.
  const { data: vault, error: vaultErr } = await supabase
    .from("vaults")
    .select(VAULT_FIELDS)
    .eq("id", vaultId)
    .maybeSingle();
  if (vaultErr) return json(500, { error: vaultErr.message });
  if (!vault) return json(404, { error: "Vault not found" });
  if (vault.user_id !== u.userId) return json(403, { error: "Only the owner can compile" });
  if (vault.status !== "draft") return json(400, { error: "Vault is not in draft status" });

  // Two ways to source signer keys: invite-based (vault_members, other
  // people bring their own xpub via a claim link) or direct_keys (the
  // owner brings every key themselves, just not necessarily all in the
  // same sitting as Configure -- no vault_members involvement at all).
  // A key counts as "provisioned" one of two ways: a real xpub-based key
  // needs its full origin triple (xpub + fingerprint + derivation_path) so
  // upgradeDescriptor can annotate it Nunchuk/Sparrow-style, OR a
  // Tapit-origin key -- which has no xpub or derivation path by design
  // (Cut C2: no invented xpub) -- needs nothing more than a real pubkey.
  // Requiring the xpub triple unconditionally silently dropped every
  // Tapit founder from the readiness count, even though the key itself
  // was perfectly usable.
  const isHexPubkey = (s) => typeof s === "string" && /^0[23][0-9a-f]{64}$/i.test(s);
  const isProvisioned = (k) => {
    if (!k || !isHexPubkey(k.pubkey)) return false;
    if (k.xpub) return Boolean(k.fingerprint && k.derivation_path);
    return true;
  };

  const dk = body.direct_keys;
  let founders, heirs, protectors, consenters, backups, secondHeirs;
  if (dk && typeof dk === "object") {
    const clean = (arr) => (Array.isArray(arr) ? arr : []).filter(isProvisioned);
    founders = clean(dk.founder_keys);
    heirs = clean(dk.heir_keys);
    protectors = clean(dk.protector_keys);
    consenters = clean(dk.consent_keys);
    backups = clean(dk.backup_keys);
    secondHeirs = clean(dk.second_heir_keys);
  } else {
    const { data: members, error: memErr } = await supabase
      .from("vault_members")
      .select("id, role, xpub, fingerprint, pubkey, derivation_path")
      .eq("vault_id", vaultId)
      .eq("status", "active");
    if (memErr) return json(500, { error: memErr.message });

    const ready = (members ?? []).filter(isProvisioned);
    founders = ready.filter(m => m.role === "founder" || m.role === "owner");
    heirs = ready.filter(m => m.role === "heir");
    protectors = ready.filter(m => m.role === "protector");
    consenters = ready.filter(m => m.role === "beneficiary");
    // Backup keys and the second inheritance cohort are the owner's own
    // (or independently-arranged) keys -- never invited, never a
    // vault_members role. Same pattern as backup: direct_keys only.
    // Invite-based vaults simply never have any.
    backups = [];
    secondHeirs = [];
  }

  const plannedF = vault.planned_founder_count ?? founders.length;
  const plannedH = vault.planned_heir_count ?? heirs.length;

  if (founders.length < plannedF) {
    return json(400, {
      error: `Need ${plannedF} provisioned founder(s); only ${founders.length} ready.`,
    });
  }
  if (plannedH > 0 && heirs.length < plannedH) {
    return json(400, {
      error: `Need ${plannedH} provisioned heir(s); only ${heirs.length} ready.`,
    });
  }

  if (vault.recovery_after && vault.recovery_after < MIN_RECOVERY_BLOCKS) {
    return json(400, {
      error: `recovery_after must be >= ${MIN_RECOVERY_BLOCKS} blocks (or 0 for no recovery leaf)`,
    });
  }

  // Forward to the Fly.io compiler. Convert draft-time relative
  // block offsets into absolute CLTV heights (tip + offset) before
  // the leaf is compiled; otherwise `after(N)` ends up at a tiny
  // absolute height that is long past on every live network and
  // the timelock path unlocks immediately.
  const hasProtector =
    protectors.length > 0 &&
    vault.protector_quorum != null &&
    vault.protector_after != null;
  // No timelock to convert -- backup is always immediately spendable.
  // Mutually exclusive with a timelocked recovery leaf (the Rust
  // compiler rejects both set at once); the wizard is responsible for
  // never setting recovery_after > 0 on a vault that also has backup
  // keys, same as it already keeps protector's ordering constraints.
  const hasBackup = backups.length > 0 && vault.backup_quorum != null;
  // Second, independent inheritance leaf (2026-08-11) -- its own key
  // set, quorum, and absolute timelock alongside the primary
  // inheritance leaf. Requires the primary inheritance leaf to already
  // be configured (heirs.length > 0), matching the Rust compiler's
  // SecondInheritanceRequiresInheritance gate.
  const hasSecondInheritance =
    secondHeirs.length > 0 &&
    vault.second_heir_quorum != null &&
    vault.second_inheritance_after != null &&
    heirs.length > 0;
  let tipHeight = 0;
  if (vault.recovery_after || vault.inheritance_after ||
      (hasProtector && vault.protector_after) ||
      (hasSecondInheritance && vault.second_inheritance_after)) {
    try {
      tipHeight = await fetchTipHeight(vault.network);
    } catch (e) {
      return json(502, {
        error: `Could not fetch chain tip for ${vault.network}: ${e.message}`,
      });
    }
  }
  const absRecoveryAfter    = relativeToAbsolute(vault.recovery_after,    tipHeight);
  const absInheritanceAfter = relativeToAbsolute(vault.inheritance_after, tipHeight);
  const absProtectorAfter   = relativeToAbsolute(vault.protector_after,   tipHeight);
  const absSecondInheritanceAfter = relativeToAbsolute(vault.second_inheritance_after, tipHeight);

  // Xpub-based keys are re-derived from the xpub itself (never trust the
  // client-supplied pubkey for those -- verify it against the key
  // material that will actually go into the descriptor's key-origin
  // annotation). A Tapit-origin key has no xpub to re-derive from -- its
  // pubkey IS the real key material, already validated as 33-byte
  // compressed hex by isProvisioned above -- so it's used as-is.
  const keyPubkeyHex = (k) => (k.xpub ? pubkeyFromXpub(k.xpub) : k.pubkey.toLowerCase());

  const compilePayload = {
    name: vault.name,
    network: vault.network,
    address_type: vault.address_type,
    founder_keys: founders.map(keyPubkeyHex),
    founder_quorum: vault.founder_quorum,
    recovery_quorum: vault.recovery_quorum,
    heir_keys: heirs.map(keyPubkeyHex),
    heir_quorum: vault.heir_quorum,
    recovery_after: absRecoveryAfter,
    inheritance_after: absInheritanceAfter,
    ...(hasProtector
      ? {
          protector_keys: protectors.map(keyPubkeyHex),
          protector_quorum: vault.protector_quorum,
          protector_after: absProtectorAfter,
        }
      : {}),
    ...(vault.consent_quorum != null && consenters.length >= (vault.consent_quorum ?? 0)
      ? {
          consent_keys: consenters.map(keyPubkeyHex),
          consent_quorum: vault.consent_quorum,
        }
      : {}),
    ...(hasBackup
      ? {
          backup_keys: backups.map(keyPubkeyHex),
          backup_quorum: vault.backup_quorum,
        }
      : {}),
    ...(hasSecondInheritance
      ? {
          second_heir_keys: secondHeirs.map(keyPubkeyHex),
          second_heir_quorum: vault.second_heir_quorum,
          second_inheritance_after: absSecondInheritanceAfter,
        }
      : {}),
  };

  let compiled;
  try {
    const res = await fetchCompiler(COMPILER_URL, "/compile", compilePayload, { compilerSecret: COMPILER_SECRET });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(502, {
        error: `Compiler returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
        hint: "Check COMPILER_SECRET matches between Netlify and Fly.io.",
      });
    }
    if (!res.ok || !data.ok) {
      return json(400, { error: data.error || "Compiler returned an error" });
    }
    compiled = data;
  } catch (err) {
    return json(502, { error: `Compiler unreachable: ${compilerFailureReason(err)}` });
  }

  const upgraded = upgradeDescriptor(compiled.descriptor, [...founders, ...heirs, ...secondHeirs]);

  // BIP32 origins for hardware-wallet signing, stored directly on the
  // vault row rather than requiring a vault_members lookup. The
  // invite-based path already has this covered by psbt-binary.js
  // reading vault_members directly, but direct_keys mode -- a single
  // owner bringing every key themselves -- never writes vault_members
  // at all (that table is one row per HUMAN signer, unique on
  // (vault_id, user_id), which can't represent "one owner, several
  // keys" in the first place). Without this, every direct_keys vault
  // silently degraded to browser/Tapit-only signing, same class of gap
  // Bloc (vaults.bloc_policy.key_origins) and tranche
  // (037_tranche_key_origins.sql) already closed. Computed uniformly
  // for both paths so future readers have one place to look.
  const keyOrigins = [...founders, ...heirs, ...protectors, ...consenters, ...backups, ...secondHeirs]
    .filter((m) => m.pubkey && m.fingerprint && m.derivation_path)
    .map((m) => ({
      pubkey: m.pubkey,
      fingerprint: m.fingerprint,
      derivation_path: m.derivation_path.replace(/\/+$/, "") + "/0/0",
    }));

  // What gets stored in vaults.founder_keys/heir_keys/etc: the real xpub
  // when the key has one, so every reader that expects an xpub there
  // (pubkeyFromXpub re-derivation, the descriptor upgrade) keeps working;
  // otherwise the bare compressed pubkey hex, matching the exact fallback
  // VaultDetail.tsx's addKey() already reads (a 66-hex-char entry is
  // treated as a pubkey directly, not an xpub) -- this is how a Tapit-
  // origin key, which has no xpub, is meant to be represented here.
  // Storing m.xpub unconditionally would have written an EMPTY STRING for
  // every Tapit founder's slot, silently dropping them from every
  // downstream reader (signing, Notify via Nostr, the circle phrase gate).
  const keyStoreValue = (k) => k.xpub || k.pubkey.toLowerCase();

  // Update the vault row with compiled output.
  const { data: saved, error: saveErr } = await supabase
    .from("vaults")
    .update({
      address: compiled.address,
      descriptor: upgraded,
      miniscript_policy: compiled.miniscript_policy,
      founder_keys: founders.map(keyStoreValue),
      heir_keys: heirs.map(keyStoreValue),
      protector_keys: protectors.map(keyStoreValue),
      consent_keys:
        vault.consent_quorum != null ? consenters.map(keyStoreValue) : [],
      backup_keys: backups.map(keyStoreValue),
      second_heir_keys: secondHeirs.map(keyStoreValue),
      // Overwrite the draft's relative offsets with the absolute
      // CLTV heights that got baked into the compiled leaves.
      recovery_after: absRecoveryAfter,
      inheritance_after: absInheritanceAfter,
      protector_after: hasProtector ? absProtectorAfter : vault.protector_after,
      second_inheritance_after: hasSecondInheritance ? absSecondInheritanceAfter : vault.second_inheritance_after,
      status: "compiled",
      // Per-role tapscript leaf bytes (Cut C3 prerequisite) -- absent
      // for non-tr_multileaf address types, since the compiler only
      // populates it for that shape.
      leaf_scripts: compiled.leaf_scripts ?? null,
      key_origins: keyOrigins,
    })
    .eq("id", vaultId)
    .select(VAULT_FIELDS)
    .single();
  if (saveErr) return json(500, { error: saveErr.message });

  await supabase.from("vault_events").insert({
    vault_id: vaultId,
    user_id: u.userId,
    event_type: "draft_compiled",
    metadata: {
      address_type: vault.address_type,
      network: vault.network,
      founder_count: founders.length,
      heir_count: heirs.length,
    },
  });

  return json(200, { ok: true, vault: saved });
}
