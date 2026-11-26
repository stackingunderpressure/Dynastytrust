# Audit package for the next outside review — prepared 2026-11-26

In-house re-audit step 5 (`docs/in-house-reaudit-build-note.md`). This is
for an outside reviewer. It says what changed since the last outside audit,
what each new piece promises, what already proves it, and what nothing
proves yet. Every proof here can be re-run, and the commands are at the
end. Nothing in this file is from memory: each line names a commit, a file,
or a test.

Code state: branch `claude/dynasty-unify-2026-11` = `main` at the release of
2026-11-26 (`cfe30aa`), plus test-only commits after it (`af5f041`,
`07d1a2e`).

## 1. What outside review has already covered

- **Recorded in the repo:** a paid automated security scan (Kimi K3) with
  146 findings, triaged 2026-08-21 and followed up 2026-08-29. The
  confirmed findings were fixed in about twenty commits, listed in
  `HISTORY.md` → "Evidence record" item 2. The scan's own per-finding text
  is NOT in the repo (gap noted there).
- **Operator-reported, not in the repo:** four outside audits in all, at
  different points in the code's life, with fewer of them on the newest
  code. The single-address vault shape had three or four scans, and each
  found fewer bugs, until none would reach a spending path on real
  bitcoin. If those reports are found, they belong in `docs/audits/`.
- **Real money:** a mainnet spend through the app, transaction
  `03107bcc…f77c`, block 962,506, 2026-08-15. This was a single-address
  1-of-2 vault (Evidence record item 1).

So the audited ground is the **single-address vault** and the app as it stood
at the end of August 2026. Everything below is newer.

## 2. What changed since (284 commits, 2026-08-30 → 2026-11-26)

Grouped by area. Each area gives its release commits on `main` and the
Build Note that set its rules before code was written.

| Area | Releases | Build Note / record |
|---|---|---|
| Threat-model fixes A–J: database writes closed, phone pin of each vault, owner sign-in hardening, rate limits | `7905602`, `71c20a1`, `1aee98f` | `docs/threat-model-2026-11-13.md`, `docs/security-backlog.md` |
| Sign-in without email: Face ID accounts, Tapit "sovereign sign-in", username | `9c85ebd`, `02dd5b2`, `b9ed874`, `a06adb9`, `fae1631` | `docs/key-signin-build-note.md`, `docs/z4-accounts-without-identity-build-note.md`, `docs/tapit-signin-binding-build-note.md` |
| Zero-knowledge storage: names, labels, comments, history and reports sealed with the vault key | `b87674c`, `3896c92` | `docs/zero-knowledge-storage-plan.md` |
| Sealed vault ledger, anchored to Bitcoin | `55d04f1`, `29f3f8d` | `HISTORY.md` |
| Path builder: must-sign keys, "fully signed" decided by who signed, one key on several paths | `8168739`, `bde1f51`, `890a2b9`, `52547e5` | `HISTORY.md` |
| Fly retired: one compiler (Rust to wasm, in process) | `542b18f` | `docs/retire-fly-build-note.md` |
| "If untouched" (relative timelock) as the only later path, behind a warning card | `542b18f` | `docs/untouched-only-build-note.md` |
| **Fresh-address vaults** (`<0;1>/*`): receive, change, finding coins, spending from many addresses, backups | `e04b75d`, `fa2b177`, `8de43b9`, `bc86f50` | `docs/ranged-addresses-slice{2,3,5}-build-note.md`, `docs/receive-address-reuse-until-paid-build-note.md` |
| Signatures by child keys counted as their vault key | `2fb3259`, `a5cdac7` | `HISTORY.md` 2026-11-25 |
| Electrum lookups, including a person's own pinned server | `1a01564` | `docs/chain-lookups-build-note.md` |
| Tapit co-signing on fresh-address vaults; Tapit's change-address check; per-member review modes | `1a01564`, `abb5ed7` | `docs/tapit-fresh-address-cosign-build-note.md`, `docs/tapit-review-modes-build-note.md` |
| Wellness path (owner must sign + K of N checkers) and the duress hold for the circle | `a85e4ec`, `c7bf164` | `docs/wellness-group-build-note.md` |
| Blind-review fixes (below) | `e2f668a`, `714f51e`, `d707b49`, `1ae06f8`, `cfe30aa`; Tapit `bc342fc` | `docs/audits/2026-11-25-blind-review-new-code.md` |

## 3. What each new piece promises, and what proves it

"Core" means stock Bitcoin Core 32.1 on a private regtest chain:
`scripts/bitcoin-core-proof.mjs` (14 checks) and
`scripts/bitcoin-core-ranged-proof.mjs` (14 checks), last run 2026-11-26,
both OK.

