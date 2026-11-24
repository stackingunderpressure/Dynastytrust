# Build note: ranged addresses, slice 5 -- spending from many addresses

Operator, 2026-11-24: **"Yes start slice 5"**. Earlier chips: real bitcoin
allowed now, slices 3-5 ship to main together, "if left untouched"
(`older()`) spend support built rather than refused.

## What would be built

A vault with a new address every time can spend coins sitting on any of its
addresses, sends the change to a never-used change address, and can spend by
an "if left untouched" path using only the coins that have each sat long
enough.

## What is true today (read from the code)

- `protocol/src/ranged.rs` `build_spend_psbt`: builds from many addresses,
  change to `/1/<n>`, fills per-index key origins on inputs and change.
  Sets ONE absolute lock time; no per-input `nSequence` for `older()`.
- `psbt-binary.js` (and `-bloc`, `-tranche`): coins only from
  `vault.address`, change back to it, PSBT built on the Fly compiler.
- `apps/web/src/lib/psbt-signer.ts` `signPsbtWithMnemonic`: signs ONLY with
  each key's `/0/0` child. A coin on `/0/7` or `/1/2` would get no signature.
- `verifyPsbtMatchesRequest` (`ownAddress`): every input and the change
  must be exactly the vault's one address -- the browser's guard against a
  server redirecting change. Called from VaultDetail (send, claim) and
  ProposalDetail (sign, merge).
- The phone pins the vault's address (`vault-pin.ts`, `vault-gate.ts`);
  nothing pins the fresh-address descriptors.
- Backups: the descriptor export, the backup PDF and Legacy Recovery all
  carry `vault.descriptor` -- the ONE-address (`/0/0`) form. For a
  fresh-address vault that backup restores address 0 only.

## Blast radius

- Rust: `ranged.rs` (`older()` per-input sequence, coin-age check),
  `service.rs` new `/ranged-spend` route, wasm rebuild + manifest.
- Server: `psbt-binary.js` (v2 branch: coins from `_vault-coins.js`,
  reserve a change index on branch 1, build in-process via wasm, record the
  change address in `vault_addresses`). `-bloc`/`-tranche` unchanged
  (those shapes stay one address). `psbt-finalize`, `psbt-merge`: miniscript
  finalize from the PSBT's own tap scripts -- check, expected unchanged.
- Browser: `psbt-signer.ts` (sign each input with the child its key origin
  names, only for this key's own fingerprint and account path);
  `verifyPsbtMatchesRequest` (v2: every input and the change must be one of
  the vault's OWN addresses, derived in the browser by the same wasm from
  the stored descriptors); pin the descriptors on the phone like the
  address; VaultDetail send + claim, ProposalDetail sign + merge; Face ID
  keys and test/password keys share the same signer.
- Hardware: SeedSigner fork already reads `/1/n` change and per-index
  origins. Nunchuk / Sparrow sign from origins but show change as foreign
  until the multipath descriptor is registered (backup slice).
- Tapit co-signing: Tapit keys are fixed at every index -- unchanged.
- Database: none new (`vault_addresses`, the reserve function exist).
- Promises to people: "change goes back to this vault" now means "to a
  new address of this vault"; the send screen says so.

## Deliberately left out

Fee bumping; spending a v2 vault from the downloaded app's local server;
coin control UI beyond what exists; gap-limit warnings.

## Decision for the operator

The backups (descriptor export, PDF, Legacy Recovery) restore only address
0 of a fresh-address vault. With real bitcoin allowed, a vault whose
backup misses most of its coins is a way to lose an inheritance. Options:
ship the backup slice (6) in the same release as 3-5, or hold fresh
addresses to test coins until it is done.
