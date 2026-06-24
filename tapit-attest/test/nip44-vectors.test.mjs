import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decryptFrom, publicKeyFromPrivate } from '../dist/index.js';

// NIP-44 v2 interop. Runs the upstream reference vectors through
// tapit-attest's decryptFrom and asserts byte-for-byte plaintext
// match — proves that a payload produced by any spec-conformant
// implementation is readable by this one. Vectors snapshot lives at
// test/fixtures/nip44-v2-vectors.json (source noted in the fixture).
//
// We only run the encrypt_decrypt vectors here; the
// get_conversation_key vectors would require exposing the internal
// derivation, which is intentionally not on tapit-attest's public
// surface. The full encrypt_decrypt round-trip exercises that
// derivation transitively — if the conversation key were wrong, the
// MAC check would fail before the plaintext came back.

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  readFileSync(join(here, 'fixtures', 'nip44-v2-vectors.json'), 'utf-8'),
);

test('decrypts every v2 reference encrypt_decrypt vector', () => {
  const vectors = VECTORS.v2.valid.encrypt_decrypt;
  assert.ok(vectors.length > 0, 'fixture must contain at least one vector');
  for (const v of vectors) {
    const senderPub = publicKeyFromPrivate(v.sec1);
    const out = decryptFrom(v.payload, senderPub, v.sec2);
    assert.equal(
      out,
      v.plaintext,
      `vector with nonce ${v.nonce} did not round-trip`,
    );
  }
});
