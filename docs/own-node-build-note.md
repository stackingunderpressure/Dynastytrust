# Build Note -- your own Bitcoin node instead of mempool.space (sovereign slice 2)

Written 2026-11-13, before any code, from the code as it is on
`claude/dynasty-unify-2026-11`. Closes threat model item K
(docs/threat-model-2026-11-13.md) as far as a web page can.

## The ask, in the operator's words

"Write the Build Note for the own-node slice" -- after choosing, in the
Super Sovereign plan (docs/super-sovereign-build-note.md), "Your own Bitcoin
node (Recommended)" as the slice after the browser compiler: "Let a family
point balances, fees and broadcasting at their own node instead of
mempool.space."

## What talks to mempool.space today (read from the code)

**From the family's own browser** -- these carry their IP address to
mempool.space, alongside what they ask about:
- broadcasting every spend and every Legacy Recovery publication
  (`config.ts` `broadcastTxUrl`, `onchain-publish.ts`, `ProposalDetail.tsx`,
  `VaultDetail.tsx`, `LegacyRecoverySetup.tsx`);
- chain tip and transaction status (`lib/chain.ts`; the tip is
  cross-checked against blockstream.info);
- Legacy Recovery's search of an address's transactions
  (`legacy-onchain-recovery.ts`, `LegacyRecoverySetup.tsx`);
- block Merkle roots when the vault's activity record is checked against
  Bitcoin (`ledger-verify.ts`, from mempool.space AND blockstream.info);
- "View on mempool.space" links (13 places via `config.ts`).

**From our server** -- these reach mempool.space from Netlify's address,
not the family's:
- balances and unspent coins (`balance.js`, `utxos.js`);
- the coins and fee rate used to build every spend (`psbt-binary.js`,
  `psbt-binary-bloc.js`, `psbt-binary-tranche.js`);
- the chain tip that turns "6 months" into a block height
  (`_chain.js fetchVerifiedTipHeight`, also checked against
  blockstream.info), transaction status (`proposals.js`,
  `distribution-wallets.js`), anchoring (`_anchor.js`).

## Three limits that decide what this slice can honestly be

1. **Our server cannot reach a node in someone's home.** So the server-side
   lookups above stay on mempool.space in this slice. Moving them means the
   browser supplies the coins and the server checks them -- a larger,
   money-touching change for its own slice.
2. **A secure web page cannot call a plain-http address.** A node reachable
   only as `http://` on a home network (common for home node boxes) cannot
   be used from the website. It needs an HTTPS address -- e.g. a node app
   that serves HTTPS, a private network service that gives one, or a
   self-hosted mempool on the internet. The desktop package (a later
   slice) has no such limit.
3. **The site's security policy only lets the page connect to
   mempool.space and blockstream.info** (`netlify.toml`, `connect-src`).
   Any family's own address is blocked until that rule is widened.

## What would be built

- **A "Bitcoin connection" setting on each device**, on the Keys page:
  mempool.space (today's default) or "My own node", given as the HTTPS
  address of an Esplora-style API (the API mempool and electrs/esplora
  serve -- the same one the app already speaks, so nothing new to learn).
  A **Test** button checks it really is the chosen network (the block hash
  at a fixed height must be that network's) and reads the tip.
- **One chain-source module** that every browser lookup above goes
  through: broadcast, tip, transaction status, Legacy Recovery's address
  search, Merkle roots, and explorer links (to the node's own web page if
  given, otherwise no link rather than a mempool.space one).
- **Honest wording** on the setting: what now goes to your node, and what
  still goes to mempool.space through our server (limit 1).

## Decisions that are yours (asked as chips)

1. **What kind of node.** An Esplora-style API over HTTPS only
   (Recommended -- the only kind a web page can use) or also Bitcoin Core's
   own interface (not possible from a web page: it is plain http with a
   password and refuses other websites; it belongs in the desktop package).
2. **The connection rule.** Allow the page to connect to any HTTPS address
   (Recommended -- the only way an address we cannot know in advance
   works; scripts stay locked to our own site, which is the main guard),
   or keep today's two and support own nodes only in the desktop package.
3. **When your node does not answer.** Stop and say so, with a one-tap
   "use mempool.space this time" (Recommended -- someone who chose their
   own node expects nothing to leak quietly), or quietly fall back.
4. **Also warn when they disagree.** Additionally check our server's
   balance and the coins in a spend against your node, and warn if
   mempool.space told the server something different -- more value, more
   work; or leave for later (Recommended for this slice).

## Blast radius -- everything downstream, read from the code

- `apps/web/src/config.ts` (`EXPLORER`, `broadcastTxUrl`, `explorerTxUrl`,
  `SECOND_TIP_SOURCE`) and their 13 callers; `lib/chain.ts`;
  `lib/onchain-publish.ts`; `lib/legacy-onchain-recovery.ts`;
  `lib/ledger-verify.ts`; `pages/LegacyRecoverySetup.tsx`,
  `ProposalDetail.tsx`, `VaultDetail.tsx`, `Dashboard.tsx` (wording); the
  Keys page (new setting); `netlify.toml` CSP `connect-src` (decision 2).
- Money-touching: broadcast is the moment a signed spend leaves the
  device. A wrong-network node could swallow it; hence the network check
  before the setting is saved, and before each broadcast.
- Not touched: every Netlify function, the Fly compiler, the database,
  the offline recovery tool (it already takes no server).
- Promise to a human that changes: the setting's own words, and the
  "View on mempool.space" links.

## Deliberately left out

- The server-side lookups (limit 1), so mempool.space still learns which
  addresses DynastyTrust asks about, from our server's address.
- Bitcoin Core's own interface, Tor, finding a node automatically.
- The disagreement warning, unless decision 4 says otherwise.

## Then

One slice: the setting, the module, every browser lookup through it, the
network check, tests, a walk at 375px against a stand-in node; on the
branch; nothing to main until the ship chip.
