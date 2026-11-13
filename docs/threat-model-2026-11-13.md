# Threat model, stage by stage -- 2026-11-13

Operator: "Help me understand where an attacker could find vulnerabilities of
each stage of a vault, from the very first time the very first person enters
the website and starts an account, makes a vault, sends the request out to the
members, and as every person joins ... I just wanna make sure we're not
leaving any holes and we're not using something very dumb and stupid in a spot
where it could penalize us."

Read from the code on `claude/dynasty-unify-2026-11` at d31a35f (= main), not
from memory. Builds on `docs/security-backlog.md`; items already closed there
are named, not re-argued.

## The frame -- what an attacker is actually after

Every vault is script-path only under a provably unspendable internal key, so
**no server, database row or API call can move a coin.** An attacker can only:

1. **Get money sent to the wrong place.** A deposit address the family
   trusts is really the attacker's, or a vault is built with the attacker's
   key in it before anyone funds it.
2. **Get a keyholder to sign the wrong thing.** Mostly closed already: the
   browser checks every input, output, fee and change against the PSBT's own
   data before signing (backlog item 1).
3. **Steal keys.** Keys live in the browser (password- or Face ID-locked) or
   on a hardware wallet. The browser is the soft spot: anything that runs
   script on dynastytrust.family runs next to the keys.
4. **Take over an account.** That alone moves no money, but the OWNER's
   account decides who is in a vault before it is funded -- see stage 3.
5. **Read private things.** Messages, saved circle phrases, who is in whose
   family, balances.

The ranking below is by how directly a hole leads to 1, then 3, then 4, then 5.

## The ranked list (fix in this order)

| # | Severity | Hole | Stage |
|---|----------|------|-------|
| A | **High** | Database still lets a signed-in owner rewrite a vault's address AND descriptor directly, bypassing every server check; the new phone-side address check passes a swap that is self-consistent | 4, 6 |
| B | **High** | Nothing on a member's phone remembers the vault it agreed to: no automatic pin of descriptor/address, no "my key is in this vault" check | 4, 6 |
| C | **High** | Owner account is the gatekeeper of a draft vault, but email accounts allow 8-character passwords (server floor 6) and two-step sign-in is optional, fail-open on lookup errors, and not required for real-bitcoin owners | 1, 3 |
| D | Medium | Whoever can push to `main` or the working branch runs code with the Supabase management token (full database and auth control); today's live-check workflow runs on every push to the working branch | infra |
| E | Medium | Messaging keys are trusted on first sight from the server; a database or server compromise can silently swap a member's messaging key and read/forge messages | 5 |
| F | Medium | Link-only invites are bearer links; the owner's fingerprint read-back is the only guard, and it is only as good as the channel it is read over | 3 |
| G | Medium | Tapit sign-in challenge is not bound to the browser that asked for it (backlog 11b): a person tricked into approving an attacker's sign-in QR signs the attacker in as them | 1 |
| H | Low-Med | No rate limits on public endpoints: account creation (username, key), challenge minting (rows never deleted), compile proxies | 1 |
| I | Low-Med | Saved circle phrases and messaging-key backups sit on the server encrypted under a human password: a database leak allows offline guessing (600,000 PBKDF2 rounds slows, does not stop, a weak password) | 5 |
| J | Low | Usernames can be squatted through Supabase's public email sign-up using the users.dynastytrust.family address | 1 |
| K | Low | Balances, fee estimates and broadcast use mempool.space only: it sees every vault address with the viewer's IP, and could lie about a balance (visible, recoverable) | 7 |

Already closed and NOT holes (so they are not re-opened by mistake): signing
the wrong transaction (backlog 1), timelocks set at the wrong height (2, 12),
attestations forged (4), cross-vault reads by guessing ids (11), stored
address not matching its own descriptor (5 + today's in-browser check), raw
HTML injection (no `dangerouslySetInnerHTML`/`innerHTML` anywhere), inline
script injection (CSP `script-src 'self' 'wasm-unsafe-eval'`).

---

## Stage 1 -- First visit, creating an account, signing in

**How an attacker comes in**
- **Phishing the password.** A look-alike site or an email "your vault needs
  attention". Email accounts accept an 8-character password in the browser
  (`Auth.tsx` `minLength={8}`) and Supabase's own floor is 6 (no
  `password_min_length` is set by `scripts/supabase-auth-deploy.sh`).
  Password reuse from another breached site works the same way.
