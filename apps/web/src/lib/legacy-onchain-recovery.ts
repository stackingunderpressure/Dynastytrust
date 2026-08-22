/**
 * legacy-onchain-recovery.ts -- orchestrates legacy-recovery.ts's
 * on-chain crypto primitives against the actual Bitcoin transaction layer
 * (onchain-publish.ts) and mempool.space lookups. No database step at
 * all -- the chain IS the storage, so this file only ever talks to
 * onchain-publish.ts and mempool.space, never api.ts/Supabase.
 */

import * as btc from '@scure/btc-signer';
import {
  legacyOnChainIdentity,
  legacyOnChainIdentityFromXpub,
  encodeOnChainPayload,
  decodeOnChainPayload,
  sealBundleOnChain,
  sealBundleOnChainExternal,
  verifyLegacyOnChainNonceSignature,
  type SealedBundle,
} from './legacy-recovery';
import {
  p2wpkhAddressForPubkey,
  bytesToHex,
  hexToBytes,
  type PublishNetwork,
} from './onchain-publish';
import type { Network } from './keystore';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Maps keystore.ts's Network ('mainnet'|'testnet'|'signet') to onchain-publish.ts's PublishNetwork ('bitcoin'|'testnet'|'signet'). */
export function toPublishNetwork(network: Network): PublishNetwork {
  return network === 'mainnet' ? 'bitcoin' : network;
}

/** Maps a Vault's network field ('bitcoin'|'testnet'|'signet') to keystore.ts's Network type ('mainnet'|'testnet'|'signet'). */
export function vaultNetworkToKeystoreNetwork(network: 'testnet' | 'signet' | 'bitcoin'): Network {
  return network === 'bitcoin' ? 'mainnet' : network;
}

/** The one on-chain lookup address a keyholder needs -- computable from just their mnemonic, no server involved. One fixed address per seed (see legacy-recovery.ts's legacyOnChainDerivationPath). */
export function legacyOnChainLookupAddress(mnemonic: string, network: Network): string {
  const { publicKey } = legacyOnChainIdentity(mnemonic, network);
  return p2wpkhAddressForPubkey(toHex(publicKey), toPublishNetwork(network));
}

export interface LegacyOnChainPayload {
  /** The exact OP_RETURN payload hex to embed -- pass this straight to onchain-publish.ts's opReturnDataHex. */
  payloadHex: string;
  /** This keyholder's on-chain lookup address -- pay it a small amount in the SAME transaction as the OP_RETURN. */
  address: string;
  identityPubkeyHex: string;
}

/**
 * Seals bundleText for one keyholder's on-chain share and returns the
 * exact OP_RETURN payload plus the address to pay it to -- nothing else.
 * Deliberately does NOT build or sign a transaction: the recovery
 * identity key never needs to sign a Bitcoin transaction at all, only
 * ever a MESSAGE, over the random nonce this seal generates (see
 * legacy-recovery.ts's signLegacyOnChainNonce). Publishing is one
 * ordinary transaction from ANY already-funded key -- an OP_RETURN
 * output carrying payloadHex, plus a small payment to `address` in the
 * SAME transaction (the caller passes both to onchain-publish.ts's
 * buildAndSignPublishTx via its `payTo` option) -- not two transactions
 * where the identity address has to be funded first and then spend from
 * itself. The identity address only ever needs to appear as an OUTPUT of
 * some transaction, never an input.
 */
export async function sealOnChainPayload(opts: {
  bundleText: string;
  mnemonic: string;
  network: Network;
}): Promise<LegacyOnChainPayload> {
  const { bundleText, mnemonic, network } = opts;
  const { sealed, identityPubkey } = await sealBundleOnChain(bundleText, mnemonic, network);
  const payload = encodeOnChainPayload(sealed);
  const publishNetwork = toPublishNetwork(network);
  return {
    payloadHex: bytesToHex(payload),
    address: p2wpkhAddressForPubkey(toHex(identityPubkey), publishNetwork),
    identityPubkeyHex: toHex(identityPubkey),
  };
}

/**
 * Hardware-wallet seal path: the identity keypair's public half comes
 * from an account-level xpub exported at legacyOnChainDerivationPath (no
 * mnemonic ever touches this browser), and the signature over the nonce
 * is produced externally by the hardware wallet's own "Sign Message"
 * feature and pasted back in -- symmetric to how DescriptorRetrieval.tsx
 * already recovers a bundle using only an externally-produced signature
 * and no local key at all. Verifies the signature actually matches the
 * given xpub for this nonce BEFORE sealing, so a wrong xpub or a
 * signature over the wrong message fails clearly here rather than
 * silently producing a share nobody can ever recover.
 */
export async function sealOnChainPayloadExternal(opts: {
  bundleText: string;
  accountXpub: string;
  nonce: Uint8Array;
  signature: Uint8Array;
  network: Network;
}): Promise<LegacyOnChainPayload> {
  const { bundleText, accountXpub, nonce, signature, network } = opts;
  const { publicKey } = legacyOnChainIdentityFromXpub(accountXpub, network);
  if (!verifyLegacyOnChainNonceSignature(signature, publicKey, nonce)) {
    throw new Error('That signature does not match this xpub for this nonce -- check the xpub, the derivation path, and that you signed the exact message shown, not a different one.');
  }
  const sealed = await sealBundleOnChainExternal(bundleText, nonce, signature);
  const payload = encodeOnChainPayload(sealed);
  const publishNetwork = toPublishNetwork(network);
  return {
    payloadHex: bytesToHex(payload),
    address: p2wpkhAddressForPubkey(toHex(publicKey), publishNetwork),
    identityPubkeyHex: toHex(publicKey),
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
