/**
 * onchain-publish.ts
 *
 * Builds, signs, and reports the fee for a small, ordinary P2WPKH
 * transaction whose only job is carrying an OP_RETURN payload -- used to
 * publish Legacy Recovery's on-chain share (see legacy-recovery.ts). This
 * is deliberately NOT vault-related: it spends an unrelated, user-funded
 * UTXO so the vault's own funding transaction stays ordinary-looking (see
 * LegacyRecoverySetup.tsx's on-chain publication instructions).
 *
 * Uses @scure/btc-signer (same paulmillr trust family as @scure/bip32/
 * bip39 and @noble/curves/hashes already vendored here) for transaction
 * construction and signing rather than hand-rolling BIP143 sighash and
 * bech32 encoding -- consensus-adjacent code earns an audited library,
 * not a first attempt.
 *
 * Actually broadcasting is a separate, explicit step in the caller (same
 * fetch-to-mempool.space pattern VaultDetail.tsx already uses for vault
 * spends) -- this module only builds and signs.
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';

export type PublishNetwork = 'testnet' | 'signet' | 'bitcoin';

function btcNetwork(network: PublishNetwork): typeof btc.NETWORK {
  return network === 'bitcoin' ? btc.NETWORK : btc.TEST_NETWORK;
}

function bip32Versions(network: PublishNetwork) {
  return network === 'bitcoin'
    ? { private: 0x0488ade4, public: 0x0488b21e }
    : { private: 0x04358394, public: 0x043587cf };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives the same child00 keypair the rest of this app already treats
 * as "this key's" signing key (see keystore.ts's deriveAccount and
 * psbt-signer.ts's signPsbtWithMnemonic) -- so the P2WPKH address shown
 * to the user to fund and the private key used to sign it are
 * guaranteed to be the same keypair as the one behind key.pubkey.
 */
function deriveChild00(mnemonic: string, derivationPath: string, network: PublishNetwork) {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, bip32Versions(network));
  const account = root.derive(derivationPath);
  const child00 = account.deriveChild(0).deriveChild(0);
  if (!child00.privateKey || !child00.publicKey) throw new Error('Could not derive private key');
  return { privateKey: child00.privateKey, publicKey: child00.publicKey };
}

/** P2WPKH address for a key already known by its (public) pubkey hex -- no mnemonic needed. */
export function p2wpkhAddressForPubkey(pubkeyHex: string, network: PublishNetwork): string {
  const p2wpkh = btc.p2wpkh(hexToBytes(pubkeyHex), btcNetwork(network));
  if (!p2wpkh.address) throw new Error('Could not derive address');
  return p2wpkh.address;
}

export interface PublishUtxo {
  txid: string;
  vout: number;
  valueSats: number;
}

export interface BuiltPublishTx {
  hex: string;
  txid: string;
  feeSats: number;
  changeSats: number;
  /** Present only when opts.payTo was given -- the amount actually sent to that address. */
  payToSats?: number;
}

/**
 * Builds and signs a transaction carrying an OP_RETURN payload: an
 * OP_RETURN output, an optional payment to a THIRD-PARTY address
 * (opts.payTo -- e.g. Legacy Recovery's own on-chain lookup address,
 * which never needs to sign anything itself this way), and the
 * remainder sent back to the signing key's own address as change.
 * Without payTo this is the original 1-input/2-output shape (OP_RETURN
 * + self-change). Throws if the UTXO can't cover the fee (+ payTo
 * amount, if given) at the given rate.
 */
export function buildAndSignPublishTx(opts: {
  mnemonic: string;
  derivationPath: string;
  network: PublishNetwork;
  utxo: PublishUtxo;
  opReturnDataHex: string;
  feeRateSatsPerVb: number;
  payTo?: { address: string; amountSats: number };
}): BuiltPublishTx {
  const { mnemonic, derivationPath, network, utxo, opReturnDataHex, feeRateSatsPerVb, payTo } = opts;
  const keypair = deriveChild00(mnemonic, derivationPath, network);
  return buildAndSignPublishTxFromKeypair({ ...keypair, network, utxo, opReturnDataHex, feeRateSatsPerVb, payTo });
}

