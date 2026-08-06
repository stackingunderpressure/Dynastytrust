// Parity gate for Cut B stage B3 (docs/integration-phase1-signin-and-bridge.md),
// same discipline as bip341-psbt-signer's own parity test from stage B0. This
// module is vendored byte-identically into every repo that needs it; this
// file travels with it. The fixture below is deterministic (fixed private
// key, fixed BIP340 auxiliary randomness, fixed timestamp) so the exact
// event id and signature were captured once against the canonical copy and
// hardcoded here. Running this same file in each repo's own CI against that
// repo's own copy proves the two copies compute identical bytes for
// identical input, without the repos needing to talk to each other at test
// time -- if any vendored copy has drifted, even by one byte, this test
// fails there and only there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';
import { buildEvent, verifyEvent } from '../dist/nostrEvent.js';

const PRIV_HEX = '11'.repeat(32);
const PRIV_BYTES = Uint8Array.from(Buffer.from(PRIV_HEX, 'hex'));
const ZERO_AUX = new Uint8Array(32);
const PUBKEY = Buffer.from(schnorr.getPublicKey(PRIV_BYTES)).toString('hex');

function sign(digest) {
  return Buffer.from(schnorr.sign(digest, PRIV_BYTES, ZERO_AUX)).toString('hex');
}

function buildFixtureEvent() {
  return buildEvent({
    pubkey: PUBKEY,
    sign,
    kind: 9576,
    content: 'test-content',
    tags: [['p', 'aa'.repeat(32)]],
    created_at: 1700000000,
  });
}

const EXPECTED_PUBKEY =
  '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const EXPECTED_EVENT_ID =
  '6c6eac5132d26498e960c5ef9327eb9825d5fa90f9c58caaf8d959212eb4db56';
const EXPECTED_SIG =
  '16dacd13def1ea6b04307e4a18d38c0f51da0c22814784e1e9a8922bdc7fb58c5f632ec7b6009fdd7fcbcefe0208ced08a2117695d66464b2e146053c3615a87';

test('fixture pubkey matches the golden value', () => {
  assert.equal(PUBKEY, EXPECTED_PUBKEY);
});

test('buildEvent produces the golden event id -- THE PARITY GATE', async () => {
  const event = await buildFixtureEvent();
  assert.equal(event.id, EXPECTED_EVENT_ID);
});

test('buildEvent produces the golden deterministic signature', async () => {
  const event = await buildFixtureEvent();
  assert.equal(event.sig, EXPECTED_SIG);
});

test('verifyEvent accepts a well-formed, correctly signed event', async () => {
  const event = await buildFixtureEvent();
  assert.equal(await verifyEvent(event), true);
});

test('verifyEvent rejects a tampered event (content changed after signing)', async () => {
  const event = await buildFixtureEvent();
  const tampered = { ...event, content: 'tampered' };
  assert.equal(await verifyEvent(tampered), false);
});

test('verifyEvent rejects a tampered event id', async () => {
  const event = await buildFixtureEvent();
  const tampered = { ...event, id: '00'.repeat(32) };
  assert.equal(await verifyEvent(tampered), false);
});
