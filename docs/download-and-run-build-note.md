# Build Note -- DynastyTrust you download and run, one person, no server of ours

Written 2026-11-13, before any code, from the code as it is on
`claude/dynasty-unify-2026-11`. Supersedes the website own-node note
(`docs/own-node-build-note.md`) for the sovereign path: inside a downloaded
app its three website limits (our server cannot reach a home node, a secure
page cannot call plain http, the site's connection rule) do not apply.

## The ask, in the operator's words

"I think what I meant was downloading the code and installing it on a
computer and run Dynasty trust completely serverless. I think you have been
building the webpage still serves the code, but you're more sovereign than
the other way with a serve back in server." Chip: "Note for one-person
download (Recommended)" -- one person, one computer, no account; family
coordination over Nostr is the slice after.

## What the website gets from our servers today (read from the code)

- **Sign-in and the database (Supabase):** every page sits behind
  `RequireAuth`; 19 files use Supabase directly.
- **Our server API (Netlify, ~50 functions):** the app makes 67 distinct
  calls across 24 areas (`lib/api.ts`). One person holding and spending
  their own vault needs about a fifth: create / compile / rename / remove a
  vault, key labels and key-origin repair, balance and coins, build and
  finalize a spend, the spend's own record and history.
- **The compiler:** already on the device (sovereign slice 1:
  `compiler-wasm/` + `lib/browser-compiler.ts`, proven 231/231 against the
  server and 14/14 by Bitcoin Core with no server).
- **Chain data:** mempool.space, mostly through our server.
- **Safety checks that live on the server today and must come with it:**
  the "6 months -> block height" conversion and its floor and ceiling
  (`_chain.js relativeToAbsolute`, `checkTimelockFloor`), the refusal of a
  private key pasted where a public one belongs
  (`assertNotPrivateExtendedKey`), used in 9 functions (`compile*.js`,
  `vaults-compile*.js`, `vaults.js`, `psbt-binary-bloc.js`,
  `distribution-wallets.js`). Money-touching: a wrong height unlocks an
  inheritance path early.

## What would be built (the first download)

- **One code base, two builds** (the same pattern the Tapit wallet already
  uses): the website as today, and a download build with a flag that
  swaps the server for the computer. No fork.
- **No account:** the download opens straight to your keys and vaults;
  the sign-in pages and `RequireAuth` are not in that build.
- **A local "server" inside the app** answering the ~13 calls one person
  needs, with the SAME request and answer shapes as `lib/api.ts`, so the
  pages do not change: vaults kept on the computer, the on-device compiler,
  the timelock conversion and key-safety checks ported from the server
  with tests that hold them to the server's own (as the compiler was).
- **Your own Bitcoin node** for balances, coins, fees, the chain tip and
  broadcasting (decision 2).
- **Hidden in this build:** everything that needs another person or our
  server -- invites, members, messages, requests, stipends, trust signing,
  the assistant, Legacy Recovery publishing, Tapit/email sign-in.
- **A desktop app you double-click** (decision 1), built for Mac, Windows
  and Linux by GitHub Actions.

## Decisions that are yours (asked as chips)

1. **What you download.** A desktop app (Recommended: double-click to
   install; the Rust shell already matches our compiler; Mac and Windows
   will warn it is from an unknown developer until we buy code-signing --
   Apple about $99 a year, Windows a certificate), or a folder you run with
   one command (quicker to a first test, for technical people only).
2. **Where Bitcoin data comes from.** Bitcoin Core on the same computer
   (Recommended: the most sovereign; the app reads Core's own login file,
   so nothing to type), an Esplora-style address (your own mempool/electrs),
   or either.
3. **Where your vaults are kept.** An encrypted file in the app's folder,
   with a backup you can save anywhere (Recommended), or the app's built-in
   browser storage only (simpler, harder to back up).
4. **Which vaults in the first download.** Every vault shape the builder
   makes today, with every key on this computer or a hardware wallet
   (Recommended), or only the standard founders/recovery/inheritance shape.

## Blast radius -- everything downstream, read from the code

- New: the desktop shell (`desktop/`), its GitHub Actions build, the
  download flag, the local API (`apps/web/src/lib/local-api/`), the chain
  source for Core or Esplora, the local vault store.
- Changed behind the flag only: `lib/api.ts` (which implementation),
  `components/RequireAuth.tsx`, `App.tsx` routes, `components/Layout.tsx`
  (nav), the vault builder's invite panels and `VaultDetail.tsx`'s
  multi-person tabs (hidden), `config.ts` explorer links, `lib/chain.ts`.
- Ported with parity tests: `_chain.js` timelock conversion and floor,
  `_xpub.js` private-key refusal, the PSBT-building steps of
  `psbt-binary*.js` (coins from your node instead of mempool.space),
  `psbt-finalize.js`.
- Not touched: the website build and everything it does, every Netlify
  function, the database, the Fly compiler, the offline recovery tool.
- Promise to a human that changes: a new download page and its words; the
  app says plainly it holds everything on this computer and that losing
  the computer AND its backup loses the vault records (never the coins:
  the descriptor and keys recover those).

## Deliberately left out

- Family coordination over Nostr (next slice): co-signers on other
  computers, invites, messages.
- Tor, automatic updates, signed releases and their hash pins.
- The website own-node setting (parked; useful only for website families).
- Moving existing website vaults into the download (an export/import, its
  own slice).

## Then

One slice end to end: the download flag, the local API for the one-person
calls, the ported checks with parity tests, Bitcoin Core as the chain
source, the desktop shell built for Linux in CI first; walked against a
private Bitcoin Core chain (build a vault, fund it, spend it, all with no
server); on the branch; nothing to main until the ship chip.
