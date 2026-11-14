// The download build's chain data: every request the screens send to
// mempool.space or blockstream.info (lib/chain.ts, the broadcast buttons)
// is answered by Bitcoin Core on this computer instead, in the same shape
// those sites answer, so no screen changes. Installed once at start-up
// (main.tsx) only when DOWNLOAD; the website build never carries it.
//
// Nothing addressed to those sites ever leaves the computer: a question
// this stand-in does not answer gets a plain "not in the download" refusal,
// never a fall-through to the internet.
//
// One honest consequence: lib/chain.ts's verifiedTipHeight asks two
// independent sites and requires them to agree. Here both answers come
// from your own node -- one source, but one that checks every block
// itself (the download's decision 2, docs/download-and-run-build-note.md).

import { EXPLORER, SECOND_TIP_SOURCE, type Network } from '../../config';
import * as core from './core';

const NOT_HERE = 'This lookup is not part of the downloaded DynastyTrust yet: it would go to a public block explorer, and the download asks only your own node.';

/** Which network a mempool.space / blockstream.info API URL is for, and the
 *  rest of its path -- or null when the URL is not one of them. */
export function explorerRoute(url: string): { network: Network; path: string } | null {
  const bases: [string, Network][] = [];
  for (const n of Object.keys(EXPLORER) as Network[]) {
    bases.push([EXPLORER[n].api, n], [SECOND_TIP_SOURCE[n], n]);
  }
  // Longest first, so .../signet/api is not mistaken for .../api.
  bases.sort((a, b) => b[0].length - a[0].length);
  for (const [base, network] of bases) {
    if (url === base || url.startsWith(base + '/')) return { network, path: url.slice(base.length) || '/' };
  }
  return null;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Find a transaction in whichever of this computer's vault wallets knows
 *  it (Core keeps no full transaction index by default). */
async function walletTx(conn: core.CoreConn, txid: string): Promise<{ confirmations: number; blockheight?: number } | null> {
  const wallets = (await core.rpc<string[]>(conn, 'listwallets')).filter(w => w.startsWith('dynastytrust-'));
  for (const w of wallets) {
    try { return await core.rpc<{ confirmations: number; blockheight?: number }>(conn, 'gettransaction', [txid, true], w); } catch { /* not in this wallet */ }
  }
  return null;
}

/** Answer one explorer request from Core. */
export async function answerChainRequest(url: string, init?: RequestInit): Promise<Response> {
  const route = explorerRoute(url);
  if (!route) return text(404, NOT_HERE);
  const conn = core.coreConnFor(route.network);
  const method = (init?.method ?? 'GET').toUpperCase();
  const { path } = route;
  try {
    if (method === 'GET' && path === '/blocks/tip/height') {
      return text(200, String(await core.tipHeight(conn)));
    }
    let m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path);
    if (method === 'GET' && m) {
      const t = await walletTx(conn, m[1]);
      if (!t) return text(404, 'Transaction not found by your node (it is not one of this computer\'s vaults).');
      // A conflicted (negative) or unconfirmed transaction is not confirmed.
      return json(t.confirmations > 0 && t.blockheight != null
        ? { confirmed: true, block_height: t.blockheight }
        : { confirmed: false });
    }
    m = /^\/tx\/?$/.exec(path);
    if (method === 'POST' && m) {
      const raw = String(init?.body ?? '').trim();
      if (!/^[0-9a-fA-F]+$/.test(raw)) return text(400, 'sendrawtransaction RPC error: not a raw transaction in hex');
      return text(200, await core.broadcast(conn, raw));
    }
  } catch (e) {
    // Core's own reason, the way mempool.space reports a rejected broadcast.
    return text(400, `Bitcoin Core: ${why(e)}`);
  }
  return text(404, NOT_HERE);
}

/** Route the screens' explorer requests to Core; everything else is
 *  untouched. Called once, in the download build only. */
export function installChainFetch(target: { fetch: typeof fetch } = globalThis): void {
  const real = target.fetch.bind(target);
  target.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (explorerRoute(url)) return answerChainRequest(url, init);
    return real(input, init);
  };
}
