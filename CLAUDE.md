# CLAUDE.md -- DynastyTrust operating doctrine

Read this start to finish before writing a single line of code. This file
is the permanent operating frame for every AI session in this repo. The
rules here override default behavior and habits. Follow them exactly.

---

## 0. What DynastyTrust is, and why it matters

DynastyTrust is family-grade Bitcoin custody treated as a design problem.
Families, trusts, and organizations use it to create Bitcoin vaults with
governed, multi-generational spending policies across multiple signers.
The core value proposition: structured inheritance, recovery, and
governance for Bitcoin, without a custodian holding the keys.

This is not a toy and not an MVP. It is shipped, signet-tested software
that touches real value. The wallets were never the hard part. The hard
part -- the thing this project actually exists to solve -- is the
human-governance-around-multisig layer: Taproot multileaf script trees,
BIP 341 sighash correctness, BIP 371 PSBT taproot fields, descriptor
attestation, role-aware governance for non-technical people, an
air-gapped QR signer that refuses unsafe scripts, an audit story that
holds up to attorney review, and a recovery story that survives a death
in the family. Every line of this codebase should be read with the
understanding that a bug can lose someone's inheritance.

### DynastyTrust's place in the fleet

DynastyTrust is one project in a larger fleet, and it has a specific job
in that fleet: it is the existence proof of a primitive everything else
depends on. DynastyTrust shipped descriptor attestation inside a Taproot
multileaf tree -- a signed claim that anyone can verify without trusting
the person who made it. That signed-attestation-with-independent-
verification pattern is the keystone of a larger network architecture
(working name: the Mycelium) where the same primitive powers peer trust,
identity, and federation between projects.

What this means for you, the session working here:

- DynastyTrust proved the cryptography works in production. The
  attestation/verification layer in this repo (`apps/web/src/lib/attest.ts`
  and the `vault_attestations` table) is a **reference implementation**.
  Other projects will read it to learn the pattern. Treat it with the
  care a reference implementation deserves -- it must be correct,
  legible, and self-documenting.
- The Mycelium is a shared *idea*, never a shared *dependency*.
  DynastyTrust is its own repo and ships on its own. Do not import from,
  reach into, or create a runtime dependency on any sibling project.
  Reference the concept in doctrine and comments; never wire code to it.

---

## 1. PRIME DIRECTIVE -- this is money-touching software

Everything below flows from one fact: code in this repo moves Bitcoin, or
decides who can. A function that "looks right" and passes a glance can
still lose coins. Vibecoded confidence is the enemy here.

**The test loop is sacred.** Nothing is "done" until it is verified.
Verified means exercised -- ideally against real signet sats, at minimum
against the test gates in section 9. A change that compiles is not a
change that works.

**No greenwashing.** Every session ends with an honest status report:
what changed, what was tested, what passed, what failed, what is still
risky. If you did not test something, say so. If you tested it and it
failed, say so. "Should work" is not a status.

**UNVERIFIED is a valid, required state.** If a change cannot be tested
in this environment -- no signet faucet, no hardware signer, no browser
-- you mark it `UNVERIFIED` explicitly and tell the operator what
verification it still needs. You never round `UNVERIFIED` up to "done".
Claiming false completion on money-touching software is the single worst
thing a session can do here.

**Diagnose before you fix.** When something breaks, find the root cause
before changing anything. Read the actual error and line number. Check
section 12 (known issues) and section 5 (crypto danger zones). Do not
patch on top of patches -- if a file has been patched three or more
times for the same class of bug, stop and rewrite it clean.

---

## 2. The Honest Sensor Rule

You are not the UX sensor. You cannot pick up a Coldcard or a Krux and
feel whether the screen is too small. You cannot tell whether a 65-year-
old trustee, scared and grieving, will understand a button labeled
"Initiate recovery path". You cannot scan a QR code with a phone in bad
light. You cannot feel latency.

The operator is the only sensor for all of that. So:

- When a change affects UX, hardware interaction, QR scanning, or
  anything physical, **defer to the operator's testing eyes.** Describe
  what you changed and what they need to look at. Do not declare a UX
  change "working" -- declare it "ready for you to test" and say what to
  check.
- Build the thing so it is *easy* for the operator to test: clear
  states, visible errors, no silent failure paths.
- If you are guessing about human factors, say you are guessing and ask.

This rule is not humility theater. It is an accurate description of the
sensor boundary. Respect it and the operator catches what you cannot.

---

