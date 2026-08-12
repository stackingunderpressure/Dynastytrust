/**
 * GET /api/balance?address=<btc_address>&network=testnet|bitcoin
 *
 * Fetches balance and UTXO summary from mempool.space.
 * Also fetches current BTC/USD price to show fiat value.
 * No auth required — address is public info.
 */

import { json } from './_auth.js';
import { MEMPOOL, mempoolFetch } from './_chain.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const address = event.queryStringParameters?.address;
  const network = event.queryStringParameters?.network || 'testnet';

  if (!address) return json(400, { error: 'Missing: address' });
  // Bitcoin addresses (bech32/bech32m/base58) are alphanumeric only.
  // Without this check, address was interpolated straight into the
  // mempool.space URL path -- a value containing "/", "..", "?", or "#"
  // could redirect this unauthenticated endpoint to a completely
  // different mempool.space API path than /address/*/utxo.
  if (!/^[a-zA-Z0-9]{14,90}$/.test(address)) {
    return json(400, { error: 'Invalid address format' });
  }

  const base = MEMPOOL[network] || MEMPOOL.testnet;

  try {
    // Fetch address stats and UTXOs in parallel
    const [stats, utxos] = await Promise.all([
      mempoolFetch(`${base}/address/${address}`),
      mempoolFetch(`${base}/address/${address}/utxo`),
    ]);

    const confirmed_sats =
      (stats.chain_stats?.funded_txo_sum || 0) -
      (stats.chain_stats?.spent_txo_sum  || 0);

    const unconfirmed_sats =
      (stats.mempool_stats?.funded_txo_sum || 0) -
      (stats.mempool_stats?.spent_txo_sum  || 0);

    const total_sats    = confirmed_sats + unconfirmed_sats;
    const utxo_count    = utxos?.length || 0;
    const confirmed_utxos = (utxos || []).filter(u => u.status?.confirmed).length;

    // Fetch BTC price (mainnet only — testnet BTC has no USD value)
    let btc_price_usd = null;
    if (network === 'bitcoin') {
      try {
        const price = await mempoolFetch('https://mempool.space/api/v1/prices');
        btc_price_usd = price?.USD || null;
      } catch { /* price is optional */ }
    }

    const btc_amount = total_sats / 1e8;
    const usd_value  = btc_price_usd ? btc_amount * btc_price_usd : null;

    return json(200, {
      ok: true,
      address,
      network,
      confirmed_sats,
      unconfirmed_sats,
      total_sats,
      btc_amount,
      btc_price_usd,
      usd_value,
      utxo_count,
      confirmed_utxos,
      // Was hardcoded to the testnet path for anything non-mainnet, so a
      // signet vault's "view on explorer" link silently pointed at
      // testnet.mempool.space -- a page that address never touched --
      // which looks exactly like "no coins ever arrived" even after a
      // real signet send. MEMPOOL already has the correct base per
      // network; reuse it instead of a second, incomplete switch.
      mempool_url: `${(MEMPOOL[network] || MEMPOOL.testnet).replace(/\/api$/, '')}/address/${address}`,
      tx_count: stats.chain_stats?.tx_count || 0,
    });

  } catch (err) {
    console.error('Balance fetch error:', err);
    return json(502, { error: 'Could not fetch balance: ' + err.message });
  }
}
