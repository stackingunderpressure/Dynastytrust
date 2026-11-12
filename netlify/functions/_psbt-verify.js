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
import { parsePsbt, leafCommitsToOutput, verifyTapScriptSig, toHex } from "@dynastytrust/bip341-psbt-signer";

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

/**
 * The public keys (x-only hex) that have a REAL signature on EVERY input
 * of this PSBT -- each one verified against a leaf the coin commits to.
 * A key that signed one input of two has not signed the spend. This is
 * what "fully signed" must be decided from: a path with must-sign keys
 * or a consent group is not satisfied by a COUNT of signatures.
 * Unreadable PSBT -> no signers.
 */
export function signersOnEveryInput(psbtHex) {
  let p;
  try { p = parsePsbt(psbtHex); } catch { return []; }
  let common = null;
  for (let i = 0; i < p.inputs.length; i++) {
    const spk = p.inputs[i].witnessUtxo?.scriptPubkey;
    const leaves = spk ? (p.inputs[i].tapLeafScript ?? []).filter((l) => leafCommitsToOutput(l, spk)) : [];
    const here = new Set();
    for (const s of p.inputs[i].tapScriptSigs ?? []) {
      if (verifyTapScriptSig(p, i, s, leaves)) here.add(toHex(s.pubkey));
    }
    common = common === null ? here : new Set([...common].filter((k) => here.has(k)));
  }
  return common === null ? [] : [...common];
}

/**
 * @param {{ psbtHex: string, proposalPsbtHex?: string | null }} args
 * @returns {{ ok: true, validSignatures: number } | { ok: false, error: string }}
 *
 * Hardened 2026-11-10 after an adversarial review showed the first
 * version could be fooled: it read the leaf scripts from the SUBMITTED
 * PSBT, so a member could attach invented leaves naming fresh keys,
 * sign those, and be counted as three signers; and it let garbage
 * filed under a co-signer's key ride along. Now:
 *   - the proposal's STORED PSBT is required and is the only source of
 *     leaves, amounts and scripts; the submission contributes
 *     signatures and nothing else;
 *   - each stored leaf must really be committed to by the coin it
 *     spends (control-block check);
 *   - EVERY tap_script_sig in the submission must verify. One bad
 *     entry refuses the whole thing -- a submission is a statement
 *     that "these are signatures", and a false one is not stored.
 */
export function verifySignedPsbt({ psbtHex, proposalPsbtHex }) {
  if (typeof psbtHex !== "string" || psbtHex.length === 0) {
    return { ok: false, error: "psbt_partial_hex is missing" };
  }
  if (!proposalPsbtHex) {
    return { ok: false, error: "this proposal has no transaction on file to sign yet" };
  }
  let parsed, base;
  try {
    parsed = parsePsbt(psbtHex);
  } catch (e) {
    return { ok: false, error: `not a valid PSBT: ${e?.message || e}` };
  }
  try {
    base = parsePsbt(proposalPsbtHex);
  } catch {
    return { ok: false, error: "this proposal's stored PSBT is unreadable" };
  }
  if (!sameUnsignedTx(base, parsed)) {
    return { ok: false, error: "this PSBT is for a different transaction than the proposal" };
  }

  let validSignatures = 0;
  const seen = new Set();
  for (let i = 0; i < parsed.inputs.length; i++) {
    const spk = base.inputs[i].witnessUtxo?.scriptPubkey;
    const leaves = spk ? (base.inputs[i].tapLeafScript ?? []).filter((l) => leafCommitsToOutput(l, spk)) : [];
    for (const s of parsed.inputs[i].tapScriptSigs ?? []) {
      if (!verifyTapScriptSig(base, i, s, leaves)) {
        return { ok: false, error: "this PSBT contains a signature that does not verify for this proposal" };
      }
      const id = `${i}:${toHex(s.pubkey)}:${toHex(s.leafHash)}`;
      if (!seen.has(id)) { seen.add(id); validSignatures++; }
    }
  }
  if (validSignatures === 0) {
    return { ok: false, error: "this PSBT carries no valid signature for this transaction" };
  }
  return { ok: true, validSignatures };
}