## 3. Chat-reply format -- one continuous prose block

The operator listens to replies via text-to-speech and copies them whole
into other tools. Formatting that looks fine on screen becomes garbage in
that workflow.

**Every chat-surface reply is ONE continuous block of prose.** No
headers. No bullet lists. No numbered lists. No tables. No code blocks
for emphasis. Just sentences and paragraphs, the way you would explain
something out loud to a colleague.

The only exceptions are when the operator *explicitly* asks for
structure ("give me a checklist", "show me a table"), or when you are
quoting a literal command or file path that has to be exact.

This single rule measurably improves session quality. It forces you to
think in arguments and through-lines instead of hiding behind bullet
fragments. Bake it in. It applies to chat replies only -- it does not
apply to the contents of files you write, like this one.

---

## 4. Owner style

The operator wants: direct answers, practical execution, modular code,
diagnosis before fixes, an explicit list of files changed, no fluff, and
no pretend completion. Match that.

- Answer the question that was asked, first, plainly.
- Show your diagnosis before your fix. "Here is what is wrong and why"
  before "here is the change".
- Name every file you changed and what changed in it.
- Make the minimal change. A bug fix does not get surrounding cleanup. A
  one-shot operation does not get a helper. Do not refactor working code
  while fixing a bug. Do not add features nobody asked for.
- Modular, feature-first structure. Small files with clear jobs.
- No filler. No "I hope this helps". No restating the task back.

---

## 5. Crypto correctness discipline -- the danger zones

Bugs in the areas below are not cosmetic. They are financial. Each one
has lost real people real coins in real wallets. When you touch any of
these, slow down, read the relevant spec, and verify against a known-good
vector before you trust your change.

**BIP 341 tapscript sighash assembly** (`apps/web/src/lib/psbt-signer.ts`).
The sighash is a precise byte concatenation: sighash type, transaction
data, the spent-outputs commitment, the tapleaf hash, key version, code
separator position. Get the order or a length prefix wrong and you
produce a valid-looking signature for the wrong message -- the network
rejects it, or worse, it signs something other than what the user saw.
Never edit sighash assembly without checking it against a BIP 341 test
vector.

**PSBT field ordering and BIP 371 taproot fields.** PSBTs are
key-value maps with strict typing. Taproot inputs carry
`PSBT_IN_TAP_KEY_SIG`, `PSBT_IN_TAP_SCRIPT_SIG`, `PSBT_IN_TAP_LEAF_SCRIPT`,
`PSBT_IN_TAP_BIP32_DERIVATION`, `PSBT_IN_TAP_INTERNAL_KEY`,
`PSBT_IN_TAP_MERKLE_ROOT`. A merge or finalize step that drops, reorders,
or duplicates a field produces a PSBT that one wallet accepts and another
rejects. The merge step (`psbt-merge`) and finalize step
(`psbt-finalize`) are where this bites.

**Control-block verification.** Each tapscript leaf spend carries a
control block: leaf version, internal key, and the Merkle path proving
the leaf is in the tree. The Krux signer (`dynastytrust-krux/`) and the
finalizer both depend on the control block being correct. A wrong Merkle
path means an unspendable output -- coins locked forever.

**Stored timelock heights.** See section 6. Timelocks are absolute block
heights baked into the script at compile time. A wrong height locks funds
until a height that is already in the past (instant unlock -- a security
hole) or centuries in the future (coins gone). The single most expensive
class of bug in this repo.

**Descriptor compilation** (`protocol/src/policy_compiler.rs`,
`compiler/`). The descriptor *is* the wallet. If the compiled descriptor
disagrees with what the UI shows, or with what a hardware wallet derives,
the user funds an address they cannot spend from. The Nunchuk key-origin
parity work (section 10) exists because of exactly this.

The discipline that catches these: derive from the spec, not from
memory. Use known-good test vectors. Round-trip every change (compile,
then parse back, then compare). Cross-check against an independent
implementation -- rust-miniscript, or a real hardware wallet -- before
calling it verified. When in doubt, mark it `UNVERIFIED` and tell the
operator what hardware test it needs.

---

## 6. Architecture invariants -- never break these

### Timelocks are absolute CLTV (`after(N)`), not relative CSV

Miniscript's `after(N)` compiles to `OP_CHECKLOCKTIMEVERIFY` -- an
**absolute** block height. `older(N)` is CSV (relative to UTXO age) but
BIP 68 caps CSV at 65,535 blocks (~15 months), which cannot express the
2-5 year inheritance windows DynastyTrust needs. DynastyTrust uses
`after()` for every timelock leaf, matching Liana.

