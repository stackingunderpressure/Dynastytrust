# Build note: re-audit the newer code in-house, before the next outside audit

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-25, in his words)

"I'm always up for further testing and I don't know how much of that testing
we can do in-house too, cause everything we catch before it goes to another
auditor is even better, so I don't know what we can do to re-secure or
re-audit in-house at least and get ready for an audit ... how we got here was
always reassessing and constantly asking, are we good enough? ... Is it doing
the right thing? Test it."

## What is already proven (HISTORY.md "Evidence record", read 2026-11-25)

- A mainnet spend through the app: a single-address 1-of-2 vault,
  transaction `03107bcc…f77c`, block 962,506 (2026-08-15).
- An outside scan with 146 findings, triaged and fixed in about twenty
  commits (2026-08-21 and 2026-08-29). The operator says four audits ran at
  different times, with fewer of them on the newest code.
- `scripts/offline-harness.sh` (part of `npm test`): 33 checks across seven
  vault shapes, run through the real compiler, signer and finalizer.
- `scripts/bitcoin-core-proof.mjs` and `scripts/bitcoin-core-ranged-proof.mjs`
  check vaults against stock Bitcoin Core: the same addresses, Core spending
  on its own, and the "if untouched" path refused and then accepted. These
  are NOT in `npm test`, because they need a Core download. The record
  doesn't say when they last ran against today's code.
- Signet, 2026-11-25 (operator-witnessed plus the chain): a fresh-address
  coin on receive address 1 spent through the everyday path. The SeedSigner
  fork rejected the wrong ones and signed the right one.

## What has had the least outside eyes (the new code)

1. Fresh-address vaults: deriving addresses, issuing receive addresses
   (`vault-addresses.js`, `_receive-choice.js`), reusing change, finding
   coins across addresses, and spending from many addresses
   (`_ranged-spend.js`).
2. Mapping each child key back to its vault key
   (`packages/vault-rules/src/ranged-signers.js`), which decides whether a
   signature counts on the server, on the request page and on the Send
   screen.
3. Tapit co-signing on fresh-address vaults, and Tapit's change-address
   check against the next 200 change scripts.
4. The wellness path (owner must sign + K of N checkers), and the duress
   hold: `/api/vault-duress`, its signature check, its one-use rule, the
   rule that the owner can't lift a circle hold alone, and the cross-site
   headers.
5. Electrum lookups and pinning each person's own server.

## What would be built, in order

1. **Re-run Bitcoin Core as referee on today's code, and extend it.** Run
   both Core proofs as they stand and record the result with a date. Then
   add to the fresh-address proof:
   - a signature by an xpub key's child counts exactly once and only for
     its own vault key, and a signature from any other key never counts;
   - a vault mixing a Tapit bare key with xpub keys;
   - change to the next unused change address, accepted by Core, and change
     to an address not in the vault's list, refused by our check;
   - addresses 0 to 500 on both chains, compared to Core's own derivation.

   Add a dated line to the evidence record each time it passes.
2. **Hostile-input tests for the new checks**, inside `npm test`:
   - `canonicalSigner` is fed thousands of random and adversarial
     derivation claims: wrong fingerprint, a hardened index, a path on
     another account, a claim whose derived child doesn't match. It must
     never map anything but an exact derived match.
   - The change check gets near-miss scripts.
   - The duress endpoint gets signatures from non-members, replays, stale
     times, and a revoked grant.
3. **A blind adversarial review** of only the five areas above. A fresh
   reviewer gets the code and the rules in `CLAUDE.md`, not our
   conclusions. Findings come with file and line, each classified as
   confirmed or plausible. We fix the confirmed ones one at a time, each
   with a test that fails first.
4. **The screen walk as a kept test.** Move today's phone-width walk (a
   faked server, the real page, a real browser signer) into the repo, so a
   signature count or a buried button gets caught before you see it. It
   stays out of `npm test` if it needs the dev server; it gets its own
   command.
5. **An audit package** at `docs/audits/2026-12-package.md`:
   - what changed since each outside audit, by commit;
   - what each new piece promises, in one line each;
   - which proof covers it;
   - what we know is not covered.

   This gives the next auditor's time to the hard parts. If the original
   Kimi report is found, it goes under `docs/audits/` too.

## Decisions that are the operator's

1. **Bitcoin Core download.** May the session download a pinned Bitcoin Core
   release (checksum checked) into the scratchpad to run the proofs?
   (Recommended — the proofs can't run without it.) Or the operator runs
   them on his own machine.
2. **Scope of the blind review.** Only the five new areas (Recommended —
   the older code had the outside audits), or the whole repo again.
3. **When a confirmed finding is money-touching.** Fix it, run the gates and
   hold for his word before shipping (Recommended, as today), or batch them
   all to the end.

## Blast radius

- New and changed test scripts under `scripts/`. `package.json`'s `test`
  gains the hostile-input tests (they're fast and need no network). The
  Core proofs stay outside `npm test`.
- `HISTORY.md` evidence record: dated lines.
- `docs/audits/`: new.
- No app behaviour changes unless a finding is confirmed. Each fix goes
  through its own Build Note line and ship word.
- Nothing told to users changes.

## Deliberately left out

- Paying for an outside audit (the operator's call, after the package
  exists).
- Mainnet spends of the new vault shapes (after this, on his word).
- Splitting `VaultDetail.tsx` (a known risk the package will name, not fix).

## Operator's decisions (2026-11-25)

1. Download a pinned, checksum-checked Bitcoin Core into the scratchpad.
2. The blind review covers only the five new areas.
3. Fix confirmed money-touching findings one at a time, each held for his word.

## Status (2026-11-26)

1. Bitcoin Core referee: done. Both proofs repaired and extended, 14 + 14
   checks, including the mixed Tapit + xpub vault.
2. Hostile-input tests: folded into the blind-review fixes, each of which
   has a test that failed first.
3. Blind review: done. 8 findings fixed and live, 1 recorded as design
   (`docs/audits/2026-11-25-blind-review-new-code.md`).
4. Screen walk kept: `npm run walk:screens`.
5. Audit package: `docs/audits/2026-12-package.md`.
