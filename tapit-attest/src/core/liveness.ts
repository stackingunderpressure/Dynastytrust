import { schnorr } from '@noble/curves/secp256k1';
import { canonicalJson } from '../internal/canonical.js';
import { taggedHash } from '../internal/hash.js';
import { utf8, toHex, fromHex } from '../internal/hex.js';

/**
 * Liveness -- the green / no-report / red primitive that the "green ladder"
 * rests on. The security idea is deliberately inverted from a status flag you
 * store and trust: GREEN is never stored anywhere. Green is the DEFAULT a
 * verifier derives at evaluation time from two -- and only two -- kinds of
 * SIGNED attestation, against a freshness window the verifier itself chooses.
 *
 * 1. Proof-of-life (a heartbeat). The SUBJECT signs "I am alive" over a
 *    domain-separated digest of `{ v, kind:'proof-of-life', subject, issuedAt }`.
 *    Nobody but the subject can mint it (the signature is over the subject's
 *    own x-only key). Whether it counts as "green" is not baked into the
 *    attestation -- the verifier passes a `ttlSeconds` and a `now`, and a
 *    heartbeat older than the window simply stops counting. Freshness lives
 *    with the verifier, not the signer, so a stale heartbeat can never be
 *    replayed forward into looking current.
 *
 * 2. Duress / red flag. A PEER signs "I am raising red on subject" over
 *    `{ v, kind:'duress-flag', subject, raisedBy, issuedAt }`. `raisedBy` is
 *    the peer's own x-only key (it always equals the signer). `raisedBy` MAY
 *    equal `subject` -- that is self-duress, a person flipping their own state
 *    red under coercion. Red dominates everything: a single verifying red flag
 *    from a member of the subject's chosen group forces 'red' even atop a
 *    fresh, valid heartbeat.
 *
 * The no-rogue rule. Only the subject's CHOSEN people can flip them red. A red
 * flag whose `raisedBy` is not in the group passed to the tally is ignored
 * entirely -- an attacker who is not on your list cannot make you look
 * compromised. This is the whole point of taking the group as an explicit
 * argument rather than trusting whoever signed.
 *
 * Red-flag expiry choice. Reds PERSIST. There is no automatic TTL on a duress
 * flag; once a chosen peer raises red it holds until every OTHER member of
 * the subject's group has cast a verifying `DuressClear` vote naming that
 * exact flag (see `DuressClear` below and the tally logic in
 * `livenessStateFor`). The conservative reading wins here: an alarm that
 * silently times itself out is worse than one that holds until a human
 * clears it, and an alarm that ONE person (least of all the flagged subject
 * themselves) can silently lift is almost as bad as no alarm at all.
 *
 * Like the sign-in module, this does no anchoring and no storage. Every
 * function is pure; `now` is injectable; nothing reaches the network. The key
 * never leaves the caller -- the `*DigestFor` helpers exist precisely so the
 * Wallet object can sign through its own `signDigest` boundary without ever
 * exposing the raw key.
 *
 * Cross-repo parity: this is a faithful port of the Tapit wallet's
 * `tapit-attest/src/core/liveness.ts`. The digests are
 * `taggedHash('tapit/proof-of-life', utf8(canonicalJson(base)))` and
 * `taggedHash('tapit/duress-flag', utf8(canonicalJson(base)))`, proven
 * byte-identical to the Tapit primitive by `test/liveness.test.mjs`, which
 * verifies real Tapit-produced signals. A Schnorr signature only verifies when
 * both sides compute the identical digest, so that test is the parity gate.
 * Never change the tags, the base shapes, or canonicalJson without regenerating
 * the golden fixtures from Tapit's source.
 */

// How far into the future an issuedAt may sit and still be treated as
// "now" for the green-window check -- real device clocks drift by a
// little; this is not a defense mechanism, just tolerance for that.
// A window far beyond this (a proof-of-life signed decades ahead, the
// #26 exploit shape) never counts as fresh.
const CLOCK_SKEW_TOLERANCE_MS = 2 * 60_000;

function isHex(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || value.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]*$/.test(value)) return false;
  return byteLength === undefined || value.length === byteLength * 2;
}

/** A subject's signed heartbeat: "I am alive as of `issuedAt`." */
export interface ProofOfLife {
  v: 1;
  kind: 'proof-of-life';
  /** x-only public key of the subject (also the signer -- they are the same). */
  subject: string;
  issuedAt: string;
  /** The subject's Schnorr signature over the proof-of-life digest. */
  signature: string;
}

