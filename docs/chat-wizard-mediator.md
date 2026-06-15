# Chat Wizard / Mediator -- design note + carpenter handoff

Status: design note. Not implemented. This is the spec the next carpenter
picks up. Read it top to bottom before writing a line; the safety rails in
section 3 are non-negotiable and define the whole shape.

Branch this work was scoped on: `claude/dynasty-trust-chat-wizard-ko6a2r`.

---

## 1. Why this exists

DynastyTrust already does the hard cryptographic part well: it compiles a
three-path Taproot vault (founders-now, recovery, inheritance) and signs PSBTs
browser-first with keys that never leave the device. But the Policy Builder
assumes the person sitting in front of it already understands founder quorums,
heir quorums, absolute CLTV timelock windows in blocks, key origins, and the
difference between the recovery path and the inheritance path. That is
expert-level knowledge.

A family that wants to be sovereign with a couple hundred thousand dollars --
not millions, not a dedicated Bitcoin operator -- cannot get there by staring
at those fields. The operator cannot sit with each family. So the gap is a
human one, not a cryptographic one: somebody has to walk a frightened,
non-expert family through what they are locking away, why the vault is shaped
the way it is, and where their redundancy lives -- and re-verify every
consequential value before anything is compiled or funded.

The wizard is that somebody. It is the bridge between the power already built
and the people who cannot currently reach it. It is the friendly,
knowledgeable self-custody hand who is glad you came, meets you where you are,
and never leaves you in the dark.

A Bitcoiner who already knows the mechanics can click straight through and use
the app exactly as it works today. The hand-holding is an *option*, never a
wall.

---

## 2. What it is