- **Two-step sign-in is optional** (`TwoStepCard`), and `_auth.js`
  `hasVerifiedFactor` is fail-OPEN when the factor lookup errors (backlog 10:
  it could not be exercised live). An attacker who can make that lookup fail
  skips the second step.
- **Tapit sign-in QR from an attacker (G).** The challenge a Tapit wallet
  signs is not tied to the browser that requested it. An attacker shows the
  victim a sign-in QR (or link) and, if the victim approves it in Tapit, the
  attacker's browser is signed in as the victim. The wallet shows the
  callback host (`SignApprovalScreen`), which helps only if people read it.
- **Spam and squatting (H, J).** `username-signup`, `key-signup` and
  `wallet-signin-challenge` accept unlimited anonymous requests. Challenge
  rows are never deleted (only an index on `expires_at`). Anyone can also
  call Supabase's public email sign-up with `grandpa.joe@users.dynastytrust.family`
  and block that username for its real owner.

**What already stops them:** placeholder addresses are never mailed and
never shown; username accounts enforce the real-bitcoin password rule;
Face ID sign-in stores the password only under the device passkey; a
captured Tapit proof cannot be replayed (single-use, atomic).

**Fix:** require two-step sign-in (or Tapit/Face ID) for the OWNER of any
real-bitcoin vault before it can be finalized; flip `hasVerifiedFactor` to
fail-closed once walked; raise the email password floor to the same rule as
usernames for anyone who owns a vault; set Supabase's own password minimum;
bind the Tapit challenge to the requesting browser (a nonce kept in that tab
and required at verify); rate-limit the three public endpoints and delete
expired challenges on the daily cron; block Supabase public sign-up for the
two placeholder domains (a database hook, or turn public email sign-up into
our own function).

## Stage 2 -- Making keys

**How an attacker comes in**
- **Code running on the page.** Keys are generated and kept in the browser
  (`keystore.ts`). Anything that runs script on dynastytrust.family -- a
  malicious npm dependency, a compromised Netlify or GitHub account, a bad
  push -- can read a key the moment it is unlocked, and can ask the device
  for Face ID itself (the person sees a prompt and may approve it).
- **Stolen device or browser data.** Test-coin keys are plain; real-bitcoin
  keys are password- or Face ID-locked. A password-locked key copied off a
  device can be guessed offline (600,000 rounds slows it).

**What already stops them:** CSP blocks injected inline scripts; no raw HTML
rendering; mainnet keys cannot be plain; Face ID keys need the passkey AND the
locked copy on that device; `scripts/audit-prod.mjs` runs in `npm test`.

**Fix:** the strongest answer is already in the product -- **hardware wallets
for real money** (the key never touches the page). Make it the default
recommendation for real-bitcoin vaults, as must-sign invites already do.

## Stage 3 -- Building the vault and inviting people

**How an attacker comes in -- the owner is the gatekeeper**
- **Owner account takeover before funding (C).** Whoever controls the
  owner's account controls the draft: paste their own key into a path (the
  owner's own and pasted keys need no confirmation, by design), confirm a
  key they joined with, finalize. The family then funds a vault the attacker
  can spend. This is the single most valuable account to steal.
- **Intercepting a link-only invite (F).** Whoever has the link can join that
  path with their own key. They see only their own path and the owner
  (`invite rules`), and their key cannot be finalized until the owner
  confirms its fingerprint. The attack is social: text the owner "my code is
  ABCD1234" and get confirmed.
- **Email invite to a compromised inbox.** The email binding is only as safe
  as that inbox.

**What already stops them:** confirmation is mandatory for every invited key,
test coins included; must-sign slots cannot be over-promised; refused claims
never burn the invite; a finalized vault takes no new members.

**Fix:** state on the confirm screen, in plain words, that the fingerprint
must be read **by voice or in person**, never accepted by text or email;
require the owner's two-step (stage 1) before any real-bitcoin finalize.

## Stage 4 -- Finalizing (compile) and the deposit address

