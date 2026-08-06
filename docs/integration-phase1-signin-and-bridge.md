# Phase 1 Integration -- Sign-in by Attestation + the Signing Bridge

Status: grounded execution plan. Companion to `docs/build-map-and-cut-lists.md`
(the cross-repo map) and the Tapit brief
`2026-06-15-dynastytrust-tapit-integration-cut-list.md`. Written after a
quarterback grounding pass that read the real code in both repos. The two
education cuts of Phase 1 (TW-1 in Tapit, DT-2 here) are already shipped on the
working branch `claude/dynasty-trust-integration-eh4ng9`. This doc covers the
two cuts that remain: sign-in by attestation, and the signing bridge.

The rails from the risk register (`build-map-and-cut-lists.md` section 6) govern
every line below. The hardest one applies directly here: **an attestation is
never a spend signature.** A sign-in attestation proves key control; it never
moves a coin. A PSBT tapscript signature moves a coin; it is never an
attestation. The two cuts below sit on opposite sides of that wall, which is
why they have very different risk profiles.

**No rogue signing (operator directive, 2026-06-22).** Tapit is never a blind
signing oracle. Before the wallet signs anything an app hands it, it must verify
the request ties to a matching attested trail it already holds and has verified.
This is a hard precondition on Cut B (the spend bridge) and a surfaced signal on
Cut A (sign-in). It is woven into both cuts below and is now a standing line in
the risk register.

---

## Ground truth established this pass

- The two `tapit-attest` copies have **diverged**. Tapit's
  (`/tapit-attest`, version `0.1.1-wallet.0`) already ships
  `src/core/sign-in.ts` with `buildSignInChallenge` /
  `answerSignInChallenge` / `verifySignIn`, plus `shamir.ts`, `wallet.ts`,
  `nip44.ts`, `ots-codec.ts`. DynastyTrust's (`/tapit-attest`, version
  `0.1.0`) does NOT have the sign-in module; it has `sign.ts`, `kinds.ts`,
  `anchor.ts`, and an `internal/` dir. The two use different internal helpers
  (`taggedHash`, `canonicalJson`), so any shared digest must be verified for
  byte-parity, never assumed.
- Tapit's existing app-to-wallet seam is the **deep-link sign-request flow**:
  DynastyTrust opens `https://<tapit>/sign?req=<base64url SignRequest>`; Tapit's
  `SignApprovalScreen` renders a plain-English banner; on approve it redirects
  to `callback?grant=<base64 SignGrant>`. The only intents today are `attest`
  and `cosign-existing` (both sign *attestation envelopes*). There is no PSBT
  intent and no sign-in intent yet.
- Tapit also has an **encrypted Nostr inbox** (`sendEnvelopeTo` /
  `subscribeInbox`, kind 9573 NIP-44 ciphertext, silent-absorb merge). This is
  the transport for the eventual multi-party flow.
- DynastyTrust signs PSBTs in the browser today via
  `apps/web/src/lib/psbt-signer.ts` -> `signPsbtWithMnemonic(psbtHex, mnemonic,
  derivationPath, network)`: it derives the `/0/0` child, finds the tapscript
  leaf whose x-only pubkey matches, computes `tapLeafHash` +
  `tapscriptSighash`, Schnorr-signs, and appends a `tapScriptSig`. The BIP341
  machinery (`parsePsbt`, `serializePsbt`, `tapLeafHash`, `tapscriptSighash`)
  lives only here. `mergePsbts` combines partial sigs. `tapit-attest` is
  deliberately zero-Bitcoin-script, so it has none of this.
- DynastyTrust auth today: Supabase email/password in
  `apps/web/src/pages/Auth.tsx`; session checked in
  `components/RequireAuth.tsx`; backend JWT verified in
  `netlify/functions/_auth.js` (`requireUser`).

---

## Cut A -- Sign-in by attestation (identity layer, lower risk)

Goal: a "Sign in with Tapit" path on `Auth.tsx`. The user proves control of
their Tapit key by signing a fresh challenge; DynastyTrust verifies and mints a
session. Never touches a spend. This is the safe one to land first.

Flow (challenge-response, reusing the existing sign-in primitive):

1. DynastyTrust backend issues a challenge.
   - New function `netlify/functions/auth-tapit-challenge.js`: build a
     `SignInChallenge` (`audience: 'dynastytrust.family'`, ttl ~300s, random
     nonce). Persist it server-side keyed by nonce (a short-lived
     `signin_challenges` row or a signed stateless token). Return the challenge.
   - The challenge builder must match Tapit's `buildSignInChallenge` shape
     exactly. Either vendor `sign-in.ts` into DynastyTrust's `tapit-attest`
     (preferred, with a parity test) or reimplement the challenge struct and
     verify against Tapit-produced fixtures.

