/**
 * _electrum.js -- coin lookups over Electrum (docs/chain-lookups-build-note.md).
 *
 * One TLS connection, every watched address asked in ONE batched request
 * (blockchain.scripthash.listunspent), plus the chain tip. Replaces one
 * mempool.space website request per address, which got this server refused.
 *
 * Two kinds of server:
 *  - DEFAULT: mempool.space's signet Electrum server (measured 2026-11-24:
 *    valid certificate, 15 of 15 back-to-back batches answered). Its normal
 *    certificate is checked the normal way. Real bitcoin and testnet have no
 *    default here -- they stay on the website lookups.
 *  - THE USER'S OWN: a host and port the person typed into Settings, sent
 *    with the request from their device (never stored on our server), and a
 *    certificate fingerprint they confirmed on first contact. Home nodes use
 *    self-signed certificates, so the fingerprint is the check: any other
 *    certificate is refused.
 *
 * Because this server connects wherever a user points it, a user's server
 * must resolve to a public address (never this machine, a private network,
 * or a cloud metadata address), the connection goes to the exact address
 * that was checked (no second lookup that could answer differently), and
 * every call has a time limit and a size limit.
 */

import tls from "node:tls";
import dns from "node:dns/promises";
import net from "node:net";
import { createHash } from "node:crypto";
import { Address, OutScript, NETWORK, TEST_NETWORK } from "@scure/btc-signer";

export const DEFAULT_SERVERS = {
  signet: { host: "mempool.space", port: 60602 },
};

// The first block of each chain. A server on a different chain (another
// signet, testnet instead of bitcoin) answers happily with the wrong coins;
// checking block 0 catches that before anything is shown.
export const GENESIS = {
  bitcoin: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  testnet: "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
  signet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
};

const TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const PIN_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

/** A user's server as sent from their device, checked; null when absent, throws when malformed. */
export function parseUserServer(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error("Your Electrum server setting is not readable.");
  const host = String(raw.host || "").trim().toLowerCase();
  const port = Number(raw.port);
  const pin = raw.pin == null ? null : String(raw.pin).toUpperCase();
  if (!HOST_RE.test(host) && !net.isIP(host)) throw new Error("Your Electrum server's name is not valid.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Your Electrum server's port is not valid.");
  if (pin !== null && !PIN_RE.test(pin)) throw new Error("Your Electrum server's certificate fingerprint is not valid.");
  return { host, port, pin };
}

/** The per-network servers a device sent in the X-Electrum-Servers header (base64 JSON). */
export function userServersFrom(event) {
  const h = event?.headers || {};
  const raw = h["x-electrum-servers"] || h["X-Electrum-Servers"];
  if (!raw) return {};
  if (raw.length > 2000) throw new Error("Your Electrum server setting is too long.");
  let obj;
  try { obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { throw new Error("Your Electrum server setting is not readable."); }
  const out = {};
  for (const n of ["bitcoin", "testnet", "signet"]) {
    const s = parseUserServer(obj?.[n]);
    if (s) out[n] = s;
  }
  return out;
}

/** Is this IP one a user-chosen server must never be? (this machine, private nets, metadata, multicast...) */
export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || /^64:ff9b:/.test(v) || /^2001:db8:/.test(v);
  }
  return true;
}

/** Resolve a user's server to ONE public address, or throw. */
export async function publicAddressOf(host, lookup = dns.lookup) {
  const all = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!all.length) throw new Error("Your Electrum server's name did not resolve.");
  if (all.some((a) => isBlockedIp(a.address))) {
    throw new Error("Your Electrum server points at a private or local network address. It has to be reachable from the internet.");
  }
  return all[0].address;
}

/** Electrum's name for an address: sha256 of its output script, byte-reversed, hex. */
export function scripthashOf(address, network) {
  const script = OutScript.encode(Address(network === "bitcoin" ? NETWORK : TEST_NETWORK).decode(address));
  return Buffer.from(createHash("sha256").update(script).digest()).reverse().toString("hex");
}

/** Block hash of a raw 80-byte header (hex), as explorers show it. */
export function headerHash(hex) {
  const once = createHash("sha256").update(Buffer.from(hex, "hex")).digest();
  return Buffer.from(createHash("sha256").update(once).digest()).reverse().toString("hex");
}

/**
 * Send one JSON-RPC batch and read the one-line answer.
 * Resolves { results: Map(id -> result), fingerprint }. `connect` is for tests.
 */
