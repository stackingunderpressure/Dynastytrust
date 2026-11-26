// test-electrum.mjs -- the Electrum coin lookups (netlify/functions/_electrum.js,
// _vault-coins.js vaultCoins; docs/chain-lookups-build-note.md). A stand-in
// socket plays the server; nothing here touches the network.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  scripthashOf, headerHash, isBlockedIp, publicAddressOf, parseUserServer, userServersFrom,
  electrumBatch, electrumCoins, serverFor, GENESIS, checkUserServer,
} from "../netlify/functions/_electrum.js";
import { vaultCoins } from "../netlify/functions/_vault-coins.js";

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

const GENESIS_HEADER_BITCOIN = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
const PIN = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, "0")).join(":");

/** A stand-in server: answers each batched call with answer(method, params). */
function fakeConnect({ answer, fingerprint = PIN, log = [] }) {
  return (opts) => {
    const s = new EventEmitter();
    s.opts = opts;
    s.getPeerCertificate = () => ({ fingerprint256: fingerprint });
    s.destroy = () => {};
    s.write = (line) => {
      log.push(line);
      const reqs = JSON.parse(line);
      const out = reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params) }));
      setImmediate(() => s.emit("data", Buffer.from(JSON.stringify(out) + "\n")));
    };
    setImmediate(() => s.emit("secureConnect"));
    log.opts = opts;
    return s;
  };
}

await t("script hash matches Electrum's documented example", () => {
  assert.equal(scripthashOf("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "bitcoin"),
    "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161");
});

await t("header hash of block 0 is bitcoin's genesis", () => {
  assert.equal(headerHash(GENESIS_HEADER_BITCOIN), GENESIS.bitcoin);
});

await t("private, local and metadata addresses are refused; public ones pass", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["1.1.1.1", "95.216.10.1", "2606:4700::1111"]) assert.equal(isBlockedIp(ip), false, ip);
  // Blind review 2026-11-25, finding 8: IPv4 inside IPv6 written in hex, or
  // spelled out in full, slipped past the list.
  for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::127.0.0.1", "::ffff:0a00:0001", "64:ff9b::a9fe:a9fe", "0:0:0:0:0:0:0:1", "FE80::1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["::ffff:808:808", "64:ff9b::808:808"]) assert.equal(isBlockedIp(ip), false, ip);
});

await t("a name that resolves to ANY private address is refused", async () => {
  const lookup = async () => [{ address: "8.8.8.8" }, { address: "10.0.0.5" }];
  await assert.rejects(publicAddressOf("sneaky.example.com", lookup), /private or local/);
  assert.equal(await publicAddressOf("ok.example.com", async () => [{ address: "8.8.8.8" }]), "8.8.8.8");
});

await t("bad host, port or fingerprint is refused", () => {
  assert.throws(() => parseUserServer({ host: "a b", port: 50002 }), /name/);
  assert.throws(() => parseUserServer({ host: "node.example.com", port: 70000 }), /port/);
  assert.throws(() => parseUserServer({ host: "node.example.com", port: 50002, pin: "nope" }), /fingerprint/);
  assert.deepEqual(parseUserServer({ host: "Node.Example.com", port: 50002, pin: PIN.toLowerCase() }), { host: "node.example.com", port: 50002, pin: PIN });
});

await t("the device's header is read per network; garbage is an error, absence is empty", () => {
  const raw = Buffer.from(JSON.stringify({ signet: { host: "node.example.com", port: 50002, pin: PIN } })).toString("base64");
  assert.deepEqual(userServersFrom({ headers: { "x-electrum-servers": raw } }), { signet: { host: "node.example.com", port: 50002, pin: PIN } });
  assert.deepEqual(userServersFrom({ headers: {} }), {});
  assert.throws(() => userServersFrom({ headers: { "x-electrum-servers": "!!!" } }), /not readable/);
});

await t("a user's server is not used until its certificate is confirmed", async () => {
  await assert.rejects(serverFor("signet", { signet: { host: "node.example.com", port: 50002, pin: null } }), /Confirm/);
});

await t("a different certificate than the pinned one: refused, nothing asked", async () => {
  const log = [];
  const connect = fakeConnect({ answer: () => [], fingerprint: "AA" + PIN.slice(2), log });
  await assert.rejects(electrumBatch({ host: "node.example.com", port: 50002, ip: "8.8.8.8", pin: PIN }, [["server.version", []]], { connect }), /different certificate/);
  assert.equal(log.length, 0);
});

