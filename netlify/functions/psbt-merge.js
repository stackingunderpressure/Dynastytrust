/**
 * POST /api/psbt-merge
 *
 * Merges two or more partially-signed PSBTs into one combined PSBT.
 * Used for multi-signer coordination:
 *   Signer 1 signs PSBT → exports partial
 *   Signer 2 imports partial, signs → exports partial
 *   Coordinator POSTs both to /api/psbt-merge → combined PSBT with both sigs
 *   When quorum is met, broadcast
 *
 * Body:
 *   vault_id    — UUID (for auth + proposal logging)
 *   proposal_id — UUID (optional, updates proposal on success)
 *   psbts       — array of hex-encoded PSBTs to merge
 */

import { requireUser, json } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { vault_id, proposal_id, psbts } = body;

  if (!vault_id) return json(400, { error: 'Missing: vault_id' });
  if (!psbts || psbts.length < 2) return json(400, { error: 'Provide at least 2 PSBTs in the psbts array' });

  // Auth: any active member of the vault may merge PSBTs, not just
  // the owner -- same membership check proposals.js / psbt-binary.js use.
  const supabase = getSupabaseAdmin();
  const { data: vault } = await supabase
    .from('vaults')
    .select('id, name, founder_quorum, heir_quorum')
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

  if (!COMPILER_URL) {
    return json(503, { error: 'COMPILER_URL not configured. Deploy the Fly.io compiler to enable PSBT merging.' });
  }

  try {
    const res = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/psbt-merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify({ psbts }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      return json(res.status, { error: data.error || 'Merge failed' });
    }

    // Update proposal with merged PSBT if proposal_id provided. Scoped
    // by vault_id (already membership-checked above), not user_id --
    // any active member merging signatures may update the shared
    // proposal record, not only whoever originally created it.
    if (proposal_id) {
      const isFullySigned = data.signature_count >= vault.founder_quorum;
      await supabase
        .from('proposals')
        .update({
          psbt_signed_hex: data.psbt_hex,
          status: isFullySigned ? 'signed' : 'pending',
        })
        .eq('id', proposal_id)
        .eq('vault_id', vault_id);

      // Log merge event
      await supabase.from('vault_events').insert({
        vault_id,
        user_id:    u.userId,
        event_type: 'psbt_merged',
        metadata:   { proposal_id, signature_count: data.signature_count, fully_signed: isFullySigned },
      });
    }

    return json(200, {
      ok:              true,
      psbt_hex:        data.psbt_hex,
      psbt_b64:        data.psbt_b64,
      input_count:     data.input_count,
      signature_count: data.signature_count,
      fully_signed:    data.signature_count >= vault.founder_quorum,
    });

  } catch (err) {
    console.error('PSBT merge error:', err);
    return json(502, { error: 'Compiler unreachable: ' + err.message });
  }
}