/** A peer's signed red flag raised on a subject. */
export interface DuressFlag {
  v: 1;
  kind: 'duress-flag';
  /** x-only public key of the person being flagged. */
  subject: string;
  /** x-only public key of the peer raising the flag (always the signer). May equal `subject`. */
  raisedBy: string;
  issuedAt: string;
  /** The peer's Schnorr signature over the duress-flag digest. */
  signature: string;
}

/**
 * A peer's signed vote to clear ONE specific red flag. References the flag
 * being cleared by `flagId` (see `duressFlagId` below) rather than just a
 * subject, so a clear vote can never be replayed against a LATER flag on the
 * same subject that the clearer never actually saw.
 *
 * Clearing is deliberately harder than raising: `livenessStateFor` only
 * stops counting a flag once EVERY member of the subject's group, other than
 * the subject themselves, has cast a verifying clear for that exact flag.
 * Neither the flagged subject nor a single peer can lift their own alarm --
 * if the subject were actually compromised, self-clearing would defeat the
 * entire point, and a single rogue or coerced clearer would let one member
 * erase everyone else's alarm.
 */
export interface DuressClear {
  v: 1;
  kind: 'duress-clear';
  /** x-only public key of the person the cleared flag was raised on. */
  subject: string;
  /** duressFlagId of the specific DuressFlag this vote clears. */
  flagId: string;
  /** x-only public key of the peer casting this clear vote (always the signer). */
  clearedBy: string;
  issuedAt: string;
  /** The peer's Schnorr signature over the duress-clear digest. */
  signature: string;
}

type ProofOfLifeBase = Omit<ProofOfLife, 'signature'>;
type DuressFlagBase = Omit<DuressFlag, 'signature'>;
type DuressClearBase = Omit<DuressClear, 'signature'>;

function proofOfLifeBase(att: ProofOfLife): ProofOfLifeBase {
  return { v: att.v, kind: att.kind, subject: att.subject, issuedAt: att.issuedAt };
}

function duressFlagBase(att: DuressFlag): DuressFlagBase {
  return {
    v: att.v,
    kind: att.kind,
    subject: att.subject,
    raisedBy: att.raisedBy,
    issuedAt: att.issuedAt,
  };
}

function duressClearBase(att: DuressClear): DuressClearBase {
  return {
    v: att.v,
    kind: att.kind,
    subject: att.subject,
    flagId: att.flagId,
    clearedBy: att.clearedBy,
    issuedAt: att.issuedAt,
  };
}

function proofOfLifeDigest(base: ProofOfLifeBase): Uint8Array {
  return taggedHash('tapit/proof-of-life', utf8(canonicalJson(base)));
}

function duressFlagDigest(base: DuressFlagBase): Uint8Array {
  return taggedHash('tapit/duress-flag', utf8(canonicalJson(base)));
}

function duressClearDigest(base: DuressClearBase): Uint8Array {
  return taggedHash('tapit/duress-clear', utf8(canonicalJson(base)));
}

/**
 * The exact bytes a subject signs to mint a proof-of-life -- exposed so a caller
 * that holds its private key behind a signing boundary (the Tapit Wallet
 * object, whose key never leaves it) can compute the digest, sign it through
 * its own `signDigest`, and assemble the attestation WITHOUT extracting the raw
 * key the way `buildProofOfLife` requires. Thin pass-through to the same
 * internal digest -- an attestation built via this path verifies identically.
 */
export function proofOfLifeDigestFor(base: {
  v: 1;
  kind: 'proof-of-life';
  subject: string;
  issuedAt: string;
}): Uint8Array {
  return proofOfLifeDigest(base);
}

/**
 * The exact bytes a peer signs to raise a duress flag -- same no-key-leak
 * pass-through as `proofOfLifeDigestFor`, for the Wallet signing boundary.
 */
export function duressFlagDigestFor(base: {
  v: 1;
  kind: 'duress-flag';
  subject: string;
  raisedBy: string;
  issuedAt: string;
}): Uint8Array {
  return duressFlagDigest(base);
}

/**
 * The exact bytes a peer signs to cast a duress-clear vote -- same
 * no-key-leak pass-through as `proofOfLifeDigestFor`/`duressFlagDigestFor`,
 * for the Wallet signing boundary.
 */
export function duressClearDigestFor(base: {
  v: 1;
  kind: 'duress-clear';
  subject: string;
  flagId: string;
  clearedBy: string;
  issuedAt: string;
}): Uint8Array {
  return duressClearDigest(base);
}

