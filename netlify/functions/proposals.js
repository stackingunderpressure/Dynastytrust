/**
 * /api/proposals
 *
 * GET  ?vault_id=<uuid>   — list proposals for a vault
 * POST                    — create a new proposal (runs governance audit)
 * PATCH ?id=<uuid>        — update status, add signed PSBT, mark broadcast
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';
import { fetchTipHeight, MEMPOOL, mempoolFetch } from './_chain.js';
import { checkNumberBounds, MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB } from './_numeric.js';
import { isLeafListVault } from './_vault-shape.js';
import { jsGovernanceAuditLeafList } from './governance.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

// Bech32/bech32m addresses (every bc1.../tb1... address, which is every
// Taproot destination this app ever compiles to) are case-insensitive by
// spec (BIP173/BIP350) -- mempool.space always returns them lowercase, but
// nothing upstream of this file normalizes a pasted/typed destination
// before it's stored on the proposal. A strict === comparison then fails
// for a perfectly valid, correctly-broadcast transaction the moment the
// stored destination's casing differs at all (e.g. an uppercase-for-QR
// address some wallets show), leaving the proposal stuck at status
// 'pending' forever even though the money already moved. Legacy base58
// (1.../3...) addresses are genuinely case-sensitive -- lowercasing those
// would corrupt them -- so normalization only applies when BOTH sides look
// like bech32.
const BECH32_LIKE = /^(bc1|tb1|bcrt1)[a-z0-9]+$/i;
function addressesMatch(a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (BECH32_LIKE.test(a) && BECH32_LIKE.test(b)) return a.toLowerCase() === b.toLowerCase();
  return false;
}

// A proposal's real lifecycle, gathered from every place status is
// written across this app: created draft (no psbt yet) or pending
// (psbt attached) -> psbt-merge.js bumps to signed once quorum is
// met -> the UI moves it to broadcast (with a txid) or cancelled, or
// (tranche claims filed as proposals) fulfilled.
const VALID_STATUSES = ['draft', 'pending', 'signed', 'broadcast', 'cancelled', 'fulfilled'];
// Once a proposal reaches one of these it's the permanent record of
// what happened -- the audit PDF and activity export both read
// straight from this table. Without this guard, PATCH allowed any
// active vault member to rewrite status/psbt_hex/txid after the fact
// with no state-transition check at all: silently reverting a
// broadcast back to draft to hide it, or swapping in a fake txid,
// or overwriting the PSBT bytes behind a spend that already went out.
const TERMINAL_STATUSES = ['broadcast', 'cancelled', 'fulfilled'];

async function runGovernanceAudit(vault, proposal) {
  // 2026-08-25 fix: the Rust /governance/audit endpoint only recognizes
  // "founders_now"/"recovery"/"inheritance" as `path` and has no leaves
  // field -- a leaf-list vault's proposal.path is always a real leaf id,
  // which the compiler rejects outright (400), so runGovernanceAudit
  // silently returned null for every leaf-list-vault proposal ever
  // created, permanently baking an uninformative governance_audit into
  // the audit-trail record proposals.js's own header comment says this
  // table is. jsGovernanceAuditLeafList (governance.js) is genuinely
  // correct for this shape -- same reason governance.js's own handler
  // routes a leaf-list vault there instead of the compiler.
  if (isLeafListVault(vault)) {
    return jsGovernanceAuditLeafList(vault, {
      path: proposal.path,
      amount_sats: proposal.amount_sats,
      destination: proposal.destination,
      utxo_age_blocks: proposal.utxo_age_blocks || 0,
      total_vault_sats: proposal.total_vault_sats || 0,
      signers: [],
    });
  }

  const body = {
    founder_quorum:    vault.founder_quorum,
    founder_key_count: (vault.founder_keys || []).length,
    heir_quorum:       vault.heir_quorum,
    heir_key_count:    (vault.heir_keys || []).length,
    recovery_after:    vault.recovery_after,
    inheritance_after: vault.inheritance_after,
    path:              proposal.path,
    amount_sats:       proposal.amount_sats,
    destination:       proposal.destination,
    // Legacy field name: this is the CURRENT CHAIN TIP HEIGHT (absolute), not
    // UTXO age. Timelocks are absolute CLTV; the engine compares it to the
    // stored absolute unlock heights. Pass the chain tip, never UTXO age.
    utxo_age_blocks:   proposal.utxo_age_blocks || 0,
    total_vault_sats:  proposal.total_vault_sats || 0,
    signers:           [],  // no signatures yet on creation
  };

  if (!COMPILER_URL) return null;

  try {
    const res = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/governance/audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // ── GET: list proposals ──────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const vault_id = event.queryStringParameters?.vault_id;
    if (!vault_id) return json(400, { error: 'Missing: vault_id' });

    // Caller must be an active member of the vault (or its creator).
    const { data: membership } = await supabase
      .from('vault_members')
      .select('id')
      .eq('vault_id', vault_id)
      .eq('user_id', u.userId)
      .eq('status', 'active')
      .maybeSingle();
    if (!membership) return json(403, { error: 'Not a member of this vault' });

    const { data, error } = await supabase
      .from('proposals')
      .select(`
        *,
        signer_sessions (id, signer_index, signer_role, label, signed, signed_at, fingerprint, member_id)
      `)
      .eq('vault_id', vault_id)
      .order('created_at', { ascending: false });

    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, proposals: data });
  }

  // ── POST: create proposal ────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const { vault_id, path = 'founders_now', destination, amount_sats, fee_sats = 0,
            fee_rate, utxo_age_blocks = 0, total_vault_sats = 0, memo, psbt_hex, psbt_b64,
            distribution_wallet_id = null, tranche_index = null } = body;

    if (!vault_id)    return json(400, { error: 'Missing: vault_id' });
    if (!destination) return json(400, { error: 'Missing: destination' });
    // checkNumberBounds requires a real finite number before comparing --
    // the previous `!x || x < 546` check let NaN/Infinity/non-numeric
    // strings through silently (both comparisons evaluate false for
    // them). This matters more here than at the PSBT-building endpoints:
    // there is no Rust compiler in this endpoint's path to catch a bad
    // value downstream -- amount_sats/fee_sats/fee_rate are written
    // directly to the proposals table, which the audit PDF, tax
    // summary, and activity export all treat as the permanent record of
    // what happened (Kimi K3 scan Family D).
    const amountErr = checkNumberBounds(amount_sats, { field: 'amount_sats', min: 546, max: Number.MAX_SAFE_INTEGER, integer: true });
    if (amountErr) return json(400, { error: amountErr });
    if (fee_sats !== 0) {
      const feeSatsErr = checkNumberBounds(fee_sats, { field: 'fee_sats', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
      if (feeSatsErr) return json(400, { error: feeSatsErr });
    }
    if (fee_rate != null) {
      const feeRateErr = checkNumberBounds(fee_rate, { field: 'fee_rate', min: MIN_FEE_RATE_SAT_VB, max: MAX_FEE_RATE_SAT_VB });
      if (feeRateErr) return json(400, { error: feeRateErr });
    }
    if (utxo_age_blocks !== 0) {
      const utxoAgeErr = checkNumberBounds(utxo_age_blocks, { field: 'utxo_age_blocks', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
      if (utxoAgeErr) return json(400, { error: utxoAgeErr });
    }
    if (total_vault_sats !== 0) {
      const totalSatsErr = checkNumberBounds(total_vault_sats, { field: 'total_vault_sats', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
      if (totalSatsErr) return json(400, { error: totalSatsErr });
    }

    // Load vault. Any active member may propose a spend, not just
    // the owner -- same membership check GET/PATCH already use.
    const { data: vault } = await supabase
      .from('vaults')
      .select('*')
      .eq('id', vault_id)
      .maybeSingle();

    if (!vault) return json(404, { error: 'Vault not found' });

    const { data: membership } = await supabase
      .from('vault_members')
      .select('id')
      .eq('vault_id', vault_id)
      .eq('user_id', u.userId)
      .eq('status', 'active')
      .maybeSingle();
    if (!membership) return json(403, { error: 'Not a member of this vault' });

    // Run governance audit
    const audit = await runGovernanceAudit(vault, { path, destination, amount_sats, utxo_age_blocks, total_vault_sats });

    const { data: proposal, error: propErr } = await supabase
      .from('proposals')
      .insert({
        vault_id, user_id: u.userId,
        path, destination, amount_sats, fee_sats,
        fee_rate, utxo_age_blocks, total_vault_sats, memo,
        psbt_hex:  psbt_hex  || null,
        psbt_b64:  psbt_b64  || null,
        status:    psbt_hex ? 'pending' : 'draft',
        governance_audit: audit,
        distribution_wallet_id, tranche_index,
      })
      .select()
      .single();

    if (propErr) return json(500, { error: propErr.message });

    // Log event
    await supabase.from('vault_events').insert({
      vault_id, user_id: u.userId,
      event_type: 'psbt_generated',
      metadata: { proposal_id: proposal.id, path, amount_sats, destination },
    });

    return json(201, { ok: true, proposal, governance_audit: audit });
  }

  // ── PATCH: update proposal ───────────────────────────────────────────────
  if (event.httpMethod === 'PATCH') {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: 'Missing: ?id=<proposal-uuid>' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const allowed = ['status', 'psbt_hex', 'psbt_b64', 'psbt_signed_hex', 'txid', 'memo'];
    const updates = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

    if (!Object.keys(updates).length) return json(400, { error: 'No valid fields to update' });

    if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
      return json(400, { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    // Any active member of the proposal's vault can PATCH. Creator-only
    // was too restrictive once quorum is collected by co-signers.
    const { data: existing } = await supabase
      .from('proposals')
      .select('vault_id, status, destination, amount_sats')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return json(404, { error: 'Proposal not found' });

    // Once a proposal is broadcast/cancelled/fulfilled it's the
    // permanent record of what happened -- the audit PDF and activity
    // export read straight from it. Only memo (a harmless annotation)
    // stays editable past that point; every other field is locked.
    if (TERMINAL_STATUSES.includes(existing.status)) {
      const lockedFieldsTouched = Object.keys(updates).some((k) => k !== 'memo');
      if (lockedFieldsTouched) {
        return json(409, {
          error: `This proposal is already ${existing.status} and its record is locked. Only memo may still be edited.`,
        });
      }
    }

    const { data: membership } = await supabase
      .from('vault_members')
      .select('id')
      .eq('vault_id', existing.vault_id)
      .eq('user_id', u.userId)
      .eq('status', 'active')
      .maybeSingle();
    if (!membership) return json(403, { error: 'Not a member of this vault' });

    // Transitioning to 'broadcast' declares a spend final -- the audit
    // PDF and activity export read this row as the permanent record.
    // Previously any active member could set status='broadcast' with a
    // fabricated txid and nothing checked it was real (Kimi K3 scan
    // #25). Require a real, well-formed txid and verify against
    // mempool.space that it actually pays this proposal's own
    // destination/amount before accepting the transition.
    if (updates.status === 'broadcast') {
      const txid = updates.txid;
      if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
        return json(400, { error: 'txid must be a 64-char hex transaction id to mark a proposal broadcast' });
      }
      const { data: v } = await supabase
        .from('vaults')
        .select('network')
        .eq('id', existing.vault_id)
        .maybeSingle();
      const base = MEMPOOL[v?.network] || MEMPOOL.testnet;
      let tx;
      try {
        tx = await mempoolFetch(`${base}/tx/${txid}`);
      } catch (e) {
        return json(400, { error: `Could not find transaction ${txid} on ${v?.network || 'testnet'}: ${e.message}` });
      }
      const paysDestination = (tx.vout || []).some(
        (out) => addressesMatch(out.scriptpubkey_address, existing.destination) && out.value === existing.amount_sats,
      );
      if (!paysDestination) {
        return json(400, {
          error: `Transaction ${txid} does not pay this proposal's destination (${existing.destination}) with the expected amount (${existing.amount_sats} sats) -- refusing to mark broadcast.`,
        });
      }
    }

    const { data: updated, error: upErr } = await supabase
      .from('proposals')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (upErr) return json(500, { error: upErr.message });

    // Log status transitions. Stamp chain tip best-effort so
    // broadcast events correlate with on-chain position in the
    // activity export / audit PDF. Falls back to null on fetch
    // failure -- not worth failing the write over.
    if (updates.status) {
      let blockHeight = null;
      if (updates.status === 'broadcast') {
        try {
          const { data: v } = await supabase
            .from('vaults')
            .select('network')
            .eq('id', updated.vault_id)
            .maybeSingle();
          if (v?.network) blockHeight = await fetchTipHeight(v.network);
        } catch {
          /* non-fatal */
        }
      }
      await supabase.from('vault_events').insert({
        vault_id: updated.vault_id, user_id: u.userId,
        // event_type used to be hardcoded to 'signed' whenever status
        // became 'broadcast' -- a proposal that was actually broadcast
        // to the network got logged in the audit trail as merely
        // "signed", understating what really happened. The status
        // string itself is the real, distinct event now.
        event_type: updates.status,
        metadata: { proposal_id: id, txid: updates.txid || null },
        block_height: blockHeight,
      });
    }

    return json(200, { ok: true, proposal: updated });
  }

  return json(405, { error: 'Method not allowed' });
}
