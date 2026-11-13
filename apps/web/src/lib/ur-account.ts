// Read a hardware wallet's animated key QR (BC-UR "crypto-account" or
// "crypto-hdkey", Blockchain Commons BCR-2020-007 and BCR-2020-015) into
// the same [fingerprint/path]xpub the static QR carries.
//
// Operator, 2026-11-13: "Decode next" -- SeedSigner's default key QR is
// "Animated (default)", a crypto-account record, and this app could only
// tell people to switch to Static. What SeedSigner puts in it, read from
// the fork's encode_qr.py (UrXpubQrEncoder):
//   crypto-account = { 1: master fingerprint (uint32), 2: [output] }
//   output         = script-expression tag(s) (400 sh, 401 wsh, 403 pkh,
//                    404 wpkh, 409 tr) around a crypto-hdkey
//   crypto-hdkey   = tag 303 { 3: key (33 bytes), 4: chain code (32),
//                    5: use-info tag 305 { 2: network, 1 = testnet },
//                    6: origin tag 304 { 1: [index, hardened, ...],
//                       2: source fingerprint, 3: depth },
//                    8: parent fingerprint (uint32) }
//
// Key data, so nothing is guessed: any missing or malformed field refuses
// the whole QR with a reason, and the result is checked by rebuilding the
// key's own public key from the xpub it produced. Pure (no React, no
// network); tested against SeedSigner's own encoder by
// scripts/test-ur-account.mjs.

import { decode } from 'cborg';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { HDKey } from '@scure/bip32';

export interface UrKey {
  /** The extended public key, in the plain xpub/tpub form for its network. */
  xpub: string;
  /** e.g. m/48'/1'/0'/2' */
  path: string;
  /** Master fingerprint, 8 hex characters. */
  fingerprint: string;
  /** The script the wallet labelled this key for: 'wsh' for native multisig. */
  script: string;
  testnet: boolean;
}

const SCRIPT_TAGS: Record<number, string> = { 400: 'sh', 401: 'wsh', 402: 'pk', 403: 'pkh', 404: 'wpkh', 405: 'combo', 406: 'multi', 407: 'sortedmulti', 408: 'addr', 409: 'tr' };
const TAG_HDKEY = 303, TAG_KEYPATH = 304, TAG_COININFO = 305;

class Tagged {
  readonly tag: number;
  readonly value: unknown;
  constructor(tag: number, value: unknown) { this.tag = tag; this.value = value; }
}

