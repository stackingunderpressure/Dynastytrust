# Outside review of DynastyTrust + the SeedSigner fork (2026-11-27)

The operator relayed this review. It covered both repos. It reported no
critical or high findings in the ranged-address or change-verification code.
It ran 143/143 Rust tests and `npm test` on DynastyTrust, plus 403
transaction and core tests on the SeedSigner fork (the QR and screen tests
could not load without libzbar).

One correction to the review: it said the audit package was "not merged to
main yet". The package has been on `main` since the 2026-11-26 releases;
checked with `git cat-file -e origin/main:docs/audits/2026-12-package.md`.

## Medium (SeedSigner fork) — fixed, branch `claude/dynasty-trust-last-work-clryy9`, 614ebd81

| # | Finding | Fix |
|---|---|---|
| M1 | Without a descriptor, an output whose tap tree holds one of the seed's keys was counted as change. That includes `tr(NUMS,{pk(you),pk(attacker)})`, which the attacker can spend alone. | `settle_unverified_script_tree_change`: with no descriptor such outputs count as money leaving; with a descriptor they're verified as before. |
| M2 | The change-index warning only fired 10,000 addresses past the inputs. DynastyTrust caps change at 999, and the Core recovery steps import 0–999. | `CHANGE_ADDRESS_INDEX_WINDOW` cut to 1,000 (stock's relative rule otherwise kept). |

Tests first: `tests/test_unverified_script_tree_change.py` (4) failed
before the fix and passes after. Full fork suite: 495 passed. The 5 l10n
tests fail the same with and without the fix (no compiled translations in
the test environment).

## Low — logged, not yet fixed

1. Two spend proposals open at the same time can both reuse the lowest
   unpaid change address. That's a privacy leak only.
2. Exported backups carry only the `<0;1>/*` multipath descriptor. Adding
   the stored `/0/*` and `/1/*` single-branch descriptors would cover
   Bitcoin Core 28 and older.
3. The look-ahead is tight (`{0:5, 1:2}`), and scanning makes one HTTP call
   per address, which can hit mempool.space rate limits on older vaults. It
   fails closed.
4. `RangedVault::build_spend_psbt` is still public, with
   `ENABLE_RBF_NO_LOCKTIME`. Production calls only `build_path_spend_psbt`.

## What the review found sound

- The `older()` sequence: `build_path_spend_psbt` reads locks from the leaf
  and sets nLockTime and `Sequence::from_height`.
- Multi-address spends.
- `miniscript::Translator` descriptor building (Tapit bare keys kept fixed).
- Row-locked index counters.
- Frozen compiled descriptors.
- Browser-side re-derivation.
- The fork is caught up with stock SeedSigner PR #1073 and verifies ranged
  Taproot descriptors with Tapit bare keys.
