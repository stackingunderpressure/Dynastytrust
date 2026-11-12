/**
 * psbt-signer.ts
 *
 * Browser-side PSBT signing for Taproot script path spends.
 * Implements BIP341 tapscript sighash + Schnorr signing using @noble/curves.
 *
 * Supports the tr_multileaf vault format produced by the DynastyTrust compiler.
 * Each spending path is a separate Taproot leaf; signing uses the script path.
 *
 * The BIP341 core (PSBT parse/serialize, tapLeafHash, tapscriptSighash) was
 * extracted to @dynastytrust/bip341-psbt-signer (Cut B stage B0,
 * docs/integration-phase1-signin-and-bridge.md) so Tapit Wallet can vendor
 * the exact same, byte-proven code rather than a reimplementation. What
 * stays here is DynastyTrust-specific: deriving the signing key from a
 * mnemonic and orchestrating signing across a PSBT's inputs.
 */

import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import {
  toHex,
  parsePsbt,
  serializePsbt,
  tapLeafHash,
  tapscriptSighash,
  leafNamesKey,
  leafCommitsToOutput,
  verifyTapScriptSig,
  type ParsedPsbt,
} from "@dynastytrust/bip341-psbt-signer";

// ── Public API ────────────────────────────────────────────────────────────────

export interface SignResult {
  psbt_hex: string;
  signaturesAdded: number;
}

/**
 * Sign a PSBT with a private key derived from a mnemonic.
 * Signs all inputs where the key's pubkey appears in tap_leaf_script.
 */
export async function signPsbtWithMnemonic(
  psbtHex: string,
  mnemonic: string,
  derivationPath: string,
  network: "testnet" | "bitcoin"
): Promise<SignResult> {
  const networkVersions = network === "bitcoin"
    ? { private: 0x0488ade4, public: 0x0488b21e }
    : { private: 0x04358394, public: 0x043587cf };

  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed, networkVersions);
  // The keystore's `derivationPath` is the account path (xpub level).
  // The pubkey embedded in the leaf script lives one step deeper at
  // /0/0 (first receive-chain child). Sign with that private key so
  // the signature matches the leaf's pubkey.
  const account = root.derive(derivationPath);
  const child00 = account.deriveChild(0).deriveChild(0);

  if (!child00.privateKey) throw new Error("Could not derive private key");

  const privKey = child00.privateKey;
  const pubKey = secp256k1.getPublicKey(privKey, true); // compressed
  const xOnlyPubKey = pubKey.slice(1); // x-only (32 bytes)

  const parsed = parsePsbt(psbtHex);
  let signaturesAdded = 0;

  for (let i = 0; i < parsed.inputs.length; i++) {
    const inp = parsed.inputs[i];
    if (!inp.tapLeafScript || inp.tapLeafScript.length === 0) continue;

    for (const leaf of inp.tapLeafScript) {
      // Is our key one this leaf script actually NAMES? Walked opcode by
      // opcode -- a substring search over the hex also matched our key
      // bytes inside a longer data push or at an odd nibble offset.
      if (!leafNamesKey(leaf.script, xOnlyPubKey)) continue;
      // And is this leaf really part of the coin being spent? Recompute
      // the output key from the control block and compare it with the
      // input's scriptPubKey. A leaf someone merely attached to the PSBT
      // fails here, so we never sign for a script that is not ours.
      if (!inp.witnessUtxo || !leafCommitsToOutput(leaf, inp.witnessUtxo.scriptPubkey)) {
        throw new Error(
          `Refusing to sign: input ${i + 1} carries a spending path that is not part of the coin it spends. This PSBT was altered.`,
        );
      }

      // Compute leaf hash
      const leafHash = tapLeafHash(leaf.script, leaf.leafVersion);

      // Compute sighash
      let sighash: Uint8Array;
      try {
        sighash = tapscriptSighash(parsed, i, leafHash, 0x00);
      } catch (e) {
        console.warn("Sighash failed for input " + i + ":", e);
        continue;
      }

      // Sign with Schnorr
      const sig = schnorr.sign(sighash, privKey);

      // Add to parsed input
      if (!inp.tapScriptSigs) inp.tapScriptSigs = [];
      // Remove existing sig for this pubkey+leaf if any
      inp.tapScriptSigs = inp.tapScriptSigs.filter(
        s => !(toHex(s.pubkey) === toHex(xOnlyPubKey) && toHex(s.leafHash) === toHex(leafHash))
      );
      inp.tapScriptSigs.push({ pubkey: xOnlyPubKey, leafHash, sig });
      signaturesAdded++;
    }
  }

  if (signaturesAdded === 0) {
    throw new Error("This key is not a signer for any input in this PSBT. Make sure the key matches the vault.");
  }

  const signedHex = serializePsbt(parsed);
  return { psbt_hex: signedHex, signaturesAdded };
}

