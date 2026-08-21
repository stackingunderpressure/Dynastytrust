/**
 * /api/liveness
 *
 * Verified ingest + read of liveness signals (proof-of-life heartbeats and
 * duress flags) that feed the fail-closed signing gate's liveness axis.
 *
 *   POST { vault_id, kind, signal }
 *     Verify the signed signal via verifyLivenessSignalForStorage (real BIP340
 *     Schnorr check, delegated to tapit-attest). On ok, store it; on not-ok,
 *     return 400 and store NOTHING. A latest proof-of-life per subject replaces
 *     the prior one; duress flags accumulate.
 *
 *   GET ?vault_id=<uuid>
 *     Return the vault's held signals shaped for assembleLivenessGateInput:
 *       { proofs: { <subject>: ProofOfLife }, redFlags: DuressFlag[] }
 *     Only an active member/owner of the vault may read.
 *
 * SECURITY: the verify-on-write gate is the wall -- an unverifiable signal
 * never reaches the store and therefore never reaches the gate. RLS protects
 * reads; writes go through this service-role function only. No private key
 * material exists in this path (signals are public pubkeys + signatures); the
 * function never logs signal contents.
 *
 * FINAL SEAM -- WIRED (2026-08-06):
 *   At sign time in apps/web VaultDetail's confirmSign(), this is exactly
 *   what happens: GET this endpoint's signals for the vault, call
 *   loadVaultLivenessConfig(vault) (from _liveness.js) to get the circle +
 *   requiredGreenByPath + ttlSeconds, call assembleLivenessGateInput({
 *   config, path, proofs, redFlags }) (from apps/web/src/lib/liveness-gate.ts),
 *   and pass the result as the `liveness` field into evaluateSigningGate
 *   alongside the ceremony / psbt-binding / governance inputs. The gate
 *   denies LIVENESS_RED / LIVENESS_NOT_GREEN for real. A failed fetch of
 *   this endpoint is treated as fail-closed (blocks signing) by the caller,
 *   not as "no liveness circle" -- see liveness-gate.ts's header for why.
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';
import { verifyLivenessSignalForStorage, loadVaultLivenessConfig } from './_liveness.js';

/** Active member/owner check (owners are auto-seeded as active members). */
async function isActiveMember(supabase, vaultId, userId) {
  const { data } = await supabase
    .from('vault_members')
    .select('id')
    .eq('vault_id', vaultId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return Boolean(data);
}

async function isOwner(supabase, vaultId, userId) {
  const { data } = await supabase
    .from('vaults')
    .select('id')
    .eq('id', vaultId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(data);
}

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // -- GET: read the vault's held signals, shaped for the gate-input assembler.
  if (event.httpMethod === 'GET') {
    const vault_id = event.queryStringParameters?.vault_id;
    if (!vault_id) return json(400, { error: 'Missing: vault_id' });

    if (!(await isActiveMember(supabase, vault_id, u.userId))) {
      return json(403, { error: 'Not a member of this vault' });
    }

    const { data, error } = await supabase
      .from('liveness_signals')
      .select('subject, kind, signal, created_at')
      .eq('vault_id', vault_id)
      .order('created_at', { ascending: true });

    if (error) return json(500, { error: error.message });

    // Shape for assembleLivenessGateInput: latest proof-of-life per subject,
    // and the flat list of duress flags. Rows arrive oldest-first, so a later
    // proof for a subject naturally overwrites an earlier one.
    const proofs = {};
    const redFlags = [];
    for (const row of data || []) {
      if (row.kind === 'proof-of-life') {
        proofs[row.subject] = row.signal;
      } else if (row.kind === 'duress-flag') {
        redFlags.push(row.signal);
      }
    }

    // Resolve the vault's liveness config server-side (the caller should
    // not have to duplicate loadVaultLivenessConfig's validation). null
    // when the vault has none configured -- the safe "not liveness-gated"
    // default, never a fabricated green.
    const { data: vault } = await supabase
      .from('vaults')
      .select('bloc_policy')
      .eq('id', vault_id)
      .maybeSingle();
    const config = loadVaultLivenessConfig(vault || {});

    return json(200, { ok: true, proofs, redFlags, config });
  }

  // -- POST: verify-on-write then store.
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }

    const { vault_id, kind, signal } = body;
    if (!vault_id) return json(400, { error: 'Missing: vault_id' });

    if (!(await isActiveMember(supabase, vault_id, u.userId))) {
      return json(403, { error: 'Not a member of this vault' });
    }

    // THE WALL: verify the signature before anything is stored. A forged,
    // tampered, unsigned, wrong-kind, or garbage signal stops here with 400 and
    // is never written.
    const verdict = verifyLivenessSignalForStorage({ kind, signal });
    if (!verdict.ok) {
      return json(400, { error: `Signal rejected: ${verdict.error}` });
    }

    const { subject, raisedBy } = verdict;

    if (kind === 'proof-of-life') {
      // Latest heartbeat per subject replaces the prior one: delete any
      // existing proof-of-life for this (vault, subject), then insert.
      const { error: delErr } = await supabase
        .from('liveness_signals')
        .delete()
        .eq('vault_id', vault_id)
        .eq('subject', subject)
        .eq('kind', 'proof-of-life');
      if (delErr) return json(500, { error: delErr.message });
    }

    const { data: inserted, error: insErr } = await supabase
      .from('liveness_signals')
      .insert({ vault_id, subject, kind, signal, raised_by: raisedBy })
      .select('id, subject, kind, created_at')
      .single();

    if (insErr) return json(500, { error: insErr.message });

    return json(201, { ok: true, signal: inserted });
  }

  // -- DELETE: owner clears duress-flag rows for a subject.
  // Duress-flag rows never expired or had any removal path (Kimi K3
  // scan #66): any active member could submit one -- the write side
  // above only checks membership + a valid signature, never that the
  // flag's subject/raiser belongs to any particular role -- and every
  // subsequent signing attempt reads it back as LIVENESS_RED, forever.
  // One malicious or stale flag could freeze a vault's spending
  // permanently with no in-band recovery. Clearing is owner-only and
  // deliberately does NOT extend to proof-of-life rows -- those already
  // self-replace on a fresh heartbeat and clearing them would let a
  // compromised owner account forge liveness for someone else.
  if (event.httpMethod === 'DELETE') {
    const vault_id = event.queryStringParameters?.vault_id;
    const subject = event.queryStringParameters?.subject;
    if (!vault_id) return json(400, { error: 'Missing: vault_id' });
    if (!subject) return json(400, { error: 'Missing: subject' });

    if (!(await isOwner(supabase, vault_id, u.userId))) {
      return json(403, { error: 'Only the vault owner can clear a duress flag' });
    }

    const { error } = await supabase
      .from('liveness_signals')
      .delete()
      .eq('vault_id', vault_id)
      .eq('subject', subject)
      .eq('kind', 'duress-flag');
    if (error) return json(500, { error: error.message });

    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
}
