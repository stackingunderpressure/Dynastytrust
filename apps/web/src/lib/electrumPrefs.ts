/**
 * electrumPrefs.ts -- this device's own Electrum server, per network
 * (docs/chain-lookups-build-note.md; operator, 2026-11-24: "Each user, in
 * the app", saved on this device only, certificate pinned on first contact,
 * their server only).
 *
 * Saved in this browser, never on our server. Sent with the coin lookups
 * (balance by vault, the coins list, building a spend) in one request
 * header; the server uses it for that request and forgets it. A server is
 * only sent once its certificate fingerprint has been confirmed -- the
 * server refuses an unpinned one.
 */

export type ElectrumNetwork = 'bitcoin' | 'testnet' | 'signet';
export interface ElectrumServer {
  host: string;
  port: number;
  /** SHA-256 certificate fingerprint, AA:BB:... as Node prints it. */
  pin: string;
}

const STORAGE_KEY = 'dynastytrust:electrum-servers';
const NETWORKS: ElectrumNetwork[] = ['bitcoin', 'testnet', 'signet'];
const HOST_RE = /^[a-z0-9.:[\]-]{1,253}$/i;
const PIN_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

function isServer(v: unknown): v is ElectrumServer {
  const s = v as ElectrumServer;
  return !!s && typeof s.host === 'string' && HOST_RE.test(s.host) && Number.isInteger(s.port) &&
    s.port > 0 && s.port < 65536 && typeof s.pin === 'string' && PIN_RE.test(s.pin);
}

function readAll(): Partial<Record<ElectrumNetwork, ElectrumServer>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<ElectrumNetwork, ElectrumServer>> = {};
    for (const n of NETWORKS) if (isServer(parsed?.[n])) out[n] = parsed[n] as ElectrumServer;
    return out;
  } catch {
    return {};
  }
}

/** This device's server for a network, or null (the default lookups). */
export function getElectrumServer(network: ElectrumNetwork): ElectrumServer | null {
  return readAll()[network] ?? null;
}

export function setElectrumServer(network: ElectrumNetwork, server: ElectrumServer): void {
  if (!isServer(server)) throw new Error('That server setting is not complete.');
  const all = readAll();
  all[network] = { host: server.host.trim().toLowerCase(), port: server.port, pin: server.pin };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function clearElectrumServer(network: ElectrumNetwork): void {
  const all = readAll();
  delete all[network];
  try {
    if (Object.keys(all).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* nothing saved to clear */ }
}

/** The request header carrying this device's servers, or {} when none is set. */
export function electrumHeaders(): Record<string, string> {
  const all = readAll();
  if (!Object.keys(all).length) return {};
  const json = JSON.stringify(all);
  return { 'X-Electrum-Servers': btoa(json) };
}