/**
 * The stable id of a DuressFlag -- what a DuressClear's `flagId` names. Pure
 * hash of the flag's signed base fields (the same digest the flag's own
 * signature covers), so a later, distinct raise on the same subject --
 * carrying its own `issuedAt` -- gets its own id, and a clear vote naming
 * this id can only ever apply to this exact raise event. Does not verify
 * the flag; callers that need trust should verify first.
 */
export function duressFlagId(flag: DuressFlag): string {
  return toHex(duressFlagDigest(duressFlagBase(flag)));
}

/**
 * Mint a proof-of-life heartbeat from a raw private key (tests / standalone
 * use). The subject is derived from the key -- `subject === signer` always.
 * For the no-key-leak path use `proofOfLifeDigestFor` + `wallet.signDigest`.
 */
export function buildProofOfLife(input: {
  /** Optional sanity check: if supplied, must equal the key's x-only pubkey. */
  subject?: string;
  signerPrivateKey: string;
  issuedAt?: string;
}): ProofOfLife {
  if (!isHex(input.signerPrivateKey, 32)) {
    throw new Error('signerPrivateKey must be 32-byte hex');
  }
  const priv = fromHex(input.signerPrivateKey);
  const subject = toHex(schnorr.getPublicKey(priv));
  if (input.subject !== undefined && input.subject !== subject) {
    throw new Error('subject does not match signerPrivateKey');
  }
  const base: ProofOfLifeBase = {
    v: 1,
    kind: 'proof-of-life',
    subject,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return { ...base, signature: toHex(schnorr.sign(proofOfLifeDigest(base), priv)) };
}

/**
 * Raise a duress flag from a raw private key (tests / standalone use). The peer
 * (`raisedBy`) is derived from the key -- `raisedBy === signer` always. The
 * `subject` is supplied; it may equal `raisedBy` for self-duress. For the
 * no-key-leak path use `duressFlagDigestFor` + `wallet.signDigest`.
 */
export function buildDuressFlag(input: {
  subject: string;
  signerPrivateKey: string;
  issuedAt?: string;
}): DuressFlag {
  if (!isHex(input.subject, 32)) {
    throw new Error('subject must be 32-byte x-only hex');
  }
  if (!isHex(input.signerPrivateKey, 32)) {
    throw new Error('signerPrivateKey must be 32-byte hex');
  }
  const priv = fromHex(input.signerPrivateKey);
  const raisedBy = toHex(schnorr.getPublicKey(priv));
  const base: DuressFlagBase = {
    v: 1,
    kind: 'duress-flag',
    subject: input.subject,
    raisedBy,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return { ...base, signature: toHex(schnorr.sign(duressFlagDigest(base), priv)) };
}

/**
 * Cast a duress-clear vote from a raw private key (tests / standalone use).
 * The peer (`clearedBy`) is derived from the key -- `clearedBy === signer`
 * always. `subject` and `flagId` name the exact flag being voted to clear.
 * For the no-key-leak path use `duressClearDigestFor` + `wallet.signDigest`.
 */
export function buildDuressClear(input: {
  subject: string;
  flagId: string;
  signerPrivateKey: string;
  issuedAt?: string;
}): DuressClear {
  if (!isHex(input.subject, 32)) {
    throw new Error('subject must be 32-byte x-only hex');
  }
  if (!isHex(input.flagId, 32)) {
    throw new Error('flagId must be 32-byte hex');
  }
  if (!isHex(input.signerPrivateKey, 32)) {
    throw new Error('signerPrivateKey must be 32-byte hex');
  }
  const priv = fromHex(input.signerPrivateKey);
  const clearedBy = toHex(schnorr.getPublicKey(priv));
  const base: DuressClearBase = {
    v: 1,
    kind: 'duress-clear',
    subject: input.subject,
    flagId: input.flagId,
    clearedBy,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return { ...base, signature: toHex(schnorr.sign(duressClearDigest(base), priv)) };
}

/** True when a value has the full, well-typed shape of a proof-of-life. */
function isProofOfLifeShape(value: unknown): value is ProofOfLife {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    a.v === 1 &&
    a.kind === 'proof-of-life' &&
    isHex(a.subject, 32) &&
    typeof a.issuedAt === 'string' &&
    isHex(a.signature, 64)
  );
}

/** True when a value has the full, well-typed shape of a duress flag. */
function isDuressFlagShape(value: unknown): value is DuressFlag {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    a.v === 1 &&
    a.kind === 'duress-flag' &&
    isHex(a.subject, 32) &&
    isHex(a.raisedBy, 32) &&
    typeof a.issuedAt === 'string' &&
    isHex(a.signature, 64)
  );
}

/** True when a value has the full, well-typed shape of a duress clear. */
function isDuressClearShape(value: unknown): value is DuressClear {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    a.v === 1 &&
    a.kind === 'duress-clear' &&
    isHex(a.subject, 32) &&
    isHex(a.flagId, 32) &&
    isHex(a.clearedBy, 32) &&
    typeof a.issuedAt === 'string' &&
    isHex(a.signature, 64)
  );
}

