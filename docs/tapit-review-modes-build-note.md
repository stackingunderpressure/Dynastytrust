# Build note: Tapit's change-address check, and a choice of what a co-signer sees

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-24, in his words)

"Build the Tapit change-address check next
And also option for a vault builder to choose blind transactions and only
need the wellness check part of relationship. Both options available"

## What is true today (read from the code)

- Tapit is ALREADY blind, and only blind. Since 2026-08-08 (operator: "only
  thing my helper sees is hey tom wants to spend call him check on him get
  the rolling code") the approval screen shows "DynastyTrust wants to spend
  from "My Vault"" and the call-them instructions -- no amount, no
  destination, no change (`renderRequest.tsx` psbt-cosign branch). The
  amount is used only to decide whether the live check is required
  (`SignApprovalScreen.tsx`, `requiresCallbackConfirmation`).
- Tapit checks every input it signs against its signed membership (exact
  first-address script, or the fresh-address rebuild shipped today). It
  checks NOTHING about the outputs: where the money goes, or whether the
  "change" really comes back to the vault.
- DynastyTrust's own signer already checks change (`checkFreshSpendAddresses`,
  the browser derives the change address itself); Tapit does not.

## Reading of the ask (to confirm)

Two modes, chosen by whoever builds the vault:
1. **Wellness check only ("blind")** -- today's behaviour. The member is
   there to confirm the PERSON is safe, calm and not under duress; they see
   no money details.
2. **Full review** -- the member also sees what the spend does: how much
   leaves the vault, to which address, and how much comes back as change,
   with the change shown as verified (or the signature refused).

In BOTH modes Tapit keeps doing its own checks silently; "blind" means the
member is not shown the money, never that Tapit stops verifying. The
change-address check runs in both: if an output claims to be the vault's
change (it carries the vault's derivation info) but does not rebuild to the
vault's own address, Tapit refuses to sign.

## What would be built

- DynastyTrust: the vault builder picks the mode; it travels inside the
  membership request and is signed into Tapit's membership, so a later
  spend request cannot switch a blind member into review or back.
- DynastyTrust: the request also carries what Tapit needs to recognise the
  vault's own change addresses (decision 3).
- Tapit: the change check in `signPsbtCosign.ts`; the review screen for
  full-review memberships (amount out, destination, change verified); the
  wellness-only screen unchanged.

## Decisions that are the operator's

1. **Mode per vault, or per member?** Per member lets an heir review while
   a wellness-check friend sees nothing (Recommended); per vault is one
   switch for everyone.
2. **Where DynastyTrust remembers the choice.** A column on the membership
   grant (one small migration, `[skip netlify]` first) so the Members tab
   shows each member's mode (Recommended); or only inside the request, with
   nothing stored on our side.
3. **How Tapit recognises the vault's change.**
   - (a) The whole vault's tree in the membership: every path's script,
     the tree shape and every xpub key. Tapit can then check ANY change
     address forever. Cost: every Tapit member learns the vault's full
     structure -- the other members' keys and every path.
   - (b) A list of the vault's next change addresses (say 200), signed into
     the membership. Reveals only addresses the member would co-sign anyway;
     runs out after 200 spends and then needs a resend (DynastyTrust can
     warn before that). (Recommended.)
4. **Existing memberships** (My Vault's, accepted today) have neither a mode
   nor change data. They stay wellness-only with the silent check skipped
   until resent (Recommended), or Tapit refuses to sign until resent.

## Blast radius (read from the code, 2026-11-24)

- Tapit: `vaultMembershipChannel.ts` (request guard), `acceptVaultMembership.ts`,
  `vaultTrail.ts` (`readVaultMembership`), `membershipOffer.ts` (a changed
  mode or change list is new content and must show), `signPsbtCosign.ts`
  (the change check), `renderRequest.tsx` + `SignApprovalScreen.tsx` (the
  full-review screen), the banner, and the bundle budget.
- DynastyTrust: `circle-membership-delivery.ts`, `VaultMembershipSetup.tsx`
  (the per-member choice and status), `VaultDetail.tsx` (passes data), the
  change-address list from the compiler wasm (`/ranged-address`,
  branch 1), and with decision 2 a migration on the grants table plus
  `vault-membership-grants` function.
- What a person is told: the Tapit approval screen changes for full-review
  members only; the DynastyTrust Members tab shows each member's mode.
- Tests: change to a vault address passes; change claiming the vault but
  going elsewhere is refused; a one-address vault's change (its single
  address) passes; mode cannot be flipped by a spend request; a changed mode
  shows as a new offer.

## Deliberately left out

- Tapit checking the DESTINATION against anything (it cannot know who the
  owner meant to pay; in full review the member sees it and can ask on the
  call).
- Hardware-wallet co-signers: unaffected.
- Changing the live-check threshold rules.
