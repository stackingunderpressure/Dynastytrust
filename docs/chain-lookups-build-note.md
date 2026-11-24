# Build note: chain lookups that do not get us refused

Operator, 2026-11-24: "The mempool keeps fetch failed won't load" -- then,
choosing between fixes: "Quick fix now, proper fix next". The quick fix
shipped (fa2b177). This note is the proper fix. Nothing is built yet.

## What is true today (measured)

- Every coin, balance and spend lookup goes from our Netlify functions to
  mempool.space's public API, one HTTP request per address: `_chain.js`
  `mempoolFetch`, `_vault-coins.js` `coinsAt` (balance, utxos,
  psbt-binary's fresh-address spend), plus psbt-binary / -bloc / -tranche,
  proposals, distribution-wallets for one-address vaults.
- A fresh-address vault watches every address it handed out plus 5 + 2
  spares. `scripts/mempool-scan-bench.mjs` (real mempool.space): before the
  quick fix 4 of 6 page views were refused (HTTP 429); after, 6 of 6 loaded
  but one took 19 s while retries waited -- over a function's time limit.
  The load grows with every address handed out, every vault on a dashboard,
  and every person using the site: all from the same server addresses.
- Privacy: mempool.space already sees every address of a vault asked for
  together from our server, which links them -- the thing fresh addresses
  exist to prevent, now visible to one third party.

## Options (the decision is the operator's)

1. **Our own indexer (electrs or Esplora) on a small server.** Batch
   queries, no third-party limits, and no outside company sees which
   addresses belong together. Costs: a machine with the chain (signet is
   small; mainnet needs ~1 TB disk), a few dollars to tens of dollars a
   month, and keeping it running.
2. **A public Electrum server** (one connection, every address in one
   batch). Fixes the limit cheaply, but a stranger's server sees all the
   addresses at once, may go away, and whether a public signet Electrum
   server exists and answers could NOT be checked from this sandbox (raw
   connections are blocked here) -- unverified.
3. **A paid mempool.space API key.** Same code, higher limits, kept
   server-side. Money every month, and mempool.space still sees every
   vault's addresses together.

## Blast radius (any option)

- `_chain.js` (one lookup layer every function already uses), `_vault-coins.js`
  `coinsAt`, the tip helpers; the functions listed above keep their shapes.
- A server secret (option 3's key) or a new host (option 1) -- never in the
  browser.
- Tests: the stand-in chain in the coin/spend tests stays; the bench gains
  a mode for the new source.
- Not changed: addresses, PSBTs, signing, the database.

## Deliberately left out

Moving lookups into the browser (each person's own IP would avoid our
limit but tells mempool.space who owns which vault).

## Decision (operator's chip, 2026-11-24)

**A public Electrum server.** First step: find servers that actually answer
for signet and for real bitcoin -- `scripts/electrum-probe.mjs`, run by a
GitHub workflow on the working branch (this sandbox cannot open raw
connections), asks each candidate for its tip and one address's coins.

## What the probe found (GitHub runners, 2026-11-24, runs 45468048287 + 45468351484)

Measured from GitHub's machines, NOT Netlify's -- whether Netlify's servers
are treated the same is unverified until the first live call.

- **Signet: mempool.space:60602 works.** Valid certificate, tip 332337 (the
  same as mempool.space's website at that minute), 20 address lookups in ONE
  request in 458-734 ms. Fifteen back-to-back batches: 15 of 15 answered,
  566-632 ms each, no slowing, no refusals.
- Signet others: electrum.mutinynet.com answers but is a DIFFERENT signet
  (tip 3,618,239) -- unusable. wakiyamap and Blockstream signet time out.
- **Real bitcoin: mempool.space has no public Electrum port** (50002 timed
  out 16 of 16). Blockstream (50002, valid cert) connects but returns nothing
  to a batched request. Three community servers answer the batch
  (fulcrum.sethforprivacy.com, electrum.emzy.de, bitcoin.lukechilds.co, tip
  977403, 278-966 ms) -- every one with a self-signed certificate, so we
  cannot prove we are talking to who we think, and each is one person's
  machine that may go away.
- Testnet: only testnet.aranguren.org answers (self-signed); mempool.space
  60002 times out; Blockstream returns nothing to a batch.

What a lying or wrong server could do: hide coins (balance looks short) or
show coins that do not exist (a spend built on them fails at signing or
broadcast -- taproot signatures commit to every input's amount and script,
so it cannot move real money wrongly, but the screen would be wrong).

Decision owed by the operator: signet is clear; real bitcoin is not.
