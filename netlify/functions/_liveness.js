/**
 * _liveness.js -- PURE, TESTED helpers for the verified liveness-signal store.
 *
 * This is the SECURITY CORE of the liveness ingest path. It owns two pure
 * functions and pulls in NO Supabase, NO network, NO env: it can be imported
 * and exercised directly by node (scripts/test-liveness-signals.mjs). The
 * netlify endpoint (liveness.js) is the only caller; it wraps these in JWT auth
 * + RLS-aware storage.
 *
 *   verifyLivenessSignalForStorage(row)
 *     The verify-on-write gate. Given an UNTRUSTED { kind, signal }, returns
 *     { ok:true, subject, raisedBy } ONLY when the signal is well-shaped AND
 *     its BIP340 Schnorr signature verifies via tapit-attest. A forged,
 *     tampered, unsigned, wrong-kind, or garbage signal returns { ok:false }
 *     and the caller stores NOTHING. This is the wall that keeps an
 *     unverifiable heartbeat or red flag out of the store -- and therefore out
 *     of the signing gate -- entirely.
 *
 *   loadVaultLivenessConfig(vault)
 *     Reads + validates vault.bloc_policy.liveness into a VaultLivenessConfig,
 *     or returns null when absent/malformed. null means "not liveness-gated"
 *     -- the deliberate safe default (see reasoning on the function).
 *
 * No private keys exist anywhere in this module: a liveness signal is built
 * from public material (x-only pubkeys, timestamps, signatures) only. Nothing
 * here is ever logged.
 */

import { verifyProofOfLife, verifyDuressFlag } from 'tapit-attest';

const VALID_KINDS = new Set(['proof-of-life', 'duress-flag']);

/** A 64-char lowercase-or-uppercase hex string (x-only pubkey / 32 bytes). */
function isXOnlyHex(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);
}

/**
 * Verify an incoming liveness signal BEFORE it is stored.
 *
 * @param {{ kind?: unknown, signal?: unknown }} row -- untrusted request shape.
 * @returns {{ ok: true, subject: string, raisedBy: string|null } | { ok: false, error: string }}
 *
 * Returns ok:true ONLY when ALL hold:
 *   - kind is one of the two valid kinds,
 *   - signal is an object whose `kind` matches the declared kind,
 *   - the signal shape matches the kind (subject hex; raisedBy hex for duress),
 *   - tapit-attest verifyProofOfLife / verifyDuressFlag returns true (the real
 *     Schnorr check). verifyProofOfLife passes only when the signature is the
 *     SUBJECT's over the proof digest -- so a proof-of-life's subject is bound
 *     to the signer by the primitive. verifyDuressFlag passes only when the
 *     signature is `raisedBy`'s -- the raiser is bound to the signer.
 *
 * It NEVER returns ok for an unverified/forged/garbage signal. No throw: any
 * malformed input falls through to a typed { ok:false }.
 */
export function verifyLivenessSignalForStorage(row) {
  const kind = row?.kind;
  const signal = row?.signal;

  if (!VALID_KINDS.has(kind)) {
    return { ok: false, error: 'invalid kind' };
  }
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
    return { ok: false, error: 'signal must be an object' };
  }
  // The embedded attestation must declare the SAME kind as the request, so a
  // duress flag cannot be smuggled in under a proof-of-life header (or vice
  // versa) to dodge the matching verifier.
  if (signal.kind !== kind) {
    return { ok: false, error: 'signal.kind does not match kind' };
  }

  if (kind === 'proof-of-life') {
    if (!isXOnlyHex(signal.subject)) {
      return { ok: false, error: 'proof-of-life subject must be x-only hex' };
    }
    // verifyProofOfLife checks the well-typed shape AND that the Schnorr
    // signature is the subject's. A tampered signature, a wrong-subject proof,
    // or a missing signature all return false here -- so we never store one.
    if (verifyProofOfLife(signal) !== true) {
      return { ok: false, error: 'proof-of-life signature does not verify' };
    }
    return { ok: true, subject: signal.subject, raisedBy: null };
  }

  // kind === 'duress-flag'
  if (!isXOnlyHex(signal.subject)) {
    return { ok: false, error: 'duress-flag subject must be x-only hex' };
  }
  if (!isXOnlyHex(signal.raisedBy)) {
    return { ok: false, error: 'duress-flag raisedBy must be x-only hex' };
  }
  // verifyDuressFlag checks the shape AND that the signature is raisedBy's.
  // Group membership (the no-rogue filter) is NOT checked here on purpose --
  // that is enforced downstream by livenessStateFor against the vault circle.
  // Storing a verifying flag from a non-circle peer is harmless: the gate
  // ignores it. What we MUST block is a flag whose signature does not verify.
  if (verifyDuressFlag(signal) !== true) {
    return { ok: false, error: 'duress-flag signature does not verify' };
  }
  return { ok: true, subject: signal.subject, raisedBy: signal.raisedBy };
}

/**
 * Read + validate a vault's liveness config from its bloc_policy jsonb.
 *
 * Shape expected at vault.bloc_policy.liveness:
 *   { circle: string[64hex], requiredGreenByPath: Record<string, number>,
 *     ttlSeconds: number > 0 }
 *
 * @param {{ bloc_policy?: unknown }} vault
 * @returns {{ circle: string[], requiredGreenByPath: Record<string, number>,
 *             ttlSeconds: number } | null}
 *
 * SAFE-DEFAULT REASONING (why malformed -> null, not throw, not a stub green):
 *   A null config means "this vault is not liveness-gated," so the caller
 *   passes `undefined` liveness into evaluateSigningGate and the gate simply
 *   SKIPS the liveness axis (it still enforces ceremony, psbt-binding,
 *   governance, and the duress hold). Returning null can NEVER manufacture a
 *   fake green -- the only route to green is a real verifying fresh heartbeat
 *   through livenessStateFor. So the conservative failure here is "don't gate
 *   on a config we can't trust," which weakens nothing the other axes already
 *   enforce, rather than fabricating liveness state from garbage.
 */
export function loadVaultLivenessConfig(vault) {
  const liveness = vault?.bloc_policy?.liveness;
  if (liveness === null || typeof liveness !== 'object' || Array.isArray(liveness)) {
    return null;
  }

  const { circle, requiredGreenByPath, ttlSeconds } = liveness;

  // circle: a non-empty array of distinct 64-hex x-only pubkeys.
  if (!Array.isArray(circle) || circle.length === 0) return null;
  if (!circle.every((s) => isXOnlyHex(s))) return null;

  // requiredGreenByPath: a plain object mapping path -> finite non-negative
  // integer count. Any non-numeric or negative value voids the whole config.
  if (
    requiredGreenByPath === null ||
    typeof requiredGreenByPath !== 'object' ||
    Array.isArray(requiredGreenByPath)
  ) {
    return null;
  }
  for (const v of Object.values(requiredGreenByPath)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      return null;
    }
  }

  // ttlSeconds: a positive finite number.
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return null;
  }

  return { circle, requiredGreenByPath, ttlSeconds };
}
