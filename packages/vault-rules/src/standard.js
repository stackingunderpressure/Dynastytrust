// The standard vault's compile rules (founders / recovery or backup /
// inheritance / second inheritance / consent), moved from
// netlify/functions/vaults-compile.js into pure functions so the website's
// server and the downloaded app run ONE copy (download slice,
// docs/download-and-run-build-note.md). Same order, same checks, same
// messages; proven unchanged by scripts/test-vault-rules-standard.mjs.
//
// Pure: no database, no network. The caller loads the draft row, supplies
// the chain tip when `needsTip` says so, sends the payload to the compiler
// (Fly or the in-browser module), and stores the row `compiledRow` returns.

import { checkTimelockFloor, relativeToAbsolute } from "./timelocks.js";

const refuse = (status, error) => ({ ok: false, status, error });

// A key counts as "provisioned" one of two ways: a real xpub-based key
// needs its full origin triple (xpub + fingerprint + derivation_path) so
// upgradeDescriptor can annotate it Nunchuk/Sparrow-style, OR a
// Tapit-origin key -- which has no xpub or derivation path by design --
// needs nothing more than a real pubkey.
const isHexPubkey = (s) => typeof s === "string" && /^0[23][0-9a-f]{64}$/i.test(s);
export const isProvisioned = (k) => {
  if (!k || !isHexPubkey(k.pubkey)) return false;
  if (k.xpub) return Boolean(k.fingerprint && k.derivation_path);
  return true;
};

