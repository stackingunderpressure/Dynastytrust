/**
 * GET /api/balance?address=<btc_address>&network=testnet|bitcoin
 *
 * Fetches balance and UTXO summary from mempool.space.
 * Also fetches current BTC/USD price to show fiat value.
 * No auth required — address is public info.
 *
 * GET /api/balance?vault_id=<uuid>  (signed in; the vault's owner or a member)
 * The whole vault: for a v2 vault ("a new address every time") the sum over
 * every one of its addresses (_vault-coins.js). Behind sign-in because the
 * list of a v2 vault's addresses is exactly what fresh addresses keep private.
 */

import { json, requireUser } from './_auth.js';
import { MEMPOOL, mempoolFetch } from './_chain.js';
import { getSupabaseAdmin } from './_supabase.js';
import { canSeeVault, nextIndexes, vaultCoins, watchedAddresses } from './_vault-coins.js';
import { userServersFrom } from './_electrum.js';

async function btcPrice(network) {
  if (network !== 'bitcoin') return null;
  try {
    const price = await mempoolFetch('https://mempool.space/api/v1/prices');
    return price?.USD || null;
  } catch { return null; }
}

async function vaultBalance(event, vaultId) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });
  if (!/^[0-9a-f-]{36}$/i.test(vaultId)) return json(400, { error: 'Invalid vault_id' });
  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase
    .from('vaults')
    .select('id, user_id, address, network, descriptor_version, descriptor_multipath, descriptor_receive, descriptor_change')
    .eq('id', vaultId)
    .maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!vault || !(await canSeeVault(supabase, vault, u.userId))) return json(404, { error: 'Vault not found' });
  if (!vault.address) return json(400, { error: 'This vault has no address yet' });
  const network = vault.network || 'testnet';
  try {
    const watched = watchedAddresses(vault, vault.descriptor_version === 2 ? await nextIndexes(supabase, vault.id) : undefined);
    // One scan serves both the balance and the coins card (2026-11-24: two
    // scans per page view got the server refused by mempool.space).
    // Electrum when there is a server for this network (the person's own, or
    // the default), else the website (_vault-coins.js vaultCoins).
    const { coins, tip, source } = await vaultCoins(network, watched, userServersFrom(event));
    const confirmed_sats = coins.filter(c => c.status?.confirmed).reduce((n, c) => n + (c.value || 0), 0);
    const unconfirmed_sats = coins.filter(c => !c.status?.confirmed).reduce((n, c) => n + (c.value || 0), 0);
    const total_sats = confirmed_sats + unconfirmed_sats;
    const btc_price_usd = await btcPrice(network);
    const btc_amount = total_sats / 1e8;
    return json(200, {
      ok: true,
      address: vault.address,
      network,
      confirmed_sats,
      unconfirmed_sats,
      total_sats,
      btc_amount,
      btc_price_usd,
      usd_value: btc_price_usd ? btc_amount * btc_price_usd : null,
      utxo_count: coins.length,
      confirmed_utxos: coins.filter(c => c.status?.confirmed).length,
      mempool_url: `${(MEMPOOL[network] || MEMPOOL.testnet).replace(/\/api$/, '')}/address/${vault.address}`,
      tx_count: coins.length,
      addresses_watched: watched.length,
      source,
      tip: typeof tip === 'number' ? tip : null,
      // The same shape utxos.js answers, so the coins card needs no second scan.
      coins: coins.map(c => {
        const confirmed = !!c.status?.confirmed;
        const block_height = c.status?.block_height ?? null;
        return {
          txid: c.txid, vout: c.vout, value_sats: c.value, confirmed,
          block_height, block_time: c.status?.block_time ?? null,
          confirmations: confirmed && block_height != null && typeof tip === 'number' ? Math.max(0, tip - block_height + 1) : 0,
          address: c.address, branch: c.branch, index: c.index,
        };
      }).sort((a, b) => b.value_sats - a.value_sats),
    });
  } catch (err) {
    console.error('Vault balance error:', err);
    return json(502, { error: 'Could not fetch balance: ' + err.message });
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const vaultId = event.queryStringParameters?.vault_id;
  if (vaultId) return vaultBalance(event, vaultId);

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