/**
 * Count how many signatures are present in a PSBT.
 */
export function countSignatures(psbtHex: string): number {
  try {
    const parsed = parsePsbt(psbtHex);
    let count = 0;
    for (let i = 0; i < parsed.inputs.length; i++) count += validSigs(parsed, i, parsed.inputs[i].tapScriptSigs ?? []).length;
    return count;
  } catch {
    return 0;
  }
}

/**
 * The public keys (x-only hex) with a real signature on EVERY input of
 * this PSBT. Twin of netlify/functions/_psbt-verify.js's function of
 * the same name: "fully signed" is decided from WHO signed
 * (vault-spending-paths.ts, pathSignatureStatus), never from a count.
 */
export function signersOnEveryInput(psbtHex: string): string[] {
  try {
    const parsed = parsePsbt(psbtHex);
    let common: Set<string> | null = null;
    for (let i = 0; i < parsed.inputs.length; i++) {
      const here = new Set(validSigs(parsed, i, parsed.inputs[i].tapScriptSigs ?? []).map(s => toHex(s.pubkey)));
      common = common === null ? here : new Set([...common].filter(k => here.has(k)));
    }
    return common === null ? [] : [...common];
  } catch {
    return [];
  }
}

type TapSig = { pubkey: Uint8Array; leafHash: Uint8Array; sig: Uint8Array };

/**
 * The signatures among `sigs` that are REAL for input `i` of `base`:
 * each must verify (BIP 340 over the BIP 341 sighash) for a key named
 * by one of `base`'s own leaves, and that leaf must be committed to by
 * the coin. One per (key, leaf). Garbage bytes filed under a co-signer's
 * key, and signatures over leaves somebody invented, are dropped -- the
 * progress bar and the merge only ever count what the chain would.
 */
function validSigs(base: ParsedPsbt, i: number, sigs: TapSig[]): TapSig[] {
  const inp = base.inputs[i];
  const spk = inp.witnessUtxo?.scriptPubkey;
  const leaves = spk ? (inp.tapLeafScript ?? []).filter(l => leafCommitsToOutput(l, spk)) : [];
  const out: TapSig[] = [];
  for (const s of sigs) {
    const dup = out.some(o => toHex(o.pubkey) === toHex(s.pubkey) && toHex(o.leafHash) === toHex(s.leafHash));
    if (!dup && verifyTapScriptSig(base, i, s, leaves)) out.push(s);
  }
  return out;
}

export interface PsbtRequestCheck {
  destination: string;
  /** Expected exact amount of the destination output, in sats. Compare
   *  against the server's OWN echoed summary.amount_sats for a sweep
   *  (where the real amount is server-derived), or the amount the human
   *  actually requested for a fixed-amount spend. */
  amountSats: number;
  network: "bitcoin" | "testnet" | "signet";
  /** The address whose coins this spend is allowed to touch -- the vault's
   *  own address (or a tranche's). When given, EVERY input must spend
   *  exactly this script and any change output must return exactly to it.
   *  This is what makes the coordinator (Netlify function, Supabase row,
   *  Rust compiler) unable to redirect "change" or sweep in a foreign
   *  input: the check reads the PSBT's own witness UTXOs, never a server
   *  summary. */
  ownAddress?: string;
  /** The fee the human is shown, in sats. When given, the real fee
   *  (sum of witness-UTXO inputs minus sum of outputs) must equal it. */
  feeSats?: number;
  /** The change the human is shown, in sats. When given, a 0 means the
   *  PSBT must have no change output at all, and a positive value must
   *  equal output[1]'s amount exactly. */
  changeSats?: number;
}

