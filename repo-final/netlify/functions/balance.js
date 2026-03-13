/**
 * GET /api/balance?address=<btc_address>&network=testnet|bitcoin
 *
 * Fetches balance and UTXO summary from mempool.space.
 * Also fetches current BTC/USD price to show fiat value.
 * No auth required — address is public info.
 */

import { json } from './_auth.js';

const MEMPOOL = {
  testnet: 'https://mempool.space/testnet/api',
  bitcoin: 'https://mempool.space/api',
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const address = event.queryStringParameters?.address;
  const network = event.queryStringParameters?.network || 'testnet';

  if (!address) return json(400, { error: 'Missing: address' });

  const base = MEMPOOL[network] || MEMPOOL.testnet;

  try {
    // Fetch address stats and UTXOs in parallel
    const [stats, utxos] = await Promise.all([
      fetchJSON(`${base}/address/${address}`),
      fetchJSON(`${base}/address/${address}/utxo`),
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
        const price = await fetchJSON('https://mempool.space/api/v1/prices');
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
      mempool_url: network === 'bitcoin'
        ? `https://mempool.space/address/${address}`
        : `https://mempool.space/testnet/address/${address}`,
      tx_count: stats.chain_stats?.tx_count || 0,
    });

  } catch (err) {
    console.error('Balance fetch error:', err);
    return json(502, { error: 'Could not fetch balance: ' + err.message });
  }
}
