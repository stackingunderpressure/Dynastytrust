# tapit-attest

A standalone, signed-attestation primitive. One envelope shape carries
**six kinds** of attestation across **three trust tiers**. No Bitcoin-script
dependency -- it depends only on a secp256k1/Schnorr library, a hash library,
and (optionally) an OpenTimestamps client.

This library was extracted from DynastyTrust's proven governance-attestation
layer (`trust_doc`, `proof_of_life`, `death_declaration`, `descriptor`) and
generalized so any project can consume the primitive. DynastyTrust keeps its
Bitcoin custody code; tapit-attest carries only the attestation logic.

## The primitive

Every attestation is the same envelope:

- a **signer** (one or more x-only secp256k1 public keys)
- a **subject** (what/who the claim is about)
- a **claim** built as a Merkle **field tree** of named fields
- an **issued-at** timestamp
- an optional **anchor** (OpenTimestamps)
- one or more **signatures** over the digest that commits to the field-tree
  root plus the envelope metadata

Signatures are **BIP340 Schnorr over secp256k1**, via `@noble/curves` -- the
same curve and library DynastyTrust signs with. Not Ed25519.

### Digest construction

```
metaHash = taggedHash(meta,  canonicalJson{v,kind,tier,subject,issuedAt})
digest   = taggedHash(root,  metaHash || fieldTreeRoot(claim))
```

Every signer signs `digest`; the anchor stamps `digest`. Changing the
subject, tier, timestamp, or any claim field invalidates every signature.

## Six kinds

| kind           | meaning                                            | DynastyTrust origin |
|----------------|----------------------------------------------------|---------------------|
| `identity`     | who a public key belongs to                        | `descriptor`        |
| `relationship` | a recurring, corroborated relationship / continuity| `proof_of_life`     |
| `credential`   | something done or earned                           | (new)               |
| `prediction`   | a future outcome, anchored before the event        | (new)               |
| `agreement`    | a multi-party mutual commitment                    | `trust_doc`         |
| `meta`         | repudiation / revocation / key-succession          | `death_declaration` |

The kind is a label, not a code path.

## Three tiers (configuration only)

`routine`, `notable`, `high_stakes` are **dials**, never separate code:

- `requiredSigners` -- minimum distinct signatures
- `minSignerWeight` -- minimum summed signer weight
- `finalityWindowMs` -- how long an attestation stays `pending`
- `requireCoSign` -- whether a lone signer is ever enough

`evaluateTier` runs identical logic for all three. If a tier needs its own
branch, that is a bug.

## v1 surface (built and tested)

| area              | exports |
|-------------------|---------|
| Field tree        | `leaf`, `branch`, `treeFromObject`, `fieldTreeRoot`, `findLeafValue` |
| Envelope          | `createDraft`, `attestationDigest`, `canonicalEnvelope`, `envelopeId`, `assertWellFormed` |
| Builders          | `identityAttestation`, `relationshipAttestation`, `credentialAttestation`, `predictionAttestation`, `agreementAttestation`, `metaAttestation` |
| Keys + signing    | `generateKeypair`, `publicKeyFromPrivate`, `signEnvelope`, `verifyEnvelope`, `verifySignature` |
| Tiers             | `DEFAULT_TIERS`, `tierConfig`, `evaluateTier` |
| Anchoring         | `anchorAttestation`, `refreshAnchor`, `verifyAnchor`, `MockOtsProvider`, `OpenTimestampsProvider`, `OtsProvider` |
| Key succession    | `createSuccessionLink`, `verifySuccessionChain` |
| Weighting         | `computeWeight` (recomputable sum) |
| Revocation        | `createRevocation`, `RevocationLedger` (`pending`/`final`/`void`) |
| Encryption        | `encrypt`, `decrypt`, `decryptToString` (AES-256-GCM + PBKDF2-SHA256) |
| Sync              | `AttestationStore`, `MemoryStore`, `SyncEngine`, `toRecord`, `loadVerified` |
| Recovery          | `buildRecoveryRequest`, `buildRecoveryResponse`, `verifyRecoveryResponse`, `rebuildFromResponses` |

### Quick start

```ts
import {
  generateKeypair, identityAttestation, signEnvelope, verifyEnvelope,
} from 'tapit-attest';

const kp = generateKeypair();
const draft = identityAttestation({
  subject: 'did:example:ada',
  tier: 'routine',
  fields: { key: kp.publicKey, label: 'Ada Lovelace' },
});
const attestation = signEnvelope(draft, kp.privateKey);

verifyEnvelope(attestation).valid; // true
```

## v1.1+ slots (designed for, not implemented)

These are named, documented stubs. The v1 data shapes already accommodate
them, so no envelope has to be re-signed when they ship:

- **Field-level selective disclosure** -- `disclosureProof` in
  `core/field-tree.ts`. The Merkle field tree exists in v1 precisely so a
  subtree can later be revealed with sibling hashes and verified against the
  signed root.
- **Full weighting engine** -- `advancedWeighting` / `WeightingPolicy` in
  `core/weighting.ts`. Recency decay, corroboration-graph centrality,
  per-kind weighting. v1 ships the recomputable sum (`computeWeight`).
- **Repudiation handling** -- `repudiate` in `core/revocation.ts`.
  Challenging a *finalized* attestation needs its own dispute flow; v1's
  state machine only covers `pending -> final` and `pending -> void`.
- **Recovery orchestration** -- `orchestrateRecovery` in `core/recovery.ts`.
  Peer discovery, requiring N corroborating peers, quarantine of
  single-source records. v1 ships the signed request/response message
  shapes plus `verifyRecoveryResponse` / `rebuildFromResponses`.
- **Richer sync reconciliation** -- `SyncEngine` is last-write-wins in v1.
  Per-field merge / vector clocks are deferred.

## Dependencies

- `@noble/curves` -- secp256k1 / Schnorr
- `@noble/hashes` -- SHA-256, PBKDF2
- `@noble/ciphers` -- AES-256-GCM
- `opentimestamps` -- *optional*; only `OpenTimestampsProvider` needs it.
  `MockOtsProvider` covers tests and local dev with no network.

No Bitcoin-script dependency: no descriptors, PSBT, Miniscript, or Taproot.

## Gates

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # tsc -> dist/
npm test            # build, then node --test
```

Unit tests cover sign/verify, anchor round-trips, the key-succession chain,
the revocation machine, encryption, sync, and peer recovery.

### Unverified

`OpenTimestampsProvider` (the real, Bitcoin-backed anchor provider) is
**unverified**: exercising it requires public OpenTimestamps calendar
servers and Bitcoin confirmation, which the offline unit suite cannot
cover. The provider interface and anchor flow are verified end-to-end
against `MockOtsProvider`.

## Status

v1 foundation. Authored as an isolated top-level folder so it can be lifted
wholesale into its own `tapit-attest` repository.
