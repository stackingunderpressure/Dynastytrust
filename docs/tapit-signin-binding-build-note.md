# Build Note -- threat model G: tie a Tapit sign-in to the screen that asked

Written 2026-11-13, before any code. Grounded in the files named below as they
are on `claude/dynasty-unify-2026-11` (DynastyTrust) and
`claude/dynasty-trust-last-work-clryy9` (tapit-wallet, level with its main).

## The ask, in the operator's words

"Help me understand where an attacker could find vulnerabilities of each stage
of a vault ... we're not leaving any holes and we're not using something very
dumb and stupid in a spot where it could penalize us." Chip: "The medium ones."
Then: "Build G next (Recommended)."

## The hole, exactly

Tapit sign-in has three ways back to the page:

1. **Redirect** (`startTapitFlow`): the wallet sends the approval back to the
   callback page *on the same phone that approved it*. On its own this signs
   in only the person holding the wallet. One gap remains: an attacker can
   approve their OWN request and send someone the resulting callback link, so
   that person's browser silently signs in to the ATTACKER's account
   ("login trap"). Anything they then set up -- a vault, a key list -- sits in
   an account the attacker controls.
2. **QR / connect** (`startTapitConnectRequest`, `TapitConnectModal`) and
3. **Pushed request** (`startTapitPubkeyConnectRequest`,
   `tapit-signin-request-delivery.ts` -> the wallet's `IncomingSignInBanner`):
   the wallet sends the approval over Nostr to whichever browser made the
   request (`response_channel.requester_pubkey`). If that browser is an
   attacker's, approving it signs the ATTACKER in as you. The wallet shows the
   callback host (`SignApprovalScreen`), but the host is honestly
   `dynastytrust.family` in the attack, so it looks right.

A browser-held secret alone cannot fix 2 and 3: the attacker's own browser
makes the request and would hold the secret. Only the person can tell which
screen they are signing in on, so the fix is a code that ties the two
screens together, the way bank and work-account apps now do it.

## What would be built

- **One sign-in number per request.** A two-digit number derived from the
  request's challenge nonce by one pure function in tapit-attest (both copies).
  DynastyTrust shows it large next to the QR and in the "check your Tapit"
  wait screen. The Tapit wallet does NOT show it: it asks the person to type
  the number they see on the screen they are signing in on, and refuses to
  approve on a wrong number. A pushed request nobody started cannot be
  approved by tapping through it, and an attacker cannot see what the
  victim's screen shows.
- **The login-trap fix (browser only).** The page that starts a redirect
  sign-in keeps a one-time marker in that tab; a callback that arrives in a
  tab that never started one is refused with a plain message.
- Wording: the wallet's approval screen says "Type the number shown on the
  screen you are signing in on. If you did not just start a sign-in, or
  someone gave you the number, do not approve."

## Decisions that are yours (asked as chips)

1. How the wallet checks the number: type it (Recommended), tap the matching
   one of three, or only show it.
2. Whether the server enforces it: the typed number goes inside the wallet's
   signature and the server refuses a sign-in without it (an older wallet
   page must reload to update -- Tapit is a web app, so that is one refresh),
   or the check lives only in the wallet and the server accepts either.
3. Order: wallet first, then DynastyTrust (Recommended -- DynastyTrust then
   never asks for a number an old wallet cannot take).

## Blast radius -- everything downstream, read from the code

DynastyTrust:
- `apps/web/src/lib/wallet-signin.ts` -- `startTapitFlow`,
  `startTapitConnectRequest`, `startTapitPubkeyConnectRequest`,
  `readTapitCallback`, `completeTapitCallback` (marker + number).
- `apps/web/src/components/TapitConnectModal.tsx` -- shows the number.
- `apps/web/src/lib/tapit-signin-request-delivery.ts`,
  `tapit-signin-response-channel.ts` -- pushed and returned requests.
- The sign-in page's three doors (`Landing.tsx` / `Auth.tsx` Tapit button)
  and the Keys page "link a wallet" (mode `link`, `wallet-link.js`).
- If enforced (decision 2): `netlify/functions/wallet-signin-verify.js`,
  `key-signup.js` and `wallet-link.js` (via `_key-account.js`
  `proveKeyControl`), and `tapit-attest/src/core/sign-in.ts`.
- Tests: `scripts/test-key-account.mjs`, `test-invite-handlers.mjs`, the
  tapit-attest `test/sign-in.test.mjs` parity test.

tapit-wallet:
- `src/features/sign-request/SignApprovalScreen.tsx`,
  `IncomingSignInBanner.tsx`, `approveRequest.ts`,
  `signInResponseChannel.ts`, `renderRequest.tsx`, and their tests
  (`signIn.test.ts`, `parseSignRequest.test.ts`).
- If enforced: `tapit-attest/src/core/sign-in.ts` -- the signed sign-in
  body gains the number. The two copies are a PORT, not the same file; the
  parity test verifies a real Tapit-made attestation (golden fixture), which
  must be regenerated from the wallet's source, never hand-written.

Not affected: other fleet apps (sworn, modot-scout, AppCommander do not use
Tapit sign-in -- checked by search), email and username sign-in, vault
spending, attestations for anything other than sign-in.

Promise to a human that changes: the sign-in screen and the wallet both get
new words; every Tapit sign-in gets one extra step (type two digits).

## Deliberately left out

- A person talked into typing a number an attacker reads to them over the
  phone. No code on two screens stops that; the wallet's wording warns
  against it, and it is named here so it is not mistaken for covered.
- Changing the sign-in envelope beyond the one number, or its tag.
- Location or device hints on the approval screen (we do not have honest
  ones).
- K (mempool privacy) and the email-code switch (waits on the mail sender).

## Then

One slice, end to end: wallet side with its tests, then DynastyTrust with its
tests, walked together with the real wallet build against a stand-in
DynastyTrust backend, both on their branches; nothing to main until the
ship chip.