2. The user answers in Tapit. Two transport options:
   - **Deep-link (simplest, recommended for v1):** add a new Tapit sign-request
     intent `sign-in` (Tapit-side cut) whose handler calls
     `answerSignInChallenge({ challenge, signerPrivateKey })` and returns the
     `SignInAttestation` in the grant. DynastyTrust opens
     `/sign?req=<base64url {intent:'sign-in', challenge, callback, nonce}>` and
     reads the `grant` on return.
   - **Nostr inbox (later):** same payload over the encrypted inbox for a
     no-redirect flow.

3. DynastyTrust verifies and mints a session.
   - New function `netlify/functions/auth-tapit-verify.js`: load the stored
     challenge by nonce, call `verifySignIn({ attestation, expectedChallenge,
     now })` -- checks echo (byte-identical challenge), freshness (not expired),
     and control (Schnorr sig verifies). On valid, map the `signer` x-only
     pubkey to a Supabase user (create on first sight; key a
     `users_tapit_keys` table or a column) and issue a Supabase session / JWT.
   - Verification can also be done directly with `@noble/curves` schnorr
     (already a dependency via psbt-signer) over the documented `tapit/sign-in`
     tagged digest, if vendoring the module proves heavy. Whichever path,
     **add a fixture test** proving DynastyTrust verifies a real
     Tapit-produced `SignInAttestation`.

4. Persist + surface (TW-6 on the Tapit side): Tapit keeps each signed sign-in
   attestation and can show "when you signed in"; OpenTimestamps anchoring is a
   free add since the primitive already exists.

Files: `apps/web/src/pages/Auth.tsx` (add the button + flow),
`apps/web/src/lib/tapit-auth.ts` (NEW, challenge fetch + deep-link + grant
parse), `netlify/functions/auth-tapit-challenge.js` (NEW),
`netlify/functions/auth-tapit-verify.js` (NEW), a migration for
`users_tapit_keys` / `signin_challenges`. Tapit-side: new `sign-in` intent in
`src/features/sign-request/*`.

Rails: the challenge nonce + expiry are mandatory (no replay). Verify echo +
freshness + signature, all three. Never accept a bare identity attestation as a
login (that is replayable). No key material ever leaves Tapit.

---

## Cut B -- The signing bridge (money-touching, its own careful cut)

Goal: a DynastyTrust vault spend PSBT gets signed by a key that lives in Tapit,
over the encrypted inbox, with a plain-English banner, and the signed PSBT comes
back to DynastyTrust to merge + finalize + broadcast. This is the literal
"two apps work together" wedge AND the most dangerous cut in the whole plan.

Why it is not a quick add: signing a vault PSBT is **not** signing an
attestation. Tapit's sign-request flow only knows `attest` / `cosign-existing`
over attestation envelopes. To sign a vault spend, Tapit needs the BIP341
tapscript machinery that currently exists ONLY in DynastyTrust's
`psbt-signer.ts` (`parsePsbt`, `serializePsbt`, `tapLeafHash`,
`tapscriptSighash`, the `/0/0` derivation, the leaf-match-by-xonly-pubkey, the
`tapScriptSig` append). Porting ~500 lines of money-touching code into Tapit and
trusting it without parity proof would be exactly the "confident wrong answer
that loses an inheritance" this repo's doctrine forbids.

**Hard precondition (no rogue signing).** Before Tapit will sign a vault PSBT it
must hold and verify a matching attested trail for that vault: the founder/heir
keys, the co-signer set, and the policy must trace to attestations the wallet
already accepted (e.g. an `agreement`-kind vault-membership attestation minted
when the vault was created and cosigned by the members), NOT to fields supplied
inside the incoming PSBT request. If the wallet has no verified attested trail
that matches the PSBT's vault, it REFUSES to sign -- it does not fall back to a
human tap. This means the bridge needs a vault-membership attestation issued at
vault creation and held by each member's wallet; the psbt-cosign handler looks
that up, verifies the PSBT's leaf pubkeys and amount/destination against the
attested vault, and only then renders the banner for the human tap. Build this
attestation-trail check as part of B1, before the signing line.

Staged plan (each stage shippable, proven before the next, small amounts first):

