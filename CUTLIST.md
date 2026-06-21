# CUTLIST — DynastyTrust (non-signing, trust/governance surface)

Small, floor-gated cuts that harden the **non-signing** trust/governance
display and backup surface — the "banner shows the meaning" layer where a wrong
number or string misrepresents when a timelock unlocks or what a backup
contains. Derived from real untested pure logic. This is NOT the big DT-1..DT-6
feature work in `docs/build-map-and-cut-lists.md` (templates, the bot, the Nostr
bridge, FROST) — those are signing-adjacent and/or too large for one iteration
and are explicitly out of scope for the loop.

## THE SIGNING FENCE — hard stop (read before every cut)

This repo is money-touching, irreversible Bitcoin software. The loop is fenced
to non-signing work. If a cut would require editing ANY of these, STOP
immediately: do not edit, leave the box unchecked, write one line under it
naming what it would have touched, and end the loop for operator review.

- `apps/web/src/lib/psbt-signer.ts` (BIP341 sighash + Schnorr signing)
- `apps/web/src/lib/keystore.ts` (key material, AES/PBKDF2)
- anything under `compiler/` or `protocol/` (the Rust signing/compile engine)
- any change that alters what bytes get signed, encrypted, or broadcast

The three cuts below touch none of these. The fence guards against drift.

## Loop contract — how each iteration runs

For the next unchecked `- [ ]` cut, in order:

1. Read the named file(s) and surrounding code before editing. Ground in the
   repo as it is, not memory. Re-read THE SIGNING FENCE.
2. Make the **smallest** change that satisfies the cut. Tests only, or a
   behaviour-preserving pure extraction plus its test. Never change what a
   function computes for a given input.
3. Run `npm run verify` (typecheck, lint, test, build, test-baseline, doctrine).
   It must be fully green.
4. If the baseline tripwire reports "grew", run `npm run test:baseline:write`,
   then re-run `npm run verify` to confirm green.
5. If green: check the box, commit the cut + `CUTLIST.md` + `.test-baseline.json`
   together, push to `claude/asymmetric-industries-projects-epz8q0`. Never main.
6. If red and not cleanly fixable with a small non-signing change: revert
   (`git restore`), leave the box unchecked with a one-line reason, stop.
7. Stop when every box is checked, or on the first un-clearable red, or the
   first time a cut would cross the signing fence.

Hard rules: working branch only, never `main`; never weaken an existing test to
go green (tripwire enforces); one cut per commit; the signing fence is absolute.

## Cuts

- [x] **chain: test the timelock countdown labels.**
  `src/lib/chain.ts` is pure and untested. In a new `src/lib/chain.test.ts` pin
  `blocksToApproxLabel`: `<= 0` is "Available now"; the hours/days/months/years
  bucket boundaries (e.g. a count under one day reads in hours, ~30 days reads in
  months, multi-year reads "~N.N years"). Also pin `approxWallclockDate` uses the
  10-minutes-per-block assumption (a known `blocksFromNow` lands ~the expected
  offset from now, within a tolerance). This is the inheritance-countdown the
  trust overview shows — a wrong label misrepresents when a path unlocks.

- [x] **config: pin the explorer + broadcast URLs per network.**
  In a new `src/config.test.ts`, pin `explorerTxUrl(network, txid)` and
  `broadcastTxUrl(network)` for all three networks (bitcoin, testnet, signet) to
  their exact expected URLs, so a wrong explorer/broadcast endpoint (which would
  send a user to the wrong chain's explorer) can't silently ship.

- [ ] **descriptor-backup: characterize vaultBackupText.**
  `src/lib/descriptor-backup.ts:vaultBackupText` is pure and untested. In a new
  `src/lib/descriptor-backup.test.ts` pin that the backup text contains the
  vault's descriptor and the load-bearing fields a restorer needs, and — security
  guard — that it never contains any private/secret material (it builds from
  public descriptor + xpubs only). Read the function first; assert what it
  actually emits, do not change what it emits.
