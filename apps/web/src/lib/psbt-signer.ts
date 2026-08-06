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
import {
  toHex,
  parsePsbt,
  serializePsbt,
  tapLeafHash,
  tapscriptSighash,
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
      // Check if our pubkey is in this leaf script
      const scriptHex = toHex(leaf.script);
      if (!scriptHex.includes(toHex(xOnlyPubKey))) continue;

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
    return parsed.inputs.reduce((sum, inp) => sum + (inp.tapScriptSigs?.length ?? 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Merge multiple PSBTs by combining their tap_script_sigs.
 */
export function mergePsbts(psbtHexes: string[]): string {
  if (psbtHexes.length === 0) throw new Error("No PSBTs to merge");
  const first = parsePsbt(psbtHexes[0]);
  for (let p = 1; p < psbtHexes.length; p++) {
    const other = parsePsbt(psbtHexes[p]);
    for (let i = 0; i < first.inputs.length; i++) {
      const otherSigs = other.inputs[i].tapScriptSigs ?? [];
      if (!first.inputs[i].tapScriptSigs) first.inputs[i].tapScriptSigs = [];
      for (const sig of otherSigs) {
        const exists = first.inputs[i].tapScriptSigs!.some(
          s => toHex(s.pubkey) === toHex(sig.pubkey) && toHex(s.leafHash) === toHex(sig.leafHash)
        );
        if (!exists) first.inputs[i].tapScriptSigs!.push(sig);
      }
    }
  }
  return serializePsbt(first);
}
