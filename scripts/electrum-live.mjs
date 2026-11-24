/**
 * electrum-live.mjs -- the real _electrum.js code against real servers
 * (docs/chain-lookups-build-note.md). Run by the Electrum probe workflow,
 * because this sandbox cannot open raw connections. NOT part of npm test.
 * Addresses are public ones picked from recent blocks (2026-11-24).
 * Exits non-zero if any check fails.
 */
import { electrumCoins, serverFor, checkUserServer, electrumBatch } from "../netlify/functions/_electrum.js";

const SIGNET = ["tb1pjyf2ry3l9lx3ge9jvs5zzvq0lnqcwg5yct5369hypequ6xs333hqj6qc0j", "tb1qt8v6gj8k2h2fu4h7mjzkwqjyu8rrxdvmvqpdc4",
  "tb1qpxh4ygyft22tjmux7evxqzj76aflk00wa3nxd3gtu3f7z8d38ffqmvg7zw", "tb1pkptnqn5u7ppgve54e5s0rt30yds5j5gyzx2p5a95l458jsr5gu8qdjumk7",
  "tb1q5enam2zwjuqe9x32f2hjuqhhqx96ylfc9szdlu", "tb1qd9wzn6dzsnsdxavmu6rk60y87nqwrj9zkmv7uw"]; // each 6 transactions or fewer, like a vault's
// The signet miner's payout address: 123,016 transactions. Not a vault's
// shape; measured for the record only (run 3 timed out on it at 8 s).
const BUSY = "tb1qr6lmcexy6285f3a04j2a75d39qvcdek739g8cz";
const BITCOIN = ["bc1qacdfqt4t0652pe35xf8t5ejtqzunwy98vdr763", "bc1q59ufxa36apk9dmd5ujlsv96slj9usqkk6gn7ya", "bc1qvps6ydydwpz3xxpc70pu9p9acw7un4lrxqt2n3"];
const watch = (list) => list.map((address, index) => ({ address, branch: 0, index }));
let failed = 0;
const check = async (name, fn) => {
  const t0 = Date.now();
  try { console.log(`ok   ${name} (${Date.now() - t0 + 0}ms) ${JSON.stringify(await fn())}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};
const key = (c) => `${c.txid}:${c.vout}:${c.value}:${c.status.confirmed}`;

await check("signet default server: coins match mempool.space's website", async () => {
  const t0 = Date.now();
  const s = await serverFor("signet", {});
  const { coins, tip } = await electrumCoins(s, "signet", watch(SIGNET));
  const ms = Date.now() - t0;
  const web = [];
  for (const a of SIGNET) {
    for (const u of await (await fetch(`https://mempool.space/signet/api/address/${a}/utxo`)).json()) {
      web.push(key({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: u.status.confirmed } }));
    }
  }
  const mine = coins.map(key).sort(), theirs = web.sort();
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) throw new Error(`differ: electrum ${mine.length} vs website ${theirs.length}`);
  return { ms, tip, coins: coins.length };
});

let pin = null;
await check("own server first contact (fulcrum.sethforprivacy.com, bitcoin)", async () => {
  const r = await checkUserServer({ host: "fulcrum.sethforprivacy.com", port: 50002 }, "bitcoin");
  if (!r.on_network || !r.fingerprint) throw new Error(JSON.stringify(r));
  pin = r.fingerprint;
  return { tip: r.tip, software: r.software };
});

await check("own server, pinned: coins match mempool.space's website", async () => {
  const t0 = Date.now();
  const s = await serverFor("bitcoin", { bitcoin: { host: "fulcrum.sethforprivacy.com", port: 50002, pin } });
  const { coins, tip } = await electrumCoins(s, "bitcoin", watch(BITCOIN));
  const ms = Date.now() - t0;
  const web = [];
  for (const a of BITCOIN) {
    for (const u of await (await fetch(`https://mempool.space/api/address/${a}/utxo`)).json()) {
      web.push(key({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: u.status.confirmed } }));
    }
  }
  const mine = coins.map(key).sort(), theirs = web.sort();
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) throw new Error(`differ: electrum ${mine.length} vs website ${theirs.length}`);
  return { ms, tip, coins: coins.length };
});

await check("own server, WRONG pin: refused", async () => {
  const s = await serverFor("bitcoin", { bitcoin: { host: "fulcrum.sethforprivacy.com", port: 50002, pin: "AA:" + "BB:".repeat(30) + "CC" } });
  try { await electrumCoins(s, "bitcoin", watch(BITCOIN)); } catch (e) {
    if (/different certificate/.test(e.message)) return "refused";
    throw e;
  }
  throw new Error("was NOT refused");
});

await check("a bitcoin server offered for signet: told it is the wrong chain", async () => {
  const r = await checkUserServer({ host: "fulcrum.sethforprivacy.com", port: 50002 }, "signet");
  if (r.on_network) throw new Error("said it was on signet");
  return "on_network=false";
});

await check("a name pointing at this machine: refused before connecting", async () => {
  try { await checkUserServer({ host: "localhost", port: 50002 }, "bitcoin"); } catch (e) {
    if (/private or local/.test(e.message)) return "refused";
    throw e;
  }
  throw new Error("was NOT refused");
});

// For the record, never a failure: how the default server copes with an
// address that has a huge history.
{
  const t0 = Date.now();
  try {
    const { coins } = await electrumCoins(await serverFor("signet", {}), "signet", watch([BUSY]), { timeoutMs: 30000 });
    console.log(`info busy address (123k transactions): ${coins.length} coins in ${Date.now() - t0}ms`);
  } catch (e) { console.log(`info busy address (123k transactions): ${e.message} after ${Date.now() - t0}ms`); }
}
void electrumBatch;
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("all live checks passed");
