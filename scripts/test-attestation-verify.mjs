/**
 * test-attestation-verify.mjs -- proves the server-side attestation check
 * (netlify/functions/_attest.js) accepts exactly what the browser's signer
 * (apps/web/src/lib/attest.ts) produces, and nothing else. Wired into
 * `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-attestation-verify.mjs
 */

import assert from 'node:assert/strict';
import { signAttestation, proofOfLifeHash, deathDeclarationHash } from '../apps/web/src/lib/attest.ts';
import { verifyAttestationSignature, attestationDigest } from '../netlify/functions/_attest.js';

let n = 0;
const pass = (label) => { n++; console.log(`  [ok] ${label}`); };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PATH = "m/86'/1'/0'";
const vaultId = '11111111-2222-3333-4444-555555555555';

// 1. What the browser signs, the server verifies.
const targetHash = proofOfLifeHash(vaultId, '2026-11-10T00:00:00.000Z', 'alive');
const signed = signAttestation({ mnemonic: MNEMONIC, derivationPath: PATH, network: 'signet', attestationType: 'proof_of_life', targetHash });
assert.equal(signed.signature.length, 128);
assert.equal(signed.pubkey.length, 64);
assert.equal(verifyAttestationSignature({ attestationType: 'proof_of_life', targetHash, ...signed }), true);
pass('browser-signed proof_of_life verifies server-side');

// 2. Forgeries: a different key, a flipped signature byte, a swapped
//    type, a swapped target -- every one refused.
const other = signAttestation({ mnemonic: MNEMONIC, derivationPath: "m/86'/1'/1'", network: 'signet', attestationType: 'proof_of_life', targetHash });
assert.equal(verifyAttestationSignature({ attestationType: 'proof_of_life', targetHash, signature: other.signature, pubkey: signed.pubkey }), false);
const flipped = (signed.signature[0] === '0' ? '1' : '0') + signed.signature.slice(1);
assert.equal(verifyAttestationSignature({ attestationType: 'proof_of_life', targetHash, signature: flipped, pubkey: signed.pubkey }), false);
assert.equal(verifyAttestationSignature({ attestationType: 'death_declaration', targetHash, ...signed }), false);
const otherTarget = deathDeclarationHash(vaultId, 'someone', '2026-11-10T00:00:00.000Z');
assert.equal(verifyAttestationSignature({ attestationType: 'proof_of_life', targetHash: otherTarget, ...signed }), false);
pass('wrong key, corrupted signature, swapped type and swapped target all refused');

// 3. A signature for one type cannot be replayed as another, and the
//    digest is domain-separated (never equal to the bare target hash).
assert.notEqual(Buffer.from(attestationDigest('proof_of_life', targetHash)).toString('hex'), targetHash);
assert.notDeepEqual(attestationDigest('proof_of_life', targetHash), attestationDigest('trust_doc', targetHash));
pass('digest is domain-separated by tag and type');

// 4. Garbage never throws, only fails.
assert.equal(verifyAttestationSignature({ attestationType: 'proof_of_life', targetHash: 'zz', signature: 'nope', pubkey: '' }), false);
pass('malformed input fails closed without throwing');

console.log(`attestation-verify tests passed (${n} cases)`);