**How an attacker comes in**
- **The database write the server never allows (A).** The `vaults` table
  still carries the June policy `users_own_vaults ... for all using
  (auth.uid() = user_id)` (`20260615232213_vaults.sql:126`), never dropped
  (only `vault_events` was, in `20261110230000_vault_ledger.sql`). The app
  never writes vaults from the browser, but the public anon key plus the
  owner's session token is enough to `UPDATE vaults SET descriptor = ...,
  address = ...` directly through Supabase's REST API -- no Netlify function,
  no sealed record, no draft-only rule. The same is true of
  `users_own_proposals` and `users_own_signer_sessions`.
- **Why today's address check does not catch it.** The in-browser check
  re-derives the address from the stored descriptor; an attacker who writes a
  matching pair (their own one-key vault's descriptor and its address) passes
  it. Every member then sees the attacker's address as the deposit address.
- **A compromised Fly compiler at creation.** The browser cross-checks the
  timelocks (backlog 2) and now the address, but not yet byte-for-byte that
  the descriptor contains exactly the keys and thresholds chosen. That is
  the next browser-compiler slice.

**Fix (A and B together, the top priority):**
1. A migration dropping the three `for all` policies (vaults, proposals,
   signer_sessions) and leaving SELECT only; every write already goes
   through a Netlify function.
2. **Pin on each member's phone:** the first time a finalized vault opens
   on a device, store its descriptor fingerprint and address; if either
   ever changes, the same red stop screen. And check that **this person's
   own key is in the descriptor**, with the quorum they were shown when
   they joined.
3. Next browser-compiler slice: compile in the browser at creation and
   refuse a Fly answer that differs.

## Stage 5 -- Members joining, messages, saved secrets

**How an attacker comes in**
- **Swapping a messaging key (E).** Each member's messaging public key is
  published to `vault_members` and trusted as-is. Anyone who can write that
  row (a server or database compromise; a member can only change their own)
  can substitute their key and read every future message to that member or
  forge messages from them. There is no way today to compare messaging keys
  person to person.
- **Offline guessing of server-held secrets (I).** Saved circle phrases
  (including the DURESS phrase) and messaging-key backups are stored on the
  server encrypted under a human password. A database leak lets an attacker
  guess offline.
- **A member changes their own key after finalize** (backlog 11b, open
  design decision).

**Fix:** show a short "messaging safety code" per member (from both public
keys) that two people can compare by voice; warn on change. Hold the
saved-secret and backup passphrases to the real-bitcoin password rule, or
move saved secrets under Face ID only.

## Stage 6 -- Funding and day-to-day viewing

Same as stage 4: a swapped pair would show the attacker's address (A, B).
The dashboard list also shows shortened addresses and balances without the
address check (noted 2026-11-13). Balances come from mempool.space alone (K):
a lie there is visible and cannot move money.

## Stage 7 -- Spending and signing

Strongest stage. Every co-signer's browser re-checks the PSBT against what it
shows (inputs are the vault's own coins, change returns to the vault, real
fee and amounts) before signing (backlog 1); the compiler refuses foreign
inputs and change; a recorded signature must be real (`_psbt-verify.js`);
proposal status cannot be set to `signed` through the API (11b). The open
piece is the same database write as A: `users_own_proposals ... for all`
lets a proposer rewrite their own proposal row directly. The signing check
still protects co-signers (it reads the PSBT itself), so this is about
record integrity, not funds -- fixed by the same migration.

Broadcast goes through mempool.space (privacy, K).

## Infrastructure -- the "dumb spot" check (D)

- **GitHub holds the master key.** Four workflows use
  `SUPABASE_ACCESS_TOKEN` (full control of the database and auth). Three run
  only on `main` or by hand. `key-signin-placeholder-test.yml`, added today,
  runs on every push to the working branch: anyone or any session that can
  push there can change the script and use the token. **It has done its job
  and should be removed or made hand-run only.**
- **Push to `main` runs migrations automatically.** Whoever can push to
  `main` can run any SQL. Protect `main` (required review or at least
  signed pushes), keep GitHub 2FA on, and treat every session with push
  rights -- including AI sessions -- as holding that power.
- **Netlify** serves the code that sits next to the keys. Its account needs
  2FA; a compromised deploy is the one attack every browser-held key is
  exposed to, which is why hardware wallets matter for real money.
- **Service-role key in Netlify functions** (backlog 11b): any function bug
  is a full-database bug. Moving reads to the caller's own session + row
  security is the long-term fix.

## Proposed slices, smallest first

1. **Close the database write (A):** one migration dropping three policies;
   prove first on a local Postgres that every app write still works through
   the functions.
2. **Remove today's live-check workflow (D).**
3. **Pin the vault on every member's phone + "your key is in this vault" (B).**
4. **Owner two-step for real bitcoin + stronger email passwords +
   fail-closed factor lookup (C).**
5. Voice-only wording on key confirmation (F); rate limits and challenge
   cleanup (H); messaging safety codes (E); stronger secret passphrases (I);
   Tapit challenge binding (G); placeholder-domain sign-up block (J).