/**
 * Verify a proof-of-life. Never throws. True only when the shape is well-typed
 * and the Schnorr signature is valid for the subject's key. Freshness is NOT
 * checked here -- that is the tally's job, with the verifier's chosen window.
 */
export function verifyProofOfLife(att: ProofOfLife): boolean {
  if (!isProofOfLifeShape(att)) return false;
  try {
    return schnorr.verify(
      fromHex(att.signature),
      proofOfLifeDigest(proofOfLifeBase(att)),
      fromHex(att.subject),
    );
  } catch {
    return false;
  }
}

/**
 * Verify a duress flag. Never throws. True only when the shape is well-typed
 * and the Schnorr signature is valid for the `raisedBy` key. Group membership
 * is NOT checked here -- that is the tally's no-rogue filter.
 */
export function verifyDuressFlag(att: DuressFlag): boolean {
  if (!isDuressFlagShape(att)) return false;
  try {
    return schnorr.verify(
      fromHex(att.signature),
      duressFlagDigest(duressFlagBase(att)),
      fromHex(att.raisedBy),
    );
  } catch {
    return false;
  }
}

/**
 * Verify a duress-clear vote. Never throws. True only when the shape is
 * well-typed and the Schnorr signature is valid for the `clearedBy` key.
 * Group membership and "which flag this actually clears" are NOT checked
 * here -- that is the tally's job in `livenessStateFor`.
 */
export function verifyDuressClear(att: DuressClear): boolean {
  if (!isDuressClearShape(att)) return false;
  try {
    return schnorr.verify(
      fromHex(att.signature),
      duressClearDigest(duressClearBase(att)),
      fromHex(att.clearedBy),
    );
  } catch {
    return false;
  }
}

/** The derived liveness state for one subject. */
export type LivenessState = 'green' | 'no-report' | 'red';

/**
 * Derive one subject's liveness state. Pure; `now` is injectable. The rules run
 * in strict order, and the order IS the security model:
 *
 * (a) RED DOMINATES. If any supplied red flag targets this subject, was raised
 *     by someone in `group` (the subject's chosen people; the subject is always
 *     allowed to flag themselves, i.e. self-duress counts even if the subject
 *     is not listed in `group`), its signature verifies, AND it has not been
 *     unanimously cleared (see below), return 'red'. Reds persist -- there is
 *     no auto-expiry. Reds raised by anyone NOT in the group (and who is not
 *     the subject) are ignored entirely (no-rogue).
 *
 *     A verifying flag stops counting ONLY when `clears` contains a
 *     verifying `DuressClear` naming that exact flag's id (`duressFlagId`)
 *     from EVERY member of `group` other than `subject` itself. A clear from
 *     the subject, or from anyone outside `group`, or a partial set of
 *     clearers, changes nothing -- the flag still dominates. This is
 *     deliberately harder to lift than it is to raise.
 *
 * (b) GREEN. Otherwise, if a proof-of-life for this subject verifies, was
 *     signed by the subject, and is within the freshness window --
 *     `issuedAt` no more than `ttlSeconds` in the past AND no more than
 *     `CLOCK_SKEW_TOLERANCE_MS` in the future -- return 'green'. Both
 *     directions matter: a stale heartbeat must lapse, and a
 *     future-dated one (a pre-signed proof-of-life stamped decades
 *     ahead) must not be able to hold 'green' forever.
 *
 * (c) NO-REPORT. Otherwise freshness has lapsed or nothing was ever reported --
 *     return 'no-report'. This is the honest default: absence of a current
 *     heartbeat is NOT green and is NOT red, it is simply unknown.
 */
