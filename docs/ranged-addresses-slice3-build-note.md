# Build note: ranged addresses, slice 3 -- creating multi-address vaults

Operator, 2026-11-24, after hearing every vault has one fixed address:
**"Yes start the multiple addresses work"** -- asking for "a new change
address each time and fresh receive address each time".

Base: `claude/dynasty-unify-2026-11` @ `663bbb4` (today's main merged in;
gates green). Slices 1-2 (Rust core, migration, address issuing) are built
there, never shipped.

## What is true today (read from the code)

- `protocol/src/ranged.rs` `RangedVault::from_template` turns a COMPILED
  vault (any NUMS-internal-key taproot descriptor: the standard shape's
  `build_multileaf` and the path builder's `build_leaf_multileaf` both use
  NUMS) into `<0;1>/*` multipath form, using each key's xpub origin. It
  refuses unless receive/0 equals the vault's compiled address. Keys with no
  xpub (Tapit keys) stay fixed at every index.
- `older()` ("if left untouched") paths: derivable, NOT spendable from a
  ranged vault yet (each coin would carry its own clock).
- Migration `20261119000000_ranged_addresses.sql`: `descriptor_version`,
  the three stored descriptors, `ranged_format`, per-branch counters,
  `vault_addresses`, the row-locked reserve function, and a freeze trigger
  (a compiled vault's address, descriptors and keys never change). Not yet
  applied anywhere real; the migration runner applies any unapplied file, so
  its earlier date than the live `20261124` file is fine.
- `vault-addresses.js` issues the next receive address of a v2 vault via the
  compiler wasm. Nothing creates a v2 vault yet.
- Everything else assumes ONE address: `balance.js`, `utxos.js`, the three
  `psbt-binary*.js` spend builders (inputs from that address, change back to
  it), the dashboard and vault page balances, the funding QR, the phone's
  address pin (`vault-gate.ts`), Legacy Recovery, descriptor exports and the
  backup PDF, rotation (`rotate-plan.ts`).

## What slice 3 builds

1. At compile, an owner can make the vault **multi-address**: the server
   compiles exactly as today, then builds the ranged form from the vault's
   key origins (wasm, `from_template`), stores `descriptor_version = 2` and
   the three descriptors, and starts both counters. `vaults.address` stays
   receive/0, so every screen that reads it still shows a real address of
   this vault.
2. The vault builder gets the choice (wording below), and the vault page
   gets **"New receive address"** (calls the slice-2 function) beside the
   existing address.
3. `_vault-fields.js` gains the new columns (held back in slice 2 until the
   migration is live -- this slice ships them together).

## Blast radius

- Server: `vaults-compile.js`, `compile-leaves.js`, `vaults-compile-bloc.js`
  (refuse or support -- decision 4), `_vault-fields.js`, `vault-addresses.js`,
  compiler wasm (a `/ranged-compile` route beside `/ranged-address`).
- Database: the slice-2 migration goes live with this slice; the freeze
  trigger then guards every compiled vault (the test-data reset and rotation
  must still work -- checked on real Postgres before shipping).
- Web: `VaultWizard.tsx` (the choice), `VaultDetail.tsx` (new address),
  `api.ts`.
- Promises to people: the CLAUDE.md "one fixed address" teaching, Sage's
  facts, Legacy Recovery ("the address never changes") -- all still true
  for v1 vaults; v2 wording waits for the slices below.
- SeedSigner: our fork already recognises `/1/n` change and has the
  "Distant Address" warning; registering a `<0;1>/*` descriptor on the
  device is the backup slice's walk.

## The danger this slice must not create

Until coin-finding and spending exist, money sent to receive/1, /2 ... is
invisible to the app and cannot be spent from it. Slice 3 therefore must not
let real bitcoin reach those addresses (decision 2).

## Remaining slices after this one

4. Find coins: balance and UTXOs across issued addresses (plus a look-ahead).
5. Spend: inputs from many addresses, a fresh change address each time.
6. Backup and recovery: descriptor export, Legacy Recovery, SeedSigner
   registration of the multipath descriptor, the backup PDF.
7. Lift the test-coins-only rule.

## Deliberately left out

Converting existing vaults (they keep their one address); `older()` spends;
gap-limit warnings (need slice 4).

## Decisions (operator's chips, 2026-11-24)

1. New vaults: **fresh addresses by default** (a single fixed address stays
   available as a choice).
2. Real bitcoin: **allowed now**. To keep "no money lands where the app
   cannot see it" true, slices 3, 4 and 5 ship to main TOGETHER, not one by
   one: nothing that can hand out receive/1+ goes live before coin-finding
   and spending do.
3. "If left untouched" paths: **build that spend support first** (per-coin
   relative lock in the spend slice) rather than refuse them.
4. Tapit-only paths: **allowed, with a plain warning** that their addresses
   can be linked.

## Built (2026-11-24, branch only -- ships with slices 4 and 5)

- Compile: `_ranged-compile.js` + `/ranged-compile` wasm route; fresh by
  default, fixed on request or when no key has an xpub; rotation and the
  Bloc shape stay fixed.
- Vault builder: "Receiving addresses" choice on the keys step; warning for
  paths that use only Tapit keys.
- Vault page: "New receive address" (`components/NewReceiveAddress.tsx`),
  label sealed with the vault key (`F.addressLabel`). Receive address 0 is
  the vault's own address: it is recorded as issued and never handed out as
  new, so the first "new" address is 1.
- Real Postgres 16: `scripts/ranged-migration-pg.sh` 45 passed, 0 failed.
  The test-data reset deletes vaults (the lock is update-only; address rows
  cascade). Rotation inserts and compiles a new draft. No function writes a
  locked field after compile (checked every `from("vaults").update`).
- Left for slice 4: the balance and coin list still read only `address`
  (receive 0), so coins on addresses 1+ are not yet seen -- which is why
  this does not ship alone.

## Slice 4 built (2026-11-24, branch only)

- `_vault-coins.js`: a v2 vault watches every reserved index on receive (0)
  and change (1) plus a look-ahead (10 receive, 5 change), all from its
  stored descriptors via the wasm `/ranged-addresses`; receive/0 must equal
  the vault's address or nothing is watched.
- `balance.js?vault_id=`: the whole vault's balance, signed in, owner or
  active member only (a v2 vault's address list is the private thing).
  By-address mode unchanged. Dashboard and the vault page use
  `api.vaultBalance(v)`.
- `utxos.js`: every coin, tagged with its address, branch and index (the
  spend slice needs these).
- Not covered yet: the downloaded app's local server
  (`apps/web/src/lib/local-server`) still reads one address; the "Explorer"
  link opens address 0 only; no gap warning when the look-ahead is used up.

## Release order (for the push to main)

`_vault-fields.js` now selects the new columns on every vault read, so the
migration must be live BEFORE the functions that read them deploy, or vault
lists fail until it is. Apply `20261119000000_ranged_addresses.sql` first
(the db-deploy workflow, run on its own), confirm, then let Netlify build.
