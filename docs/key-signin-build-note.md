# Email-free sign-in with your key -- Build Note (2026-11-13)

Operator, by voice: "Is it possible to never have an email and only sign in
with your key, and when you first come to join the site if you don't have a
key, you can import yours from a hardware wallet with QR or you create one
there with a password and face lock, and then that is your sign in without
having to have the email, just for a more sovereign feel. It can still be
hooked to the Supabase I think."

## What exists (read from the code, not memory)
- Key sign-in (`wallet-signin-challenge.js`, `wallet-signin-verify.js`,
  tapit-attest `verifySignIn`): one-time challenge, 300 s, Schnorr (BIP 340),
  single-use consume. It then looks up the linked account's EMAIL and mints a
  session through `auth.admin.generateLink({ type: 'magiclink' })`; a key with
  no email account behind it is refused.
- `wallet_identities.user_id` is the PRIMARY KEY: one key per account.
- Email is read by: invites-claim (`emailMatches`), invites-lookup (email
  hint), invites.js, `_invite-rules.js` (the 2026-11-11 email binding),
  Layout.tsx ("Hi, <email local part>"), InviteClaimPath.tsx ("Signed in as"),
  PathInvites.tsx (invite form), VaultDetail invites list + vault-audit-pdf
  (label fallback), wallet-signin-verify.
- Real-bitcoin joins need aal2 (`joinAllowedAtAal`).
- SeedSigner fork: Sign Message exists, OFF by default (advanced settings),
  standard single-sig paths only, legacy Bitcoin-message ECDSA (BIP 137) --
  the server needs a second verifier for it.

## Decisions (operator's chips, 2026-11-13)
1. A key made on the site: the sign-in key comes from the SAME 24 words as
   the person's first vault key, at its own hardened path, never a Bitcoin key.
2. Email-free invites: the link plus the owner confirming the key's
   fingerprint (gate 3, already mandatory). No extra spoken code.
3. Real-bitcoin joins: a key sign-in is enough (no authenticator code
   required). Needs a server record of which sessions were made by a key
   proof, because a Supabase session cannot show how it was made.
4. Order: phone key + Face ID first.

## Status
SUPERSEDED IN PART 2026-11-13 (operator: "I don't like signing in with key. It's too
much garble"): the 24-word sign-in box was removed; the email-free doors are
now a username (no reset, warned) and Sovereign sign-in with Tapit, with Face ID
keeping a password on the phone. Hardware-wallet sign-in (slice 2) is dropped.
See HISTORY.md. What follows is the original note.

Slice 1 shipped 2026-11-13 (f226b54). Slice 3 built 2026-11-13 (see HISTORY.md).
Slice 2 (hardware wallet sign-in) and slice 4 are open.

## Slices
1. Create an account with a phone key (24 words, backup check, Face ID lock),
   sign in with Face ID, recover from the words. FIRST: prove on the live
   project that Supabase accepts the placeholder account and issues the
   one-time login for it (a write to the real database -- operator's OK).
2. Hardware wallet sign-in: SeedSigner Sign Message by QR round trip + a
   BIP 137 verifier; then that phone gets its own Face ID sign-in key.
3. Email-free invites + key-made sessions counting for real-bitcoin joins.
4. Existing email accounts add a key (and later may drop the email).

## Blast radius
Migration: `wallet_identities` many keys per account (kind, label). Server:
new sign-up-with-key, sign-in verify, challenge, wallet-link, invites-claim,
invites-lookup, `_invite-rules.js`, possibly `_auth.js`. Web: Auth.tsx,
lib/wallet-signin, keystore (sign-in key), RequireAuth, Layout name, invite
page, PathInvites, VaultDetail invites list, audit PDF fallback, Keys page.
Promises: invite wording; the recovery story ("your words are your account").

## Left out
Removing email from existing accounts (later). Anything about spending.
Recovery without the words (lose phone AND words: account gone, money safe,
re-invited). Rate limits on key sign-up beyond what Supabase does today.

## Proven live, 2026-11-13 (run 43356834911, key-signin-placeholder-test.yml)
On the real project, for BOTH `k-<random>@keys.dynastytrust.family` and
`k-<random>@key.invalid`: account created confirmed (nothing sent), one-time
login token generated (nothing sent), redeemed exactly as the browser does,
session belonged to that account, account deleted. The session reads
aal1 with amr ["otp"] -- the same as an email-code login, which confirms
decision 3 needs our own record of key-made sessions.
