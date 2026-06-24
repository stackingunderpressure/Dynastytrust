import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseOtsProof,
  serializeOtsProof,
  serializeTimestampBytes,
  assembleProof,
  pendingAttestations,
  bitcoinHeight,
  commitmentHex,
  OpenTimestampsProvider,
  anchorAttestation,
  refreshAnchor,
  verifyAnchor,
  generateKeypair,
  signEnvelope,
  predictionAttestation,
} from '../dist/index.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const node = (items) => ({ msg: new Uint8Array(), items });
const digestOf = (label) => sha256(new TextEncoder().encode(label));

// The real OpenTimestamps proof committed to the repo for AUTHORSHIP_RECORD.md.
const realProof = new Uint8Array(
  readFileSync(new URL('./fixtures/authorship-record.ots', import.meta.url)),
);

// TODO(fixture-restoration): test/fixtures/authorship-record.ots was
// corrupted at rest before this repo was bootstrapped — the binary
// bytes that should be 0xbf 0x89 0xe2 0xe8 0x84 0xe8 0x92 0x94 (last
// 8 bytes of the 31-byte OTS magic) were rewritten as runs of the
// UTF-8 replacement character 0xef 0xbf 0xbd, almost certainly during
// a web-upload pass in the chassis. Same bad bytes are in the
// parts-copy commit ba3b3f7. Restoring requires either downloading a
// clean copy of the original proof from elsewhere or re-stamping a
// known source file against real OpenTimestamps calendars. Tracked
// for a separate focused session. Until then, the four fixture-
// dependent tests below are skipped with this reason. The OTS codec
// is still exercised by the eight synthetic-proof tests further down.
const SKIP_CORRUPTED_FIXTURE = {
  skip: 'authorship-record.ots fixture is UTF-8-corrupted at rest; see TODO above',
};

const confirmedProof = (digest, height) =>
  serializeOtsProof({
    version: 1,
    fileHashOp: 0x08,
    fileDigest: digest,
    timestamp: node([{ item: 'attestation', attestation: { kind: 'bitcoin', height } }]),
  });

const pendingProof = (digest, uri) =>
  serializeOtsProof({
    version: 1,
    fileHashOp: 0x08,
    fileDigest: digest,
    timestamp: node([{ item: 'attestation', attestation: { kind: 'pending', uri } }]),
  });

test('parses the real AUTHORSHIP_RECORD proof', SKIP_CORRUPTED_FIXTURE, () => {
  const proof = parseOtsProof(realProof);
  assert.equal(proof.version, 1);
  assert.equal(proof.fileHashOp, 0x08);
  assert.equal(
    hex(proof.fileDigest),
    '37b18fc45b20d80b99ffc275e3503b147ae1bf64b3901295e92af257e7ae0dc9',
  );
});

test('finds the three pending calendars in the real proof', SKIP_CORRUPTED_FIXTURE, () => {
  const pendings = pendingAttestations(parseOtsProof(realProof));
  assert.deepEqual(
    pendings.map((p) => p.uri),
    [
      'https://alice.btc.calendar.opentimestamps.org',
      'https://bob.btc.calendar.opentimestamps.org',
      'https://finney.calendar.eternitywall.com',
    ],
  );
});

test('the real proof carries no Bitcoin attestation yet', SKIP_CORRUPTED_FIXTURE, () => {
  assert.equal(bitcoinHeight(parseOtsProof(realProof)), undefined);
});

test('re-serializing the real proof reproduces it byte for byte', SKIP_CORRUPTED_FIXTURE, () => {
  assert.deepEqual(serializeOtsProof(parseOtsProof(realProof)), realProof);
});

test('operation paths compute the commitment a calendar must be queried with', () => {
  const fileDigest = digestOf('field-report');
  const salt = new TextEncoder().encode('sixteen-byte-arg');
  const expected = sha256(concat(fileDigest, salt));
  const proof = serializeOtsProof({
    version: 1,
    fileHashOp: 0x08,
    fileDigest,
    timestamp: node([
      {
        item: 'op',
        op: { kind: 'append', arg: salt },
        child: node([
          {
            item: 'op',
            op: { kind: 'sha256' },
            child: node([
              { item: 'attestation', attestation: { kind: 'pending', uri: 'https://cal.test' } },
            ]),
          },
        ]),
      },
    ]),
  });
  const [pending] = pendingAttestations(parseOtsProof(proof));
  assert.equal(commitmentHex(pending.commitment), hex(expected));
});

test('reads the block height out of a Bitcoin attestation', () => {
  assert.equal(bitcoinHeight(parseOtsProof(confirmedProof(digestOf('a'), 875142))), 875142);
});