export interface PsbtVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Re-parse a server-returned PSBT and confirm its real bytes actually pay
 * what was requested, before a human is shown a confirm screen built from
 * the server's own summary text alone. Kimi K3 scan Family A ("blind trust
 * of server-returned PSBTs"): #9/#14/#40/#50/#53/#54/#67/#77/#84/#93/#124/
 * #132/#140 are all instances of the same gap -- the client set psbtHex
 * from a response and rendered res.summary directly, with nothing that
 * re-derives what the PSBT actually does from the PSBT's own bytes.
 *
 * By this app's own architecture the destination output is always
 * output[0] -- every server-side builder (compiler/src/main.rs's
 * psbt_binary, protocol/src/psbt_builder.rs's build_bloc_spend_psbt /
 * build_tranche_spend_psbt) constructs `tx_outputs` with the destination
 * pushed first, change (if any) second, and never more than two outputs.
 * A third output, or a destination output at any other index, is not a
 * shape this app's own compiler ever produces -- reject rather than
 * trust it.
 */
export function verifyPsbtMatchesRequest(
  psbtHex: string,
  request: PsbtRequestCheck,
): PsbtVerifyResult {
  let parsed: ParsedPsbt;
  try {
    parsed = parsePsbt(psbtHex);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not parse PSBT" };
  }

  if (parsed.tx.outputs.length === 0 || parsed.tx.outputs.length > 2) {
    return { ok: false, reason: `Unexpected output count: ${parsed.tx.outputs.length}` };
  }

  let expectedScript: Uint8Array;
  try {
    const net = request.network === "bitcoin" ? NETWORK : TEST_NETWORK;
    expectedScript = OutScript.encode(Address(net).decode(request.destination));
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not decode destination address" };
  }

  const destOutput = parsed.tx.outputs[0];
  if (toHex(destOutput.scriptPubkey) !== toHex(expectedScript)) {
    return { ok: false, reason: "The PSBT's destination does not match the address you entered" };
  }
  if (destOutput.amount !== BigInt(request.amountSats)) {
    return {
      ok: false,
      reason: `The PSBT pays ${destOutput.amount} sats, not the ${request.amountSats} sats shown`,
    };
  }

  // Everything below reads the PSBT's own witness UTXOs (BIP174
  // PSBT_IN_WITNESS_UTXO), which every tapscript spend must carry because
  // the BIP341 sighash commits to every spent amount and scriptPubKey.
  // An input without one cannot be checked, so it is refused rather than
  // assumed benign -- the server is the party under suspicion here.
  const inputsNeedUtxo = request.ownAddress !== undefined || request.feeSats !== undefined;
  if (inputsNeedUtxo) {
    for (let i = 0; i < parsed.inputs.length; i++) {
      if (!parsed.inputs[i].witnessUtxo) {
        return { ok: false, reason: `Input ${i + 1} carries no witness UTXO, so what it spends cannot be verified` };
      }
    }
  }

  if (request.ownAddress !== undefined) {
    let ownScript: string;
    try {
      const net = request.network === "bitcoin" ? NETWORK : TEST_NETWORK;
      ownScript = toHex(OutScript.encode(Address(net).decode(request.ownAddress)));
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "Could not decode the vault's own address" };
    }
    for (let i = 0; i < parsed.inputs.length; i++) {
      if (toHex(parsed.inputs[i].witnessUtxo!.scriptPubkey) !== ownScript) {
        return { ok: false, reason: `Input ${i + 1} does not spend this vault's own coins` };
      }
    }
    if (parsed.tx.outputs.length === 2 && toHex(parsed.tx.outputs[1].scriptPubkey) !== ownScript) {
      return { ok: false, reason: "The PSBT's change output does not return to this vault" };
    }
  }

  if (request.changeSats !== undefined) {
    if (!Number.isSafeInteger(request.changeSats) || request.changeSats < 0) {
      return { ok: false, reason: `Invalid change amount shown: ${request.changeSats}` };
    }
    if (request.changeSats === 0 && parsed.tx.outputs.length !== 1) {
      return { ok: false, reason: "The PSBT has a change output, but no change was shown" };
    }
    if (request.changeSats > 0) {
      if (parsed.tx.outputs.length !== 2) {
        return { ok: false, reason: "The PSBT has no change output, but change was shown" };
      }
      if (parsed.tx.outputs[1].amount !== BigInt(request.changeSats)) {
        return {
          ok: false,
          reason: `The PSBT returns ${parsed.tx.outputs[1].amount} sats of change, not the ${request.changeSats} sats shown`,
        };
      }
    }
  }

  if (request.feeSats !== undefined) {
    if (!Number.isSafeInteger(request.feeSats) || request.feeSats < 0) {
      return { ok: false, reason: `Invalid fee shown: ${request.feeSats}` };
    }
    const totalIn = parsed.inputs.reduce((s, inp) => s + inp.witnessUtxo!.amount, 0n);
    const totalOut = parsed.tx.outputs.reduce((s, o) => s + o.amount, 0n);
    const fee = totalIn - totalOut;
    if (fee < 0n) {
      return { ok: false, reason: "The PSBT's outputs exceed its inputs" };
    }
    if (fee !== BigInt(request.feeSats)) {
      return { ok: false, reason: `The PSBT's real fee is ${fee} sats, not the ${request.feeSats} sats shown` };
    }
  }

  return { ok: true };
}