export function electrumBatch({ host, port, ip, pin, publicCa }, calls, { connect = tls.connect, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const sock = connect({
      host: ip || host, port, servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: !!publicCa,
    });
    const timer = setTimeout(() => finish(new Error(`Electrum server ${host} did not answer in time.`)), timeoutMs);
    sock.on("secureConnect", () => {
      const fingerprint = sock.getPeerCertificate?.()?.fingerprint256 || null;
      if (pin && fingerprint !== pin) {
        return finish(new Error(`Electrum server ${host} showed a different certificate than the one you confirmed. Nothing was read from it. If you changed your node's certificate, confirm the new one in Settings.`));
      }
      sock.fingerprint = fingerprint;
      sock.write(JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c[0], params: c[1] }))) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > MAX_BYTES) return finish(new Error(`Electrum server ${host} sent too much.`));
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let arr;
      try { arr = JSON.parse(buf.slice(0, nl)); } catch { return finish(new Error(`Electrum server ${host} sent an answer that is not readable.`)); }
      if (!Array.isArray(arr)) return finish(new Error(`Electrum server ${host} does not answer batched requests.`));
      const results = new Map();
      for (const r of arr) {
        if (r?.error) return finish(new Error(`Electrum server ${host}: ${r.error.message || JSON.stringify(r.error)}`));
        results.set(r.id, r.result);
      }
      finish(null, { results, fingerprint: sock.fingerprint });
    });
    sock.on("error", (e) => finish(new Error(`Electrum server ${host}: ${e.code || e.message}`)));
    sock.on("close", () => finish(new Error(`Electrum server ${host} closed the connection.`)));
  });
}

/**
 * Coins on every watched address plus the tip, from one server, in the same
 * shape the website lookups give (_vault-coins.js coinsAt), so nothing
 * downstream changes. Also checks the server is on the right chain.
 */
export async function electrumCoins(server, network, watched, deps = {}) {
  const calls = [
    ["blockchain.block.header", [0]],
    ["blockchain.headers.subscribe", []],
    ...watched.map((w) => ["blockchain.scripthash.listunspent", [scripthashOf(w.address, network)]]),
  ];
  const { results } = await electrumBatch(server, calls, deps);
  if (headerHash(String(results.get(0) || "")) !== GENESIS[network]) {
    throw new Error(`Electrum server ${server.host} is not on ${network}. Nothing was read from it.`);
  }
  const tip = results.get(1)?.height;
  if (!Number.isInteger(tip)) throw new Error(`Electrum server ${server.host} did not say how tall the chain is.`);
  const coins = [];
  watched.forEach((w, i) => {
    const list = results.get(i + 2);
    if (!Array.isArray(list)) throw new Error(`Electrum server ${server.host} did not answer for every address.`);
    for (const u of list) {
      const confirmed = Number.isInteger(u.height) && u.height > 0;
      coins.push({
        txid: u.tx_hash, vout: u.tx_pos, value: u.value,
        status: { confirmed, block_height: confirmed ? u.height : undefined },
        address: w.address, branch: w.branch, index: w.index,
      });
    }
  });
  return { coins, tip };
}

/**
 * Which watched addresses have EVER been paid (any history, confirmed or
 * waiting, even if since spent) -- one batched get_history
 * (docs/receive-address-reuse-until-paid-build-note.md). Checks the chain
 * like electrumCoins does. Returns a Set of addresses.
 */
export async function electrumUsed(server, network, watched, deps = {}) {
  const calls = [
    ["blockchain.block.header", [0]],
    ...watched.map((w) => ["blockchain.scripthash.get_history", [scripthashOf(w.address, network)]]),
  ];
  const { results } = await electrumBatch(server, calls, deps);
  if (headerHash(String(results.get(0) || "")) !== GENESIS[network]) {
    throw new Error(`Electrum server ${server.host} is not on ${network}. Nothing was read from it.`);
  }
  const used = new Set();
  watched.forEach((w, i) => {
    const list = results.get(i + 1);
    if (!Array.isArray(list)) throw new Error(`Electrum server ${server.host} did not answer for every address.`);
    if (list.length) used.add(w.address);
  });
  return used;
}

/** First contact with a user's server: is it reachable, on the right chain, and what certificate does it show? */
export async function checkUserServer(raw, network, deps = {}) {
  const s = parseUserServer(raw);
  if (!s) throw new Error("No server given.");
  const ip = await publicAddressOf(s.host, deps.lookup);
  const { results, fingerprint } = await electrumBatch({ ...s, ip, pin: null }, [
    ["server.version", ["DynastyTrust", "1.4"]],
    ["blockchain.block.header", [0]],
    ["blockchain.headers.subscribe", []],
  ], deps);
  const onChain = headerHash(String(results.get(1) || "")) === GENESIS[network];
  return {
    host: s.host, port: s.port, fingerprint,
    software: Array.isArray(results.get(0)) ? String(results.get(0)[0]).slice(0, 80) : null,
    tip: results.get(2)?.height ?? null,
    on_network: onChain,
  };
}

/** The server to use for this network: the user's own (pinned, public), else the default, else none. */
export async function serverFor(network, userServers = {}, deps = {}) {
  const own = userServers[network];
  if (own) {
    if (!own.pin) throw new Error("Confirm your Electrum server's certificate in Settings before it is used.");
    return { ...own, ip: await publicAddressOf(own.host, deps.lookup), own: true };
  }
  const d = DEFAULT_SERVERS[network];
  return d ? { ...d, publicCa: true, own: false } : null;
}
