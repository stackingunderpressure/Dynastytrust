/**
 * test-liveness-gate.mjs -- node-runnable test for the pure liveness gate-input
 * assembler (apps/web/src/lib/liveness-gate.ts).
 *
 * WHY ESBUILD INSTEAD OF A PLAIN IMPORT:
 *   The assembler is a TypeScript module under apps/web/src/lib that imports
 *   the vendored `tapit-attest` package. Node cannot import a .ts file without
 *   a loader. Rather than mirror the assembler's logic by hand (brittle and
 *   could drift from the shipped code), this test esbuild-bundles the ACTUAL
 *   assembler source into a temp .mjs once, with `tapit-attest` resolved to its
 *   real built dist, then imports that. So the code under test is the exact
 *   code apps/web ships, and the verification path is genuinely exercised --
 *   the signals below are REAL ProofOfLife / DuressFlag minted via the
 *   tapit-attest builders with raw test keys, so livenessStateFor really runs
 *   Schnorr verification, the no-rogue group filter, and the freshness window.
 *
 * It also feeds the assembled output into the real evaluateSigningGate to
 * confirm the bridge lands exactly on the gate's liveness axis.
 *
 * Standalone runner. NOT wired into `npm test` (scripts/test-policy.mjs); run
 * directly with `node scripts/test-liveness-gate.mjs`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

import {
  buildProofOfLife,
  buildDuressFlag,
} from '../tapit-attest/dist/index.js';
import { evaluateSigningGate } from '../packages/policy-engine/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const assemblerSrc = join(repoRoot, 'apps/web/src/lib/liveness-gate.ts');

// Bundle the real assembler. `tapit-attest` is the bare specifier the source
// imports; alias it to the built dist so esbuild resolves it the same way the
// linked node_modules symlink would.
const outDir = mkdtempSync(join(tmpdir(), 'liveness-gate-'));
const outFile = join(outDir, 'liveness-gate.mjs');
await build({
  entryPoints: [assemblerSrc],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
  alias: { 'tapit-attest': join(repoRoot, 'tapit-attest/dist/index.js') },
});
const { assembleLivenessGateInput } = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// Test keys. Raw 32-byte hex private keys -> the schnorr x-only pubkeys are the
// circle subjects. Distinct, non-trivial values; these are test-only.
// ---------------------------------------------------------------------------
const PRIV = {
  alice: '11'.repeat(32),
  bob: '22'.repeat(32),
  carol: '33'.repeat(32),
  mallory: '44'.repeat(32), // an OUTSIDER -- never in the circle
};

// Derive each subject's x-only pubkey by minting a throwaway heartbeat and
// reading its `subject` (buildProofOfLife sets subject = schnorr pubkey).
function pubOf(priv) {
  return buildProofOfLife({ signerPrivateKey: priv, issuedAt: new Date(0).toISOString() }).subject;
}
const PUB = {
  alice: pubOf(PRIV.alice),
  bob: pubOf(PRIV.bob),
  carol: pubOf(PRIV.carol),
  mallory: pubOf(PRIV.mallory),
};

const CIRCLE = [PUB.alice, PUB.bob, PUB.carol];
const TTL = 3600; // one hour freshness window
const NOW = 2_000_000_000_000; // fixed epoch ms for deterministic freshness

const isoAt = (ms) => new Date(ms).toISOString();
const freshIso = isoAt(NOW - 60_000); // 1 minute ago -- well within ttl

// A vault config gating 'parents_now' at 2 green; 'recovery' deliberately
// absent from the map (not liveness-gated).
const config = {
  circle: CIRCLE,
  requiredGreenByPath: { parents_now: 2 },
  ttlSeconds: TTL,
};

// Helper: feed an assembled liveness object into the real gate and report
// whether the LIVENESS axis blocked it (isolating the liveness denials).
function livenessCodes(liveness) {
  const r = evaluateSigningGate(
    {
      request: { vaultId: 'v1', psbtHash: 'h', destination: 'd', amountSats: 1, path: 'p' },
      ceremony: {
        proposalId: 'pr1', vaultId: 'v1', status: 'approved', authorizedPsbtHash: 'h',
        destination: 'd', amountSats: 1, path: 'p',
        duress: false,
      },
      vault: { vaultId: 'v1', address: 'addr' },
      psbtBindsToVault: true,
      governanceApproved: true,
      liveness,
    },
    NOW,
  );
  return r.denials.map((d) => d.code).filter((c) => c.startsWith('LIVENESS_'));
}

// ===========================================================================
// (1) Circle of 3, two fresh heartbeats + third silent, requiredGreen 2.
//     -> ['green','green','no-report'], requiredGreen 2; gate allows on the
//        liveness axis.
// ===========================================================================
{
  const proofs = {
    [PUB.alice]: buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: freshIso }),
    [PUB.bob]: buildProofOfLife({ signerPrivateKey: PRIV.bob, issuedAt: freshIso }),
    // carol silent -- no entry
  };
  const out = assembleLivenessGateInput({ config, path: 'parents_now', proofs, redFlags: [], now: NOW });
  assert.deepEqual(out, { memberStates: ['green', 'green', 'no-report'], requiredGreen: 2 });
  assert.deepEqual(livenessCodes(out), [], 'two greens meets requiredGreen 2 -- no liveness denial');
  console.log('  (1) two fresh heartbeats + one silent -> green,green,no-report; gate allows -- OK');
}

// ===========================================================================
// (2) A verifying in-group red flag present -> memberStates contains 'red',
//     and the gate denies LIVENESS_RED (red dominates even with greens).
//     Carol raises red on Bob; both are in the circle.
// ===========================================================================
{
  const proofs = {
    [PUB.alice]: buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: freshIso }),
    [PUB.bob]: buildProofOfLife({ signerPrivateKey: PRIV.bob, issuedAt: freshIso }),
    [PUB.carol]: buildProofOfLife({ signerPrivateKey: PRIV.carol, issuedAt: freshIso }),
  };
  const redOnBob = buildDuressFlag({ subject: PUB.bob, signerPrivateKey: PRIV.carol, issuedAt: freshIso });
  const out = assembleLivenessGateInput({ config, path: 'parents_now', proofs, redFlags: [redOnBob], now: NOW });
  assert.ok(out.memberStates.includes('red'), 'a verifying in-group red must surface as red');
  assert.deepEqual(out.memberStates, ['green', 'red', 'green'], 'bob (index 1) is red, others green');
  assert.deepEqual(livenessCodes(out), ['LIVENESS_RED'], 'red dominates -- gate denies LIVENESS_RED');
  console.log('  (2) in-group red on a member -> red surfaces; gate denies LIVENESS_RED -- OK');
}

// ===========================================================================
// (2b) ADVERSARIAL no-rogue: an OUTSIDER (mallory, not in the circle) tries to
//      red-flag Alice. livenessStateFor ignores it -- Alice stays green.
// ===========================================================================
{
  const proofs = {
    [PUB.alice]: buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: freshIso }),
    [PUB.bob]: buildProofOfLife({ signerPrivateKey: PRIV.bob, issuedAt: freshIso }),
  };
  const rogueRed = buildDuressFlag({ subject: PUB.alice, signerPrivateKey: PRIV.mallory, issuedAt: freshIso });
  const out = assembleLivenessGateInput({ config, path: 'parents_now', proofs, redFlags: [rogueRed], now: NOW });
  assert.ok(!out.memberStates.includes('red'), 'an outsider cannot raise red (no-rogue filter)');
  assert.deepEqual(out.memberStates, ['green', 'green', 'no-report']);
  assert.deepEqual(livenessCodes(out), [], 'rogue red ignored -- still allows');
  console.log('  (2b) outsider red flag ignored (no-rogue) -- Alice stays green -- OK');
}

// ===========================================================================
// (3) ADVERSARIAL forged/tampered proof -> that member is 'no-report', NEVER
//     green. We mint a real heartbeat for Alice, then flip a byte of its
//     signature so it no longer verifies.
// ===========================================================================
{
  const realAlice = buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: freshIso });
  // Tamper: flip the first nibble of the signature. Still well-shaped hex,
  // but the Schnorr verification must now fail.
  const flipped = realAlice.signature[0] === '0' ? '1' : '0';
  const forgedAlice = { ...realAlice, signature: flipped + realAlice.signature.slice(1) };

  const proofs = {
    [PUB.alice]: forgedAlice, // forged -- must NOT count green
    [PUB.bob]: buildProofOfLife({ signerPrivateKey: PRIV.bob, issuedAt: freshIso }),
  };
  const out = assembleLivenessGateInput({ config, path: 'parents_now', proofs, redFlags: [], now: NOW });
  assert.equal(out.memberStates[0], 'no-report', 'a forged proof is no-report, never green (safe-by-default)');
  assert.deepEqual(out.memberStates, ['no-report', 'green', 'no-report']);
  // Only one real green vs requiredGreen 2 -> gate denies NOT_GREEN.
  assert.deepEqual(livenessCodes(out), ['LIVENESS_NOT_GREEN'], 'forged proof drops the green count -> denied');
  console.log('  (3) forged/tampered proof -> no-report (never green); gate denies LIVENESS_NOT_GREEN -- OK');
}

// ===========================================================================
// (3b) ADVERSARIAL wrong-subject proof -> a proof minted by Mallory but placed
//      under Alice's slot cannot pass for Alice; she is no-report.
// ===========================================================================
{
  const malloryProof = buildProofOfLife({ signerPrivateKey: PRIV.mallory, issuedAt: freshIso });
  const proofs = {
    [PUB.alice]: malloryProof, // wrong signer for this slot
    [PUB.bob]: buildProofOfLife({ signerPrivateKey: PRIV.bob, issuedAt: freshIso }),
    [PUB.carol]: buildProofOfLife({ signerPrivateKey: PRIV.carol, issuedAt: freshIso }),
  };
  const out = assembleLivenessGateInput({ config, path: 'parents_now', proofs, redFlags: [], now: NOW });
  assert.equal(out.memberStates[0], 'no-report', 'a proof for the wrong subject cannot count green for Alice');
  assert.deepEqual(out.memberStates, ['no-report', 'green', 'green']);
  console.log('  (3b) wrong-subject proof -> no-report for that slot -- OK');
}

// ===========================================================================
// (4) Path with no configured requiredGreen -> returns undefined (not gated).
// ===========================================================================
{
  const proofs = {
    [PUB.alice]: buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: freshIso }),
  };
  const out = assembleLivenessGateInput({ config, path: 'recovery', proofs, redFlags: [], now: NOW });
  assert.equal(out, undefined, 'an unconfigured path is not liveness-gated -> undefined');
  // And undefined fed to the gate produces no liveness denial.
  assert.deepEqual(livenessCodes(out), [], 'undefined liveness -> gate skips the liveness axis');
  console.log('  (4) unconfigured path -> undefined (not gated); gate skips liveness axis -- OK');
}

// ===========================================================================
// (5) Stale heartbeat past ttl -> 'no-report'. Alice's heartbeat is older than
//     ttlSeconds; Bob's is fresh.
// ===========================================================================
{
  const staleIso = isoAt(NOW - (TTL * 1000 + 60_000)); // one minute past the window
  const proofs = {
    [PUB.alice]: buildProofOfLife({ signerPrivateKey: PRIV.alice, issuedAt: staleIso }),
    [PUB.bob]: buildProofOfLife({ signerPrivateKey: PRIV.bob, issuedAt: freshIso }),
  };
  const out = assembleLivenessGateInput({ config, path: 'parents_now', proofs, redFlags: [], now: NOW });
  assert.equal(out.memberStates[0], 'no-report', 'a stale (past-ttl) heartbeat is no-report, never green');
  assert.deepEqual(out.memberStates, ['no-report', 'green', 'no-report']);
  assert.deepEqual(livenessCodes(out), ['LIVENESS_NOT_GREEN'], 'stale drops the count -> denied');
  console.log('  (5) stale heartbeat past ttl -> no-report; gate denies LIVENESS_NOT_GREEN -- OK');
}

// Clean up the bundle temp dir.
rmSync(outDir, { recursive: true, force: true });

console.log('liveness gate-input assembler tests passed');