// Dedupe by the key material that actually lands in the compiled policy
// (xpub if present, else the bare pubkey) -- two entries with the SAME key
// would otherwise occupy two slots while being one real signer, quietly
// lowering the real threshold (Kimi K3 scan #134).
const dedupeByKey = (arr) => {
  const seen = new Set();
  return arr.filter((k) => {
    const id = k.xpub || k.pubkey;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/**
 * Which keys go into the vault, and which optional parts it has.
 * `directKeys`: the owner brings every key (`{founder_keys, heir_keys,
 * consent_keys, backup_keys, second_heir_keys}`). Otherwise `members`
 * (active vault_members rows) are the invite-based roster.
 */
export function standardKeys(vault, directKeys, members) {
  const dk = directKeys;
  let founders, heirs, consenters, backups, secondHeirs;
  if (dk && typeof dk === "object") {
    const clean = (arr) => (Array.isArray(arr) ? arr : []).filter(isProvisioned);
    founders = clean(dk.founder_keys);
    heirs = clean(dk.heir_keys);
    consenters = clean(dk.consent_keys);
    backups = clean(dk.backup_keys);
    secondHeirs = clean(dk.second_heir_keys);
  } else {
    const ready = (members ?? []).filter(isProvisioned);
    founders = ready.filter(m => m.role === "founder" || m.role === "owner");
    heirs = ready.filter(m => m.role === "heir");
    consenters = ready.filter(m => m.role === "beneficiary");
    // Backup keys and the second inheritance cohort are the owner's own
    // keys -- never invited. Invite-based vaults simply never have any.
    backups = [];
    secondHeirs = [];
  }
  founders = dedupeByKey(founders);
  heirs = dedupeByKey(heirs);

  // On the invite-based path, a null planned count defaulting to the
  // roster size would trivially satisfy the exact-count check below.
  if (!dk) {
    if (vault.planned_founder_count == null) {
      return refuse(400, "This vault has no planned founder count set -- cannot compile an invite-based roster without it.");
    }
    if (vault.planned_heir_count == null && heirs.length > 0) {
      return refuse(400, "This vault has heirs but no planned heir count set -- cannot compile without it.");
    }
  }
  const plannedF = vault.planned_founder_count ?? founders.length;
  const plannedH = vault.planned_heir_count ?? heirs.length;
  // Exact match, not merely "at least": a roster that grew or shrank
  // relative to the plan fails closed.
  if (founders.length !== plannedF) {
    return refuse(400, `Need exactly ${plannedF} provisioned founder(s); ${founders.length} ready (after removing duplicate keys).`);
  }
  if (plannedH > 0 && heirs.length !== plannedH) {
    return refuse(400, `Need exactly ${plannedH} provisioned heir(s); ${heirs.length} ready (after removing duplicate keys).`);
  }

  // Backup is always immediately spendable, and mutually exclusive with
  // a timelocked recovery leaf (the compiler rejects both).
  const hasBackup = backups.length > 0 && vault.backup_quorum != null;
  // A second inheritance leaf requires the primary one (the compiler's
  // SecondInheritanceRequiresInheritance gate).
  const hasSecondInheritance =
    secondHeirs.length > 0 &&
    vault.second_heir_quorum != null &&
    vault.second_inheritance_after != null &&
    heirs.length > 0;

  // Every stored relative timelock is floor- and ceiling-checked
  // immediately before it is converted (Kimi K3 scan Family D).
  for (const [value, field] of [
    [vault.recovery_after, "recovery_after"],
    [vault.inheritance_after, "inheritance_after"],
    [hasSecondInheritance ? vault.second_inheritance_after : null, "second_inheritance_after"],
  ]) {
    const err = checkTimelockFloor(value, field);
    if (err) return refuse(400, err);
  }

  const needsTip = Boolean(vault.recovery_after || vault.inheritance_after ||
    (hasSecondInheritance && vault.second_inheritance_after));
  return { ok: true, founders, heirs, consenters, backups, secondHeirs, hasBackup, hasSecondInheritance, needsTip };
}

/**
 * The compiler request (POST /compile). `tipHeight` is the verified chain
 * tip (0 when `needsTip` was false). `pubkeyFromXpub` re-derives an
 * xpub key's /0/0 pubkey -- never trust the client-supplied pubkey for an
 * xpub key; a Tapit key has no xpub and its pubkey IS the key.
 */
export function standardCompilePayload(vault, keys, tipHeight, pubkeyFromXpub) {
  const keyPubkeyHex = (k) => (k.xpub ? pubkeyFromXpub(k.xpub) : k.pubkey.toLowerCase());
  const { founders, heirs, consenters, backups, secondHeirs, hasBackup, hasSecondInheritance } = keys;
  return {
    name: vault.name,
    network: vault.network,
    address_type: vault.address_type,
    founder_keys: founders.map(keyPubkeyHex),
    founder_quorum: vault.founder_quorum,
    recovery_quorum: vault.recovery_quorum,
    heir_keys: heirs.map(keyPubkeyHex),
    heir_quorum: vault.heir_quorum,
    recovery_after: relativeToAbsolute(vault.recovery_after, tipHeight),
    inheritance_after: relativeToAbsolute(vault.inheritance_after, tipHeight),
    ...(vault.consent_quorum != null && consenters.length >= (vault.consent_quorum ?? 0)
      ? { consent_keys: consenters.map(keyPubkeyHex), consent_quorum: vault.consent_quorum }
      : {}),
    ...(hasBackup
      ? { backup_keys: backups.map(keyPubkeyHex), backup_quorum: vault.backup_quorum }
      : {}),
    ...(hasSecondInheritance
      ? {
          second_heir_keys: secondHeirs.map(keyPubkeyHex),
          second_heir_quorum: vault.second_heir_quorum,
          second_inheritance_after: relativeToAbsolute(vault.second_inheritance_after, tipHeight),
        }
      : {}),
  };
}

// Replace every occurrence of a raw pubkey hex in the descriptor
// with its Nunchuk-format key origin expression. Pure string work,
// same algorithm as the browser's upgradeDescriptor.
//
// Fixed at /0/0, not a `/0/*` wildcard range (matches the 2026-08-06
// fix in apps/web/src/lib/descriptor-keys.ts -- see that file's header
// comment for the full rationale). This function is the one that
// actually wins for every vault compiled through vaults-compile.js: it
// runs BEFORE the browser ever sees the descriptor and consumes the
// raw pubkey substrings the browser's own upgradeDescriptor searches
// for, so the browser's /0/0 fix was silently a no-op here the whole
// time this function still said /0/*. A ranged descriptor lets
// Nunchuk/Sparrow offer a second receive address at index 1+ that our
// own compiler has no way to build a spend for (it only ever knows the
// exact /0/0 key baked into the leaf script) -- funds sent there would
// be spendable by the hardware wallet directly but invisible to this
// app's own coordinator.
export function upgradeDescriptor(descriptor, origins) {
  let out = descriptor;
  for (const { pubkey, fingerprint, derivation_path, xpub } of origins) {
    if (!pubkey || !fingerprint || !derivation_path || !xpub) continue;
    const cleanPath = derivation_path.replace(/^m\//, "");
    const keyExpr = `[${fingerprint}/${cleanPath}]${xpub}/0/0`;
    out = out.split(pubkey).join(keyExpr);
  }
  return out;
}

/** The vault row's new fields once the compiler has answered. */
export function standardCompiledRow(vault, keys, compiled, tipHeight) {
  const { founders, heirs, consenters, backups, secondHeirs, hasSecondInheritance } = keys;
  // BIP32 origins for hardware-wallet signing, stored on the vault row
  // (a one-owner vault never gets a vault_members row per key).
  const keyOrigins = [...founders, ...heirs, ...consenters, ...backups, ...secondHeirs]
    .filter((m) => m.pubkey && m.fingerprint && m.derivation_path)
    .map((m) => ({
      pubkey: m.pubkey,
      fingerprint: m.fingerprint,
      derivation_path: m.derivation_path.replace(/\/+$/, "") + "/0/0",
    }));
  // Stored key value: the real xpub when the key has one; otherwise the
  // bare compressed pubkey (a Tapit key), never an empty string.
  const keyStoreValue = (k) => k.xpub || k.pubkey.toLowerCase();
  return {
    address: compiled.address,
    descriptor: upgradeDescriptor(compiled.descriptor, [...founders, ...heirs, ...secondHeirs]),
    miniscript_policy: compiled.miniscript_policy,
    founder_keys: founders.map(keyStoreValue),
    heir_keys: heirs.map(keyStoreValue),
    consent_keys: vault.consent_quorum != null ? consenters.map(keyStoreValue) : [],
    backup_keys: backups.map(keyStoreValue),
    second_heir_keys: secondHeirs.map(keyStoreValue),
    // The draft's relative offsets become the absolute CLTV heights baked
    // into the compiled leaves.
    recovery_after: relativeToAbsolute(vault.recovery_after, tipHeight),
    inheritance_after: relativeToAbsolute(vault.inheritance_after, tipHeight),
    second_inheritance_after: hasSecondInheritance ? relativeToAbsolute(vault.second_inheritance_after, tipHeight) : vault.second_inheritance_after,
    status: "compiled",
    leaf_scripts: compiled.leaf_scripts ?? null,
    key_origins: keyOrigins,
  };
}
