/**
 * _psbt-verify.js -- does a submitted PSBT actually carry a real
 * signature for the proposal it claims to sign?
 *
 * signer-sessions.js used to store whatever hex it was handed and mark
 * the row `signed: true`: "00" recorded as a signature showed up as one
 * in the proposal list, the audit PDF and the activity export. The
 * chain would never accept it, but the record people read would say a
 * person signed who did not.
 *
 * This checks, from the PSBT's own bytes (same shared, byte-proven BIP341
 * code the browser signs with):
 *   1. it parses;
 *   2. it is the SAME unsigned transaction as the proposal's stored PSBT
 *      (inputs, sequences, outputs, version, locktime);
 *   3. at least one tapscript signature in it is cryptographically valid
 *      -- a BIP340 signature, over the BIP341 sighash, by a key that
 *      appears in the leaf script it claims to sign.
 *
 * It deliberately does NOT require the signature to be from the
 * caller's own registered key: an owner who holds several of a vault's
 * keys signs with each under one membership, and a hardware or Tapit
 * signature is relayed by the member who collected it. What is recorded
 * is "this PSBT now carries N valid signatures", which is what it says.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { parsePsbt, tapLeafHash, tapscriptSighash, toHex } from "@dynastytrust/bip341-psbt-signer";

function sameUnsignedTx(a, b) {
  if (a.tx.version !== b.tx.version || a.tx.locktime !== b.tx.locktime) return false;
  if (a.tx.inputs.length !== b.tx.inputs.length || a.tx.outputs.length !== b.tx.outputs.length) return false;
  for (let i = 0; i < a.tx.inputs.length; i++) {
    const x = a.tx.inputs[i], y = b.tx.inputs[i];
    if (toHex(x.txid) !== toHex(y.txid) || x.vout !== y.vout || x.sequence !== y.sequence) return false;
  }
  for (let i = 0; i < a.tx.outputs.length; i++) {
    const x = a.tx.outputs[i], y = b.tx.outputs[i];
    if (x.amount !== y.amount || toHex(x.scriptPubkey) !== toHex(y.scriptPubkey)) return false;
  }
  return true;
}

/** Count the cryptographically valid tapscript signatures in a parsed PSBT. */
function countValidSignatures(parsed) {
  let valid = 0;
  for (let i = 0; i < parsed.inputs.length; i++) {
    const inp = parsed.inputs[i];
    for (const s of inp.tapScriptSigs ?? []) {
      const leaf = (inp.tapLeafScript ?? []).find(
        (l) => toHex(tapLeafHash(l.script, l.leafVersion)) === toHex(s.leafHash),
      );
      if (!leaf) continue;
      // The signing key must be one the leaf script actually names.
      if (!toHex(leaf.script).includes(toHex(s.pubkey))) continue;
      // 64 bytes = SIGHASH_DEFAULT; 65 = explicit type in the last byte.
      if (s.sig.length !== 64 && s.sig.length !== 65) continue;
      const sighashType = s.sig.length === 65 ? s.sig[64] : 0x00;
      try {
        const digest = tapscriptSighash(parsed, i, s.leafHash, sighashType);
        if (schnorr.verify(s.sig.slice(0, 64), digest, s.pubkey)) valid++;
      } catch {
        /* an input we cannot compute a sighash for carries no valid signature */
      }
    }
  }
  return valid;
}

/**
 * @param {{ psbtHex: string, proposalPsbtHex?: string | null }} args
 * @returns {{ ok: true, validSignatures: number } | { ok: false, error: string }}
 */
export function verifySignedPsbt({ psbtHex, proposalPsbtHex }) {
  if (typeof psbtHex !== "string" || !/^[0-9a-f]+$/i.test(psbtHex) || psbtHex.length % 2 !== 0) {
    return { ok: false, error: "psbt_partial_hex is not hex" };
  }
  let parsed;
  try {
    parsed = parsePsbt(psbtHex);
  } catch (e) {
    return { ok: false, error: `not a valid PSBT: ${e?.message || e}` };
  }
  if (proposalPsbtHex) {
    let base;
    try {
      base = parsePsbt(proposalPsbtHex);
    } catch {
      return { ok: false, error: "this proposal's stored PSBT is unreadable" };
    }
    if (!sameUnsignedTx(base, parsed)) {
      return { ok: false, error: "this PSBT is for a different transaction than the proposal" };
    }
  }
  const validSignatures = countValidSignatures(parsed);
  if (validSignatures === 0) {
    return { ok: false, error: "this PSBT carries no valid signature for this transaction" };
  }
  return { ok: true, validSignatures };
}
