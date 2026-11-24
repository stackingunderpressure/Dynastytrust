// mempool-scan-bench.mjs -- NOT part of npm test (hits the real mempool.space).
// Measure _vault-coins.js against the REAL mempool.space: a page view runs
// the balance scan and the coins scan at once, for a fresh-address vault
// watching 5 receive + 10 look-ahead, 2 change + 5 look-ahead (22 addresses).
import { readFileSync } from 'node:fs';
process.env.SUPABASE_URL ||= 'https://x.supabase.co';
const F = (f) => new URL(`../netlify/functions/${f}`, import.meta.url).href;
const { watchedAddresses, coinsAt } = await import(F('_vault-coins.js'));
const { callWasm } = await import(F('_ranged-wasm.js'));
const shape = JSON.parse(readFileSync(new URL('../protocol/tests/vectors/ranged.json', import.meta.url), 'utf8')).shapes.find(s => s.name === 'family');
const V = { network: 'signet', descriptor_version: 2, descriptor_multipath: shape.multipath_descriptor, descriptor_receive: shape.receive_descriptor, descriptor_change: shape.change_descriptor };
V.address = callWasm('/ranged-address', { multipath: V.descriptor_multipath, receive: V.descriptor_receive, change: V.descriptor_change, network: 'signet', branch: 0, index: 0 }).body.address;
const w = watchedAddresses(V, { 0: 5, 1: 2 });
let ok = 0, fail = 0; const errs = {};
for (let view = 0; view < 6; view++) {
  const t = Date.now();
  const r = await Promise.allSettled([coinsAt('signet', w), coinsAt('signet', w)]);
  for (const x of r) { if (x.status === 'fulfilled') ok++; else { fail++; const m = x.reason.message.replace(/: https.*/, ''); errs[m] = (errs[m] || 0) + 1; } }
  console.log(`page view ${view + 1}: ${r.map(x => x.status === 'fulfilled' ? 'ok' : 'FAIL').join(' ')} in ${Date.now() - t} ms`);
}
console.log({ watched: w.length, ok, fail, errs });
