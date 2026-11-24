# Z4 -- accounts without identity -- Build Note (2026-11-24)

Operator, asked "what is the best sign-in method, email, or do we need to make
it better?", heard the answer (Tapit best, email weakest, Face ID is only a
shortcut today) and said: **"I like z4"**.

Plan reference: docs/zero-knowledge-storage-plan.md, Z4 -- "Username or
Tapit-key accounts only; no real email; no password-reset email (recovery is
the key or passkey). Rate-limit buckets keep the IP only for their short
window."

## What exists (read from the code, not memory)

- Four ways in (`apps/web/src/pages/Auth.tsx`): email + password (resettable
  by a 6-digit code), username + password (no reset), Sovereign sign-in with
  Tapit, and Face ID -- which is NOT an account: it keeps an existing
  password on this phone under the device passkey (`lib/faceid-signin.ts`).
- Key accounts already work end to end: `key-signup.js` makes a confirmed
  account at a never-mailed placeholder address from a signed challenge
  (`_key-account.js`), and already accepts `kind: 'device'` ("Phone key")
  besides `'tapit'`. `wallet-signin-verify.js` signs a key in;
  `wallet_identities` holds many keys per account (kind tapit / device /
  hardware). Key-made sessions count for real-bitcoin joins
  (`issueKeySessionClaim`). Proven live 2026-11-13.
- The phone's passkey with the PRF extension already guards Bitcoin keys, the
  messaging key and saved secrets (`keystore.provenPasskeySecret`).
- History: the 2026-11-13 key sign-in showed 24 words; the operator dropped it
  ("too much garble"). This note shows no words anywhere.
- Identity the server still keeps: the email (email accounts);
  `user_metadata.display_name` (key and username accounts; read by
  `lib/account-name.ts` for the greeting); the browser's user agent in every
  vault's `terms_accepted` history entry (`vaults.js:357`); the raw IP inside
  rate-limit bucket names (`_rate-limit.js`, `rate_hit`), cleared "now and then".

## What would be built

A **Face ID account**: "Create account with Face ID" makes the phone's passkey,
derives a sign-in key from it (PRF, its own fixed label -- never a Bitcoin key,
never shown), and creates the account through the existing `key-signup`
(`kind: 'device'`). Signing in is one Face ID prompt. No email, no password, no
words. The sign-in screen leads with Face ID and Tapit; username and email move
behind "Other ways". Existing accounts can add Face ID sign-in and then remove
their email. The server stops keeping the display name, the user agent and raw
IPs.

## Slices (one shipped and walked before the next)

0. **Prove on a real iPhone first** that the passkey's PRF output is the same
   on a second Apple device signed into the same iCloud account (that is what
   makes a lost phone recoverable). If it is not, decision 1 changes.
1. Face ID account: create, sign in, sign out and back in.
2. Sign-in screen order; email behind "Other ways".
3. Existing accounts: add Face ID sign-in; remove my email (placeholder
   address swapped in, with a clear warning).
4. Server hygiene: no display name stored, no user agent, rate-limit buckets
   keyed by a keyed hash of the IP.

## Blast radius

- Web: `Auth.tsx`, new `lib/passkey-account.ts` (beside
  `lib/faceid-signin.ts`), `lib/passkey.ts` / `keystore.ts` (a fixed-label PRF
  secret for sign-in), `lib/wallet-signin.ts` (device kind), `lib/account-name.ts`
  + `Layout.tsx` greeting, the account/settings page (add Face ID, remove email).
- Server: `key-signup.js`, `wallet-signin-challenge.js` / `-verify.js`,
  `_key-account.js`, a remove-email path (Supabase admin update),
  `vaults.js` (terms entry), `_rate-limit.js`.
- Database: none expected (`wallet_identities` already allows `device`).
- Promises to people: the sign-in screen's words; "no email means no reset";
  invite pages ("sign in or create an account").
- Gates: key-account, username-signup, faceid-signin, rate-limit,
  placeholder-guard tests all touch this.

## Deliberately left out

- Who shares a vault (Z5, pseudonyms per vault).
- IP addresses Netlify and Supabase themselves log for every request and
  sign-in -- outside this code; only Tor or self-hosting removes those.
- Hardware-wallet sign-in (dropped 2026-11-13).
- Money fields and vault structure (Z2, Z3).

## Decisions -- the operator's

1. Recovery for a Face ID account: the synced passkey only, or also a printed
   recovery code.
2. Existing email accounts: offer "remove my email", or leave them.
3. Display name: on the device only, or kept on the server.
4. Email sign-up: behind "Other ways", or removed for new accounts.