| Promise | Proved by |
|---|---|
| No server, row or API call can move a coin: script-path only, NUMS internal key | Mainnet spend (control block = NUMS); Core proofs; `scripts/offline-harness.sh` (33 checks, part of `npm test`) |
| A fresh-address vault's descriptor gives the same addresses as Core | Core ranged proof: same checksum, receive and change 0–499 |
| One watch-only import of the backup's one descriptor finds every coin | Core ranged proof, step 2 |
| The family can spend with Core alone, without this app | Both Core proofs: "Core alone" steps, including the "if untouched" path |
| "If untouched" is refused before the coin's own wait and accepted after | Core ranged proof, step 5 (refused as non-BIP68-final, then mined) |
| A child-key signature counts once, for its own vault key, and never for another | Core ranged proof 4b and 6; `test-ranged-sign.mjs`; blind review "checked and holding" |
| A vault mixing a bare Tapit key with xpub keys works and is counted right | Core ranged proof, step 6 (Core stands in for Tapit's signer) |
| Change goes only to a change address the vault handed out | `test-change-recorded.mjs`; Core ranged proof (reused change mined) |
| Only the owner reserves new receive addresses; at most 20 unpaid in a row | `test-vault-addresses.mjs` (12 cases) |
| A duress hold stops signing, filing, merging and building, on the server and on the request page | `test-duress-guard.mjs`; `test-vault-duress.mjs` (9 cases) |
| Only the vault's own compiled wellness checkers can raise or lift a circle hold; the owner alone cannot | `test-vault-duress.mjs` cases 7–8; checked against a real compiled wellness vault |
| A merge sets a proposal's status only from its own transaction and coins | `test-merge-same-tx.mjs` |
| A user's own Electrum server must be public, pinned, and on the right chain | `test-electrum.mjs` (16, including IPv6 forms) |
| Keys and seed words never leave the browser unencrypted | Design rule in `CLAUDE.md`; keystore tests (`test-keystore-*.mjs`). **No outside check since the August scan.** |
| Screens: each tapped result lands on screen; counts are right after signing | `npm run walk:screens` (phone width, real browser, faked server) |
| Tapit refuses while a hold stands, and asks first when it can't check | Tapit `vaultDuress.test.ts`; Tapit suite 1,074 tests |

## 4. What nothing proves yet — where an auditor's time is best spent

1. **Tapit's own signing code on fresh-address and mixed vaults.** In the
   Core proof, Core stands in for Tapit, and the operator has walked it on
   signet. No outside review has seen it.
2. **The zero-knowledge storage and the vault key** (sealing, key wrap,
   who can open what). This is new since August, and only in-house tests
   cover it.
3. **Sign-in without email**: Face ID / passkey accounts, the Tapit sign-in
   binding, and owner sign-in hardening for real-bitcoin vaults.
4. **The duress system end to end across both apps**: the notice format,
   the cross-site headers, the Nostr notices between checkers. Each part
   has tests; no one outside has tried to break the whole.
5. **The relative-timelock ("if untouched") vault shape on mainnet**: proven
   on regtest only.
6. **A spend with this vault's coins but someone else's change, when the
   PSBT gives no derivation for the change.** Co-signers would see that
   output as the destination. This is covered by design, not by a test.

## 5. Known weaknesses we are not hiding

- `apps/web/src/pages/VaultDetail.tsx` is about 9,100 lines, far over the
  repo's own 800-line limit. Every change there carries more risk than it
  should. Splitting it is a planned slice, not done.
- `npm run typecheck` has 10 errors that were already there (keystore and
  psbt-signer typings, and a signet/testnet type union). The build is
  green; the typecheck is not clean.
- Tapit's `npm run build` fails on two bundle budgets that were already
  over (SettingsScreen, WalletProvider). `build:sovereign` passes.
- The Bitcoin Core download was checked against the release's SHA256SUMS;
  the signatures on that SUMS file were not verified.
- The blind review was in-house (an AI reviewer given only the code and
  the rules). It is a pre-audit, not an audit.

## 6. How to re-run every proof

```
npm test                                   # unit, handler and harness tests (~90 scripts) + the offline every-door harness
BITCOIN_BIN=/path/to/bitcoin-32.1/bin node --experimental-strip-types \
  --import ./scripts/register-ts-resolver.mjs scripts/bitcoin-core-proof.mjs
BITCOIN_BIN=/path/to/bitcoin-32.1/bin node --experimental-strip-types \
  --import ./scripts/register-ts-resolver.mjs scripts/bitcoin-core-ranged-proof.mjs
npm run walk:screens                       # phone-width screen walk (needs Playwright + Chromium)
# Tapit (separate repo): npm test; npm run build:sovereign
```

Results on 2026-11-26:
- `npm test`: exit 0.
- Bitcoin Core proofs: 14 + 14 checks OK.
- Screen walk: OK, 7 taps.
- Tapit: 1,074 tests passed.
