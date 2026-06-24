/**
 * liveness-gate.ts -- PURE GLUE: vault liveness config + received circle
 * signals -> the exact `liveness` input the fail-closed signing gate accepts.
 *
 * THE SEAM THIS BRIDGES
 *   The fail-closed gate (packages/policy-engine/src/index.ts,
 *   evaluateSigningGate) already accepts an optional
 *     liveness?: { memberStates: LivenessState[]; requiredGreen: number }
 *   and denies LIVENESS_RED (a single red dominates) or LIVENESS_NOT_GREEN
 *   (greens short of the leg's required count). What was missing was the
 *   glue that turns "we have a circle and some signed signals" into exactly
 *   that object. This module is that glue and nothing more. It does NO
 *   storage, NO network, NO Supabase, NO endpoint, and it does NOT touch the
 *   signing path. It is pure and `now` is injectable so it is unit-testable
 *   in isolation.
 *
 * SAFE-BY-DEFAULT (the load-bearing property)
 *   This module pre-trusts NOTHING. It never inspects a signature itself and
 *   never decides "green" on its own. For each circle subject it delegates
 *   entirely to tapit-attest `livenessStateFor`, which:
 *     - returns 'green' ONLY for a fresh (within ttlSeconds), signature-
 *       verifying, self-signed heartbeat,
 *     - returns 'red' ONLY for a signature-verifying duress flag raised by
 *       someone inside the subject's own group (the no-rogue filter; reds
 *       from outsiders are ignored), with red dominating a fresh heartbeat,
 *     - returns 'no-report' for everything else -- no proof, a proof that
 *       fails to verify, a forged/tampered proof, a stale proof past ttl, or
 *       a proof for the wrong subject.
 *   So a member with no signal, a forged signal, or a stale signal is
 *   'no-report' and is NEVER counted green. There is no code path in this
 *   module that can upgrade a member to green or clear a red. The
 *   conservative reading wins by construction: the only way to be green is
 *   to actually be green per the verified primitive.
 *
 * THE STORE + LOADER NOW EXIST (built in the ingest cut)
 *   The VERIFIED Supabase store and the config loader that this module was
 *   designed to consume are now in place:
 *     - netlify/functions/liveness.js: circle members POST their signed
 *       proof-of-life / duress-flag signals; the SERVER verifies each signature
 *       ON WRITE (verifyLivenessSignalForStorage in _liveness.js) so an
 *       unverifiable signal is rejected before it is ever stored. GET returns
 *       the vault's held signals as { proofs, redFlags } -- exactly the shape
 *       this module's `proofs` and `redFlags` args expect.
 *     - netlify/functions/_liveness.js loadVaultLivenessConfig(vault): reads +
 *       validates vault.bloc_policy.liveness into a VaultLivenessConfig, or
 *       null when absent/malformed (null = not liveness-gated, the safe
 *       default). The config (circle + requiredGreenByPath + ttlSeconds) lives
 *       under bloc_policy.liveness; see db/migrations/024_liveness_signals.sql.
 *
 * THE FINAL SEAM (the LAST wire, deliberately NOT made in this cut)
 *   At sign time in apps/web VaultDetail, the one remaining wire is: GET the
 *   vault's signals from /api/liveness, get its VaultLivenessConfig via
 *   loadVaultLivenessConfig(vault), call assembleLivenessGateInput({ config,
 *   path, proofs, redFlags }) here, and pass the returned object as the
 *   `liveness` field into evaluateSigningGate alongside the existing ceremony /
 *   psbt-binding / governance inputs. Only then does the gate deny
 *   LIVENESS_RED / LIVENESS_NOT_GREEN for real. That wire is intentionally NOT
 *   made yet; the signing path is untouched this cut, leaving a clean,
 *   documented seam.
 */

import { livenessStateFor } from 'tapit-attest';
import type { ProofOfLife, DuressFlag, LivenessState } from 'tapit-attest';

/**
 * A vault's liveness configuration. In a later cut this is read from vault
 * config (a Bloc policy leg / the vault_members liveness circle); here it is
 * just the typed shape the assembler consumes.
 */
export interface VaultLivenessConfig {
  /**
   * The liveness circle: x-only public keys (32-byte hex) of the chosen
   * people whose signals decide this vault's liveness. This same set is the
   * `group` passed to livenessStateFor, so it doubles as the no-rogue filter
   * (only these keys -- plus a subject flagging themselves -- can raise red).
   */
  circle: string[];
  /**
   * Leg/path id (e.g. 'parents_now', 'recovery', 'inheritance') -> the number
   * of green circle members that leg requires. A path absent from this map is
   * NOT liveness-gated (see assembleLivenessGateInput's undefined return).
   */
  requiredGreenByPath: Record<string, number>;
  /**
   * Freshness window in seconds. A heartbeat older than this stops counting
   * as green. Chosen by the verifier (the vault config), never by the signer.
   */
  ttlSeconds: number;
}

/**
 * Assemble the gate's `liveness` input from a vault's liveness config and the
 * circle's received signals. PURE: no storage, no network, no crypto of its
 * own. `now` is injectable for tests.
 *
 * For each subject in `config.circle` (kept IN CIRCLE ORDER so memberStates
 * lines up with the circle) it computes the derived state via
 * `livenessStateFor`, passing the whole circle as the `group` so the
 * primitive's no-rogue filter and freshness check apply. A subject with no
 * proof, a non-verifying proof, or a stale proof comes back 'no-report'; only
 * a fresh self-signed verifying heartbeat is 'green'; only a verifying
 * in-group flag is 'red'.
 *
 * `requiredGreen` is `config.requiredGreenByPath[path]`. If the path has NO
 * configured requirement, this returns `undefined` -- meaning "this leg is
 * not liveness-gated." That matches the gate treating an undefined `liveness`
 * field as not-applicable (exactly like an undefined `governanceApproved`),
 * so an un-gated leg is unaffected by liveness rather than being blocked. The
 * caller passes the undefined straight through to evaluateSigningGate.
 *
 * @returns `{ memberStates, requiredGreen }` for a liveness-gated leg, or
 *          `undefined` when the path has no configured required-green count.
 */
export function assembleLivenessGateInput(args: {
  config: VaultLivenessConfig;
  path: string;
  proofs: Record<string, ProofOfLife | null | undefined>;
  redFlags: DuressFlag[];
  now?: number;
}): { memberStates: LivenessState[]; requiredGreen: number } | undefined {
  const { config, path, proofs, redFlags, now } = args;

  // Not-configured -> not liveness-gated. Return undefined so the gate skips
  // the liveness axis for this leg (backward-compatible, not a denial).
  const requiredGreen = config.requiredGreenByPath[path];
  if (requiredGreen === undefined) return undefined;

  // For each circle subject, in circle order, derive its state. We pre-trust
  // nothing: livenessStateFor does the signature verification, the no-rogue
  // group filter, and the freshness window. A forged or stale signal can only
  // come back 'no-report', never 'green'.
  const memberStates: LivenessState[] = config.circle.map((subject) =>
    livenessStateFor({
      subject,
      group: config.circle,
      proofOfLife: proofs[subject] ?? null,
      redFlags,
      ttlSeconds: config.ttlSeconds,
      now,
    }),
  );

  return { memberStates, requiredGreen };
}
