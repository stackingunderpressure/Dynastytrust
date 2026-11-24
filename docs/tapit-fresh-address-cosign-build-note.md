# Build note: Tapit co-signs a fresh-address vault's coins

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-24, in his words)

A phone screenshot of Tapit Wallet, `tapit-wallet.netlify.app`: "DynastyTrust
wants to spend from "My Vault"", the live-check box ticked, and under the
Approve button, in red: "This key is not a known signer for any recognized
leaf in ..." (cut off; the full text in `signPsbtCosign.ts:115` is "...in this
transaction. Refusing to sign."). Asked whether My Vault is a
new-address-every-time vault and how to fix it, he chose: "Yes, Build Note for
fix".

## What is happening (read from the code; the vault itself not inspected)

- Tapit signs an input only when the leaf script's bytes EXACTLY equal one of
  the `leaf_scripts` in the vault-membership attestation it accepted
  (`vaultTrail.ts` `isKnownLeafScript`, `signPsbtCosign.ts`). That list is the
  scripts at the vault's FIRST address (receive/0).
- In a fresh-address vault every key with an xpub becomes a different key at
  each address (`protocol/src/ranged.rs`: "keys with no origin stay fixed").
  A Tapit key has no xpub, so it stays the same, but any path that also holds
  an xpub key has a different script at every address.
- So a coin on any address other than receive/0, or on change, is refused.
  The refusal is correct behaviour; the gap is that DynastyTrust gives Tapit
  no way to recognise the vault's own scripts at its other addresses. This is
  a hole the fresh-address slices left (not caught: no test signs a
  fresh-address coin with a Tapit key).
- Not the key rotation: Tapit checks every key it has ever held.

## What would be built

Tapit learns to recognise "this vault's script, at one of its addresses":

1. DynastyTrust's membership request also carries, for each key with an xpub
   on the paths it lists: the xpub, its fingerprint and account path, and its
   `/0/0` key as it appears in the receive/0 scripts.
2. For each input, Tapit reads the PSBT's tap BIP32 derivations (field 0x16;
   DynastyTrust's ranged spend already writes them) for those keys, checks they
   all name the SAME branch (0 or 1) and index (capped), derives each key itself
   from the xpub in the signed membership (never trusting the PSBT's pubkey),
   swaps those keys into the receive/0 script, and requires the result to equal
   the input's script byte for byte. Only then does it sign, as today.

An attacker who controls the request can only produce scripts of THIS vault,
with THESE keys and THIS policy, at some address. That is the same promise the
exact-bytes check makes today.

## Decisions that are the operator's

1. **Existing memberships.** The one Tapit holds for My Vault has no xpubs in
   it. Either you resend the membership request once from the Members tab
   (Recommended: the signed attestation stays the single source of truth), or
   Tapit fetches the xpubs at signing time (weaker: a fact Tapit never signed).
2. **The coins already in My Vault.** Wait for this fix (both apps ship
   together), or, if you want them moved sooner, sign the spend with the other
   key's path in DynastyTrust's own signer.

## Blast radius (read from the code, 2026-11-24)

- Tapit (`/home/user/tapit-wallet`), money-signing code:
  - `bip341-psbt-signer/` (Tapit's own copy): does NOT read field 0x16 yet;
    DynastyTrust's `packages/bip341-psbt-signer` does. Bring that reader
    across.
  - BIP32 public derivation: Tapit has `@noble/curves` and `@noble/hashes`,
    no `@scure/bip32`. Either add `@scure/bip32` (same author as the
    libraries already used) or derive with noble directly.
  - `vaultTrail.ts` (`readVaultMembership`, `isKnownLeafScript`),
    `signPsbtCosign.ts`, `vaultMembershipChannel.ts` (the request payload
    guard), `acceptVaultMembership.ts` (what gets signed into the attestation).
  - The bundle budget (`scripts/bundle-budget.mjs`) will move.
- DynastyTrust:
  - `lib/circle-membership-delivery.ts` and `components/VaultMembershipSetup.tsx`
    add the xpub list for a fresh-address vault.
  - No server, database or address change. The ranged spend's PSBT already
    carries the derivations.
- Tests: a Tapit test that signs a coin at receive/5 and on change/2 of a real
  ranged vault built by the compiler wasm (vectors from DynastyTrust), and
  refuses a swapped xpub, mixed indexes, and an index past the cap; the
  existing exact-bytes tests stay.
- Promise to a person: Tapit's approval screen keeps saying what it says now.

## Deliberately left out

- Tapit checking where the change goes (that it is the vault's own address).
  Worth doing; a separate slice.
- One-address vaults: unchanged.
- The Electrum slice waiting for its ship word is separate and unaffected.