test('verify accepts a confirmed proof and rejects a digest mismatch', async () => {
  const provider = new OpenTimestampsProvider();
  const digest = digestOf('verify-me');
  const proof = hex(confirmedProof(digest, 800000));

  const ok = await provider.verify(digest, proof);
  assert.equal(ok.valid, true);
  assert.equal(ok.status, 'confirmed');
  assert.equal(ok.btcHeight, 800000);

  const wrong = await provider.verify(digestOf('someone-else'), proof);
  assert.equal(wrong.valid, false);

  const garbage = await provider.verify(digest, 'deadbeef');
  assert.equal(garbage.valid, false);
});

test('stamp wraps a calendar response into a parseable pending proof', async () => {
  const digest = digestOf('stamp-me');
  const calendarTimestamp = serializeTimestampBytes(
    node([{ item: 'attestation', attestation: { kind: 'pending', uri: 'https://cal.test' } }]),
  );
  const transport = async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(url, 'https://cal.example/digest');
    return { ok: true, status: 200, bytes: async () => calendarTimestamp };
  };
  const provider = new OpenTimestampsProvider({ calendarUrl: 'https://cal.example', transport });
  const result = await provider.stamp(digest);
  assert.equal(result.status, 'pending');
  const reparsed = parseOtsProof(Buffer.from(result.proof, 'hex'));
  assert.equal(hex(reparsed.fileDigest), hex(digest));
  assert.equal(pendingAttestations(reparsed).length, 1);
});

test('upgrade GETs /timestamp/<commitment> and confirms when Bitcoin attests', async () => {
  const digest = digestOf('upgrade-me');
  const proof = hex(pendingProof(digest, 'https://cal.test'));
  const upgradeBody = serializeTimestampBytes(
    node([{ item: 'attestation', attestation: { kind: 'bitcoin', height: 870123 } }]),
  );
  let calledUrl = '';
  const transport = async (url, init) => {
    calledUrl = url;
    assert.equal(init.method, 'GET');
    return { ok: true, status: 200, bytes: async () => upgradeBody };
  };
  const provider = new OpenTimestampsProvider({ transport });
  const result = await provider.upgrade(digest, proof);

  assert.equal(calledUrl, `https://cal.test/timestamp/${hex(digest)}`);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.btcHeight, 870123);
  // The upgraded proof keeps the pending attestation and now carries Bitcoin.
  const reparsed = parseOtsProof(Buffer.from(result.proof, 'hex'));
  assert.equal(bitcoinHeight(reparsed), 870123);
  assert.equal(pendingAttestations(reparsed).length, 1);
});

test('upgrade stays pending when the calendar has not confirmed yet', async () => {
  const digest = digestOf('still-waiting');
  const proof = hex(pendingProof(digest, 'https://cal.test'));
  const transport = async () => ({
    ok: false,
    status: 404,
    bytes: async () => new Uint8Array(),
  });
  const provider = new OpenTimestampsProvider({ transport });
  const result = await provider.upgrade(digest, proof);
  assert.equal(result.status, 'pending');
  assert.equal(result.btcHeight, undefined);
});

test('anchorAttestation → refreshAnchor → verifyAnchor against a fake calendar', async () => {
  const signed = signEnvelope(
    predictionAttestation({
      subject: 'did:example:ada',
      tier: 'routine',
      fields: { outcome: 'eclipse-2027' },
    }),
    generateKeypair().privateKey,
  );

  const stampBody = serializeTimestampBytes(
    node([{ item: 'attestation', attestation: { kind: 'pending', uri: 'https://cal.test' } }]),
  );
  const upgradeBody = serializeTimestampBytes(
    node([{ item: 'attestation', attestation: { kind: 'bitcoin', height: 860000 } }]),
  );
  const transport = async (url, init) =>
    init.method === 'POST'
      ? { ok: true, status: 200, bytes: async () => stampBody }
      : { ok: true, status: 200, bytes: async () => upgradeBody };
  const provider = new OpenTimestampsProvider({ calendarUrl: 'https://cal.example', transport });

  const anchored = await anchorAttestation(signed, provider);
  assert.equal(anchored.anchor.provider, 'opentimestamps');
  assert.equal(anchored.anchor.status, 'pending');

  const refreshed = await refreshAnchor(anchored, provider);
  assert.equal(refreshed.anchor.status, 'confirmed');
  assert.equal(refreshed.anchor.btcHeight, 860000);

  const verified = await verifyAnchor(refreshed, provider);
  assert.equal(verified.valid, true);
  assert.equal(verified.status, 'confirmed');
});
