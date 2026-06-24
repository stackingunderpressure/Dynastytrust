# tapit-attest standardization — one envelope standard, two repos

> This document is the permanent record of why the `tapit-attest` library
> is now byte-identical in every repo that vendors it, how that is
> enforced, and what to do when it must change. It is written to be read
> cold by anyone in the future. It is committed identically into every
> repo that carries `tapit-attest`.

## The one-sentence rule

`tapit-attest` is the **single signed-attestation envelope standard** for
the fleet. Every repo that vendors it carries a **byte-identical** copy.
The **canonical source of truth is the `tapit-wallet` repo**. A change is
made in `tapit-wallet` first, then mirrored out — never edited downstream.

## Why this document exists — the drift that was found (2026-06-24)

`tapit-attest` was originally extracted from DynastyTrust's governance
attestation work, then it grew up inside `tapit-wallet` into the wallet's
full identity core. Because each repo kept its **own hand-vendored copy**,
the two copies silently diverged — and not cosmetically. They had become
**two cryptographically incompatible standards that happened to share a
name**. For the exact same claim, the two copies computed different signed
bytes:

| Construction | DynastyTrust copy (old) | tapit-wallet copy (canonical) |
|---|---|---|
| Leaf hash | `taggedHash("tapit-attest/v1/field-leaf", u32(nameLen)‖name‖u32(valLen)‖value)` | `taggedHash("tapit/leaf", utf8(canonicalJson({name, value})))` |
| Branch hash | `taggedHash("tapit-attest/v1/field-branch", u32(nameLen)‖name‖u32(childCount)‖…childHashes)` | `taggedHash("tapit/branch", utf8(name)‖concat(childHashes))` |
| Node shape | `{ kind: "leaf" \| "branch" }` | `{ node: "leaf" \| "branch" }` |
| Leaf value type | `string \| number \| boolean \| null` | `string \| number \| boolean` |
| Kinds | 6 | 7 (adds `journal`) |
| Tags | `tapit-attest/v1/*` | `tapit/*` |

The consequence: an attestation signed under one copy **would not verify
under the other**. For money-touching, identity-bearing software, two
copies of the canonical envelope that disagree is the precise failure the
"one library, never re-implemented" doctrine exists to prevent.

## The decision and the reasoning

**Decision: `tapit-wallet`'s `tapit-attest` is the canonical source of
truth. DynastyTrust's copy was replaced to match it byte-for-byte.**

The direction was not a judgment call — it was forced by where the real,
irreversible data lives. Both sides were investigated for blast radius
(the full evidence is in the session record; the load-bearing findings):

- **tapit-wallet — maximum blast radius, format LOCKED.** Real
  attestations are persisted (browser IndexedDB plus the Supabase
  `wallet_blobs` encrypted snapshot), **chain-anchored via
  OpenTimestamps**, multi-device synced over Nostr, and shipped across
  five production features (identity attestation, friends-trees,
  sign-in by attestation, the Shamir recovery cohort, encrypted sync).
  Changing the wallet's canonical bytes would invalidate every stored
  signature, orphan every confirmed Bitcoin anchor (the anchored digest
  would no longer match), and break recovery from backup. Its format
  cannot move.
- **DynastyTrust — zero blast radius.** Its app does **not import
  `tapit-attest` at all**. The `tapit-attest/` directory was an orphaned
  workspace-external snapshot (the root `workspaces` are only `apps/*`
  and `packages/*`, and CI never built or tested it). DynastyTrust's own
  governance attestations use a **separate, simpler bespoke format**
  (`DT-ATT-v1` in `apps/web/src/lib/attest.ts`, a flat
  `SHA256(tag‖type‖sep‖hash)` with no Merkle tree), persisted in the
  `vault_attestations` table. Nothing in DynastyTrust was committed to
  its `tapit-attest` copy.

A side with live, chain-anchored production data cannot move; a side with
an orphaned, unconsumed copy can. So the wallet is the source of truth and
DynastyTrust adopts it.

## Proof of the standardization (2026-06-24)

Every claim below was run, not assumed.

1. **Byte-identical.** `diff -rq` of the two `tapit-attest` trees
   (excluding `node_modules/` and the build output `dist/`) reports no
   differences. `src/` and `test/` are identical.
2. **Library is correct in both repos.** The canonical suite —
   `npm test` (which runs `tsc` build + `node --test "test/**/*.test.mjs"`)
   — passes identically in both: **160 pass / 0 fail / 4 skipped, 164
   total**.
3. **Neither app regressed.** The wallet consumes `tapit-attest` as a
   `file:` dependency and its gates stay green. DynastyTrust's app gates
   are structurally unaffected because the directory is outside its
   workspace and is imported by nothing.
4. **The manifest is identical across repos.** `INTEGRITY.sha256` (44
   files under `src/` and `test/`) is byte-identical in both repos, and
   the guard passes in both.

## The mechanism that keeps it flawless — `INTEGRITY.sha256`

Prose does not stop drift; a failing check does. `scripts/check-integrity.mjs`
hashes every file under `src/` and `test/` and compares the result to the
committed `INTEGRITY.sha256`. It is wired into each repo's CI (the `gates`
workflow) and runs as a pure-node step before install, so any local edit
to a vendored copy fails CI.

Because the **same** `INTEGRITY.sha256` is committed in every repo, and
each repo's CI verifies its own tree against it, two passing repos are
provably identical: each matches the same manifest, therefore each other.

## How to change `tapit-attest` (the only safe procedure)

1. Make the change in **`tapit-wallet`** (the canonical source) on a
   branch. This is the only place `tapit-attest` is edited.
2. Treat any change to the canonical signed bytes (tags, leaf/branch
   hashing, node shape, canonical JSON, the `Attestation` shape) as a
   **breaking format change**. The wallet has chain-anchored production
   data on the current format — a breaking change needs a real migration
   plan (a `v: 2` envelope plus re-sign / re-anchor logic), never a silent
   edit. Additive, backward-compatible changes are the default.
3. Regenerate the manifest: `node scripts/check-integrity.mjs --write`.
4. Run `npm test` in `tapit-attest` — green before going further.
5. Mirror `src/`, `test/`, the config files, `scripts/check-integrity.mjs`,
   `INTEGRITY.sha256`, and this file into **every** repo that vendors
   `tapit-attest`. Verify each with `diff -rq` and the integrity guard.
6. Run each downstream repo's full gates before pushing.

## Known follow-on (not done here) — DynastyTrust does not yet *use* the shared standard

Standardizing the *library* is complete. A separate, larger question
remains open by design: DynastyTrust's app still signs its governance
attestations with its own `DT-ATT-v1` format and does **not** import the
shared `tapit-attest`. Making DynastyTrust actually consume the shared
envelope (so the two apps share one signing standard in production, not
just one vendored library) is a real migration — it touches the deployed
`vault_attestations` table and the Trust tab — and is therefore its own
decision, with its own blast radius, to be taken deliberately. It is
flagged here so the gap is honest and visible, not hidden behind the
shared-library lineage.

---

*Canonical source: `tapit-wallet` repo, `tapit-attest/`, version
`0.1.1-wallet.0`, at commit `a50ef53` (the TA-1 sign-in release).
Standardized 2026-06-24.*
