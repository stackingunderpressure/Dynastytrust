# Tapit sign-in + green/red peer readiness — design + build plan

> Locked with the operator 2026-06-24. This is the spec the implementation
> cuts follow. Read it before touching the auth, proposal, or member code.

## The model (operator's words, paraphrased)

DynastyTrust is **not the security wall and never freezes your money.** The
base layer of any vault is your own multisig that you can spend any time you
know how — the app does not gate that, ever. The layers on top are optional
and used a hundred different ways: an extra security step for one person, a
large multi-party inheritance for another. They don't even bite until the
timelocks.

The real defense is not the app standing in front of the coins. It is:

1. **The attestation trail makes tampering visible** the instant a hash goes
   janky — someone altering a record throws a flag because the signatures and
   digests stop verifying.
2. **Timelocks** mean a stolen key gets nothing in the window you need to
   notice and **sweep to a clean, untampered wallet.**
3. The app is an **interface that surfaces "someone may be trying to gain
   access,"** plus extra layers of recovery (peers, time, recovery pads) so
   that "no matter what, you get your money back."

Sign-in exists so a person can **prove who they are to the wallet and to the
other participants** — that this is the same wallet that showed up last time,
and that this person is agreeing to this or that. The wallet becomes an extra
identity verifier. We can't verify a human for certain, but we can verify it's
the same key, and the trail shows when that stops being true.

## Green / red

`green` = the peer/recovery group is ready and uncompromised. `red` = the peer
group flagged a wallet as compromised.

**Enforcement scope (operator decision, corrected 2026-06-24 — GUIDANCE ONLY):**

When the operator was given the red-state powers as independent switches
("click all that apply"), he chose **only "guide the sweep"** — twice. Red is
therefore a **visible flag that guides, never a hard block**:

- When a wallet goes red, the app **surfaces the sweep-to-a-clean-wallet
  recovery path and a readiness checklist** — the flag becomes a guided "get
  your people green" flow.
- Red does **NOT** block login. A flagged wallet can still sign in; it just
  sees the sweep/readiness guidance.
- Red does **NOT** block in-app signing, attesting, or agreeing, and does
  **NOT** refuse a signature toward quorum.

This is faithful to the deeper model: DynastyTrust is the **interface that
makes a compromise visible and guides the recovery, not the security wall.**
"Maybe you can hack around the interface" — the app's job is to show the flag
and lead the peer group to sweep, not to pretend it can lock an attacker out.

**The hard line, true across everything:** none of this touches a member's own
**base multisig spend.** Red means you get your people back on the same page
and green, so that when you actually need the recovery / inheritance /
protector layers, your peers are verified and ready.

## Sign-in flow — link-to-existing-account model

The operator chose **link**, not replace. Email login stays; the Tapit key
becomes a second, key-based way into the *same* account.

1. **Bind once (while logged in).** A logged-in user proves control of their
   wallet key via the sign-in flow; the server stores `user_id -> pubkey` in
   `wallet_identities`.
2. **Log in by key thereafter.** DynastyTrust mints a TA-1 `SignInChallenge`,
   persists it (`wallet_signin_challenges`), and redirects to the wallet at
   `/sign?req=<base64>` with `intent: 'sign-in'`. The wallet shows "DynastyTrust
   wants you to sign in," the user approves, the wallet answers with
   `wallet.signIn()` (private key never leaves), and redirects back to the
   DynastyTrust callback with the `SignInGrant`.
3. **Verify server-side.** The callback function calls `verifySignIn` against
   the *stored* challenge (echo + freshness + signature), resolves
   `pubkey -> user_id`, writes the `wallet_signins` trail row, and establishes
   a Supabase session for the linked user (admin `generateLink` -> token_hash
   -> client `verifyOtp`). If the wallet is red (`wallet_is_red`) the login
   still succeeds, but the response carries a `red` flag so the UI can surface
   the sweep/readiness guidance — guidance, not a block.

The wallet half of this is **already built and gated** (see "Status").

## Data foundation — migration `023_wallet_signin_readiness.sql`

- `wallet_identities` — one wallet bound to one user; carries `readiness`
  (`green`/`red`) + reason + who set it.
- `wallet_signin_challenges` — server-minted single-use challenges by nonce;
  never client-readable (the verifier must hold its own copy).
- `wallet_signins` — append-only "same wallet as last time" login trail.
- `member_flags` — append-only green/red history: who flagged/cleared whom,
  on which vault, why.
- `wallet_is_red(user)` — the helper the login + participation gates call.

RLS: writes go through Netlify functions (service_role); reads are self +
shared-vault co-members so the peer group can see each other's readiness.

## Status

**Done + gated (on the working branch, not main):**

- `tapit-attest`: `Wallet.signIn(challenge)` added to the shared library,
  byte-identical and green in both repos (slice 1).
- tapit-wallet: a `sign-in` intent in the inter-app pathway — approval screen,
  parse, approve, render, tests — typecheck/lint/791 tests/build all green
  (slice 2).
- DynastyTrust: this migration + this spec.

**Next cuts (the money-touching DynastyTrust batch):**

1. **Wire `tapit-attest` into the Netlify functions.** The verify step needs
   `verifySignIn` server-side. DynastyTrust's functions don't yet depend on
   `tapit-attest`; add it (`file:./tapit-attest`, now standardized + current)
   so the bundler can resolve it. This is the one real integration wrinkle.
2. **`wallet-signin-challenge` function** — mint + store a challenge.
3. **`wallet-signin-verify` function** — `verifySignIn` vs the stored
   challenge, red check, write the trail, mint a Supabase session.
4. **Bind UI + Auth button + callback route** in `apps/web` — "Sign in with
   Tapit," and a "link your wallet" surface for a logged-in user.
5. **Green/red UI** — set/clear a peer flag, show each member's state in the
   vault; the readiness checklist.
6. **The guidance surface (NOT a gate)** — when a wallet is red, the app
   surfaces the sweep/readiness flow. There is **no** hard block on login,
   signing, or quorum, and **base spend is never gated.** `wallet_is_red` is
   read by the UI to decide whether to show the guidance, not by `requireUser`
   or `proposals.js` to refuse anything.
7. **The sweep flow** — when a member goes red, surface the sweep-to-clean
   recovery path and the "get your people green" checklist.
8. **Tests** — the verify path and session-mint are money-touching; they ship
   with tests against real auth flows. No greenwashing.

## Decisions on record

- Sign-in model: **link to existing account** (keep email login; bind the key).
- Red enforcement: **guidance only** — surface the sweep + readiness checklist
  when a wallet is flagged. No hard block on login, signing, or quorum; base
  spend never gated. (Corrected 2026-06-24 from an earlier too-aggressive
  "fullest" reading; the operator chose only "guide the sweep" on the
  click-all-that-apply switches.)
- Source of truth for the crypto: the standardized `tapit-attest` (canonical in
  tapit-wallet, byte-identical in DynastyTrust; see
  `tapit-attest/STANDARDIZATION.md`). Never re-implement the verify.