function cbor(bytes: Uint8Array): unknown {
  const tags: ((v: unknown) => unknown)[] = [];
  for (const t of [TAG_HDKEY, TAG_KEYPATH, TAG_COININFO, ...Object.keys(SCRIPT_TAGS).map(Number)]) tags[t] = (v) => new Tagged(t, v);
  return decode(bytes, { tags, useMaps: true, rejectDuplicateMapKeys: true });
}

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const fp8 = (n: unknown, what: string): string => {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`The QR's ${what} is missing or not readable.`);
  return n.toString(16).padStart(8, '0');
};
function field<T>(m: unknown, k: number, check: (v: unknown) => v is T, what: string): T {
  if (!(m instanceof Map)) throw new Error(`The QR's ${what} is not readable.`);
  const v = m.get(k);
  if (!check(v)) throw new Error(`The QR's ${what} is missing or not readable.`);
  return v;
}
const isBytes = (n: number) => (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.length === n;

/** One crypto-hdkey (tag 303's map) to a key. */
function hdkeyToKey(hdkey: unknown, accountFingerprint: string | null, script: string): UrKey {
  const key = field(hdkey, 3, isBytes(33), 'public key');
  const chain = field(hdkey, 4, isBytes(32), 'chain code');
  if (key[0] !== 2 && key[0] !== 3) throw new Error('The QR carries a private key or an unreadable key. Export the public key (xpub) only.');
  const m = hdkey as Map<number, unknown>;

  const origin = m.get(6);
  if (!(origin instanceof Tagged) || origin.tag !== TAG_KEYPATH) throw new Error("The QR does not say which derivation path this key is at.");
  const comps = field(origin.value, 1, (v): v is unknown[] => Array.isArray(v), 'derivation path');
  if (comps.length === 0 || comps.length % 2 !== 0) throw new Error("The QR's derivation path is not readable.");
  const steps: { index: number; hardened: boolean }[] = [];
  for (let i = 0; i < comps.length; i += 2) {
    const index = comps[i], hardened = comps[i + 1];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 0x80000000 || typeof hardened !== 'boolean') {
      throw new Error("The QR's derivation path is not readable (wildcards are not supported).");
    }
    steps.push({ index, hardened });
  }
  const om = origin.value as Map<number, unknown>;
  const sourceFp = om.has(2) ? fp8(om.get(2), 'master fingerprint') : null;
  const fingerprint = sourceFp ?? accountFingerprint;
  if (!fingerprint) throw new Error("The QR does not carry the wallet's master fingerprint.");
  if (sourceFp && accountFingerprint && sourceFp !== accountFingerprint) throw new Error('The QR names two different master fingerprints. Export it again.');
  const depth = om.has(3) ? om.get(3) : steps.length;
  if (depth !== steps.length) throw new Error("The QR's derivation path and its depth disagree.");
  if (depth > 255) throw new Error("The QR's derivation path is too long.");

  // Only the network decides tpub or xpub; anything else in use-info is ignored.
  let testnet = false;
  const use = m.get(5);
  if (use !== undefined) {
    if (!(use instanceof Tagged) || use.tag !== TAG_COININFO || !(use.value instanceof Map)) throw new Error("The QR's network information is not readable.");
    const net = use.value.get(2) ?? 0;
    if (net !== 0 && net !== 1) throw new Error("The QR names a network this app does not know.");
    testnet = net === 1;
  }
  const parent = fp8(m.get(8), 'parent fingerprint');

  const last = steps[steps.length - 1];
  const child = (last.index + (last.hardened ? 0x80000000 : 0)) >>> 0;
  const raw = new Uint8Array(78);
  const version = testnet ? 0x043587cf : 0x0488b21e;
  raw.set([version >>> 24, (version >>> 16) & 255, (version >>> 8) & 255, version & 255], 0);
  raw[4] = depth as number;
  raw.set(Uint8Array.from(parent.match(/../g)!.map(h => parseInt(h, 16))), 5);
  raw.set([child >>> 24, (child >>> 16) & 255, (child >>> 8) & 255, child & 255], 9);
  raw.set(chain, 13);
  raw.set(key, 45);
  const xpub = base58check(sha256).encode(raw);

  // Check our own work: the xpub must read back to the very key the QR sent.
  const back = HDKey.fromExtendedKey(xpub, testnet ? { private: 0x04358394, public: 0x043587cf } : undefined);
  if (!back.publicKey || hex(back.publicKey) !== hex(key)) throw new Error('The key in the QR could not be rebuilt exactly. Nothing was saved.');

  const path = 'm/' + steps.map(s => `${s.index}${s.hardened ? "'" : ''}`).join('/');
  return { xpub, path, fingerprint, script, testnet };
}

/** Unwrap script-expression tags around a crypto-hdkey: wsh(...) -> 'wsh'. */
function unwrapOutput(o: unknown): { script: string; hdkey: unknown } {
  const names: string[] = [];
  let cur = o;
  while (cur instanceof Tagged && SCRIPT_TAGS[cur.tag]) { names.push(SCRIPT_TAGS[cur.tag]); cur = cur.value; }
  if (!(cur instanceof Tagged) || cur.tag !== TAG_HDKEY) throw new Error('The QR holds a key type this app does not read (only plain extended keys are supported).');
  return { script: names.join('-') || 'none', hdkey: cur.value };
}

/**
 * Decode a scanned UR (its type and the CBOR payload bytes) into keys.
 * crypto-account may list several outputs (one per script type); every
 * one is returned and the caller picks the one it needs.
 */
export function keysFromUr(type: string, payload: Uint8Array): UrKey[] {
  const t = type.toLowerCase();
  const value = cbor(payload);
  if (t === 'crypto-hdkey' || t === 'hdkey') {
    return [hdkeyToKey(value instanceof Tagged ? value.value : value, null, 'none')];
  }
  if (t === 'crypto-account' || t === 'account-descriptor') {
    if (!(value instanceof Map)) throw new Error('The QR is not a readable key export.');
    const accountFp = fp8(value.get(1), 'master fingerprint');
    const outputs = value.get(2);
    if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('The QR does not contain any keys.');
    return outputs.map((o) => { const { script, hdkey } = unwrapOutput(o); return hdkeyToKey(hdkey, accountFp, script); });
  }
  throw new Error(`Scanned a "${type}" QR, which is not a key export.`);
}

/** The key a vault needs from an export: native multisig (wsh) if offered,
 *  otherwise the only key. Several keys and no wsh: ask, never guess. */
export function pickVaultKey(keys: UrKey[]): UrKey {
  const wsh = keys.filter(k => k.script === 'wsh');
  if (wsh.length === 1) return wsh[0];
  if (keys.length === 1) return keys[0];
  throw new Error('This QR holds several keys. On the wallet, export the Multisig, Native Segwit key only.');
}

/** As the static QR writes it: [fingerprint/path]xpub. */
export function keyOriginString(k: UrKey): string {
  return `[${k.fingerprint}${k.path.slice(1)}]${k.xpub}`;
}
