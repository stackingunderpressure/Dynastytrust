# Build note: show the same receive address until it is paid

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-24, in his words)

"If I click on an address and don't use it there is no way to go back and
use it it just skips to next one. Nunchick only counts after it's used on
chain. Your thoughts ?"

Then, choosing: "Mix: Nunchuk + new button" -- show the newest unpaid
address until it is paid; an "I need a different one" button for a second
payer, refused at 20 unpaid in a row; a list showing which addresses are
still unpaid; and lift the 200-address scan ceiling.

## What is true today (read from the code)

- `NewReceiveAddress.tsx`: every tap of "New receive address" calls
  `POST /api/vault-addresses`, which reserves the next receive index for
  good (`reserve_vault_address_index`; "an index reserved but not recorded
  is burned, never handed out again") and records it in `vault_addresses`
  (address, script, label, issued_at). Nothing ever shows an issued address
  again, and nothing limits how many unpaid ones pile up.
- Recovery risk: Sparrow, Nunchuk and Bitcoin Core restore by scanning
  forward and stop after about 20 addresses in a row with no history (the
  "gap limit"). 25 taps with only the last one paid can leave that coin
  unfound by another wallet. Our own scan watches every issued address, so
  DynastyTrust itself still sees it; the risk is the backup in someone
  else's wallet -- the exact thing the descriptor backup promises works.
- `_vault-coins.js`: `MAX_PER_BRANCH = 200` ("the wasm route's own cap")
  -- a vault past 195 issued addresses stops watching the newest ones.
- Change has the same shape: a spend reserves a change index when it is
  BUILT; a spend never broadcast leaves an unpaid change address.

## What would be built

1. **"Paid" means the address has any history on chain** (received, even if
   since spent) -- found with the same Electrum batch as the coin scan
   (`blockchain.scripthash.get_history`), or mempool.space's per-address
   history where Electrum is not set up.
2. **Receive shows the newest issued address that has never been paid**,
   the same one each time, with its label and QR. Only when every issued
   address has been paid does a tap reserve a new one (as today).
3. **"I need a different one"** reserves a fresh address even though the
   current one is unpaid -- for a second person paying at the same time.
   Refused when 20 receive addresses in a row are unpaid, with the reason in
   one plain line: other wallets restoring this vault would stop looking
   before a later payment.
4. **A list of issued addresses**, newest first: address, label, paid or
   still waiting; tap one to show its QR again.
5. **The 200 ceiling**: the scan and the address route take a range, so a
   vault's watching moves with its newest addresses instead of stopping.

## Decisions that are the operator's

1. **How many unpaid in a row before "I need a different one" refuses.**
   20, matching the wallets people restore into (Recommended); or fewer
   (10) for more margin.
2. **Reusing an unpaid address from the list for a different person.**
   Allowed, with a one-line note that the two payers could see each other's
   payment (Recommended); or the list is view-only.
3. **Change addresses from spends never broadcast.** Count them toward the
   20 too and have the next spend reuse the lowest unpaid change address
   (Recommended; a spend that never went out leaves no trace); or leave
   change as is this slice.

## Blast radius (read from the code, 2026-11-24)

- Server: `vault-addresses.js` (POST gains "current unpaid or new", GET
  lists issued addresses with paid/unpaid), `_vault-coins.js`
  (`MAX_PER_BRANCH`, scan window), `_electrum.js` (history batch),
  `_ranged-spend.js` (change reuse, decision 3).
- Database: none needed for 1-4 -- `vault_addresses` already records every
  issued address; "paid" is read from the chain, not stored. Decision 3
  needs none either.
- Web: `NewReceiveAddress.tsx` (current address, the button, the refusal
  line, the list), `lib/api.ts`.
- What people are told: the receive screen's wording changes ("Get a new
  one each time someone sends to you" becomes "This address is yours until
  it is paid").
- Tests: unpaid address shown again; paid address moves on; "different one"
  refused at the limit; list paid/unpaid from a stand-in chain; scan beyond
  200; the Electrum live check gains history.

## Deliberately left out

- Deleting or hiding addresses (an issued address is never forgotten; the
  database refuses edits by design).
- Changing how other wallets restore (we stay inside their gap limit
  instead).
- One-address vaults: unchanged.
