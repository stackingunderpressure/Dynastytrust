# Build note: each coin, and when each path opens for it

Operator, 2026-11-24, after signet coins arrived on a fresh-address dead
man's switch vault: "The coins arrived. The utxo is only in history
section. We need it in send tab and overview. Both showing blocks left
estimated date till unlock of each one."

## What would be built

One "Coins" card, shown near the top of the vault overview (under the
balance) and on the Send tab, listing every coin the vault holds: amount,
which address it sits on, confirmations, and for each later path whether
that coin can use it now or how many blocks are left and roughly when
("about 8,410 blocks -- around 23 Jan"). The card refreshes with the
balance, so a coin that arrives while the page is open appears.

## What is true today (read from the code)

- `UtxosSection` (VaultDetail.tsx) already lists coins with coin control
  ("spend only this", pick several), but only at the BOTTOM of the
  overview, after the path tree, trust document and other cards, and it
  loads once on mount (no refresh when the balance reloads). The Send tab
  has no coin list; it only shows "Locked to N UTXOs" after a prefill.
- `utxos.js` returns each coin's block height, confirmations, the chain
  tip, and (fresh-address vaults) its address/branch/index.
- Path timing: a dated path opens at one block height for every coin
  (`vault.leaves[].unlock {type:'after', blocks}` is absolute); an "if
  untouched" path opens per coin when confirmations >= its blocks (the
  same rule `_ranged-spend.js` `oldEnough` uses to pick spendable coins).
  `timelock-words.ts` already turns blocks into words (`durationWords`).

## Blast radius

- `VaultDetail.tsx`: `UtxosSection` moves up in `OverviewTab` and is also
  mounted in `SendTab` (where "spend only these" fills the send form
  directly); a reload hook so it refreshes with the balance.
- New pure helper (`lib/coin-unlock.ts`, tested): per coin, per later path
  -> "now" or { blocksLeft, approxDate }. Uses the 10-minute block average,
  labelled "about".
- Read-only: no server, database, PSBT or signing change. The spend
  builder already enforces the real rule; this only shows it.
- Vault shapes: path-builder (all new vaults) and the older named-field
  shape (recovery / inheritance dates). Bloc (family plan) decay ladders:
  shown as their first rung only -- see "left out".

## Deliberately left out

Bloc decay ladders step by step; fee estimates per coin; labels for coins.
