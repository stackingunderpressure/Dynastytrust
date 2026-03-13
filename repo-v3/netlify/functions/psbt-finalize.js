/**
 * POST /api/psbt-finalize
 *
 * Finalizes a fully-signed PSBT and returns the raw transaction hex
 * ready for broadcast to mempool.space.
 *
 * mempool.space /api/tx requires raw tx hex, not PSBT hex. This endpoint
 * calls the Rust compiler which uses miniscript::psbt::finalize_mut() to
 * validate signatures meet quorum, assemble the Tapscript witness stack,
 * then extract_tx() to strip the PSBT wrapper.
 *
 * Body:    { psbt_hex: "70736274ff..." }
 * Returns: { ok, raw_tx_hex, txid, input_count, output_count, vbytes }
 */

import { requireUser, json } from './_auth.js';

const COMPILER_URL    = process.env.COMPILER_URL;
const COMPILER_SECRET = process.env.COMPILER_SECRET;

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type' },
    };
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { psbt_hex } = body;

  if (!psbt_hex || typeof psbt_hex !== 'string') {
    return json(400, { error: 'psbt_hex is required' });
  }

  // Validate PSBT magic bytes: 0x70736274ff ("psbt\xff")
  if (!psbt_hex.toLowerCase().startsWith('70736274ff')) {
    return json(400, {
      error: 'Not a valid PSBT. Expected hex starting with 70736274ff. If you have base64, convert it first.',
    });
  }

  if (!COMPILER_URL) {
    return json(503, {
      error: 'COMPILER_URL not configured. Deploy the Rust compiler to Fly.io and add COMPILER_URL to Netlify environment variables.',
    });
  }

  try {
    const res = await fetch(`${COMPILER_URL.replace(/\/$/, '')}/psbt-finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(COMPILER_SECRET ? { Authorization: `Bearer ${COMPILER_SECRET}` } : {}),
      },
      body: JSON.stringify({ psbt_hex }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      return json(res.status >= 500 ? 502 : res.status, {
        error: data.error || 'Finalization failed',
      });
    }

    return json(200, {
      ok:           true,
      raw_tx_hex:   data.raw_tx_hex,
      txid:         data.txid,
      input_count:  data.input_count,
      output_count: data.output_count,
      vbytes:       data.vbytes,
    });

  } catch (err) {
    console.error('psbt-finalize error:', err);
    return json(502, {
      error: `Compiler unreachable: ${err.message}. Check COMPILER_URL and that Fly.io is running.`,
    });
  }
}