- **B0 -- Shared signer module + parity test (do this FIRST, no UI).** Extract
  the BIP341 signing core (`signPsbtWithMnemonic` and its helpers) into a small
  pure module usable by both repos, OR vendor a copy into Tapit. Then write a
  cross-repo **parity test**: given the same PSBT + same seed + same derivation
  path, DynastyTrust's signer and Tapit's signer produce the **byte-identical**
  `tapScriptSig`. This test is the gate. No signing bridge ships until it is
  green. Bitcoin-respect demands this.

- **B1 -- New Tapit `psbt-cosign` intent + banner.** A sign-request intent that
  carries `{ psbt_hex, vault_context }`, renders a banner that shows the REAL
  meaning (this vault, paying X sats to this address, from which path), and on
  approval signs the matching tapscript input with the user's vault key and
  returns the signed PSBT in the grant. The banner shows meaning, never hex.
  No value commits without the human tap. The session must be abortable. Above
  the vault's configured amount threshold, the banner step additionally
  requires the operator to confirm the out-of-band callback ritual happened
  before `approveRequest` calls `wallet.signDigest` --
  `docs/2026-08-callback-verification-and-amount-tiers.md` has the full design
  and the honest line on what it does and does not close.

- **B2 -- DynastyTrust requester + absorb. DONE 2026-08-06.** `VaultDetail.tsx`'s
  send flow gained a "Sign via Tapit" card alongside local key signing and
  hardware export. `lib/tapit-cosign.ts` builds the psbt-cosign request and
  opens it in a NEW TAB (`window.open`, not `window.location`) rather than a
  full-page redirect -- deliberate: signing lives inside VaultDetail's
  in-memory `signing` session and there is no "resume signing this proposal"
  entry point today, so a full navigation away and back the way sign-in does
  it would strand that state. The callback page (`TapitCosignCallback.tsx`,
  route `/tapit-cosign-callback`) hands the signed PSBT back to the original
  tab via a same-origin `localStorage` write + the browser's own `storage`
  event (fires in every OTHER tab, never the writer), which `VaultDetail`
  listens for and feeds into the EXISTING `externalImport` -> `mergePsbts` ->
  `/api/psbt-finalize` path, unchanged, exactly as specified -- with a
  visible copy-the-hex fallback on the callback page if the original tab
  isn't listening anymore (closed, reloaded). Uses a distinct `psbt_grant`
  query param, not `grant`, so `RequireAuth.tsx`'s global sign-in-callback
  check (which fires on every authed page load) never mistakes a signed PSBT
  for a sign-in proof.

  Deviation from this doc, surfaced deliberately per doctrine ("if the code
  contradicts the plan, surface it"): did NOT add a `proposals.signing_method`
  column. Signers can genuinely mix methods on the same proposal (one via
  mnemonic, one via Tapit, one via hardware), so a single proposal-level
  column cannot honestly represent it. `signer_sessions.label` already
  exists for exactly this and is per-signature, not per-proposal --
  `externalImport` now takes an optional `label` parameter and the Tapit path
  passes `"Tapit"` through it, the same mechanism hardware-wallet imports
  already used with the hardcoded label `"Hardware wallet"`. The audit trail
  this doc wanted is there; it just lives in the row that was already
  correct for it.

- **B3 -- Multi-member over Nostr.** Move the transport to the encrypted inbox
  so a co-signer's Tapit shows the proposal in their inbox (ties into the
  existing "multi-member vault flow" open gap and Supabase Realtime feed).

Rails (all from the risk register): an attestation is never a spend signature --
this intent is explicitly a PSBT-sign, domain-separated from `attest`. The
banner shows the spend's meaning, not the raw PSBT. No key leaves Tapit. No
signature is produced without a human tap. The fast path (Tapit online) can
stall; the absolute-CLTV timelock leaf remains the guarantee that needs nobody.
Prove on signet/testnet with small amounts before any mainnet sat rides on it.

---

## Recommended order for the next pass

1. Cut A (sign-in) end to end -- lower risk, unblocks "log into Dynasty with
   your Tapit identity," and forces the tapit-attest parity discipline on the
   easy case first.
2. Cut B0 (the signer parity test) -- the single most important safety artifact
   before any spend crosses repos. Land it red-to-green before B1.
3. Cut B1/B2 behind the green parity test, signet first.
4. Then climb the build-map: FROST (Phase 2), resharing (Phase 3), paid
   witnesses (Phase 4).

Nothing in Cut B merges to `main` until the parity test is green and a
small-amount signet spend has been verified end to end.
