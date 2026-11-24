/**
 * electrum-probe.mjs -- which public Electrum servers answer, and how fast?
 * (docs/chain-lookups-build-note.md). For each candidate: TLS connect,
 * server.version, the chain tip (blockchain.headers.subscribe), and ONE
 * batched request of listunspent for several script hashes -- the call the
 * coin scan would make. Prints a line per server; never fails the job.
 * NOT part of npm test. Run: node scripts/electrum-probe.mjs
 */
import tls from 'node:tls';
import { createHash } from 'node:crypto';

const CANDIDATES = [
  ['signet', 'mempool.space', 60602], ['signet', 'electrum.mutinynet.com', 50002],
  ['signet', 'signet-electrumx.wakiyamap.dev', 50002], ['signet', 'electrum.blockstream.info', 60602],
  ['testnet', 'electrum.blockstream.info', 60002], ['testnet', 'testnet.aranguren.org', 51002],
  ['bitcoin', 'electrum.blockstream.info', 50002], ['bitcoin', 'fulcrum.sethforprivacy.com', 50002],
  ['bitcoin', 'electrum.emzy.de', 50002], ['bitcoin', 'bitcoin.lukechilds.co', 50002],
];
// Any script: P2TR of 32 x 0x01 bytes (empty is fine; we time the round trip).
const spk = (n) => Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, n)]);
const scripthash = (s) => Buffer.from(createHash('sha256').update(s).digest()).reverse().toString('hex');

function probe(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = { host, port };
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      out.tlsMs = Date.now() - t0;
      out.certOk = sock.authorized;
      const batch = [
        { jsonrpc: '2.0', id: 1, method: 'server.version', params: ['dt-probe', '1.4'] },
        { jsonrpc: '2.0', id: 2, method: 'blockchain.headers.subscribe', params: [] },
        ...Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', id: 10 + i, method: 'blockchain.scripthash.listunspent', params: [scripthash(spk(i + 1))] })),
      ];
      sock.write(JSON.stringify(batch) + '\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (!buf.includes('\n')) return;
      try {
        const res = JSON.parse(buf.split('\n')[0]);
        const arr = Array.isArray(res) ? res : [res];
        const by = Object.fromEntries(arr.map(r => [r.id, r]));
        out.version = JSON.stringify(by[1]?.result ?? by[1]?.error);
        out.tip = by[2]?.result?.height ?? JSON.stringify(by[2]?.error);
        out.listunspentOk = arr.filter(r => r.id >= 10 && Array.isArray(r.result)).length;
        out.batchMs = Date.now() - t0;
      } catch (e) { out.parseError = e.message; }
      sock.end(); resolve(out);
    });
    sock.on('timeout', () => { out.error = 'timeout'; sock.destroy(); resolve(out); });
    sock.on('error', (e) => { out.error = e.code || e.message; resolve(out); });
  });
}

for (const [net, host, port] of CANDIDATES) {
  const r = await probe(host, port);
  console.log(`${net.padEnd(8)} ${JSON.stringify(r)}`);
}