/**
 * Two PSBTs are "the same spend" if their unsigned transactions match
 * exactly -- same inputs (txid+vout+sequence, same order) and same
 * outputs (amount+scriptPubkey, same order). A signature is
 * cryptographically bound to the sighash it was computed over, so a
 * signature from a genuinely different transaction could never
 * validate here regardless -- this check exists so a mismatch fails
 * with a clear error at merge time instead of a cryptic finalize
 * failure later, and so co-signers merging PSBTs from different
 * coordinator responses get an explicit signal if they were ever
 * handed two different transactions to sign.
 */
function sameUnsignedTx(a: ParsedPsbt, b: ParsedPsbt): boolean {
  if (a.tx.inputs.length !== b.tx.inputs.length) return false;
  if (a.tx.outputs.length !== b.tx.outputs.length) return false;
  if (a.tx.version !== b.tx.version || a.tx.locktime !== b.tx.locktime) return false;
  for (let i = 0; i < a.tx.inputs.length; i++) {
    const ai = a.tx.inputs[i], bi = b.tx.inputs[i];
    if (toHex(ai.txid) !== toHex(bi.txid) || ai.vout !== bi.vout || ai.sequence !== bi.sequence) return false;
  }
  for (let i = 0; i < a.tx.outputs.length; i++) {
    const ao = a.tx.outputs[i], bo = b.tx.outputs[i];
    if (ao.amount !== bo.amount || toHex(ao.scriptPubkey) !== toHex(bo.scriptPubkey)) return false;
  }
  return true;
}

/**
 * Merge multiple PSBTs by combining their tap_script_sigs.
 * All PSBTs must be for the exact same underlying transaction.
 */
export function mergePsbts(psbtHexes: string[]): string {
  if (psbtHexes.length === 0) throw new Error("No PSBTs to merge");
  const first = parsePsbt(psbtHexes[0]);
  for (let p = 1; p < psbtHexes.length; p++) {
    const other = parsePsbt(psbtHexes[p]);
    if (!sameUnsignedTx(first, other)) {
      throw new Error(
        `PSBT ${p + 1} of ${psbtHexes.length} is for a different transaction than the others -- refusing to merge signatures across mismatched spends.`
      );
    }
    for (let i = 0; i < first.inputs.length; i++) {
      // Verify against the FIRST PSBT's own leaves and amounts (the one
      // the caller already checked), never the ones that arrived with a
      // signature. An unverifiable entry can no longer occupy a signer's
      // slot and shut the real signature out.
      first.inputs[i].tapScriptSigs = validSigs(first, i, [
        ...(first.inputs[i].tapScriptSigs ?? []),
        ...(other.inputs[i].tapScriptSigs ?? []),
      ]);
    }
  }
  if (psbtHexes.length === 1) {
    for (let i = 0; i < first.inputs.length; i++) {
      first.inputs[i].tapScriptSigs = validSigs(first, i, first.inputs[i].tapScriptSigs ?? []);
    }
  }
  return serializePsbt(first);
}