A warm, reassuring, persistent conversational mediator -- working name
**Counsel** (final name TBD: "the Counsel", "the Protector's desk", "your
sovereign guide"). It introduces itself on first contact:

> "Nice to meet you. I am not here to do this for you -- I am here so you
> understand exactly what you are building and why. We are going to learn the
> weaknesses of self custody together and stitch them up, and we are going to
> verify everything, never just take a word for it. Take as long as you need."

It is not a chat box bolted onto a page. It is a persona with three properties
that make it worth building:

1. **Memory.** It remembers who you are, what role you hold, what you have
   already done, where you are in the process, and what your next step is.
2. **Context.** It has the full picture -- your vault, your keys, your
   attestations, the trust document -- so it can answer a question about *your*
   situation the way a generic chatbot with no context never could.
3. **A conscience.** Its own guardrails are part of the lesson it teaches. It
   actively protects you from itself (see section 3).

---

## 3. The safety rails -- the spine, non-negotiable

These are what make the feature safe enough to ship in a money-touching,
irreversible context. A vault compiled wrong is permanently broken vs. Nunchuk
and immutable (see CLAUDE.md "Nunchuk key-material parity"). A confident wrong
answer from a chatty helper is the failure mode that loses an inheritance.
Every rail below exists to defuse that.

1. **No authority, ever.** The assistant can read, teach, remind, and draft. It
   **cannot** move money, cannot hold or request a key, cannot sign, cannot
   compile-and-fund on its own. It proposes; the human disposes.

2. **Tap-to-confirm on every consequential value.** Keys, quorums, timelock
   windows, network, address type, destination addresses, amounts. The wizard
   shows the value back in plain language and the user explicitly confirms it
   before it is committed. The user verifies; they do not take the wizard's
   word. This is the same discipline a careful Bitcoiner applies to their own
   work, taught by example.

3. **Never touches secrets.** Keys and mnemonics are generated and stored in
   the browser (`lib/keystore.ts`) and that does not change. The wizard runs
   server-side (AI calls are server-side only, per stack rules) and is given
   only public, safe material: xpubs, pubkey hex, vault metadata, role, the
   trust doc. No private key, mnemonic, or password is ever in the wizard's
   context, ever logged, ever sent to the model provider.

4. **It protects you from itself.** A core scripted behavior: the wizard is the
   voice that says "I will never ask you for your keys, and neither should
   anyone else." The only time a secret is ever split is Shamir secret sharing,
   and when that comes up the wizard teaches the full checks and balances
   before anything happens -- it never normalizes handing key material to a
   person, an institution, or the bot. Refusing to handle keys is a feature, not
   a bug, and the wizard says so out loud as a teaching moment.

5. **Honest about uncertainty.** On anything legal or tax-shaped it gives
   grounded guidance about how *this vault* behaves and what *this trust doc*
   says, and it defers clearly where a real attorney is required. It never
   dresses probability up as a guarantee.

If a future change would give the wizard any spend authority, key access, or
the ability to skip a tap-to-confirm, that change is wrong. Stop and re-read
this section.

---

## 4. Two speeds

Same engine, two modes, chosen by the user (and re-choosable any time):

- **Guided (hand-held).** Plain-language questions, one decision at a time,
  with teaching woven in. "Who are your heirs? How many of you should have to
  agree to move money? How long after you are gone should the children be able
  to reach it?" Each answer maps to a Policy Builder field. The wizard explains
  *why* the question matters before asking it.

- **Express (click-through).** A Bitcoiner who knows the mechanics skips the
  teaching and answers fast, or bypasses the wizard entirely and uses Policy
  Builder as it works today. The wizard never blocks the expert path.

The mode is a presentation dial over one shared flow, not two code paths.
(Mirror the `tapit-attest` tier discipline: if a speed needs its own branch,
that is a bug.)

---

## 5. Persistent memory and the year-later check-in

The wizard keeps a per-user, per-vault state record: identity, role, what has
been completed, the open checklist, and the next step. This is what lets it
behave like a mediator instead of a stateless prompt.

The killer behavior this unlocks: the **year-later check-in**. A user logs back
in having done nothing since setup, and the wizard runs the same checklist a
careful Bitcoiner runs on themselves:

> "It has been a year. If you lost your phone today, could you recover your
> Bitcoin? Let us walk the checklist together. Have you tested a seed restore?
> Is your metal backup still where you put it? Has any trustee gone silent?"

This is the difference between dropping someone at the door with papers to fill
out and actually keeping them safe over time. It plugs into the existing
`/reminders` route (already in `config.ts` `NAV_LINKS`) as the natural surface
for time-based nudges.

Storage: a new Supabase table (RLS-scoped to the user, like every other table),
holding conversation state, the checklist, and next-step pointers. No secrets.
Sketch:

```
assistant_threads
  id, user_id, vault_id (nullable), role, mode (guided|express),
  checklist (jsonb), next_step (text), updated_at

assistant_messages
  id, thread_id, sender (user|wizard), content, created_at
  -- content is plain text; no key material may ever be written here
```

---

## 6. What it teaches

The wizard's real job is not filling fields -- it is teaching the shape of the
user's own risk. The core lesson:

- Every single way to hold Bitcoin has a failure mode. A lost phone, a dead
  trustee, a fire, a forgotten password, a stolen seed.
- You beat each weakness with **redundancy**: keys with different strengths in
  different hands, plus timelocks, so that losing one key is not catastrophic
  and only an asteroid hitting the planet takes your coins.
- The user should understand *where their redundancy lives* and *why the vault
  is shaped that way* -- not as trivia, but so they can act when something goes
  wrong.

This material already exists in the codebase and the wizard should consume it,
not reinvent it: the `VAULT_TEMPLATES` in `PolicyBuilder.tsx` already carry
per-template "what happens if..." playbooks (trustee dies, beneficiary refuses
to cosign, trustees go silent, single device lost) with the outcome and which
path unlocks when. The wizard narrates those playbooks in conversation, tied to
the user's actual chosen template. This is also the on-ramp to the roadmap's
Scenario Playbooks and Role-aware Dashboards (CLAUDE.md "Next roadmap").

---

## 7. Legal-doc / trust-doc Q&A grounded in the real vault

Because the wizard carries the full context -- the vault, the keys, the
attestations, the trust document, and who is expected to do what -- it can
answer a question about a trust document the way a generic chatbot cannot. A
user no longer has to paste a legal document into a context-free model. The
wizard answers according to *how this wallet actually performs* and *what this
trust doc actually says*, mapping the legal clause to the on-chain mechanism
(e.g. "the doc says the heirs inherit after two years; on-chain that is the
inheritance path, which unlocks at block N, about 14 months from now").

Source material: the trust-doc templates on the roadmap (CLAUDE.md "Trust doc
templates"), the `tapit-attest` `trust_doc` / `agreement` attestation kind, and
the vault's stored policy. Still defers to a real attorney on anything that is
genuinely legal advice (rail 5).

---

## 8. Architecture -- where it plugs in

Respect the existing stack. Do not introduce a client-side model call.

```
Browser (React)                     Netlify function (server)         Model
---------------                     -------------------------         -----
ChatWizard panel  --- JWT --->      netlify/functions/assistant.js
  - user messages                     - verify JWT (_auth.js)
  - mode (guided|express)             - load vault + role + trust doc
  - vault_id                            from Supabase (_supabase.js)
  - tap-to-confirm UI                 - assemble SAFE context
                                        (xpubs, pubkey hex, metadata;
                                         NEVER keys/mnemonics)
                                      - call model provider  -------->  (Claude:
                                      - persist thread + checklist        default
                                        to assistant_threads               to the
                  <--- reply --------  - return reply + proposed            latest
  render proposal                       field values (not committed)       Claude
  user taps confirm --------------->  - only on confirm: hand values        model,
                                        to the existing compile /           e.g.
                                        vault-save path                     claude-
                                                                            opus-4-8)
```

Key points for the carpenter:

- **New Netlify function** `assistant.js`, JWT-auth'd via `_auth.js`, Supabase
  via `_supabase.js`. The model API key is a backend env var only, never in the
  Vite bundle.
- **New env var** (backend scope) for the model provider key. Add to the env
  table in CLAUDE.md when wired.
- **Default to the latest Claude model** for the assistant (recommend
  `claude-opus-4-8` for the guided teaching flow; a smaller/faster Claude is
  fine for the year-later checklist). Keep the provider call behind one helper
  so the model id is swappable in one place.
- **Frontend feature**: a `ChatWizard` panel/component plus a thin
  `lib/assistant.ts` client (mirror `lib/api.ts`). Use the design system --
  `<Button>`, `<Input>`/`<Textarea mono>`, `useToast()`, `colors.*` from
  `theme.ts`. No raw markup, no per-page palette (CLAUDE.md code conventions).
- **The wizard proposes field values; it does not commit them.** Commitment
  flows through the *existing* Policy Builder compile + `api.vaults` save path
  after tap-to-confirm, so there is exactly one code path that ever creates a
  vault. Do not let the wizard create a second one.
- **DB migration** adds `assistant_threads` + `assistant_messages` with RLS
  scoped to `user_id`, in `db/migrations/` (next number in sequence).

---

## 9. Tap wallet / tapit-attest integration seam -- PENDING, to be hashed out

The operator is adding the "tap wallet" repo and wants to integrate it as both
a **sign-in** method and a way to do **attestations**. This is not yet decided
-- it is a named seam for the next working session, not a spec. Capture, do not
build, until the operator reconvenes on it.

What we already have to build on:

- `tapit-attest/` is a standalone signed-attestation primitive already in this
  repo (BIP340 Schnorr over secp256k1, same curve DynastyTrust signs with).
  Six attestation kinds (`identity`, `relationship`, `credential`, `prediction`,
  `agreement`, `meta`) across three trust tiers. It was extracted from
  DynastyTrust's governance-attestation layer and is designed to lift into its
  own repo. See `tapit-attest/README.md`.
- The `identity` kind ("who a public key belongs to") is the natural backbone
  for tap-wallet **sign-in**: prove control of a key by signing a challenge
  envelope.
- The `agreement` / `trust_doc` kind is the backbone for **attestations** the
  wizard helps a family produce (proof-of-life, trustee acknowledgement,
  death declaration).

Open questions for the operator session (do not answer alone):

- Does tap-wallet sign-in replace or sit alongside Supabase email/password
  auth? (Likely alongside, as a second factor / sovereign option.)
- Where does the tap-wallet key live relative to the existing browser keystore?
- Does the wizard *orchestrate* attestation ceremonies (walk you through them,
  tap-to-confirm), holding to the no-key-access rail throughout?
- How does this line up with Super Sovereign Mode's local-keypair auth
  (`docs/super-sovereign-mode.md`, step 3) so we build the seam once?

Decision needed before any code. Flag it; do not guess.

---

## 10. Phased delivery -- the first slice

Do not build all of section 2-9 at once. The smallest vertical that proves the
whole vision:

1. **Slice 1 -- guided vault build.** The warm intro, the two-speed choice, and
   a guided conversation that walks a newbie through building ONE vault
   end-to-end, with teaching woven in (consuming the existing template
   playbooks), and tap-to-confirm on every consequential value. Commitment
   flows through the existing compile + save path. Server-side `assistant.js`,
   the `assistant_threads` table, the `ChatWizard` panel. This alone is
   shippable value and proves the spine.

2. **Slice 2 -- persistent memory + year-later check-in.** Persist the
   checklist and next-step; wire the `/reminders` surface to the "if you lost
   your phone today" check-in.

3. **Slice 3 -- trust-doc Q&A.** Ground the wizard in the trust-doc template so
   it answers questions about the user's own document and maps clauses to
   on-chain mechanisms.

4. **Slice 4 -- role-aware mediation.** Beneficiary / trustee / protector /
   successor each get the wizard speaking to their role and their next action
   (feeds the roadmap's Role-aware Dashboards and Event-to-action guides).

5. **Slice 5 -- tap-wallet integration.** Only after section 9 is decided with
   the operator.

Slice 1 is the proof. Everything else grows from its spine.

---

## 11. What this is NOT

- **Not an agent with authority.** It never spends, signs, holds a key, or
  commits a value without a human tap. (Section 3.)
- **Not a replacement for Policy Builder.** The expert path stays exactly as it
  is; the wizard is the friendlier door to the same engine.
- **Not a key holder or key handler.** It never sees a mnemonic or private key.
  Its refusal to is a feature it teaches.
- **Not a lawyer.** It explains how the vault and the trust doc behave and
  defers real legal advice to a real attorney.
- **Not a second vault-creation code path.** Exactly one path compiles and
  saves a vault; the wizard feeds it after tap-to-confirm.

---

## 12. Definition of done for slice 1

- Gates green or honestly UNVERIFIED: `npm run lint`, `npm run typecheck`,
  `npm run build`, `npm test` (CLAUDE.md workflow).
- No private key, mnemonic, or password ever reaches the server or the model
  context. Verified by reading the assembled context, not assumed.
- Every consequential value passes through tap-to-confirm before commit.
- The vault is created through the existing compile + `api.vaults` save path,
  not a new one.
- Design system used throughout; no `alert()`, no hardcoded colors, no
  per-page palette.
