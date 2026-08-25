/**
 * POST /api/governance
 *
 * Proxies governance evaluation requests to the Fly.io Rust compiler service,
 * which hosts the deterministic governance engine.
 *
 * Supports two actions:
 *   action: "status"  — evaluate which spending paths are currently active
 *   action: "audit"   — full governance audit of a proposed spend
 *
 * The governance engine is stateless pure logic — no private data involved,
 * so this endpoint requires a valid Supabase JWT but no COMPILER_SECRET
 * is sent for status checks. Audit checks do forward to the compiler.
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';
import { checkNumberBounds } from './_numeric.js';
import { isLeafListVault, getSpendingPaths, findSpendingPath } from './_vault-shape.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

async function forwardToCompiler(endpoint, body) {
  if (!COMPILER_URL) {
    throw new Error('COMPILER_URL not configured');
  }
  const res = await fetch(`${COMPILER_URL.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Compiler error: ${res.status}`);
  }
  return res.json();
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { action, vault_id } = body;

  if (!action) return json(400, { error: 'Missing: action ("status" or "audit")' });
  if (!vault_id) return json(400, { error: 'Missing: vault_id' });

  // Load vault for policy params
  const supabase = getSupabaseAdmin();
  const { data: vault, error: vaultErr } = await supabase
    .from('vaults')
    .select('id, name, network, founder_quorum, heir_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, address, leaves')
    .eq('id', vault_id)
    .eq('user_id', u.userId)
    .single();

  if (vaultErr || !vault) return json(404, { error: 'Vault not found' });

  // 2026-08-25 fix: the Rust compiler's /governance/status and
  // /governance/audit HTTP endpoints only ever accept the named-field
  // policy shape (founder_quorum/heir_quorum/recovery_after/
  // inheritance_after) -- they have no leaves field to forward a
  // leaf-list vault's real structure through, so a leaf-list vault was
  // always evaluated as if founder_quorum=2/founder_key_count=0/
  // recovery_after=26000/inheritance_after=52560 (the bare DB
  // defaults), reporting "All paths unlocked. Founders and heirs can
  // spend" for a vault that may still be fully timelocked. Generalizing
  // those two Rust endpoints to accept leaves the way /psbt-binary
  // already does is real compiler work requiring a Fly.io redeploy,
  // outside what this pass can ship -- so a leaf-list vault is routed
  // to the JS fallback engine unconditionally instead of forwarding
  // named-field-shaped nonsense to a compiler endpoint that can't
  // represent its real policy. jsGovernanceStatusLeafList/
  // jsGovernanceAuditLeafList below are genuinely correct for this
  // shape, not a degraded fallback.
  const leafList = isLeafListVault(vault);

  const policyBase = {
    founder_quorum:    vault.founder_quorum,
    founder_key_count: (vault.founder_keys || []).length,
    heir_quorum:       vault.heir_quorum,
    heir_key_count:    (vault.heir_keys || []).length,
    recovery_after:    vault.recovery_after,
    inheritance_after: vault.inheritance_after,
  };

  // ── status: evaluate which paths are active ──────────────────────────────

  if (action === 'status') {
    const { utxo_age_blocks = 0 } = body;

    // The `jsGovernanceStatus`/`jsGovernanceAudit` comparisons below
    // (`utxo_age_blocks >= policy.recovery_after`, `amount_sats < 546`,
    // etc.) all evaluate false for NaN, so a non-numeric value silently
    // produced a plausible-looking but wrong advisory result instead of
    // a clear error. This endpoint is read-only/advisory -- it doesn't
    // authorize a real spend on its own -- but the audit/status result
    // it returns is what a human reads before deciding whether to
    // propose one (Kimi K3 scan Family D).
    if (utxo_age_blocks !== 0) {
      const err = checkNumberBounds(utxo_age_blocks, { field: 'utxo_age_blocks', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
      if (err) return json(400, { error: err });
    }

    if (leafList) {
      return json(200, { ok: true, vault_name: vault.name, result: jsGovernanceStatusLeafList(vault, utxo_age_blocks) });
    }

    // If compiler is not available, run a simplified JS version
    if (!COMPILER_URL) {
      return json(200, { ok: true, result: jsGovernanceStatus(policyBase, utxo_age_blocks) });
    }

    try {
      const result = await forwardToCompiler('/governance/status', {
        ...policyBase,
        utxo_age_blocks,
      });
      return json(200, { ok: true, vault_name: vault.name, result });
    } catch (err) {
      // Fallback to JS engine if compiler is cold/unavailable
      console.warn('Compiler unavailable, using JS fallback:', err.message);
      return json(200, { ok: true, vault_name: vault.name, result: jsGovernanceStatus(policyBase, utxo_age_blocks), fallback: true });
    }
  }

  // ── audit: full governance audit of a proposed spend ────────────────────

  if (action === 'audit') {
    const { path = 'founders_now', amount_sats, destination, utxo_age_blocks = 0, total_vault_sats = 0, signers = [] } = body;

    const amountErr = checkNumberBounds(amount_sats, { field: 'amount_sats', min: 546, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (amountErr) return json(400, { error: amountErr });
    if (!destination) return json(400, { error: 'Missing: destination' });
    if (utxo_age_blocks !== 0) {
      const err = checkNumberBounds(utxo_age_blocks, { field: 'utxo_age_blocks', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
      if (err) return json(400, { error: err });
    }
    if (total_vault_sats !== 0) {
      const err = checkNumberBounds(total_vault_sats, { field: 'total_vault_sats', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
      if (err) return json(400, { error: err });
    }

    if (leafList) {
      return json(200, {
        ok: true,
        vault_name: vault.name,
        result: jsGovernanceAuditLeafList(vault, { path, amount_sats, destination, utxo_age_blocks, total_vault_sats, signers }),
      });
    }

    if (!COMPILER_URL) {
      return json(200, { ok: true, result: jsGovernanceAudit(policyBase, { path, amount_sats, destination, utxo_age_blocks, total_vault_sats, signers }) });
    }

    try {
      const result = await forwardToCompiler('/governance/audit', {
        ...policyBase,
        path,
        amount_sats,
        destination,
        utxo_age_blocks,
        total_vault_sats,
        signers,
      });
      return json(200, { ok: true, vault_name: vault.name, result });
    } catch (err) {
      console.warn('Compiler unavailable, using JS fallback:', err.message);
      return json(200, { ok: true, vault_name: vault.name, result: jsGovernanceAudit(policyBase, { path, amount_sats, destination, utxo_age_blocks, total_vault_sats, signers }), fallback: true });
    }
  }

  return json(400, { error: `Unknown action: ${action}. Use "status" or "audit"` });
}

// ── JavaScript fallback governance engine ────────────────────────────────────
// Mirrors the Rust governance engine logic exactly.
// Used when the compiler service is unavailable (cold start, not deployed, etc.)
//
// NOTE on `utxo_age_blocks`: this is a legacy field name. The value is the
// CURRENT CHAIN TIP HEIGHT (absolute), not UTXO age. Timelocks are absolute
// CLTV, so recovery_after/inheritance_after are absolute heights and a path
// unlocks once the tip reaches that height. Renaming the field across the
// stack (DB column + Rust + this proxy) is a separate migration.

const BLOCKS_PER_DAY = 144;

function jsGovernanceStatus(policy, utxo_age_blocks) {
  // recovery_after == 0 means this vault has no recovery leaf at all
  // (the "Gift Locker" shape -- see protocol/src/governance.rs's
  // evaluate_vault_status doc comment, the Rust engine this JS fallback
  // mirrors). Without the has_recovery guard, utxo_age_blocks >= 0 is
  // trivially true and every Gift Locker vault reports recovery as
  // already unlocked from block 0.
  const has_recovery         = policy.recovery_after > 0;
  const recovery_unlocked    = has_recovery && utxo_age_blocks >= policy.recovery_after;
  const inheritance_unlocked = utxo_age_blocks >= policy.inheritance_after;

  const active_paths = ['founders_now'];
  if (recovery_unlocked)    active_paths.push('recovery');
  if (inheritance_unlocked) active_paths.push('inheritance');

  const phase = inheritance_unlocked ? 'inheritance_unlocked'
    : recovery_unlocked ? 'recovery_unlocked'
    : 'active';

  const blocks_until_recovery    = (!has_recovery || recovery_unlocked) ? null : policy.recovery_after - utxo_age_blocks;
  const blocks_until_inheritance = inheritance_unlocked ? null : policy.inheritance_after - utxo_age_blocks;

  return {
    current_block: utxo_age_blocks,
    active_paths,
    phase,
    blocks_until_recovery,
    blocks_until_inheritance,
    days_until_recovery:    blocks_until_recovery    != null ? blocks_until_recovery / BLOCKS_PER_DAY    : null,
    days_until_inheritance: blocks_until_inheritance != null ? blocks_until_inheritance / BLOCKS_PER_DAY : null,
    status_label: phase === 'active'
      ? (has_recovery
          ? `Active — founders can spend. Recovery unlocks in ~${Math.round(blocks_until_recovery / BLOCKS_PER_DAY)} days.`
          : `Active — founders can spend. No separate recovery path on this vault.`)
      : phase === 'recovery_unlocked'
      ? `Recovery path unlocked. Inheritance unlocks in ~${Math.round(blocks_until_inheritance / BLOCKS_PER_DAY)} days.`
      : 'All paths unlocked. Founders and heirs can spend.',
  };
}

function jsGovernanceAudit(policy, { path, amount_sats, destination, utxo_age_blocks, total_vault_sats, signers }) {
  // Same has_recovery guard as jsGovernanceStatus above -- a Gift
  // Locker vault (recovery_after == 0) has no recovery leaf, so a
  // Recovery-path audit must never be reported timelock-satisfied
  // just because utxo_age_blocks >= 0 is trivially true.
  const has_recovery = policy.recovery_after > 0;
  const timelock_ok = path === 'founders_now' ? true
    : path === 'recovery'    ? (has_recovery && utxo_age_blocks >= policy.recovery_after)
    : utxo_age_blocks >= policy.inheritance_after;

  const required = (path === 'inheritance') ? policy.heir_quorum : policy.founder_quorum;
  const signed   = signers.filter(s => s.signed).length;
  const quorum_ok = signed >= required;

  const violations = [];
  const warnings   = [];
  const notes      = [];

  if (!timelock_ok) {
    if (path === 'recovery' && !has_recovery) {
      violations.push({ rule: { id: 'GOV-001', description: 'Timelock not satisfied', severity: 'hard' },
        detail: 'This vault has no separate recovery path -- founders spend via Founders Now at any time.' });
    } else {
      const needed = path === 'recovery'
        ? policy.recovery_after - utxo_age_blocks
        : policy.inheritance_after - utxo_age_blocks;
      violations.push({ rule: { id: 'GOV-001', description: 'Timelock not satisfied', severity: 'hard' },
        detail: `Current chain height ${utxo_age_blocks} is below the unlock height. Needs ${needed} more blocks (~${Math.round(needed/BLOCKS_PER_DAY)} days).` });
    }
  }
  if (!quorum_ok) {
    violations.push({ rule: { id: 'GOV-002', description: 'Quorum not satisfied', severity: 'hard' },
      detail: `Need ${required} signatures, have ${signed}.` });
  }
  if (amount_sats < 546) {
    violations.push({ rule: { id: 'GOV-003', description: 'Output below dust limit', severity: 'hard' },
      detail: `${amount_sats} sats is below the 546 sat dust limit.` });
  }
  if (amount_sats > total_vault_sats) {
    violations.push({ rule: { id: 'GOV-004', description: 'Insufficient vault balance', severity: 'hard' },
      detail: `Spend ${amount_sats} sats exceeds vault balance ${total_vault_sats} sats.` });
  }
  if (total_vault_sats > 0 && amount_sats > total_vault_sats / 2) {
    warnings.push({ rule: { id: 'GOV-005', description: 'Large spend (>50% of vault)', severity: 'soft' },
      detail: `Spending ${((amount_sats / total_vault_sats) * 100).toFixed(1)}% of vault balance.` });
  }
  if (path === 'inheritance') {
    notes.push({ rule: { id: 'GOV-006', description: 'Inheritance path active', severity: 'info' },
      detail: 'This spend uses the heir inheritance path.' });
  }

  const missing = Math.max(0, required - signed);
  const pending = signers.filter(s => !s.signed).map(s => s.index);

  return {
    audit: { violations, warnings, notes, approved: violations.length === 0 },
    evaluation: {
      allowed: timelock_ok && quorum_ok,
      path,
      required_signers: required,
      provided_signers: signed,
      missing_signers: missing,
      timelock_satisfied: timelock_ok,
      quorum_satisfied: quorum_ok,
      pending_signer_indices: pending,
      reason: violations.length > 0 ? violations[0].detail : `Valid. ${signed} of ${required} signatures collected.`,
    },
    next_action: {
      ready_to_broadcast: timelock_ok && quorum_ok,
      signer_index: pending[0] ?? null,
      instruction: timelock_ok && quorum_ok
        ? 'All signatures collected. Ready to broadcast.'
        : !timelock_ok ? violations[0]?.detail
        : `Waiting for signer #${(pending[0] ?? 0) + 1} to sign.`,
    },
  };
}

// ── Leaf-list governance (2026-08-25) ────────────────────────────────────────
// Genuinely correct for a leaf-list vault, not a degraded fallback -- the
// Rust compiler endpoints have no leaves field to forward this vault's real
// structure through (see the leafList branch in handler() above), so this
// runs unconditionally for that shape rather than ever building a
// named-field policyBase from bogus DB defaults.

export function jsGovernanceStatusLeafList(vault, utxo_age_blocks) {
  const paths = getSpendingPaths(vault).map((p) => {
    // 'older' is relative to the SPENT UTXO's own confirmation height,
    // not the chain tip alone -- not evaluable from utxo_age_blocks here,
    // same honest limitation VaultDetail.tsx's buildVaultLeaves already
    // documents for this leaf type.
    const unlocked = p.unlockType === 'immediate' ? true
      : p.unlockType === 'after' ? utxo_age_blocks >= p.unlockBlocks
      : false;
    return {
      id: p.id, label: p.label, quorum: p.quorum, key_count: p.keyCount,
      unlock_type: p.unlockType, unlock_blocks: p.unlockBlocks, unlocked,
      blocks_until_unlock: p.unlockType === 'after' && !unlocked ? p.unlockBlocks - utxo_age_blocks : null,
    };
  });
  const active_paths = paths.filter((p) => p.unlocked).map((p) => p.id);
  const allUnlocked = paths.length > 0 && paths.every((p) => p.unlocked);

  return {
    current_block: utxo_age_blocks,
    active_paths,
    paths,
    phase: allUnlocked ? 'all_unlocked' : 'active',
    status_label: allUnlocked
      ? 'All paths unlocked.'
      : `${active_paths.length} of ${paths.length} paths currently spendable.`,
  };
}

export function jsGovernanceAuditLeafList(vault, { path, amount_sats, destination, utxo_age_blocks, total_vault_sats, signers }) {
  const resolved = findSpendingPath(vault, path);
  const violations = [];
  const warnings = [];
  const notes = [];

  if (!resolved) {
    violations.push({ rule: { id: 'GOV-000', description: 'Unknown spending path', severity: 'hard' },
      detail: `"${path}" is not a real leaf on this vault.` });
  }

  const timelock_ok = !resolved ? false
    : resolved.unlockType === 'immediate' ? true
    : resolved.unlockType === 'after' ? utxo_age_blocks >= resolved.unlockBlocks
    : false; // 'older' -- see jsGovernanceStatusLeafList's note above.

  const required = resolved ? resolved.quorum : 0;
  const signed = signers.filter((s) => s.signed).length;
  const quorum_ok = !!resolved && signed >= required;

  if (resolved && !timelock_ok) {
    if (resolved.unlockType === 'older') {
      notes.push({ rule: { id: 'GOV-001', description: 'Relative timelock not evaluable here', severity: 'info' },
        detail: "This path unlocks relative to the spent UTXO's own confirmation height, which this audit does not have -- check on-chain directly." });
    } else {
      const needed = resolved.unlockBlocks - utxo_age_blocks;
      violations.push({ rule: { id: 'GOV-001', description: 'Timelock not satisfied', severity: 'hard' },
        detail: `Current chain height ${utxo_age_blocks} is below the unlock height. Needs ${needed} more blocks (~${Math.round(needed / BLOCKS_PER_DAY)} days).` });
    }
  }
  if (resolved && !quorum_ok) {
    violations.push({ rule: { id: 'GOV-002', description: 'Quorum not satisfied', severity: 'hard' },
      detail: `Need ${required} signatures, have ${signed}.` });
  }
  if (amount_sats < 546) {
    violations.push({ rule: { id: 'GOV-003', description: 'Output below dust limit', severity: 'hard' },
      detail: `${amount_sats} sats is below the 546 sat dust limit.` });
  }
  if (amount_sats > total_vault_sats) {
    violations.push({ rule: { id: 'GOV-004', description: 'Insufficient vault balance', severity: 'hard' },
      detail: `Spend ${amount_sats} sats exceeds vault balance ${total_vault_sats} sats.` });
  }
  if (total_vault_sats > 0 && amount_sats > total_vault_sats / 2) {
    warnings.push({ rule: { id: 'GOV-005', description: 'Large spend (>50% of vault)', severity: 'soft' },
      detail: `Spending ${((amount_sats / total_vault_sats) * 100).toFixed(1)}% of vault balance.` });
  }

  const missing = Math.max(0, required - signed);
  const pending = signers.filter((s) => !s.signed).map((s) => s.index);
  const allowed = !!resolved && timelock_ok && quorum_ok;

  return {
    audit: { violations, warnings, notes, approved: violations.length === 0 },
    evaluation: {
      allowed,
      path,
      required_signers: required,
      provided_signers: signed,
      missing_signers: missing,
      timelock_satisfied: timelock_ok,
      quorum_satisfied: quorum_ok,
      pending_signer_indices: pending,
      reason: violations.length > 0 ? violations[0].detail : (allowed ? `Valid. ${signed} of ${required} signatures collected.` : 'Not ready.'),
    },
    next_action: {
      ready_to_broadcast: allowed,
      signer_index: pending[0] ?? null,
      instruction: allowed
        ? 'All signatures collected. Ready to broadcast.'
        : !resolved ? `Unknown path "${path}".`
        : !timelock_ok ? (violations[0]?.detail ?? 'Timelock not satisfied.')
        : `Waiting for signer #${(pending[0] ?? 0) + 1} to sign.`,
    },
  };
}