export function livenessStateFor(input: {
  subject: string;
  group: string[];
  proofOfLife?: ProofOfLife | null;
  redFlags?: DuressFlag[];
  /**
   * Duress-clear votes to weigh against `redFlags`. Optional and additive --
   * omitting it (or passing []) reproduces the exact pre-clear behavior, so
   * every existing caller is unaffected.
   */
  clears?: DuressClear[];
  ttlSeconds: number;
  now?: number;
}): LivenessState {
  const { subject, group, proofOfLife, ttlSeconds } = input;
  const redFlags = input.redFlags ?? [];
  const clears = input.clears ?? [];
  const now = input.now ?? Date.now();

  // The subject's chosen people, plus the subject themselves (self-duress).
  const allowed = new Set(group);
  allowed.add(subject);

  // Every OTHER chosen member (never the subject) must clear a flag before
  // it stops counting. Computed once per call since `group` is fixed here.
  const requiredClearers = group.filter((pk) => pk !== subject);

  // (a) Red dominates, unless every required clearer has voted for THIS flag.
  for (const flag of redFlags) {
    if (!isDuressFlagShape(flag)) continue;
    if (flag.subject !== subject) continue;
    if (!allowed.has(flag.raisedBy)) continue; // no-rogue: only chosen people
    if (!verifyDuressFlag(flag)) continue;

    const flagId = duressFlagId(flag);
    const clearedBy = new Set<string>();
    for (const clear of clears) {
      if (!isDuressClearShape(clear)) continue;
      if (clear.subject !== subject) continue;
      if (clear.flagId !== flagId) continue;
      if (clear.clearedBy === subject) continue; // self-clear never counts
      if (!requiredClearers.includes(clear.clearedBy)) continue;
      if (!verifyDuressClear(clear)) continue;
      clearedBy.add(clear.clearedBy);
    }
    const fullyCleared =
      requiredClearers.length > 0 && requiredClearers.every((pk) => clearedBy.has(pk));
    if (!fullyCleared) return 'red';
  }

  // (b) Green: a fresh, verifying, self-signed heartbeat. The window is
  // two-sided -- `now - issuedMs <= ttlSeconds * 1000` alone is
  // satisfied forever by a future-dated issuedAt (the difference goes
  // negative, trivially <= a positive bound), letting one pre-signed
  // future-dated proof-of-life hold 'green' permanently. Allow a small
  // clock-skew tolerance rather than a hard issuedMs <= now, since real
  // devices' clocks drift.
  if (proofOfLife && isProofOfLifeShape(proofOfLife) && proofOfLife.subject === subject) {
    if (verifyProofOfLife(proofOfLife)) {
      const issuedMs = Date.parse(proofOfLife.issuedAt);
      const age = now - issuedMs;
      if (!Number.isNaN(issuedMs) && age >= -CLOCK_SKEW_TOLERANCE_MS && age <= ttlSeconds * 1000) {
        return 'green';
      }
    }
  }

  // (c) No current report.
  return 'no-report';
}

/** Per-state counts over a set of subjects. */
export interface GroupTally {
  green: number;
  noReport: number;
  red: number;
}

/**
 * Tally liveness across many subjects at once. Each subject is evaluated with
 * `livenessStateFor` against the shared group, ttl, and `now`; `proofs` and
 * `redFlags` are looked up per subject. `proofs` maps subject -> their latest
 * heartbeat; `redFlags` is the full flat set (each subject's relevant flags are
 * filtered inside `livenessStateFor` by the `flag.subject` match).
 */
export function groupTally(
  subjects: string[],
  input: {
    group: string[];
    proofs?: Record<string, ProofOfLife | null | undefined>;
    redFlags?: DuressFlag[];
    clears?: DuressClear[];
    ttlSeconds: number;
    now?: number;
  },
): GroupTally {
  const proofs = input.proofs ?? {};
  const tally: GroupTally = { green: 0, noReport: 0, red: 0 };
  for (const subject of subjects) {
    const state = livenessStateFor({
      subject,
      group: input.group,
      proofOfLife: proofs[subject] ?? null,
      redFlags: input.redFlags,
      clears: input.clears,
      ttlSeconds: input.ttlSeconds,
      now: input.now,
    });
    if (state === 'green') tally.green += 1;
    else if (state === 'red') tally.red += 1;
    else tally.noReport += 1;
  }
  return tally;
}

/**
 * The green-quorum gate. True only when at least `m` subjects are green AND no
 * subject is red. Any single red blocks the quorum outright -- a compromised or
 * coerced member must halt the group action even if the headcount is otherwise
 * met. This is the conservative reading the whole primitive is built around.
 */
export function meetsGreenQuorum(states: LivenessState[], m: number): boolean {
  let green = 0;
  let red = 0;
  for (const state of states) {
    if (state === 'green') green += 1;
    else if (state === 'red') red += 1;
  }
  return green >= m && red === 0;
}
