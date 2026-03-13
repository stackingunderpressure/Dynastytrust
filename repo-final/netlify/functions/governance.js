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
    .select('id, name, network, founder_quorum, heir_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, address')
    .eq('id', vault_id)
    .eq('user_id', u.userId)
    .single();

  if (vaultErr || !vault) return json(404, { error: 'Vault not found' });

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

    if (!amount_sats) return json(400, { error: 'Missing: amount_sats' });
    if (!destination) return json(400, { error: 'Missing: destination' });

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

const BLOCKS_PER_DAY = 144;

function jsGovernanceStatus(policy, utxo_age_blocks) {
  const recovery_unlocked    = utxo_age_blocks >= policy.recovery_after;
  const inheritance_unlocked = utxo_age_blocks >= policy.inheritance_after;

  const active_paths = ['founders_now'];
  if (recovery_unlocked)    active_paths.push('recovery');
  if (inheritance_unlocked) active_paths.push('inheritance');

  const phase = inheritance_unlocked ? 'inheritance_unlocked'
    : recovery_unlocked ? 'recovery_unlocked'
    : 'active';

  const blocks_until_recovery    = recovery_unlocked    ? null : policy.recovery_after - utxo_age_blocks;
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
      ? `Active — founders can spend. Recovery unlocks in ~${Math.round(blocks_until_recovery / BLOCKS_PER_DAY)} days.`
      : phase === 'recovery_unlocked'
      ? `Recovery path unlocked. Inheritance unlocks in ~${Math.round(blocks_until_inheritance / BLOCKS_PER_DAY)} days.`
      : 'All paths unlocked. Founders and heirs can spend.',
  };
}

function jsGovernanceAudit(policy, { path, amount_sats, destination, utxo_age_blocks, total_vault_sats, signers }) {
  const timelock_ok = path === 'founders_now' ? true
    : path === 'recovery'    ? utxo_age_blocks >= policy.recovery_after
    : utxo_age_blocks >= policy.inheritance_after;

  const required = (path === 'inheritance') ? policy.heir_quorum : policy.founder_quorum;
  const signed   = signers.filter(s => s.signed).length;
  const quorum_ok = signed >= required;

  const violations = [];
  const warnings   = [];
  const notes      = [];

  if (!timelock_ok) {
    const needed = path === 'recovery'
      ? policy.recovery_after - utxo_age_blocks
      : policy.inheritance_after - utxo_age_blocks;
    violations.push({ rule: { id: 'GOV-001', description: 'Timelock not satisfied', severity: 'hard' },
      detail: `UTXO age ${utxo_age_blocks} blocks < required. Needs ${needed} more blocks (~${Math.round(needed/BLOCKS_PER_DAY)} days).` });
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
