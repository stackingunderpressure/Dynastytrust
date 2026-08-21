/**
 * legacy-onchain-recovery.ts -- orchestrates legacy-recovery.ts's v2
 * on-chain crypto primitives against the actual Bitcoin transaction layer
 * (onchain-publish.ts) and mempool.space lookups. Mirrors legacy-seal.ts's
 * role for the v1 (Supabase-backed) mechanism, but v2 has no database
 * step at all -- the chain IS the storage, so this file only ever talks
 * to onchain-publish.ts and mempool.space, never api.ts/Supabase.
 */

import * as btc from '@scure/btc-signer';
import {
  legacyOnChainIdentity,
  encodeOnChainPayload,
  decodeOnChainPayload,
  sealBundleOnChain,
  type SealedBundle,
} from './legacy-recovery';
import {
  p2wpkhAddressForPubkey,
  buildAndSignPublishTxFromKeypair,
  bytesToHex,
  hexToBytes,
  type PublishNetwork,
  type PublishUtxo,
  type BuiltPublishTx,
} from './onchain-publish';
import type { Network } from './keystore';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Maps keystore.ts's Network ('mainnet'|'testnet'|'signet') to onchain-publish.ts's PublishNetwork ('bitcoin'|'testnet'|'signet'). */
export function toPublishNetwork(network: Network): PublishNetwork {
  return network === 'mainnet' ? 'bitcoin' : network;
}

/** The one on-chain lookup address a keyholder needs for a given vaultIndex -- computable from just their mnemonic, no server involved. */
export function legacyOnChainLookupAddress(mnemonic: string, network: Network, vaultIndex: number): string {
  const { publicKey } = legacyOnChainIdentity(mnemonic, network, vaultIndex);
  return p2wpkhAddressForPubkey(toHex(publicKey), toPublishNetwork(network));
}

export interface LegacyOnChainPublishResult {
  built: BuiltPublishTx;
  address: string;
  identityPubkeyHex: string;
}

/**
 * Seals bundleText for one keyholder's v2 on-chain share and builds +
 * signs the publish transaction in one step -- the caller still performs
 * the actual broadcast (same explicit, separate step every other
 * Bitcoin-touching flow in this app already keeps distinct from signing).
 */
export async function sealAndBuildOnChainPublishTx(opts: {
  bundleText: string;
  mnemonic: string;
  network: Network;
  vaultIndex: number;
  utxo: PublishUtxo;
  feeRateSatsPerVb: number;
}): Promise<LegacyOnChainPublishResult> {
  const { bundleText, mnemonic, network, vaultIndex, utxo, feeRateSatsPerVb } = opts;
  const { sealed, identityPubkey } = await sealBundleOnChain(bundleText, mnemonic, network, vaultIndex);
  const { privateKey } = legacyOnChainIdentity(mnemonic, network, vaultIndex);
  const payload = encodeOnChainPayload(sealed);
  const publishNetwork = toPublishNetwork(network);
  const built = buildAndSignPublishTxFromKeypair({
    privateKey,
    publicKey: identityPubkey,
    network: publishNetwork,
    utxo,
    opReturnDataHex: bytesToHex(payload),
    feeRateSatsPerVb,
  });
  return {
    built,
    address: p2wpkhAddressForPubkey(toHex(identityPubkey), publishNetwork),
    identityPubkeyHex: toHex(identityPubkey),
  };
}

// ── Scanning: given an address's transaction history (already fetched --
// see fetchLegacyOnChainCandidates below for the actual network call),
// extract every OP_RETURN output that decodes as a v2 payload. Kept as a
// pure function, separate from the fetch, so it's unit-testable without
// a network call.

/** The subset of a mempool.space tx object this module actually reads. */
export interface MempoolTxLike {
  txid: string;
  vout: Array<{ scriptpubkey_type?: string; scriptpubkey?: string }>;
}

export interface OnChainCandidate {
  txid: string;
  sealed: SealedBundle;
}

/**
 * Extracts every valid v2 Legacy Recovery payload from a list of
 * transactions at one address. Silently skips anything that isn't an
 * OP_RETURN output, or doesn't decode as this payload format (see
 * decodeOnChainPayload's header comment) -- once an address is public,
 * anyone can send it junk, and that's expected, not an error.
 */
export function extractOnChainCandidates(txs: MempoolTxLike[]): OnChainCandidate[] {
  const found: OnChainCandidate[] = [];
  for (const tx of txs) {
    for (const output of tx.vout) {
      if (output.scriptpubkey_type !== 'op_return' || !output.scriptpubkey) continue;
      let decoded: unknown[];
      try {
        decoded = btc.Script.decode(hexToBytes(output.scriptpubkey));
      } catch {
        continue;
      }
      if (decoded[0] !== 'RETURN') continue;
      const pushes = decoded.slice(1).filter((el): el is Uint8Array => el instanceof Uint8Array);
      if (pushes.length === 0) continue;
      const totalLen = pushes.reduce((n, p) => n + p.length, 0);
      const payload = new Uint8Array(totalLen);
      let offset = 0;
      for (const p of pushes) {
        payload.set(p, offset);
        offset += p.length;
      }
      const sealed = decodeOnChainPayload(payload);
      if (sealed) found.push({ txid: tx.txid, sealed });
    }
  }
  return found;
}

/**
 * The actual network call: fetch an address's transaction history from
 * mempool.space and extract every v2 payload found there. A hardened
 * address never has "too much" history to matter -- only this exact
 * seed's derivation can ever have published to it, so realistically this
 * is one transaction (or a handful, across reseals).
 */
export async function fetchLegacyOnChainCandidates(
  address: string,
  network: PublishNetwork,
): Promise<OnChainCandidate[]> {
  const base =
    network === 'bitcoin' ? 'https://mempool.space/api'
    : network === 'signet' ? 'https://mempool.space/signet/api'
    : 'https://mempool.space/testnet/api';
  const res = await fetch(`${base}/address/${address}/txs`);
  if (!res.ok) throw new Error(`mempool.space lookup failed (${res.status})`);
  const txs = (await res.json()) as MempoolTxLike[];
  return extractOnChainCandidates(txs);
}
