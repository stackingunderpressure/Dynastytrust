/**
 * electrum-live.mjs -- the real _electrum.js code against real servers
 * (docs/chain-lookups-build-note.md). Run by the Electrum probe workflow,
 * because this sandbox cannot open raw connections. NOT part of npm test.
 * Addresses are public ones picked from recent blocks (2026-11-24).
 * Exits non-zero if any check fails.
 */
import { electrumCoins, serverFor, checkUserServer, electrumBatch } from "../netlify/functions/_electrum.js";

const SIGNET = ["tb1qr6lmcexy6285f3a04j2a75d39qvcdek739g8cz", "tb1pd5lycwpxag9suvpwcuu974xj7tzf57jyqk3pr2c98e022r5s2zkqzg6xd2",
  "tb1qxc9rhgpdjcp42nmhg6lepe7pp5g86tx25vlv8h", "tb1qdd32sw5j5w6qs88yuchlqwj88685r8hkyjyucm", "tb1qpg6xwt45gceu6vfw7h4xkrygt0djxyj6nsjhg8",
  "tb1pmpd2lv2a3fmy02986w3y7gw2mm6ztr08p9nyn8zglf6xz0euvegs5wtk7x"];
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

void electrumBatch;
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("all live checks passed");