/**
 * Same transaction shape as buildAndSignPublishTx, but given an
 * already-derived keypair directly rather than deriving one internally
 * from a base path + the fixed /0/0 child convention. The two concerns
 * (deriving the RIGHT key, and building a VALID transaction from any
 * key) stay separate. buildAndSignPublishTx above is a thin wrapper
 * over this.
 */
export function buildAndSignPublishTxFromKeypair(opts: {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  network: PublishNetwork;
  utxo: PublishUtxo;
  opReturnDataHex: string;
  feeRateSatsPerVb: number;
  payTo?: { address: string; amountSats: number };
}): BuiltPublishTx {
  const { privateKey, publicKey, network, utxo, opReturnDataHex, feeRateSatsPerVb, payTo } = opts;
  const net = btcNetwork(network);
  const p2wpkh = btc.p2wpkh(publicKey, net);
  if (!p2wpkh.address) throw new Error('Could not derive address');

  const opReturnScript = btc.Script.encode(['RETURN', hexToBytes(opReturnDataHex)]);

  // Dust threshold for a P2WPKH output is 294 sats -- a payTo amount
  // below that would create a non-standard, likely-unrelayable output.
  if (payTo && payTo.amountSats < 294) {
    throw new Error(`payTo amount (${payTo.amountSats} sats) is below the 294-sat dust threshold for a P2WPKH output.`);
  }

  // vsize estimate: 1 P2WPKH input (~68 vbytes incl. witness) +
  // 8-byte-overhead OP_RETURN output (payload + 11) + one 31-byte
  // P2WPKH output per payTo/change output present + ~11 byte tx
  // overhead. Rounded up generously -- these are one-off, non-urgent
  // publish txs, overpaying a few sats is a non-issue.
  const dataLen = opReturnDataHex.length / 2;
  const payToVsize = payTo ? 31 : 0;
  const estVsize = 68 + (11 + dataLen) + payToVsize + 31 + 11;
  const feeSats = Math.ceil(estVsize * feeRateSatsPerVb);
  const payToSats = payTo?.amountSats ?? 0;
  const changeSats = utxo.valueSats - feeSats - payToSats;
  if (changeSats < 0) {
    throw new Error(
      `UTXO (${utxo.valueSats} sats) can't cover the estimated fee${payTo ? ' plus the payment amount' : ''} ` +
      `(fee ${feeSats} sats at ${feeRateSatsPerVb} sat/vb${payTo ? `, payment ${payToSats} sats` : ''}). ` +
      `Fund with more, lower the fee rate${payTo ? ', or lower the payment amount' : ''}.`
    );
  }

  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    witnessUtxo: { amount: BigInt(utxo.valueSats), script: p2wpkh.script },
  });
  tx.addOutput({ script: opReturnScript, amount: 0n });
  if (payTo) {
    tx.addOutputAddress(payTo.address, BigInt(payToSats), net);
  }
  // Dust threshold for a P2WPKH output is 294 sats -- if change would be
  // below that, let it go to the miner as extra fee instead of creating
  // an unspendable/non-standard output.
  if (changeSats >= 294) {
    tx.addOutputAddress(p2wpkh.address, BigInt(changeSats), net);
  }
  tx.sign(privateKey);
  tx.finalize();

  return {
    hex: tx.hex,
    txid: tx.id,
    feeSats: changeSats >= 294 ? feeSats : feeSats + (utxo.valueSats - feeSats - payToSats),
    changeSats: changeSats >= 294 ? changeSats : 0,
    ...(payTo ? { payToSats } : {}),
  };
}

export { bytesToHex, hexToBytes };
