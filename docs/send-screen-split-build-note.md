# Build note: split the Send screen

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-27)

"Do the Send screen split next."

## Why it's different from the vault page split

`pages/vault-detail/SendTab.tsx` is 1,558 lines, but it's ONE function:
`SendTab`. The page split moved whole functions between files without
changing a line. This one has to cut a function open. Its state and its
three screens move into separate components, and values pass between them
as props. That's a refactor of the screen where money moves, so it gets a
Build Note and stronger checks.

## What's inside today (measured)

| Part | Lines | What it does |
|---|---|---|
| State and setup | 87–206 | ~25 `useState`s, the path choice, the Bloc ladder, totals |
| `buildAndSign` | 207–528 (~320) | Builds the spend (path, coins, fee), checks it, files the proposal |
| `signWithKey` | 529–758 (~230) | Signs with a browser key: password or Face ID, gates, merge, count |
| `externalImport` | 759–778 | Takes a signed PSBT from a hardware wallet or Tapit |
| `broadcast` | 779–871 (~90) | Sends, records, closes out stipends, tranches and requests |
| Done screen | 872–918 | "sent", the txid, "Record it in history" |
| Signing screen | 919–1250 (~330) | The summary, the ways to sign, Broadcast, Cancel |
| Form screen | 1251–1558 (~305) | Path, send to, amount, fee, memo, choose coins |

## What would be built

A folder `pages/vault-detail/send/`:

- `SendTab.tsx`: holds the state and decides which screen shows. It keeps
  `buildAndSign`, `signWithKey`, `externalImport` and `broadcast`, so every
  money step stays in one place, unchanged. Around 800 lines.
- `SendForm.tsx`: the form screen's markup, given the values and setters it
  shows. Around 320 lines.
- `SendSigning.tsx`: the signing screen's markup, given the signing state
  and the handlers it calls. Around 350 lines.
- `SendDone.tsx`: the done screen. Around 60 lines.

Rule for the cut: **only markup moves.** Every function that builds, signs,
records or sends stays in `SendTab.tsx` with its body unchanged. The new
components get no state of their own except what was purely visual (the QR
show/hide and the "copied" flash). That way the money logic is untouched by
this slice and can be split later on its own if needed.

If `SendTab.tsx` is still over 800 lines after that, it's reported, not
forced. The next cut would be the money functions themselves, and that's a
separate decision.

## How we know nothing changed

- The same gates as every slice: `npm test`, lint (0 errors), typecheck (the
  same 10 pre-existing errors), build.
- **The screen walk is extended first, before the split.** Today it stops at
  signing. It will also tap Broadcast against the faked server and check:
  - the "sent" screen and its txid;
  - that the spend is recorded;
  - that a second Broadcast doesn't send twice;
  - that Cancel asks first.

  It runs before the split (to prove it passes on today's code) and after.
- A diff check: the four money functions are compared line for line
  before and after, and must be identical.
- The bundle size before and after, as a sanity check. (It won't match to
  the byte this time, because props are new code.)

## Decisions that are the operator's

1. **Scope of this slice.** Markup only, with the money functions untouched
   (Recommended). Or also move the money functions into a separate file in
   the same slice. That gets under 800 lines, but it touches the logic.

## Blast radius

- `pages/vault-detail/SendTab.tsx` becomes `send/SendTab.tsx`, plus three
  new files. Imports of `SendTab` and `SendPrefill` in `VaultDetail.tsx`,
  `OverviewTab.tsx`, `UtxosSection.tsx` and others get repointed (checked
  by typecheck).
- Text-scanning tests (`test-broadcast-record.mjs`, `test-no-viewport-
  traps.mjs`, `test-readability.mjs`) read `SendTab.tsx` by path or scan the
  folder. They get repointed or checked to still cover it.
- `scripts/screen-walk/walk.cjs` gains the Broadcast taps, and its fake
  server gains a broadcast route.
- Server, Tapit and the SeedSigner fork: untouched. No change to what
  anyone is told.

## Deliberately left out

- Splitting the money functions (decision 1, second option).
- The other pages still over the limit (`VaultWizard.tsx` 2,916,
  `KeyManager.tsx` 1,489, `ProposalDetail.tsx` 1,475).
- The library list from 2026-11-27. That's its own slice (see below).

## The library list (operator relayed, 2026-11-27): a separate slice, in this order

1. **Netlify `NODE_VERSION` "20" to 22.** Node 20 is past end of life, so
   the live functions get no security patches. CI already uses 22. It's a
   runtime change for every server function, so it ships alone, with the
   full tests and a live check.
2. **Desktop app (Tauri):** `cargo update -p url -p cookie`, for two low
   advisories.
3. **Dev-only:** `npm audit fix` in the DynastyTrust root and in
   tapit-attest. These are non-major bumps that never ship to users.
4. **SeedSigner:** Pillow 10.3.0 to 13.0.0, with the screen tests re-run
   (they need libzbar here). Plus `helpers/qr.py`: call qrencode with an
   argument list, not `shell=True`.
5. **Later, on their own branch:** rust-bitcoin 0.32, miniscript 13,
   secp256k1, @noble/@scure v2. None has an open advisory.
