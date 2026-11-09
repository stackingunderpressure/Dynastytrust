# Security backlog -- the gaps, in the order we close them

Written 2026-11-09 from a grounded read of `main` (not from memory), after the
operator asked: other than the compiler living on Fly, how could someone be
tricked into signing something they should not, or how could DynastyTrust be
hacked to compromise funds or identity? Each item names the file, the attack
it closes, and how it is proven. Close one, append the proof to `HISTORY.md`,
strike it here. Nothing on this list is theoretical hand-waving: each one was
read in the code.

The frame: every vault is script-path only under the NUMS key, so no server
can move a coin. The only ways to lose funds are (a) a keyholder signs a
transaction that is not what they think it is, or (b) the keys themselves
leak. Identity is lost through (c) what an account or database exposure
reveals. The list is ordered by how directly each item stops (a), then (b),
then (c).

## Closed

1. ~~**Browser full-transaction gate.**~~ Closed 2026-11-09 (see `HISTORY.md`).
   `verifyPsbtMatchesRequest` now verifies, from the PSBT's own witness UTXOs,
   that every input is the vault's own coin, that any change returns to the
   vault, and that the real fee and change equal what the human is shown; wired
   into the main Send flow, the tranche claim, and the co-signer page. A
   coordinator (Netlify function, Supabase row, Fly compiler) can now only
   refuse to build a transaction, never redirect one. Proven by 8 harness
   checks (forged change, foreign input, lying fee, lying change, swapped
   destination; compiler-side refusals as belt and braces).

2. ~~**Absolute timelock cross-check.**~~ Closed 2026-11-09 (see `HISTORY.md`).
   Server: `_chain.js` `fetchTipHeight` now requires an all-digit response and a
   per-network `TIP_FLOOR`. Browser: `lib/timelock-check.ts` + `VaultWizard`
   fetch the tip separately and refuse to accept a compiled vault (all three
   shapes) unless every `after()` height is tip + the chosen offset within 12
   blocks, every `older()` duration came back untouched, and nothing carries a
   timelock that was not asked for. Proven by `scripts/test-timelock-check.mjs`
   (6 cases, in `npm test`). Honest limit: both tips still come from
   mempool.space, so this defends against the server path, not against the
   feed itself -- that is item 12.

## Open -- stops "tricked into signing"

3. **Co-signer gate for tranche claims.** `ProposalDetail.tsx` skips the
   own-coins/change check for `path === "tranche_claim"` because the page does
   not load the tranche address. Load it (the proposal row carries
   `distribution_wallet_id` + `tranche_index`) and pass `ownAddress`.

4. **Attestations verified on write.** `netlify/functions/vault-attestations.js`
   stores proof-of-life, death-declaration and descriptor-binding attestations
   without verifying the Schnorr signature (documented deliberate gap). A forged
   attestation cannot unlock a leaf but can mislead heirs and trustees about
   liveness and succession. Fix: schnorr-verify `signature` over `target_hash`
   against the caller's `vault_members.pubkey` before insert; reject otherwise.

5. **Descriptor trust on load.** The vault's descriptor and address come from
   Supabase; fingerprint pinning (2026-08-29) is a comparison aid only. Once the
   compiler runs in the browser (item 9), re-derive the address from the stored
   descriptor on every load and refuse to show a vault whose descriptor does
   not compile to its own address.

## Open -- stops key leakage

6. **Mainnet requires secure mode.** `lib/keystore.ts` test-mode keys are
   plaintext in localStorage. Refuse to let a test-mode key sign for a vault on
   `network === "bitcoin"`, and say why. Small, mechanical, closes the worst
   case of a malicious script reading storage.

7. **Harden secure-mode storage.** Move the AES-GCM wrapping key from a
   PBKDF2 password to WebAuthn PRF / passkey where the device supports it, with
   the password as fallback; never hold a decrypted mnemonic beyond the signing
   call (audit `revealMnemonic` callers). The honest statement stays: a
   compromised page can capture a password at entry; real funds belong on
   hardware signers, which the app already supports.

8. **Supply chain + reproducible bundle.** The bundle trusts every npm
   dependency and the Netlify build; CSP `script-src 'self'` blocks injected
   scripts but not a poisoned dependency. Add `npm audit --audit-level=high`
   to the gate, pin exact versions, and add a script that builds locally and
   compares bundle hashes against what dynastytrust.family serves, so a build
   that differs from the committed source is caught.

9. **Compiler in the browser (WASM), Fly as cross-check.** Compile-first
   migration of `protocol/` to WASM so the descriptor, address and PSBT are
   produced on the device; keep Fly for a byte-identical cross-check until the
   WASM path has run long enough to trust alone. This also unlocks item 5.

## Open -- stops identity exposure

10. **Second factor on sign-in.** `Auth.tsx` is email + password only. Enable
    Supabase MFA (TOTP) and require it for any account that is a member of a
    `network === "bitcoin"` vault. An account takeover shows vault structure,
    balances, addresses, member names and pending requests -- coercion
    material even though it moves no coins.

11. **Least privilege for the service-role key.** Every Netlify function runs
    with the Supabase service-role key; a Netlify account compromise is full
    database read/write, including the vault addresses and proposal rows that
    item 1 now defends against. Review which functions truly need service role
    versus the caller's JWT with RLS, and move the rest.

12. **Two independent chain sources.** Tip height, balances and broadcast all
    go through mempool.space. Add a second source (e.g. blockstream.info) and
    cross-check the tip used for compile and the confirmation state shown to
    heirs; disagree loudly rather than pick one silently.

## Operational, not a code gap

13. **Supabase free-tier pause.** The project pauses after a week idle and the
    front door answers "Load failed". Recovery never depended on the server
    (descriptor backup + Legacy Recovery), which is the right property, but
    before anyone other than the operator relies on the hosted app, either the
    paid tier or a scheduled keep-alive request. Operator's call, deliberately
    deferred while the app is in build.

14. **The Kimi K3 report text.** The 146-finding scan's per-finding text is not
    in the repo. When found, commit it under `docs/audits/` so the next scan
    can be diffed against it.