await t("connects to the checked address, with the name for TLS", async () => {
  const log = [];
  const connect = fakeConnect({ answer: () => "x", log });
  await electrumBatch({ host: "node.example.com", port: 50002, ip: "8.8.8.8", pin: PIN }, [["server.version", []]], { connect });
  assert.equal(log.opts.host, "8.8.8.8");
  assert.equal(log.opts.servername, "node.example.com");
  assert.equal(log.opts.rejectUnauthorized, false);
});

const watched = [
  { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", branch: 0, index: 0 },
  { address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", branch: 1, index: 3 },
];
function chainAnswer(genesisHeader) {
  return (method, params) => {
    if (method === "blockchain.block.header") return genesisHeader;
    if (method === "blockchain.headers.subscribe") return { height: 977403, hex: "" };
    if (method === "blockchain.scripthash.listunspent") {
      return params[0] === scripthashOf(watched[0].address, "bitcoin")
        ? [{ tx_hash: "ab".repeat(32), tx_pos: 1, height: 977000, value: 5000 }, { tx_hash: "cd".repeat(32), tx_pos: 0, height: 0, value: 700 }]
        : [];
    }
    return null;
  };
}

await t("every address in ONE batch; coins come back in the website's shape", async () => {
  const log = [];
  const connect = fakeConnect({ answer: chainAnswer(GENESIS_HEADER_BITCOIN), log });
  const { coins, tip } = await electrumCoins({ host: "x", port: 1, ip: "8.8.8.8", pin: PIN }, "bitcoin", watched, { connect });
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).length, 2 + watched.length);
  assert.equal(tip, 977403);
  assert.deepEqual(coins[0], { txid: "ab".repeat(32), vout: 1, value: 5000, status: { confirmed: true, block_height: 977000 }, address: watched[0].address, branch: 0, index: 0 });
  assert.equal(coins[1].status.confirmed, false);
});

await t("a server on another chain is refused before any coin is shown", async () => {
  const connect = fakeConnect({ answer: chainAnswer("00".repeat(80)) });
  await assert.rejects(electrumCoins({ host: "x", port: 1, ip: "8.8.8.8", pin: PIN }, "bitcoin", watched, { connect }), /not on bitcoin/);
});

await t("first contact reports the fingerprint and whether it is on the right chain", async () => {
  const connect = fakeConnect({ answer: (m) => m === "server.version" ? ["Fulcrum 2.1.4", "1.4"] : chainAnswer(GENESIS_HEADER_BITCOIN)(m) });
  const r = await checkUserServer({ host: "node.example.com", port: 50002 }, "bitcoin", { connect, lookup: async () => [{ address: "8.8.8.8" }] });
  assert.equal(r.fingerprint, PIN);
  assert.equal(r.on_network, true);
  assert.equal(r.software, "Fulcrum 2.1.4");
});

const website = { coinsAt: async () => [{ txid: "ee".repeat(32), vout: 0, value: 1, status: { confirmed: true, block_height: 5 } }], fetchJson: async () => 10 };

await t("your own server failing is shown, never sent to mempool.space instead", async () => {
  let asked = false;
  const deps = { ...website, coinsAt: async () => { asked = true; return []; }, serverFor: async () => ({ host: "mine", own: true }), electrumCoins: async () => { throw new Error("mine is down"); } };
  await assert.rejects(vaultCoins("bitcoin", watched, {}, deps), /mine is down/);
  assert.equal(asked, false);
});

await t("the default server failing falls back to the website", async () => {
  const deps = { ...website, serverFor: async () => ({ host: "mempool.space", own: false }), electrumCoins: async () => { throw new Error("busy"); } };
  const r = await vaultCoins("signet", watched, {}, deps);
  assert.equal(r.source, "mempool.space");
  assert.equal(r.tip, 10);
});

await t("no server for the network: website lookups as before", async () => {
  const r = await vaultCoins("bitcoin", watched, {}, { ...website, serverFor: async () => null });
  assert.equal(r.source, "mempool.space");
  assert.equal(r.coins.length, 1);
});

await t("signet uses mempool.space's Electrum server with a normally checked certificate", async () => {
  const s = await serverFor("signet", {});
  assert.deepEqual(s, { host: "mempool.space", port: 60602, publicCa: true, own: false });
  assert.equal(await serverFor("bitcoin", {}), null);
});

console.log(`electrum: ${pass} passed`);