**Crucial:** callers pass *relative offsets* ("6 months = 26,280
blocks"). The Netlify `compile.js` / `vaults-compile.js` functions fetch
the current chain tip from mempool.space and forward **`tip + offset`**
to the Fly compiler. The leaf then bakes in a specific absolute block
height. Without the tip addition, a leaf's `after(26280)` compiles to
`OP_CLTV` at height 26,280 -- long past on any live network -- so every
timelock path unlocks the moment the vault is funded. This is the timelock
danger zone from section 5 made concrete.

`vaults.recovery_after`, `inheritance_after`, and `protector_after` store
the resulting **absolute block height**. The UI subtracts the current tip
to display "unlocks in ~Y months".

Spending a timelocked path requires `tx.lock_time = N`. `psbt-binary`
accepts a `path` field (`founders_now` | `recovery` | `inheritance` |
`protector`) and sets `lock_time` accordingly.

Tranche (T-vesting) wallets are absolute by design -- `unlock_block` is
set directly from the ceremony UI, no tip math.

### Address type: always `tr_multileaf`

Default address type is `tr_multileaf`. Never use `tr` (single-leaf) as
the default -- it causes `DuplicatePubKeys` errors because founder keys
appear in both the founders-now path and the recovery path within one
Miniscript expression. `tr_multileaf` puts each spending path in its own
Taproot leaf, which Miniscript allows. The internal key is an unspendable
BIP 341 NUMS point, so the only way to spend is through a script leaf.

### The three (or four) spending paths

Every vault compiles these paths into a Taproot script tree:

- **Path 1 -- Founders now**: `thresh(Q, founder_keys)` -- immediate.
- **Path 2 -- Recovery**: `and(after(R), thresh(Q_r, founder_keys))` --
  timelocked. `recovery_quorum` may differ from the founder quorum (e.g.
  3-of-3 now, 2-of-3 after the recovery delay, as lost-device insurance).
- **Path 3 -- Inheritance**: `and(after(I), thresh(Q_h, heir_keys))` --
  timelocked, heir keys.
- **Path 4 -- Protector** (optional): `and(after(P), thresh(Q_p,
  protector_keys))` -- an independent party (often a trust lawyer),
  timelocked typically between recovery and inheritance.

### Keys never leave the browser

Private keys and mnemonics are generated and stored in `localStorage`
only. Only xpubs and pubkey hex (public, safe) are ever sent to the
server or the Fly compiler. `apps/web/src/lib/keystore.ts` is the single
source of truth for key material. Seeds and private keys are never
logged, never committed, never echoed into a chat reply, never written to
a file. If you find code that does, that is a security bug -- fix it and
flag it.

### Two key modes

- **Test mode**: mnemonic stored plaintext in `localStorage`, no
  password, instant generation. Never for real funds. `testMnemonic`
  field set, `backedUp: false`.
- **Secure mode**: AES-256-GCM encrypted mnemonic, key derived via
  PBKDF2 (210,000 rounds). `encryptedMnemonic` blob stored, password
  required to decrypt. Test keys upgrade to secure via `secureTestKey()`.

### PSBT signing flow (browser-first)

1. Browser calls `/api/psbt-binary` (Netlify -> Fly.io) to build the PSBT.
2. Browser parses the PSBT in `psbt-signer.ts` -- no server involvement.
3. For each required signer: derive the private key from the mnemonic,
   compute the BIP 341 tapscript sighash, Schnorr-sign via
   `@noble/curves/secp256k1`.
4. Merge signed PSBTs in the browser with `mergePsbts()`.
5. Finalize via `/api/psbt-finalize` (Fly.io).
6. Broadcast directly from the browser to mempool.space.

Air-gapped variant: the PSBT moves to and from a hardware signer as
animated QR (BC-UR), via `PsbtQrDisplay` / `PsbtQrScanner`. The Krux
signer (section 7) is the reference air-gapped device.

### Networks

`testnet`, `signet`, and `mainnet` are all supported. Signet is the
primary verification network -- "signet-tested" is the bar. xpub version
bytes and address prefixes differ per network; `attest.ts` and the
compiler both branch on it. Never hardcode a network.

### Routing (react-router-dom v7)

Unauthenticated: `/` renders `Landing`, `/invite/:token` renders
`InviteClaim`, everything else redirects. Authenticated subtree (wrapped
in `<RequireAuth>`, which handles session loading, the redirect to
`<Auth />`, and `repairPubkeys()` on boot):

| Path                                      | Component        |
|-------------------------------------------|------------------|
| `/`                                       | redirect `/keys` |
| `/keys`                                   | `KeyManager`     |
| `/policy`                                 | `PolicyBuilder`  |
| `/vaults`                                 | `Dashboard`      |
| `/vaults/:id`                             | `VaultDetail`    |
| `/vaults/:vaultId/proposals/:proposalId`  | `ProposalDetail` |
| `/reminders`                              | `Reminders`      |
| `*`                                       | redirect `/keys` |

`Dashboard` and `PolicyBuilder` push to `/vaults/:id` with
`state: { vault }` so `VaultDetail` hydrates instantly. On hard refresh
`VaultDetail` falls back to fetching the vault list and finding by id.

---

## 7. The attestation / verification layer -- the reference primitive

This is the part of DynastyTrust the wider fleet learns from. Understand
it before you touch it.

A DynastyTrust attestation is a Schnorr signature over a domain-separated
digest, made by a member's Bitcoin key, that asserts a specific claim and
can be verified by anyone without trusting the server, the database, or
the person who made it. The implementation is `apps/web/src/lib/attest.ts`;
storage is the `vault_attestations` table; the transport is
`netlify/functions/vault-attestations.js`.

How it works, precisely. The member's Bitcoin signing key is the same
`/0/0` child that signs PSBTs, so the attestation pubkey matches
`vault_members.pubkey`. The signed digest is
`SHA256("DT-ATT-v1" || attestation_type || 0x00 || target_hash)`. The
`"DT-ATT-v1"` tag plus the attestation type is **domain separation**: it
guarantees a governance signature can never be replayed as a Bitcoin
transaction sighash, and vice versa. The same key serves both roles
safely because the messages it signs live in disjoint domains. The
`target_hash` is a 32-byte SHA-256 the browser computes for the specific
claim. Verification (`verifyAttestation`) runs entirely client-side -- it
needs only the type, the target hash, the signature, and the pubkey.

Four attestation types ship today: `trust_doc` (a member ratifies the
current trust document, hashed with sorted-key canonical JSON),
`proof_of_life` (a member checks in at a timestamp), `death_declaration`
(a member declares a subject deceased as of a date), and `descriptor` (a
member binds their key to the vault's compiled descriptor and address).

Why `descriptor` attestation matters most. Its `target_hash` covers the
descriptor string *and* the address it derives to. If an attacker
breaches the database and swaps the vault's address, the descriptor digest
changes, every prior attestation stops verifying, the UI shows "0 of N
attested", and members refuse to sign until they re-attest -- which, if
the change is legitimate, they do after verifying it themselves. This is
the keystone: a signed claim that anyone can independently verify, that
fails loud when the thing it points at is tampered with. That is the
primitive the Mycelium is built on.

Discipline when working here. Keep verification client-side and
trustless -- the server currently gates writes with RLS plus a membership
check and does **not** cryptographically verify signatures on write
(a documented, deliberate gap; for court-grade export, add a
secp256k1 schnorr-verify step server-side). Never break domain
separation -- the tag and the `0x00` separator are load-bearing. Keep
`canonicalJson` stable; if hashing of a structured claim changes, every
old attestation silently invalidates. Treat this file as a reference
implementation: correct, legible, commented where the *why* is
non-obvious.

### The Krux air-gapped signer (`dynastytrust-krux/`)

A separate, self-contained subproject: a narrow-scope Taproot
trust-policy signing extension for the Krux air-gapped hardware signer
(Python, runs on K210 hardware). It turns a general-purpose signer into a
safety-first, template-driven one -- a Krux running this extension
**refuses to sign any PSBT whose tap-script tree is not one of five
approved DynastyTrust templates** (Normal, Recovery, Inheritance,
Protector, Consent). Every other shape is rejected by design.

Phases 1-3 are complete: templates, policy guard, allowlist, descriptor
hash, PSBT adapter, timelock formatter, on-device UI screens, firmware
integration patches. 90 of 90 tests pass (`pytest` from the
`dynastytrust-krux/` directory). The remaining work is fork-side: clone
Krux `v26.03.0`, apply `firmware/INTEGRATION.md`, build, and run on real
K210 hardware -- which is `UNVERIFIED` until someone does it on a device.
This subproject has its own README and its own test suite; it is not part
of the npm workspace.

---

## 8. Stack and repo map

```
Monorepo root (npm workspaces: apps/*, packages/*)
|-- apps/web/                        React 19 + TypeScript + Vite 7
|   `-- src/
|       |-- main.tsx                 Mounts ToastProvider + App
|       |-- App.tsx                  Router: public + authed route trees
|       |-- config.ts                APP_NAME, NAV_LINKS, explorer helpers
|       |-- theme.ts                 colors / fonts / radii / space (JS tokens)
|       |-- styles/core.css          Same tokens as CSS custom properties
|       |-- components/
|       |   |-- Layout, PageHeader, LoadingScreen, ErrorBoundary
|       |   |-- RequireAuth          Session guard + repairPubkeys()
|       |   |-- KeyCard, TrustTab, RemindersBanner
|       |   |-- DescriptorQr, QrImage, QrScanner
|       |   |-- PsbtQrDisplay, PsbtQrScanner   Air-gapped PSBT transport
|       |   |-- ui/                  Button, Input, Label, Card, Field
|       |   `-- toast/               ToastProvider + useToast()
|       |-- lib/
|       |   |-- supabase.ts          Supabase client
|       |   |-- api.ts / lib/api.ts  Unified API client, JWT-bearer auth
|       |   |-- keystore.ts          Browser key manager (localStorage)
|       |   |-- psbt-signer.ts       BIP 341 sighash + Schnorr signing
|       |   |-- psbt-format.ts       PSBT parse / serialize helpers
|       |   |-- attest.ts            Schnorr governance attestations
|       |   |-- descriptor-backup.ts Descriptor export / restore
|       |   |-- messaging.ts         End-to-end encrypted member messaging
|       |   |-- realtime.ts          Supabase Realtime subscriptions
|       |   |-- chain.ts / xpub.ts   Chain tip + xpub helpers
|       `-- pages/
|           Auth, Landing, InviteClaim, KeyManager, Keyring,
|           PolicyBuilder, Dashboard, VaultDetail, ProposalDetail, Reminders
|-- netlify/functions/               Serverless backend (Node ESM, ~35 fns)
|   |-- compile.js / vaults-compile.js / compile-tranche.js
|   |-- vaults.js / vaults_compiled.js / vaults-rotate.js
|   |-- proposals.js / proposals-mine.js / proposal-comments.js
|   |-- psbt.js / psbt-binary.js / psbt-merge.js / psbt-finalize.js
|   |-- members.js / invites.js / invites-claim.js / invites-lookup.js
|   |-- vault-attestations.js        Signed governance attestations
|   |-- vault-messages.js            E2E encrypted messaging transport
|   |-- vault-requests.js / vault-events.js / vault-activity-export.js
|   |-- stipends.js / distribution-wallets.js
|   |-- vault-pdf.js / vault-audit-pdf.js / vault-tax-summary.js
|   |-- balance.js / utxos.js / governance.js / health.js / me.js
|   |-- signer-sessions.js
|   `-- _auth.js / _supabase.js / _chain.js / _xpub.js   (shared helpers)
|-- compiler/src/main.rs             Rust HTTP service (Axum, Fly.io)
|-- protocol/src/                    Rust library
|   |-- policy_compiler.rs           Miniscript multileaf compilation
|   |-- psbt_builder.rs              PSBT construction + coin selection
|   `-- governance.rs                Spend-path evaluation engine
|-- packages/policy-engine/          Shared TS policy validation
|-- dynastytrust-krux/               Air-gapped Krux signer (Python, own tests)
|-- db/migrations/                   Supabase SQL, 001..021, run in order
|-- docs/                            Manifesto, legal framework, ToS, etc.
`-- scripts/test-policy.mjs          Policy-engine test runner (npm test)
```

**Deployments:** frontend + functions on Netlify (`dynastytrust.family`);
Rust compiler on Fly.io (`dynastytrust-compiler.fly.dev`); database on
Supabase; Bitcoin block / fee / broadcast via mempool.space.

**Required env vars:**

| Scope    | Variable                    | Notes                                   |
|----------|-----------------------------|-----------------------------------------|
| Frontend | `VITE_SUPABASE_URL`         | Baked into the Vite bundle at build     |
| Frontend | `VITE_SUPABASE_ANON_KEY`    | Baked into the Vite bundle at build     |
| Backend  | `SUPABASE_URL`              | Netlify function runtime                |
| Backend  | `SUPABASE_SERVICE_ROLE_KEY` | Netlify function runtime                |
| Backend  | `COMPILER_URL`              | `https://dynastytrust-compiler.fly.dev` |
| Backend  | `COMPILER_SECRET`           | Must match the Fly.io secret exactly    |

**Fly.io compiler endpoints** (all require
`Authorization: Bearer <COMPILER_SECRET>`; the machine spins down when
idle and cold-starts in ~2-3s):

```
GET  /health             Service health check
POST /compile            Compile Miniscript policy -> descriptor + address
POST /psbt-binary        Build unsigned PSBT from vault + UTXOs
POST /psbt-merge         Merge partially-signed PSBTs
POST /psbt-finalize      Finalize signed PSBT -> raw tx hex
POST /governance/status  Active spending paths at the current block height
POST /governance/audit   Audit a proposed spend for policy compliance
```

---

## 9. Workflow and test gates

We push directly to feature branches on `stackingunderpressure/dynastytrust`.
The active branch convention is `claude/<topic>-<id>`. PRs are not opened
automatically -- ask first.

Before pushing, run the gates from the repo root (each proxies into the
`apps/web` workspace):

```
npm run lint        # eslint -- 0 errors required, warnings allowed
npm run typecheck   # tsc --noEmit -- pre-existing keystore/psbt-signer errors
npm run build       # vite build -- must succeed
npm test            # node scripts/test-policy.mjs -- policy-engine tests
```

For the Krux subproject, `pytest` from `dynastytrust-krux/` (90 tests).
For the Rust crates, `cargo test` and the `protocol/examples/*` round-trip
checks.

These gates are the *floor*, not the ceiling. They prove the code
compiles and the policy engine is internally consistent. They do **not**
prove a vault is spendable, a signature is valid on-chain, or a hardware
wallet will import the descriptor. Real verification for money-touching
changes is a signet round-trip: compile a vault, fund the address, build
a PSBT, sign it, broadcast it, watch it confirm. If you cannot do that in
this environment, the change is `UNVERIFIED` -- say so, and tell the
operator exactly what signet or hardware test closes the gap.

Commits are atomic and self-describing. One commit per unit of work.

---

## 10. Code conventions

### Use the design system, not raw markup

| Don't                                    | Do                                          |
|-------------------------------------------|---------------------------------------------|
| `alert("...")`                            | `useToast().error(...) / .success(...)`     |
| Hardcoded `#C9A84C`                       | `colors.gold` (from `theme.ts`)             |
| Inline `<button style={{...}}>`           | `<Button variant="primary|ghost|danger">`   |
| Inline `<input style={{...}}>`            | `<Input>` / `<Input mono>` for hex/PSBT     |
| Inline `<label style={{...}}>`            | `<Label>`                                   |
| Raw `<textarea>`                          | `<Textarea mono>`                           |
| Per-page palette `const C = {...}`        | Import `colors`, `fonts`, `radii`, `space`  |
| `'DYNASTYTRUST'` literal                  | `APP_NAME` from `config.ts`                 |
| `'https://mempool.space/tx/' + txid`      | `explorerTxUrl(network, txid)` from config  |
| Tab state for navigation                  | `<NavLink>` + `useNavigate()`               |

`<select>` is the one HTML control without a primitive -- use the local
`selectStyle` pattern (PolicyBuilder is the canonical example).

### JSX hazards -- characters that break esbuild

Invalid inside JSX text content (between tags):

- `>` closes the parent tag. Use `&gt;` or reword.
- `<` opens a new tag. Use `&lt;` or reword.
- `->` -- the `>` breaks parsing. Use `=>`, `to`, or `--`.

These are fine inside JS string and template literals. Only forbidden in
raw JSX text.

### ASCII only in source

No box-drawing characters in code or comments. No curly quotes, no em or
en dashes -- use `--` for em-dash, `-` for en-dash. Emoji is fine in JSX
text, JS string literals, and comments, but only if the operator asks.

### Browser-only crypto

- Hex encoding:
  `Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')`
  -- never `Buffer.from()` (Node-only, breaks in the browser bundle).
- Randomness: `crypto.getRandomValues()` -- never `Math.random()` for
  anything cryptographic.

### TypeScript patterns

- External API responses are typed `unknown` and narrowed before use.
- Async errors:
  `catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }`.
- Dropping props because of routing? Replace with `useNavigate` /
  `useParams` / `useLocation`, not threaded optional callbacks.

### Comments

Default to no comments. Add one only when the *why* is non-obvious -- a
hidden invariant, a spec requirement, a workaround for a specific bug.
The crypto files (`attest.ts`, `psbt-signer.ts`, `policy_compiler.rs`)
are the exception: there, comments that explain *why* a byte order or a
domain tag is the way it is are load-bearing. Keep them.

### Nunchuk / Sparrow / Coldcard key-material parity

Target hardware-wallet compatibility is real and fragile. Two rules that
exist because breaking them produced unspendable vaults:

- Descriptors use key-origin form: `pk([fp/path]xpub/0/*)`.
  `upgradeDescriptor` and `buildKeyOrigins` run right after
  `api.compile()` returns. Master fingerprint is used when the keystore
  has it, with a fall back to the child fingerprint.
- Every pubkey sent to the compiler is the `xpub/0/0` child (first
  receive-chain key), not the account-level pubkey, so the compiler's
  address and the wildcard descriptor's first address agree. `psbt-signer`
  signs with the `/0/0` child to match the leaf script. Fingerprints are
  BIP 32 standard (`HASH160(pub)[0..4]`).

**Any vault compiled before this parity fix is permanently broken versus
Nunchuk** -- the descriptor/address pair was wrong and is immutable.
Recompile from a fresh draft; do not try to migrate it.

---

## 11. Supabase schema

RLS is enabled on every table -- users only ever reach their own data.
Run migrations `001` through `021` in order. Selected key tables:

```
vaults            id, user_id, name, network, address, descriptor,
                  miniscript_policy, address_type, founder_quorum,
                  recovery_quorum, heir_quorum, recovery_after,
                  inheritance_after, protector_after, founder_keys,
                  heir_keys, protector_keys, archived, predecessor_id,
                  created_at, updated_at
vault_members     id, vault_id, user_id, role, status, pubkey,
                  key fingerprint / origin material
vault_invites     id, vault_id, token, role, status, ...
proposals         id, vault_id, path, destination, amount_sats, fee_sats,
                  status, psbt_hex, psbt_b64, txid, memo,
                  governance_audit, per-signer state, created_at
proposal_comments id, proposal_id, user_id, body, created_at
signer_sessions   id, proposal_id, signer_fingerprint, signed_at,
                  psbt_partial_hex
vault_events      id, vault_id, event_type, data, block_height, created_at
vault_attestations id, vault_id, user_id, attestation_type, target_hash,
                  target_data, signature, pubkey, signed_at
trust documents, beneficiaries / requests, scheduled stipends,
distribution wallets, trust consent, e2e messaging -- see migrations
008, 011, 013, 014, 015, 019.
```

Multi-member vaults are shipped: a vault has many `vault_members` with
distinct roles, invites flow through `vault_invites`, and proposals carry
per-signer signing state. The schema is no longer single-user.

---

## 12. Known issues and lessons learned

| Issue                                     | Cause                                          | Fix                                                  |
|--------------------------------------------|------------------------------------------------|------------------------------------------------------|
| `DuplicatePubKeys` on compile              | Using `tr` instead of `tr_multileaf`           | Default to `tr_multileaf`                            |
| `pubkey hex should be 66 digits, got 111`  | Sent an xpub string instead of pubkey hex      | Use `toPubkeyHex()` in PolicyBuilder                 |
| `This key is not a signer for any input`   | Keys regenerated after the vault compiled      | Delete keys, regenerate, recompile the vault         |
| Non-JSON from the compiler                 | `COMPILER_SECRET` mismatch Netlify vs Fly.io   | Make both env vars match exactly                     |
| `Buffer is not defined`                    | Node `Buffer` used in browser code             | Use `Array.from().map()` hex encoding                |
| PSBT signing `wrong private key format`    | `HDKey` not configured with HMAC               | Wire `HDKey.utils` with `@noble/hashes/hmac`         |
| `JSX > is not valid` build failure         | Bare `>` or `->` inside JSX text               | Use `&gt;`, `=>`, `--`, or reword                    |
| Timelock path unlocks at funding           | Forgot `tip + offset`; baked a past height     | Add the chain tip in `compile.js` before forwarding  |
| Vite build ignores TS errors               | esbuild is permissive; `tsc` enforces          | Run `npm run typecheck` before every push            |
| Dead helpers flagged by lint               | Code written ahead of a caller                 | Do not restore until there is a caller; document gap |

---

## 13. Current state -- shipped, fragile, unverified

**Shipped and working:**

- Auth via Supabase email/password with signup confirmation.
- Key Manager: generate test/secure keys, backup-with-verify, archive,
  delete, edit, import/export keyring JSON, persona grouping.
- Policy Builder: compile a vault via the Fly.io compiler, copy
  descriptor / Miniscript / address / BSMS export, save to Supabase.
- Dashboard: vault list with live BTC balance and USD value, search,
  archive toggle, rename, deep links.
- Vault Detail: overview, send flow with PSBT build, browser signing,
  broadcast to mempool.space, proposal history.
- Multi-member vaults: invites, role-aware invite claim wizard, five
  roles (owner, trustee, protector, beneficiary, successor),
  `vault_members` with per-role views, proposal comments.
- Descriptor + governance attestations (`attest.ts`,
  `vault_attestations`): trust-doc, proof-of-life, death-declaration,
  descriptor binding -- with client-side verification.
- Air-gapped QR PSBT transport (BC-UR animated QR).
- End-to-end encrypted member messaging (migration 019, `messaging.ts`).
- Krux signer Phases 1-3: 90/90 tests passing in `dynastytrust-krux/`.
- Protector path, recovery quorum, scheduled stipends, distribution
  wallets, signet support, audit/tax PDF export functions.

**Fragile -- handle with care:**

- `lib/keystore.ts`: strict TS errors around
  `Uint8Array<ArrayBufferLike>` variance. Build passes (esbuild is
  tolerant); `tsc --noEmit` complains. Pre-existing.
- `lib/psbt-signer.ts`: `HDKey.utils` typed as missing. Pre-existing.
- A few intentional lint warnings (react-refresh in `ToastProvider.tsx`;
  occasionally unused locals in `VaultDetail.tsx`).
- `vault-attestations.js` does not cryptographically verify signatures on
  write -- deliberate, documented; add server-side schnorr-verify before
  any court-grade export feature.
- Vaults compiled before the Nunchuk key-material parity fix are
  permanently broken versus Nunchuk and must be recompiled fresh.

**Unverified -- needs real-world testing:**

- The Krux trust-mode firmware on real K210 hardware. Tests pass in
  simulation; the on-device build (clone Krux `v26.03.0`, apply
  `firmware/INTEGRATION.md`) has not been exercised on a physical signer.
- End-to-end testnet/signet spend with real independent signers across
  separate accounts.
- Hardware-wallet signing round-trips (Coldcard PSBT export/import,
  Sparrow descriptor import) against live vaults.

**Dependency pins (no CVE pressure -- upgrade when a feature needs it):**
Rust `bitcoin = 0.31.2` (0.32.x is current), `miniscript = 11.2.3`
(13.0.0 is current). Browser `@scure/bip32 = 1.7.0`, `@scure/bip39 =
1.6.0`, `@noble/curves = 1.9.x`, `@noble/hashes = 1.x` -- v2 lines exist.
Each upgrade is breaking-change work; cheapest order is browser libs
first, then `bitcoin` 0.31 -> 0.32, then `miniscript` 11 -> 13.

**Roadmap (trust / governance layer is the priority, not wallet
features):** per-template scenario playbooks ("what happens if a trustee
dies / goes silent / the protector steps in"), trust-doc templates per
vault type, role-aware dashboards (beneficiary, trustee, protector,
successor each see their own view), event-to-action guides, and an
attorney-grade audit-trail PDF tying every event to a trust-doc clause.
Wallet primitives are deliberately deferred -- if BDK-grade features are
ever needed (Esplora sync, fee bumping, CPFP, native HWI), embed BDK
(MIT/Apache) via WASM; do not fork Liana (AGPL-3.0 kills commercial
flexibility) and do not rebuild a wallet core from scratch.

---

## 14. What a good response looks like

When making a code change: read the relevant files first; use the design
system before hand-rolling markup; make the minimal change; run lint,
typecheck, build, and the relevant tests; then report -- in one
continuous prose block -- what changed, in which files, what you tested,
what passed, what failed, and what is still `UNVERIFIED`.

When a build fails: read the error line. Check the JSX hazards rule
first. Check the known-issues table. Fix the specific error, then scan
the whole file for the same pattern. Do not patch on top of patches.

When you are unsure: say so. Mark the unknown, name the test that would
resolve it, and defer to the operator for anything physical. On
money-touching software, an honest "UNVERIFIED" is worth more than a
confident "done". Get it right rather than fast.
