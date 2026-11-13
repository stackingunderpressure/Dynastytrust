// Bitcoin Core on this computer, for the download build: tip, a vault's
// coins and balance, fee estimates, transaction status, broadcast. Every
// call goes through the desktop shell's narrow `bitcoin_rpc` (allow-list,
// Core's own login file; desktop/src-tauri/src/main.rs).
//
// Each vault is watched by its OWN watch-only Core wallet, named
// `dynastytrust-<first 16 hex of SHA-256(descriptor)>`, created blank with no
// private keys and fed the vault's descriptor -- which works on any network
// (the address format is Core's; the script is the vault's). Core never holds
// a key and cannot spend.

import { sha256 } from '@noble/hashes/sha2';
import { desktopInvoke } from '../download';

export interface CoreConn { network: string; datadir?: string | null; port?: number | null }

const CONN_KEY = 'dt:coreConnection:v1';
/** Where Core is: by default the vault's own network; a private test chain
 *  ('regtest') or a different folder/port can be set on this computer. */
export function coreConnFor(vaultNetwork: string): CoreConn {
  try {
    const saved = JSON.parse(localStorage.getItem(CONN_KEY) || 'null') as Partial<CoreConn> | null;
    if (saved && typeof saved.network === 'string') return { network: saved.network, datadir: saved.datadir ?? null, port: saved.port ?? null };
  } catch { /* fall through to the default */ }
  return { network: vaultNetwork === 'mainnet' ? 'bitcoin' : vaultNetwork };
}
export function saveCoreConn(conn: CoreConn | null): void {
  try {
    if (conn) localStorage.setItem(CONN_KEY, JSON.stringify(conn));
    else localStorage.removeItem(CONN_KEY);
  } catch { /* private storage off: the default is used */ }
}

export async function rpc<T = unknown>(conn: CoreConn, method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  return (await desktopInvoke('bitcoin_rpc', { conn, method, params, wallet: wallet ?? null })) as T;
}

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
export function walletNameFor(descriptor: string): string {
  return 'dynastytrust-' + hex(sha256(new TextEncoder().encode(descriptor.trim().split('#')[0]))).slice(0, 16);
}

const ready = new Set<string>();
/**
 * Make sure Core is watching this vault: load its wallet, or create it
 * (blank, watch-only) and import the descriptor. `since` is how far back
 * Core should look for coins: 'now' for a vault compiled moments ago,
 * a unix time (or 0 for the whole chain) for an older one.
 */
export async function ensureWatched(conn: CoreConn, descriptor: string, since: number | 'now' = 0): Promise<string> {
  const name = walletNameFor(descriptor);
  const key = `${conn.network}:${conn.datadir ?? ''}:${name}`;
  if (ready.has(key)) return name;
  const loaded = await rpc<string[]>(conn, 'listwallets');
  if (!loaded.includes(name)) {
    try {
      await rpc(conn, 'loadwallet', [name]);
    } catch {
      await rpc(conn, 'createwallet', [name, true, true]);
      const body = descriptor.trim().split('#')[0];
      const info = await rpc<{ descriptor: string }>(conn, 'getdescriptorinfo', [body]);
      const res = await rpc<{ success: boolean; error?: { message: string } }[]>(conn, 'importdescriptors', [[{ desc: info.descriptor, timestamp: since, active: false, internal: false }]], name);
      if (!res[0]?.success) throw new Error(`Bitcoin Core could not watch this vault: ${res[0]?.error?.message ?? 'unknown reason'}`);
    }
  }
  ready.add(key);
  return name;
}

export interface CoreCoin { txid: string; vout: number; value: number; confirmed: boolean; scriptPubKey: string; confirmations: number }

/** The vault's coins as Core sees them, including unconfirmed ones. */
export async function vaultCoins(conn: CoreConn, descriptor: string): Promise<CoreCoin[]> {
  const w = await ensureWatched(conn, descriptor);
  const list = await rpc<{ txid: string; vout: number; amount: number; confirmations: number; scriptPubKey: string }[]>(conn, 'listunspent', [0], w);
  return list.map(u => ({
    txid: u.txid, vout: u.vout,
    // Core reports BTC as a decimal; round to whole sats.
    value: Math.round(u.amount * 1e8),
    confirmed: u.confirmations > 0, confirmations: u.confirmations, scriptPubKey: u.scriptPubKey,
  }));
}

export async function tipHeight(conn: CoreConn): Promise<number> {
  return rpc<number>(conn, 'getblockcount');
}

/**
 * Core's fee estimate in sat/vB for confirmation in about `blocks` blocks,
 * or null when Core has no estimate yet (a fresh node, a test chain). Never
 * a silent made-up rate: the caller says so and asks for one.
 */
export async function feeRate(conn: CoreConn, blocks = 3): Promise<number | null> {
  const r = await rpc<{ feerate?: number; errors?: string[] }>(conn, 'estimatesmartfee', [blocks]);
  if (typeof r.feerate !== 'number' || !(r.feerate > 0)) return null;
  // BTC per 1,000 vbytes -> sat per vbyte, at least 1.
  return Math.max(1, Math.ceil(r.feerate * 1e5));
}

export async function broadcast(conn: CoreConn, rawHex: string): Promise<string> {
  return rpc<string>(conn, 'sendrawtransaction', [rawHex]);
}

/** Status of a transaction this vault's wallet knows about. */
export async function txStatus(conn: CoreConn, descriptor: string, txid: string): Promise<{ confirmed: boolean; block_height?: number; confirmations: number }> {
  const w = await ensureWatched(conn, descriptor);
  const t = await rpc<{ confirmations: number; blockheight?: number }>(conn, 'gettransaction', [txid, true], w);
  return { confirmed: t.confirmations > 0, block_height: t.blockheight, confirmations: Math.max(0, t.confirmations) };
}
