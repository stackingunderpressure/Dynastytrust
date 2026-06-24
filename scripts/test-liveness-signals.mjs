/**
 * test-liveness-signals.mjs -- node-runnable tests for the verify-on-write
 * helper and the vault liveness-config loader (netlify/functions/_liveness.js).
 *
 * WHY A PLAIN IMPORT (no esbuild bundle needed):
 *   _liveness.js is already an ESM .js module that imports the vendored
 *   `tapit-attest` by bare specifier. Node resolves that via the repo's
 *   node_modules symlink, so we import the SHIPPED helper directly -- the exact
 *   code the netlify endpoint calls. The signals below are REAL ProofOfLife /
 *   DuressFlag minted with tapit-attest's builders from raw test keys, so
 *   verifyProofOfLife / verifyDuressFlag genuinely run Schnorr verification.
 *
 * Standalone runner. NOT wired into `npm test` (scripts/test-policy.mjs is a
 * single-file runner, not an aggregator). Run directly with
 *   node scripts/test-liveness-signals.mjs
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildProofOfLife, buildDuressFlag } from '../tapit-attest/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = join(here, '../netlify/functions/_liveness.js');
const { verifyLivenessSignalForStorage, loadVaultLivenessConfig } = await import(
  pathToFileURL(helperPath).href
);

// ---------------------------------------------------------------------------
// Raw 32-byte hex test keys. Their schnorr x-only pubkeys are the subjects.
// ---------------------------------------------------------------------------
const PRIV = {
  alice: '11'.repeat(32),
  bob: '22'.repeat(32),
  carol: '33'.repeat(32),
};
const pubOf = (priv) =>
  buildProofOfLife({ signerPrivateKey: priv, issuedAt: new Date(0).toISOString() }).subject;
const PUB = { alice: pubOf(PRIV.alice), bob: pubOf(PRIV.bob), carol: pubOf(PRIV.carol) };

const nowIso = new Date().toISOString();

// ===========================================================================
// (1) A REAL proof-of-life verifies and yields subject = signer, raisedBy null.
// ===========================================================================
{
  const signal = buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: nowIso });
  const v = verifyLivenessSignalForStorage({ kind: 'proof-of-life', signal });
  assert.deepEqual(v, { ok: true, subject: PUB.alice, raisedBy: null });
  console.log('  (1) real proof-of-life accepted; subject = signer, raisedBy null -- OK');
}

// ===========================================================================
// (2) A REAL duress flag verifies and yields subject + raisedBy (the raiser).
// ===========================================================================
{
  const signal = buildDuressFlag({
    subject: PUB.bob,
    signerPrivateKey: PRIV.carol,
    issuedAt: nowIso,
  });
  const v = verifyLivenessSignalForStorage({ kind: 'duress-flag', signal });
  assert.deepEqual(v, { ok: true, subject: PUB.bob, raisedBy: PUB.carol });
  console.log('  (2) real duress flag accepted; subject = flagged, raisedBy = raiser -- OK');
}

// ===========================================================================
// (3) ADVERSARIAL: a tampered signature (flipped byte) is REJECTED, never ok.
// ===========================================================================
{
  const real = buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: nowIso });
  const flip = real.signature[0] === '0' ? '1' : '0';
  const forged = { ...real, signature: flip + real.signature.slice(1) };
  const v = verifyLivenessSignalForStorage({ kind: 'proof-of-life', signal: forged });
  assert.equal(v.ok, false, 'a tampered signature must NOT be storable');
  console.log('  (3) tampered-signature proof-of-life rejected (never stored) -- OK');
}

// ===========================================================================
// (3b) ADVERSARIAL: a tampered duress-flag signature is REJECTED.
// ===========================================================================
{
  const real = buildDuressFlag({ subject: PUB.bob, signerPrivateKey: PRIV.carol, issuedAt: nowIso });
  const flip = real.signature[0] === '0' ? '1' : '0';
  const forged = { ...real, signature: flip + real.signature.slice(1) };
  const v = verifyLivenessSignalForStorage({ kind: 'duress-flag', signal: forged });
  assert.equal(v.ok, false, 'a tampered duress signature must NOT be storable');
  console.log('  (3b) tampered-signature duress flag rejected -- OK');
}

// ===========================================================================
// (4) ADVERSARIAL: wrong-kind. A duress flag declared as proof-of-life (and
//     vice versa) is rejected -- the embedded kind must match the header AND
//     the matching verifier must pass.
// ===========================================================================
{
  const dur = buildDuressFlag({ subject: PUB.bob, signerPrivateKey: PRIV.carol, issuedAt: nowIso });
  const v1 = verifyLivenessSignalForStorage({ kind: 'proof-of-life', signal: dur });
  assert.equal(v1.ok, false, 'duress flag under proof-of-life header rejected');

  const pol = buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: nowIso });
  const v2 = verifyLivenessSignalForStorage({ kind: 'duress-flag', signal: pol });
  assert.equal(v2.ok, false, 'proof-of-life under duress-flag header rejected');

  // An entirely unknown kind is rejected too.
  const v3 = verifyLivenessSignalForStorage({ kind: 'heartbeat', signal: pol });
  assert.equal(v3.ok, false, 'unknown kind rejected');
  console.log('  (4) wrong-kind / unknown-kind signals rejected -- OK');
}

// ===========================================================================
// (5) ADVERSARIAL: garbage / malformed objects are rejected, never throw.
// ===========================================================================
{
  for (const signal of [null, undefined, 42, 'nope', {}, { kind: 'proof-of-life' }, [], { kind: 'proof-of-life', subject: 'zz' }]) {
    const v = verifyLivenessSignalForStorage({ kind: 'proof-of-life', signal });
    assert.equal(v.ok, false, `garbage signal ${JSON.stringify(signal)} must be rejected`);
  }
  // Missing/garbage kind in the row itself.
  assert.equal(verifyLivenessSignalForStorage({}).ok, false);
  assert.equal(verifyLivenessSignalForStorage(null).ok, false);
  console.log('  (5) garbage / malformed signals rejected without throwing -- OK');
}

// ===========================================================================
// (6) ADVERSARIAL: a proof-of-life whose signature does not match its claimed
//     subject. We mint Alice's real proof, then rewrite `subject` to Bob's
//     pubkey -- the signature is Alice's, so it cannot verify for Bob.
// ===========================================================================
{
  const aliceProof = buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: nowIso });
  const subjectSwapped = { ...aliceProof, subject: PUB.bob };
  const v = verifyLivenessSignalForStorage({ kind: 'proof-of-life', signal: subjectSwapped });
  assert.equal(v.ok, false, 'a proof whose signature does not match its subject must be rejected');
  console.log('  (6) wrong-subject proof-of-life (sig != subject) rejected -- OK');
}

// ===========================================================================
// (7) loadVaultLivenessConfig: a good bloc_policy.liveness parses through.
// ===========================================================================
{
  const vault = {
    bloc_policy: {
      liveness: {
        circle: [PUB.alice, PUB.bob, PUB.carol],
        requiredGreenByPath: { parents_now: 2, recovery: 1 },
        ttlSeconds: 86400,
      },
    },
  };
  const cfg = loadVaultLivenessConfig(vault);
  assert.deepEqual(cfg, {
    circle: [PUB.alice, PUB.bob, PUB.carol],
    requiredGreenByPath: { parents_now: 2, recovery: 1 },
    ttlSeconds: 86400,
  });
  console.log('  (7) good bloc_policy.liveness parses to a VaultLivenessConfig -- OK');
}

// ===========================================================================
// (8) loadVaultLivenessConfig: missing config -> null (not gated, safe).
// ===========================================================================
{
  assert.equal(loadVaultLivenessConfig({}), null, 'no bloc_policy -> null');
  assert.equal(loadVaultLivenessConfig({ bloc_policy: {} }), null, 'no liveness -> null');
  assert.equal(loadVaultLivenessConfig(null), null, 'null vault -> null');
  assert.equal(loadVaultLivenessConfig({ bloc_policy: { liveness: null } }), null, 'null liveness -> null');
  console.log('  (8) missing / absent config -> null (not liveness-gated) -- OK');
}

// ===========================================================================
// (9) loadVaultLivenessConfig: malformed -> null (never a fake config).
//     Bad circle entry, negative ttl, non-numeric required count, etc.
// ===========================================================================
{
  const bad = [
    { circle: [PUB.alice, 'not-hex'], requiredGreenByPath: { p: 1 }, ttlSeconds: 10 },
    { circle: [], requiredGreenByPath: { p: 1 }, ttlSeconds: 10 },
    { circle: [PUB.alice], requiredGreenByPath: { p: -1 }, ttlSeconds: 10 },
    { circle: [PUB.alice], requiredGreenByPath: { p: 1.5 }, ttlSeconds: 10 },
    { circle: [PUB.alice], requiredGreenByPath: { p: 'two' }, ttlSeconds: 10 },
    { circle: [PUB.alice], requiredGreenByPath: { p: 1 }, ttlSeconds: -5 },
    { circle: [PUB.alice], requiredGreenByPath: { p: 1 }, ttlSeconds: 0 },
    { circle: [PUB.alice], requiredGreenByPath: [], ttlSeconds: 10 },
    { circle: 'nope', requiredGreenByPath: { p: 1 }, ttlSeconds: 10 },
    { circle: [PUB.alice], requiredGreenByPath: { p: 1 } }, // missing ttl
  ];
  for (const liveness of bad) {
    assert.equal(
      loadVaultLivenessConfig({ bloc_policy: { liveness } }),
      null,
      `malformed liveness must -> null: ${JSON.stringify(liveness)}`,
    );
  }
  console.log('  (9) malformed config (bad circle / ttl / counts) -> null (safe) -- OK');
}

console.log('liveness-signal verify-on-write + config-loader tests passed');
