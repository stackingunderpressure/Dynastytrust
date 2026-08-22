# CLAUDE.md -- DynastyTrust

Read this before writing any code. Follow every rule here without exception.

---

## Engineering doctrine -- standing orders (read first)

You are the developer on this repo: the executor. The operator owns the WHY;
you cut. Cut like a professional engineer the operator has never seen the likes
of -- one who checks their own work, looks over their own shoulder, never trusts
and always verifies, and grounds every line in the actual code rather than
memory or assumption. This is money-touching, irreversible Bitcoin software; a
confident wrong answer here can lose an inheritance. Hold that weight on every
cut.

### The operator's decision filter (the five flavors)

Resolve any choice with these before asking. If they answer it, proceed.

1. **Make it frictionless.** The surface is the product; a person taps and it
   just works.
2. **Make it secure.** Safe beats fast. Keys never leave the browser
   unencrypted -- that rule outranks every other.
3. **Don't go the easy cheap way.** No shortcut that costs correctness or
   sovereignty. Cheap-and-quick is not a value here.
4. **Don't trust -- verify.** Ground every claim in the source and on-chain
   reality; tap-to-confirm shows the real value; no blind taps, no "it probably
   works."
5. **Build it like Bitcoin would be proud of every step.** Each cut should be
   something a serious Bitcoiner would respect.

### How a professional cuts here (non-negotiable)

- **Ground in the code, never memory.** Read the file before you touch it. Read
  the function before you call it. Verify every assertion against actual source
  and, where relevant, against what Bitcoin actually does. When the task names
  cryptography, timelocks, descriptors, or signing, read the real code first --
  this whole repo's history is bugs that came from assuming.
- **Verify twice; look over your own shoulder.** After a change, re-read it
  against the goal and the rails. Run all four gates -- `npm run lint`,
  `npm run typecheck`, `npm run build`, `npm test` -- and actually read the
  output; never claim green you did not run. Distinguish pre-existing failures
  (document them) from ones you caused (fix them).
- **No shortcuts. No patch-on-patch.** Make the minimal correct change; do not
  add features nobody asked for; do not refactor working code while fixing a
  bug. If a file has been patched three-plus times, rewrite it clean rather than
  stack another patch.
- **Be honest, always.** If tests fail, say so with the output. If a step was
  skipped, say it. Mark anything unverified as unverified. Surface drift and
  mistakes rather than hiding them -- a caught mistake preserved is worth more
  than a clean-looking lie.
- **Security and keys outrank everything.** Private keys and mnemonics never
  leave the browser unencrypted, never reach a server or a model context, never
  get logged or committed. An attestation is never a Bitcoin spend signature.
  When in doubt, the safe reading wins.

### Workflow (quarterback model + build-fee discipline)

All cutting happens on the working branch; nothing auto-pushes to `main`; the
merge to `main` happens only in deliberate operator-driven batches so a Netlify
production build fires once per batch, not once per cut. Routine commits carry
`[skip ci]`. The orchestrating session quarterbacks; a fresh-eyes auditor agent
reviews at phase boundaries. Full detail: `docs/quarterback-workflow.md`.

### Where the architecture and the rails live

- `docs/build-map-and-cut-lists.md` -- the system map across all three repos and
  the per-repo cut lists, plus the **risk register** (section 6) of honest lines
  that never bend.
- `docs/sovereignty-education-bot.md` -- the education-bot vision and the grounded
  design (sections 11-11e: layered UTXO, FROST, FROST resharing, Nostr transport,
  the worked-example vault, Lightning witness payments).
- `docs/quarterback-workflow.md` -- this build's operating agreement.

When this doctrine and any older "direct-to-main" or convenience language
conflict, this section and `docs/quarterback-workflow.md` win on process; the
technical rules below win on implementation.

---

## What this project is

DynastyTrust is a Bitcoin multi-generational vault platform. Families and
organizations use it to create Bitcoin vaults with governed spending policies
across multiple signers. The core value prop: structured inheritance and
recovery for Bitcoin, without custodians.

Every vault has three spending paths compiled into a Taproot script:

- **Path 1 -- Founders now**: `thresh(Q, founder_keys)` -- available immediately
- **Path 2 -- Recovery**: `and(after(R_blocks), thresh(Q, founder_keys))` -- timelock
- **Path 3 -- Inheritance**: `and(after(I_blocks), thresh(Q_h, heir_keys))` -- timelock

Target hardware-wallet compatibility: Nunchuk, Sparrow, Coldcard.

---

## Stack

```
Monorepo root
|-- apps/web/                          React 19 + TypeScript + Vite
|   `-- src/
|       |-- main.tsx                   Mounts ToastProvider + App
|       |-- App.tsx                    BrowserRouter + 5 routes
|       |-- config.ts                  APP_NAME, NAV_LINKS, EXPLORER helpers
|       |-- theme.ts                   colors / fonts / radii / space tokens (JS)
|       |-- styles/
|       |   `-- core.css               Same tokens as CSS custom properties + reset
|       |-- components/
|       |   |-- Layout.tsx             Sticky header + nav + content container
|       |   |-- PageHeader.tsx         Title + subtitle block
|       |   |-- LoadingScreen.tsx      Brand splash
|       |   |-- RequireAuth.tsx        Session guard (loading | Auth | children)
|       |   |-- ui/
|       |   |   |-- Button.tsx         primary | ghost | danger, sizes sm | md
|       |   |   |-- Input.tsx          Input + Textarea, mono prop
|       |   |   |-- Label.tsx          Uppercase gold field caption
|       |   |   |-- Card.tsx           Surface container
|       |   |   |-- Field.tsx          Label + control + hint
|       |   |   `-- index.ts           Barrel export
|       |   `-- toast/
|       |       |-- ToastProvider.tsx  Context + renderer
|       |       `-- index.ts           useToast() hook
|       |-- lib/
|       |   |-- supabase.ts            Supabase client (VITE_SUPABASE_URL/KEY)
|       |   |-- api.ts                 Unified API client, JWT-bearer auth
|       |   |-- keystore.ts            Browser-side key manager (localStorage)
|       |   `-- psbt-signer.ts         BIP341 tapscript sighash + Schnorr signing
|       `-- pages/
|           |-- Auth.tsx               Email/password sign-in/sign-up
|           |-- KeyManager.tsx         Key CRUD (generate, backup, archive)
|           |-- PolicyBuilder.tsx      Vault compiler UI
|           |-- Dashboard.tsx          Vault list with live balances
|           `-- VaultDetail.tsx        Vault detail, send flow, history
|-- netlify/functions/                 Serverless backend (Node ESM)
|   |-- compile.js                     Proxy to Fly.io compiler
|   |-- vaults.js                      Vault CRUD
|   |-- proposals.js                   Spend proposals
|   |-- psbt-binary.js                 Build PSBT
|   |-- psbt-merge.js                  Merge PSBTs
|   |-- psbt-finalize.js               Finalize PSBT
|   |-- balance.js                     mempool.space balance
|   |-- governance.js                  Governance engine proxy
|   |-- vault-pdf.js                   PDF generation
|   |-- _auth.js                       JWT verification helper
|   `-- _supabase.js                   Supabase admin client
|-- compiler/                          Rust HTTP service (Fly.io)
|   `-- src/main.rs                    Axum endpoints
|-- protocol/                          Rust library
|   `-- src/
|       |-- policy_compiler.rs         Miniscript policy compilation
|       |-- psbt_builder.rs            PSBT construction
|       `-- governance.rs              Spend path evaluation
|-- packages/policy-engine/            Shared TS policy validation
|-- supabase/migrations/                Supabase SQL migrations (auto-applied
|                                        on push to main -- see
|                                        .github/workflows/supabase-db-deploy.yml)
`-- scripts/test-policy.mjs            Policy-engine test runner (`npm test`)
```

**Deployments:**
- Frontend + functions: Netlify (`dynastytrust.family`)
- Rust compiler: Fly.io (`dynastytrust-compiler.fly.dev`)
- Database: Supabase
- Bitcoin block / fee / broadcast: mempool.space (testnet + mainnet)

**Required env vars:**

| Scope    | Variable                       | Notes                                          |
|----------|--------------------------------|------------------------------------------------|
| Frontend | `VITE_SUPABASE_URL`            | Embedded into the Vite bundle at build time    |
| Frontend | `VITE_SUPABASE_ANON_KEY`       | Embedded into the Vite bundle at build time    |
| Backend  | `SUPABASE_URL`                 | Netlify function runtime                       |
| Backend  | `SUPABASE_SERVICE_ROLE_KEY`    | Netlify function runtime                       |
| Backend  | `COMPILER_URL`                 | `https://dynastytrust-compiler.fly.dev`        |
| Backend  | `COMPILER_SECRET`              | Must match the Fly.io secret exactly           |

---

## Architecture rules -- never break these

### Timelocks are absolute CLTV (`after(N)`) by default; relative CSV (`older(N)`) is a documented, capped exception

Miniscript's `after(N)` compiles to `OP_CHECKLOCKTIMEVERIFY` —
**absolute** block height, a deadline that never moves regardless
of activity. `older(N)` compiles to `OP_CHECKSEQUENCEVERIFY` —
**relative** to the spent UTXO's confirmation height, and it
resets every time the coin moves. BIP 68 caps CSV at 65,535
blocks (~15 months), which can't express 2-5 year inheritance
windows — so every leaf meant to hold a fixed deadline (recovery,
inheritance, second inheritance) uses `after()`, matching Liana's
design for the same reason.

`older()` is permitted, but only for a short, self-refreshing leaf
where resetting the clock on every spend is the entire point — e.g.
a normal-quorum leaf that relaxes to a lower quorum only if the coin
has sat untouched for N months, so simply moving/consolidating the
coin keeps the vault at its full quorum. `protocol::MAX_RELATIVE_BLOCKS`
(60,000 blocks, ~13.7 months) hard-caps any `OlderThan` leaf, well
inside BIP 68's 65,535-block ceiling, and `verify_leaf_policy` rejects
a leaf policy where a relative leaf is the ONLY non-immediate
fallback — it is a quality-of-life relaxation on an already-adequate
vault, never a substitute for a real recovery/inheritance leaf with a
fixed deadline. This exception exists only on the generic leaf-list
vault path (`LeafPolicy`/`Unlock::OlderThan`/`build_leaf_multileaf`);
the named-field `DynastyPolicy`/`build_multileaf` path never emits
`older()` at all.

**Crucial:** callers pass relative offsets ("6 months = 26,280
blocks"). The Netlify `compile.js` / `vaults-compile.js` fetch
the current chain tip from mempool.space and forward **`tip +
offset`** to the Fly compiler. An `after()` leaf then bakes in a
specific absolute block height. Without the tip addition, the leaf's
`after(26280)` compiles to `OP_CLTV` at height 26,280 (long past
on any live network) → every timelock path unlocks at funding. An
`older()` leaf's block count is a duration, never a height, and is
forwarded unchanged — no tip addition, since BIP68 measures it from
whichever UTXO is actually being spent, not a fixed calendar point.

`vaults.recovery_after / inheritance_after` store the resulting
**absolute block height**. The UI subtracts current tip to show
"unlocks in Y months".

Spending an `after()`-gated leaf requires `tx.lock_time = N`;
spending an `older()`-gated leaf requires `nSequence = N` on every
spending input instead — CLTV and CSV are enforced through two
different transaction fields, never interchangeable, and
`compiler/src/main.rs`'s `psbt_binary` handler sets exactly one of
the two per leaf based on its `Unlock` variant. `psbt-binary`
accepts a `path` field; for the named-field vault it is one of
"founders_now" | "recovery" | "inheritance" | "backup" |
"second_inheritance", and for the generic leaf-list vault it is
any `id` the caller's own `LeafPolicy.leaves` declares.

Tranche (T-vesting) wallets are absolute by design — `unlock_block`
is set directly from the ceremony UI.

### Address type: always `tr_multileaf`

Default address type is `tr_multileaf`. Never use `tr` (single-leaf) as the
default -- it causes `DuplicatePubKeys` errors because founder keys appear in
both the founders-now path and the recovery path in the same Miniscript
expression. `tr_multileaf` puts each path in a separate Taproot leaf, which
Miniscript allows.

### Keys never leave the browser

Private keys and mnemonics are generated and stored in `localStorage` only.
Only xpubs and pubkey hex (public, safe) are ever sent to the server or the
Fly.io compiler. `lib/keystore.ts` is the single source of truth for key
material.

### Two key modes

- **Test mode**: mnemonic stored plaintext in localStorage, no password,
  instant generation. Never for real funds. `testMnemonic` field set,
  `backedUp: false`.
- **Secure mode**: AES-256-GCM encrypted mnemonic via PBKDF2 (210,000 rounds).
  `encryptedMnemonic` blob stored, password required to decrypt. Test keys
  can be upgraded to secure via `secureTestKey()`.

### PSBT signing flow (browser-first)

1. Browser calls `/api/psbt-binary` (Netlify -> Fly.io) to build the PSBT
2. Browser parses PSBT in `psbt-signer.ts` (no server)
3. For each required signer: derive private key from mnemonic, compute
   BIP341 tapscript sighash, Schnorr-sign via `@noble/curves/secp256k1`
4. Merge signed PSBTs in browser using `mergePsbts()`
5. Finalize via `/api/psbt-finalize` (Fly.io)
6. Broadcast directly from the browser to mempool.space

### Routing (react-router-dom)

| Path           | Component       |
|----------------|-----------------|
| `/`            | redirect `/keys`|
| `/keys`        | `KeyManager`    |
| `/policy`      | `PolicyBuilder` |
| `/vaults`      | `Dashboard`     |
| `/vaults/:id`  | `VaultDetail`   |
| `*`            | redirect `/keys`|

`Dashboard` and `PolicyBuilder` push to `/vaults/:id` with `state: { vault }`
so `VaultDetail` hydrates instantly. On hard refresh `VaultDetail` falls back
to fetching `api.vaults.list(false|true)` and finding by id; navigates back to
`/vaults` if not found.

The whole authed subtree is wrapped in `<RequireAuth>`, which handles
session loading, the unauthenticated redirect to `<Auth />`, and
`repairPubkeys()` on boot.

---

## Code conventions

### Use the design system, not raw markup

| Don't                                    | Do                                          |
|------------------------------------------|---------------------------------------------|
| `alert("...")`                           | `useToast().error("...") / .success("...")` |
| Hardcoded `#C9A84C`                      | `colors.gold` (from `theme.ts`)             |
| Inline `<button style={{...}}>`          | `<Button variant="primary|ghost|danger">`   |
| Inline `<input style={{...}}>`           | `<Input>` / `<Input mono>` for hex/PSBT     |
| Inline `<label style={{...}}>`           | `<Label>`                                   |
| `<textarea>` raw                         | `<Textarea mono>`                           |
| Local per-page palette `const C = {...}` | Import `colors`, `fonts`, `radii`, `space`  |
| `'DYNASTYTRUST'` literal                 | `APP_NAME` from `config.ts`                 |
| `'https://mempool.space/tx/' + txid`     | `explorerTxUrl(network, txid)` from config  |
| Tab state for navigation                 | `<NavLink>` + `useNavigate()`               |

`<select>` is the one HTML control without a primitive yet -- use the local
`selectStyle` pattern (see PolicyBuilder for the canonical example).

### JSX hazards -- characters that break esbuild

These are INVALID inside JSX text content (between tags):

- `>` -- closes the parent tag. Use `&gt;` or reword.
- `<` -- opens a new tag. Use `&lt;` or reword.
- `->` -- the `>` breaks parsing. Use `=>`, `to`, or `--` and reword.

These are FINE in JS string literals like `'Compile ->'` or template
literals. Only forbidden in raw JSX text like `<div>Compile -> result</div>`.

### ASCII only in source

- No box-drawing characters (`-`, `|`) in code or comments.
- No curly quotes, no em or en dashes. Use `--` for em-dash, `-` for en-dash.
- Emoji is fine in JSX text, JS string literals, and comments.

### Browser-only crypto

- Hex encoding: `Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')`
  -- never `Buffer.from()` (Node-only).
- Randomness: `crypto.getRandomValues()` -- never `Math.random()` for crypto.

### TypeScript patterns

- External API responses typed as `unknown`, narrowed before use.
- Async errors caught with
  `catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }`.
- Dropping props because of routing? Replace with `useNavigate`/`useParams`/
  `useLocation` rather than threading optional callbacks.

---

## Workflow

We push directly to feature branches on `stackingunderpressure/dynastytrust`.
The active branch convention is `claude/<topic>-<id>`.

Before pushing:

```bash
npm run lint        # eslint -- 0 errors required, warnings allowed
npm run typecheck   # tsc --noEmit -- pre-existing errors in keystore/psbt-signer
npm run build       # vite build -- must succeed
npm test            # node scripts/test-policy.mjs
```

Each script proxies to the workspace via root `package.json`. Run from the
repo root or from `apps/web/`.

Commits are atomic and self-describing. PRs are not opened automatically --
ask before opening one.

---

## Supabase schema

```sql
-- vaults table (key columns)
id, user_id, name, network, address, descriptor, miniscript_policy,
address_type, founder_quorum, heir_quorum, recovery_after, inheritance_after,
founder_keys (jsonb), heir_keys (jsonb), archived, created_at, updated_at

-- proposals table
id, vault_id, path, destination, amount_sats, fee_sats, status,
psbt_hex, psbt_b64, txid, memo, governance_audit, created_at

-- vault_events table
id, vault_id, event_type, data (jsonb), created_at

-- signer_sessions table
id, proposal_id, signer_fingerprint, signed_at, psbt_partial_hex
```

All tables have RLS enabled. Users can only access their own data.
Migrations live in `supabase/migrations/` (CLI-style
`YYYYMMDDHHMMSS_name.sql` filenames) and apply automatically on push to
main via `.github/workflows/supabase-db-deploy.yml` -- see that
workflow's header for the required secrets/variables and the one-time
bootstrap step. Manual SQL-editor pasting is no longer the normal path;
only reach for it if the automated pipeline itself is broken.

---

## Fly.io compiler endpoints

```
GET  /health             Service health check
POST /compile            Compile Miniscript policy -> descriptor + address
POST /psbt-binary        Build unsigned PSBT from vault + UTXOs
POST /psbt-merge         Merge multiple partially-signed PSBTs
POST /psbt-finalize      Finalize signed PSBT -> raw tx hex
POST /governance/status  Get active spending paths at current block height
POST /governance/audit   Audit a proposed spend for policy compliance
```

All endpoints require `Authorization: Bearer <COMPILER_SECRET>`. The compiler
spins down when idle (`auto_stop_machines = "stop"`) and wakes on first
request (~2-3 second cold start).

---

## Known issues and lessons learned

| Issue                                          | Cause                                                        | Fix                                                              |
|------------------------------------------------|--------------------------------------------------------------|------------------------------------------------------------------|
| `DuplicatePubKeys` on compile                  | Using `tr` instead of `tr_multileaf`                         | Default to `tr_multileaf`                                        |
| `pubkey hex should be 66 digits, got 111`      | Sending xpub string instead of pubkey hex                    | Use `toPubkeyHex()` helper in PolicyBuilder                      |
| `This key is not a signer for any input`       | Keys regenerated after vault compiled                        | Delete keys, regenerate, recompile vault                         |
| Non-JSON from compiler                         | `COMPILER_SECRET` mismatch between Netlify and Fly.io        | Ensure both env vars match exactly                               |
| `Buffer is not defined`                        | Used Node `Buffer` in browser code                           | Use `Array.from().map()` for hex encoding                        |
| PSBT signing error `wrong private key format`  | HDKey not configured with HMAC                               | Wire `HDKey.utils` with `@noble/hashes/hmac`                     |
| `JSX > is not valid` build failure             | Bare `>` or `->` inside JSX text                             | Use `&gt;`, `=>`, `--`, or reword                                |
| Vite build ignores TypeScript errors           | esbuild is permissive; tsc enforces                          | Run `npm run typecheck` before push for full safety              |
| Dead helpers flagged by lint                   | Code written for unimplemented features                      | Don't restore until there is a caller. Document the gap instead. |
| Hardware wallet (Nunchuk/Coldcard) won't sign a tapscript spend | PSBT never carried `tap_key_origins` (PSBT_IN_TAP_BIP32_DERIVATION) -- only `tap_internal_key`/`tap_scripts` were attached, so a hardware wallet had no BIP371-compliant way to recognize its own key on a leaf. Compounded by `/psbt-binary` always attaching the founders-now leaf's control block regardless of `path`, so a non-founders spend (recovery/inheritance/protector) had the WRONG leaf attached entirely. | `protocol/src/policy_compiler.rs`'s `MultileafOutput` now exposes every leaf, not just `founder_leaf`; `compiler/src/main.rs` selects the leaf matching `path` and calls the new `attach_tap_key_origins` (in `psbt_builder.rs`) with per-signer `{pubkey, fingerprint, derivation_path}` forwarded from `vault_members` via `psbt-binary.js` (Bloc vaults: from the client via `descriptor-keys.ts`'s `buildPsbtKeyOrigins`). `derivation_path` must be the FULL path including `/0/0` -- the stored account-level path used for the descriptor's `[fp/path]xpub/0/0` form is NOT enough on its own. |

---

## Current state

**Restructure (Apr 2026):** the app moved from a tab-state SPA with per-page
inline style objects and `alert()` calls into a routed app with a shared design
system, UI primitives, toast feedback, a session guard, and centralized config.
See `Stack` above for the layout.

**Working features:**

- Auth: Supabase email/password, signup confirmation
- Key Manager: generate test/secure keys, backup-with-verify flow, archive,
  delete, edit, import/export keyring JSON, persona grouping
- Policy Builder: compile vault via Fly.io, copy descriptor / Miniscript /
  address / BSMS export, save vault to Supabase
- Dashboard: vault list with live BTC balance + USD value, search, archive
  toggle, rename, deep links to `/vaults/:id`
- Vault Detail: overview, send flow with PSBT build, browser signing,
  broadcast to mempool.space, proposal history
- Legacy Recovery: long-horizon descriptor recovery independent of this app
  ever running again -- "all you need is your key," no database, no
  shares to combine, no number to remember (see
  `apps/web/src/lib/legacy-recovery.ts`'s header for the full mechanism
  and CLAUDE.md's "Recently closed" entries below for the design
  history). Each keyholder derives ONE fixed on-chain address per seed
  (`m/84'/coin'/900000'/1/0` -- the account level is still hardened, so
  it's computable only from their own seed, never from this vault's
  xpubs, its descriptor, or anything DynastyTrust stores; the same
  address for every vault that seed ever publishes Legacy Recovery for,
  so there is no per-vault index to track) and publishes an encrypted
  copy of the vault's descriptor there via a single OP_RETURN
  transaction, keyed directly by a deterministic signature over the
  random AES-GCM nonce chosen at seal time -- not a remembered sentence.
  Years later, recovery is: find that transaction, read the nonce it
  already carries in plain sight, sign THAT (a hardware wallet's own
  "Sign Message" feature works fine -- no seed phrase ever typed into a
  recovery tool, nothing to memorize or transcribe wrong), and decrypt --
  no vault ID, no second key, no combining, no index. `LegacyRecoverySetup.tsx`
  (`/vaults/:id/legacy-recovery`) is the publish side: derive the
  address, check the chain, then pick any OTHER already-funded local key
  to pay for one ordinary transaction that carries the OP_RETURN payload
  and a small permanent payment to the identity address as its outputs
  -- the identity key never signs a transaction, only ever the recovery
  message, and the recovery address only ever needs to appear as an
  output, never an input, so there's no fund-then-respend two-step. Also
  downloads a small takeaway note (nothing secret in it -- address and
  derivation path are public by design; no message or index printed,
  since the exact bytes to sign are only knowable once the on-chain
  transaction is found) to keep alongside the seed phrase.
  `DescriptorRetrieval.tsx` (`/recover-descriptor`) is the recovery
  side: enter the address, check the chain, sign the bytes it shows
  (or sign locally with a loaded key), unlock.
  `apps/web/src/lib/legacy-onchain-recovery.ts` orchestrates both
  against `onchain-publish.ts` (P2WPKH build/sign/broadcast, via
  `@scure/btc-signer`) and mempool.space. A standalone, offline,
  single-HTML-file recovery tool ships at
  `/dynastytrust-legacy-recovery-tool.html`
  (`tools/legacy-recovery/`, rebuild with `node tools/legacy-recovery/
  build.mjs` and commit whenever legacy-recovery.ts changes) -- reuses
  the exact same tested functions, not a second hand-typed
  implementation. Covers the named-field ("standard") vault shape only
  so far -- see Open Gaps.

**Open gaps (prioritized):**

1. **Multi-member vault flow (Nunchuk-style command center).** Each vault is
   currently owned by a single Supabase user (`vaults.user_id`). The target
   flow is each co-signer having their own account, proposals surfacing in
   their dashboard, in-browser signing against stored partial sigs, quorum
   tracking, and Supabase Realtime for the activity feed. Schema work will
   add `vault_members`, `vault_invites`, and extend `proposals` with
   per-signer state. See Phase B plan in the session notes.
2. **End-to-end testnet spend** verified with real signers.
3. **Hardware wallet signing flow** (Coldcard PSBT export/import).
4. **Governance panel** showing real block height from mempool.space.
5. **Dependency upgrades (no rush, batch when convenient).** Current pins:
   - Rust: `bitcoin = 0.31.2` (latest stable 0.32.x), `miniscript = 11.2.3`
     (latest 13.0.0). Both rust-bitcoin maintained.
   - Browser: `@scure/bip32 = 1.7.0`, `@scure/bip39 = 1.6.0`, `@noble/curves
     = 1.9.7`, `@noble/hashes = 1.8.0`. All v2 is out.
   Upgrading each is breaking-change work (method renames in bitcoin 0.32,
   API changes in miniscript 12+13, Uint8Array signature tightening in
   paulmillr v2). No CVE pressure; upgrade when a specific feature or fix
   is needed, not on schedule. Cheapest path: browser libs first, then
   bitcoin 0.31 -> 0.32, then miniscript 11 -> 13.
6. **Legacy Recovery: leaf-list ("generic") vault shape not covered yet.**
   `LegacyRecoverySetup.tsx` only enumerates founder/backup/heir/
   second_heir roles -- a vault built on the newer `leaves` shape has no
   sealing UI. The crypto core (`legacy-recovery.ts`) doesn't care about
   vault shape at all; this is purely a missing role-enumeration branch in
   the setup page.
7. ~~Legacy Recovery: on-chain publication of the pad.~~ **Closed
   2026-08-18.** `LegacyRecoverySetup.tsx` now shows the on-chain share as
   an OP_RETURN-ready hex payload with instructions for embedding it via
   any wallet, and records the resulting txid once the owner broadcasts it
   themselves. Deliberately still not auto-broadcast -- DynastyTrust
   doesn't custody funds or manage a user's unrelated UTXOs, so the actual
   send stays a human action in their own wallet, same boundary every
   other send flow here respects.
8. ~~PDF / audit / tax exports don't know about the custom leaf-list vault
   shape.~~ **Closed 2026-08-19.** `vault-pdf.js`, `vault-audit-pdf.js`,
   and `vault-tax-summary.js` all now branch on `Array.isArray(vault.leaves)
   && vault.leaves.length > 0` and read the generic `LeafSpec[]` shape --
   per-path quorum/key-count/timing rows -- instead of assuming
   `founder_keys`/`heir_keys`/`founder_quorum`/`heir_quorum` unconditionally.
   `vault-pdf.js` additionally regenerates its "VAULT POLICY" path cards,
   the "KEY CONFIGURATION" rows, page 2's public-key listing (one section
   per path instead of the fixed Founder/Heir pair), and the signing-
   instructions copy from the real leaf list. Named-field and Bloc vaults
   are byte-for-byte unchanged -- this only adds the missing branch, no
   existing rendering path was touched. One honest residual: the client
   PDF's per-path key listing on page 2 stops drawing (with a page break)
   if it runs off the bottom rather than flowing onto a third page --
   pre-existing behavior for the founder/heir path too, not new here, but
   worth knowing for a vault with a very large number of paths and keys.
9. ~~Vault-membership circle invites don't work at all for the custom
   leaf-list vault shape.~~ **Closed 2026-08-19.** Three real, connected
   fixes, not one: (1) `compile-leaves.js` never read `leaf_scripts` off
   the Fly.io compiler's response at all, despite `compile_leaves` (Rust,
   `compiler/src/main.rs`) already returning it keyed by leaf id and
   already being unit-tested to do so (`compiles_a_valid_leaf_list_and_
   returns_leaf_scripts_by_id`) -- so `vaults.leaf_scripts` sat `null` for
   every leaf-list vault ever compiled. Now persisted on compile, same as
   `vaults-compile.js` already does for the named-field shape. (2)
   `circle-membership-delivery.ts`'s `VaultMembershipRole` type and
   `leafScriptsForRole` were hard-wired to the five named-field roles;
   widened (`(string & {})`) with a fallback that treats an unrecognized
   role as a literal leaf id and looks it up in `leaf_scripts` directly --
   exactly what a leaf-list vault's "role" actually is, no fixed mapping
   needed since compile-leaves.js's leaf_scripts is already keyed by leaf
   id. (3) `VaultMembershipSetup.tsx` gained an optional `leaves` prop;
   when present it builds its roleArrays from each leaf's own `id`/`keys`
   instead of the five fixed arrays, and every role label falls back to
   the leaf's own `label` (e.g. "Grantor(s)") instead of the fixed
   `ROLE_LABELS` map. `tapit-circle-members.ts` needed no change at all --
   it was already role-agnostic, taking any key array. `VaultDetail.tsx`
   now passes `vault.leaves` through. A key that legitimately sits in more
   than one leaf (the key-reuse pattern `find_key_reuse` already
   recognizes) gets one membership grant per leaf it's actually in, which
   is arguably more correct than the named-field path's fixed
   founder-signs-two-leaves mapping. Works for any custom-shape vault,
   including the new Revocable living trust template.

**Next roadmap (captured 2026-04-18, post audit-fix push):**

Pipeline is locked in. Bitcoin path verified via rust-miniscript round-trip
on descriptor compile + single-source tree builder. Next phase is the trust
/ governance layer.

1. **Scenario playbooks**. Per-template "what happens if..." docs baked
   into the UI. For each vault template (Family Inheritance, Generational
   Trust, Business Treasury, etc.): trustee dies, beneficiary refuses to
   cosign, trustees go silent 6 months, protector steps in, inheritance
   triggers. With step-by-step actions + which path unlocks when.

2. **Trust doc templates** aligned to each vault template. Purpose,
   beneficiaries, distribution rules pre-filled. Editable but real.

3. **Role-aware dashboards**. Beneficiary sees "your distributions + timelock
   countdowns". Trustee sees "pending requests + stipends due + signing
   queue". Protector sees "any suspicious activity + when my path unlocks".
   Successor sees "status + time-to-inheritance".

4. **Event-to-action guides**. When a request is filed, the trustee UI
   shows "here's what to do, here's what the trust doc says". When a
   timelock approaches, the UI nudges the relevant party.

5. **Audit trail export**. PDF in an attorney-review format: every event,
   vote, comment, signature, spend, tied to the trust doc clause.

6. **Wallet primitives deferred**. No Liana fork -- AGPL-3.0 kills
   commercial flexibility. If we ever need BDK-grade features (Esplora
   sync, fee bumping, CPFP, native HW via HWI), embed BDK (MIT/Apache)
   via WASM. Don't rebuild a wallet core from scratch. Value-per-month
   is higher in the trust layer.

**Recently closed:**

- **File downloads (vault backup, Tranche backup, Legacy Recovery note,
  keyring export, descriptor QR PNG) unreliable on mobile, blocking
  vault creation (2026-08-22).** Operator: "When creating a vault, the
  download backup file will not fire and is not working and then it
  will not let you continue because it's not firing." The operator is
  on an iPhone (confirmed from an earlier screenshot's status bar), and
  this is a well-known iOS Safari gap: a `Blob` + `URL.createObjectURL`
  + synthetic `<a download>` click is unreliable there in particular --
  it often opens the raw content in a new tab instead of saving a file,
  or does nothing at all -- and every one of the five download sites in
  this app hand-rolled that exact pattern independently, with the
  anchor never attached to the DOM before `.click()` and the object URL
  revoked synchronously right after (before some engines have actually
  started reading the blob). `VaultWizard.tsx`'s vault-creation
  "Backup" step was the one that actually blocked forward progress:
  `Continue to funding` stays disabled until `downloaded` is true, and
  the old code set `downloaded = true` synchronously the instant the
  button was clicked, regardless of whether anything actually
  downloaded -- so on a phone where the download silently failed, nothing
  told the operator why, but critically the button SHOULD have already
  looked "Downloaded" and let them continue; the fact that it visibly
  didn't states the failure was deeper than "no feedback," matching the
  report of it "not firing" at all. New `apps/web/src/lib/
  download-file.ts` is the one download implementation now used
  everywhere (`downloadVault`/`downloadVaultBackup`,
  `downloadDistributionWalletBackup`, `downloadLegacyOnChainRecoveryNote`
  in `descriptor-backup.ts`; `KeyManager.tsx`'s keyring export;
  `DescriptorQr.tsx`'s PNG download): where the Web Share API supports
  file shares (most modern phones, iOS included), it hands the file to
  the native share sheet -- far more reliable than a blob download on
  iOS, and gives a real "Save to Files" option -- falling back to the
  classic anchor-click download (now DOM-attached before the click, with
  the object URL revoke delayed rather than immediate) everywhere else.
  All five functions are now async and return whether the save actually
  happened (false only when a user explicitly cancels a share sheet;
  the anchor fallback has no way to detect success and always resolves
  true, same as its old fire-and-forget behavior). `BackupStep` now
  awaits the real result: `downloaded` is only set true on an actual
  success, a genuine failure surfaces a toast with a way to retry
  instead of a silently stuck button, and the button shows
  "Downloading..." while a share sheet is up. Every other call site
  (VaultDetail's two backup-download buttons, the Tranche backup
  button, the Legacy Recovery note button) just needed the `void`
  prefix already used elsewhere in this codebase for a fire-and-forget
  async call in an onClick handler -- none of them gate forward
  progress, so no behavior change beyond "more reliably actually
  downloads." All four gates green, matching the documented 10/10
  baseline exactly.

- **QR scanning reliability + live feedback, fixed everywhere at once
  (2026-08-22).** Operator: "When scanning qr it is very finicky is
  there any improvements we can do to make it better and show better
  progress or if it's even reading the xpub. Fix every where not just
  one place." Audit found four independent hand-rolled camera-scanning
  implementations across the app (`QrScanner.tsx`, `PsbtQrScanner.tsx`,
  `XpubQrScanner.tsx`, plus the standalone offline tool's own copy in
  `tools/legacy-recovery/recover.ts`) -- each with its own copy-pasted
  `getUserMedia`/`requestAnimationFrame`/jsQR loop, no video quality
  constraints beyond `facingMode: 'environment'`, and zero on-screen
  feedback before a code either decoded or the whole thing errored out.
  Two root causes, both fixed at the source instead of patched per
  site: (1) the DEFAULT unconstrained camera stream on many phones is
  low enough resolution that a dense QR (a descriptor-bearing xpub
  export, a UR PSBT fragment) is genuinely too blurry for jsQR to ever
  lock onto -- not a decoder bug; (2) a scanner that hadn't found a code
  yet showed nothing but the raw video feed, so "is it even reading"
  had no honest answer on screen. New `apps/web/src/components/
  useQrCameraLoop.ts` is the ONE camera-capture-plus-decode
  implementation now shared by all three React scanners: requests an
  ideal 1280x1280 stream with continuous autofocus where supported,
  falling back to a plain request if a browser rejects the richer
  constraint set outright (some throw `OverconstrainedError` instead of
  silently ignoring an unsupported `advanced` entry); reads its
  `onFrame` callback via a ref rather than a `useEffect` dependency, so
  a fresh inline handler on every parent re-render (the ordinary React
  pattern, and what all three components were already doing) can never
  tear down and restart the camera mid-scan; and exposes `scanning` +
  `elapsedMs` so every caller can show a live "Scanning... Ns" line
  (new `QrScanStatus.tsx`) that starts the moment the camera opens, not
  only once a fragment decodes -- past 5 seconds it adds a concrete
  nudge (fill the frame, hold steady, check the lighting) aimed at the
  two things that actually cause most failed scans. `QrScanner.tsx`,
  `PsbtQrScanner.tsx`, and `XpubQrScanner.tsx` were all rebuilt on the
  shared hook, keeping each one's own decode logic (UR reassembly,
  PSBT-magic detection, `parseXpubText`) layered on top -- the
  duplicated camera plumbing is gone, a future camera fix now lands in
  one file instead of three. Separately, `InviteClaim.tsx`'s hardware-
  key-import scanner was still wired to the plain `QrScanner` (no UR
  support, and its own hand-rolled `applyScan` didn't even parse a
  BIP-380 `[fingerprint/path]xpub...` key-origin string, just dumped
  whatever text it scanned into the xpub field) despite `XpubQrScanner`
  -- built for the exact same "scan an xpub" job in `KeyManager.tsx`/
  `VaultWizard.tsx` -- already handling key-origin strings, bare xpubs,
  JSON, and UR-reassembled multi-fragment scans correctly. Swapped to
  `XpubQrScanner` directly rather than teaching the dumb component UR
  parsing a fourth time; this was very likely the direct cause of "is
  it even reading the xpub" for that page specifically. The standalone
  offline tool's hand-rolled scanner (no React runtime available to
  share the hook with) got the equivalent fixes applied by hand: the
  same resolution/autofocus constraints with the same fallback, and a
  live status line wired into `template.html`
  (`#signature-scan-status`, replacing the now-unused hidden
  `#signature-scan-canvas` element -- the canvas is created offscreen
  in JS instead, matching the hook's approach). Rebuilt and re-verified
  against a real signed transaction (`verify-legacy-recovery-tool.mjs`,
  unaffected by this change since it drives the non-camera decode path
  -- camera capture itself can't be exercised headlessly). All four
  gates green, matching the documented 10/10 baseline exactly.

- **Legacy Recovery: standalone tool silently failed to decode when given
  the raw payload hex instead of the real scriptPubKey (2026-08-22).**
  Caught live: the operator pasted the hex from the newly-added "Seal
  payload" button (previous entry) into the standalone recovery tool's
  scriptPubKey field to test the flow, and the "Message to sign" box
  never populated -- no error, just the placeholder text sitting there.
  Root cause: `decodeScriptPubkey()` in `tools/legacy-recovery/recover.ts`
  only ever tried unwrapping the input as a Script (expects the OP_RETURN
  opcode `6a` plus a push-length byte wrapped around the payload, exactly
  what a block explorer shows) -- it had no path for the bare payload
  bytes the "Seal payload" step hands out for pasting into OTHER wallets.
  Those two hex strings are trivially confusable (both just look like a
  wall of hex) and this is a recovery tool, so a silent wrong-field
  paste failing with no explanation is exactly the kind of "mess up" the
  whole nonce-signing/no-index redesign (earlier entries) was built to
  eliminate. Fixed with a fallback, not a warning: `decodeScriptPubkey`
  now tries the Script-unwrap first, and if that fails, tries
  `decodeOnChainPayload` directly on the raw bytes before giving up --
  so both the real scriptPubKey AND the bare "Seal payload" hex work
  in that field, whichever one someone has on hand. Field label and the
  "doesn't decode" error message both updated to name both accepted
  formats. `scripts/verify-legacy-recovery-tool.mjs` extended to prove
  BOTH input paths recover byte-identically against the same real signed
  transaction, not just the scriptPubKey one -- rebuilt and passing. All
  four gates green.

- **Legacy Recovery: seal and publish split into two independent steps
  (2026-08-22).** Operator, working through the mechanism out loud: "we
  have to know the nuts which is when our web browser creates the
  transaction... I feel like [it] not the number we use once independent
  of the transaction... needs to be put in the return right before
  hand... the first one is the one that you are signing... the second
  one is the part of the [decrypt]... that way the transaction can be
  anywhere, not have to be created on our browser at the exact time of
  creation. It could be done from any transaction being sent from
  anywhere as long as that [OP_]return['s] messages in there." Correct
  on every count, and confirmed directly: sealing (nonce -> sign ->
  derive key -> encrypt, producing the OP_RETURN payload bytes) and
  publishing (getting those exact bytes into a broadcast transaction)
  were never actually coupled at the cryptography level -- `sealOnChain
  Payload` already returns a pure, static blob of hex with no side
  effects, `buildAndSignPublishTx` already takes that hex as a plain
  parameter. The only reason it felt tied to "this browser, right now"
  is that `LegacyRecoverySetup.tsx`'s single "Build and sign" button
  called both in one breath and never showed the intermediate value.
  Operator's follow-up confirmed the outside-wallet flow precisely: "I
  just put the data into the return and... set to the address that's
  generated by the key... there's nothing else I have to do correct...
  It's findable at that moment... that's all I have to have." True with
  one caveat surfaced and explained: the transaction also has to pay the
  recovery address itself (any amount at or above the 294-sat dust
  floor) as one of its outputs, alongside the OP_RETURN -- not because
  the cryptography needs it, but because recovery's chain lookup works
  by asking "what's this address's history," so a transaction that
  carries the right payload but never touches that address wouldn't
  surface when someone later looks it up. `LegacyOnChainV2Card` now has
  a real "Seal payload" button (`handleSeal`, calling the unchanged
  `sealOnChainPayload`) that does nothing but reveal the mnemonic, seal,
  and display the resulting hex in a copyable textarea -- no network
  call, no transaction. Underneath, the existing payer-key builder
  (unchanged mechanics, still `buildAndSignPublishTx` with `payTo`) is
  now reframed as one option among two: use DynastyTrust's own builder,
  or copy the sealed hex into Sparrow, Electrum, or any other wallet
  that supports a custom OP_RETURN output, funded from wherever, built
  and broadcast whenever -- both paths converge on the identical
  recovery outcome since nothing about `extractOnChainCandidates` or
  `recoverViaOnChainPath` cares which tool produced the transaction.
  `handleBuildPublishTx` now consumes the already-sealed `payloadHex`
  from state instead of calling `sealOnChainPayload` inline, which also
  fixes a latent inconsistency risk: sealing twice produces two
  DIFFERENT payloads (a fresh random nonce each time), so the old
  inline-reseal-per-build-click pattern could in principle have sealed
  one payload while showing the user a different one from an earlier
  attempt; now there is exactly one sealed value in play at a time, and
  the UI warns against mixing an old copied hex with a freshly re-sealed
  one. No changes to `legacy-recovery.ts` or `legacy-onchain-recovery.ts`
  -- this is purely a workflow/UI change exposing capability the crypto
  core already had. All four gates green, matching the documented 10/10
  baseline exactly; no test-script changes needed since the existing
  on-chain round-trip tests already build transactions from `payloadHex`
  as a standalone value, proving the same thing this UI change now lets
  a human do by hand.

- **Legacy Recovery: sign the on-chain nonce instead of a remembered
  sentence, and drop the vault index entirely (2026-08-22).** Two
  connected operator design calls, same session as the path-reshape
  above. First: "Why do I have to... why can't I just put the op return
  in the first message... Why cant the first part of op return be the
  numbers you sign and the other part be the part you decrypt" -- correct
  read of the wire format (magic+version, then the nonce, then the
  ciphertext -- the nonce genuinely IS "the first part," the ciphertext
  genuinely IS "the second part"), and correct diagnosis of the actual
  design flaw: the fixed sentence
  (`DynastyTrust Legacy Recovery v2\nvault index: N`) had to be
  correctly reconstructed by a person, by hand, possibly decades later,
  when the AES-GCM nonce that already had to be published on-chain
  anyway could serve as the signed content instead -- read straight off
  the found transaction, nothing to get wrong. Answered directly why
  signing the WHOLE OP_RETURN can't work (raised as the natural
  follow-up): the ciphertext is the OUTPUT of encrypting with the key
  that signing produces, so at sealing time the ciphertext doesn't exist
  yet -- nothing that depends on it can be the thing signed to derive it.
  The nonce is chosen before encryption, so it's the one piece of the
  eventual payload actually available to sign up front, at both sealing
  and recovery time. Second, on confirming the build: "Yes top one but
  we need to drop having to put a number with it. 99.999999% of the time
  those one keys have one job one vault not ten per backup. I want no
  mess ups from user in last case recovery scenario" -- read as: optimize
  the mechanism against user error in a last-resort, decades-later
  recovery scenario, not against the rare case of one seed publishing
  Legacy Recovery for more than one vault. `legacy-recovery.ts`'s
  derivation path is now ONE fixed constant per network
  (`legacyOnChainDerivationPath(network)`, no index parameter --
  `m/84'/coin'/900000'/1/0`, `LEGACY_ACCOUNT_NUMBER` replacing the old
  `LEGACY_ACCOUNT_OFFSET`), so a seed always lands on the same single
  address regardless of how many vaults it publishes for.
  `legacyOnChainUnlockMessage(vaultIndex)` is gone, replaced by
  `legacyOnChainNonceMessage(nonce)` (a fixed prefix plus the nonce as
  hex); `signLegacyOnChainUnlock`/`verifyLegacyOnChainSignature` became
  `signLegacyOnChainNonce`/`verifyLegacyOnChainNonceSignature`, both
  taking the nonce bytes instead of a vault index;
  `deriveLegacyOnChainKey` dropped its index-tag parameter entirely (the
  signature is already unique per seal, since it's over a fresh random
  nonce each time -- no further domain separation needed).
  `sealBundle` gained an optional third `nonce` parameter (defaults to a
  fresh random value, same as before, when omitted) so
  `sealBundleOnChain` can generate the nonce FIRST, sign it, derive the
  key from that signature, and only then encrypt with that exact
  key+nonce -- the order the chicken-and-egg problem above actually
  requires. `legacyOnChainLookupAddress`/`sealOnChainPayload` both
  dropped their `vaultIndex` parameters to match. Degrades gracefully
  in the rare multi-vault-per-seed case rather than breaking silently:
  both publishes land at the same address as separate transactions, and
  because the key is nonce-specific (not vault-specific), each
  transaction's own nonce still only ever unlocks its own ciphertext --
  nothing decrypts to the wrong vault's data, recovery just needs to
  find the right transaction, the same way it already has to for a
  re-sealed vault's older vs. newer publish. Frontend:
  `LegacyRecoverySetup.tsx` lost its entire "vault index" field and
  `defaultVaultIndex` role-position guess; `DescriptorRetrieval.tsx`
  lost its vault-index field too and gained a real sequencing change --
  since the message to sign now depends on the nonce found ON the
  transaction, "derive address" and "sign" are no longer one combined
  step; deriving the address happens first, checking the chain finds
  the nonce, and only then can a "Sign locally with this key" button
  (new) or an external hardware wallet actually sign anything.
  `descriptor-backup.ts`'s recovery note dropped `vaultIndex` and
  `unlockMessage` fields entirely -- there's no message to print ahead of
  time any more, only the address and path, with instructions to let the
  chain lookup compute the message at recovery time. The standalone
  offline tool (`tools/legacy-recovery/`) had its field order flipped:
  paste the scriptPubKey FIRST, the tool decodes it and computes the
  message from the nonce it finds, then sign -- previously vault index
  came first and drove the message. All three test scripts
  (`test-legacy-recovery.mjs`, `test-legacy-onchain-recovery.mjs`,
  `verify-legacy-recovery-tool.mjs`) rewritten around the new nonce-first
  API and the fixed single address; the last one re-verified against a
  real signed transaction, byte-identical. One typecheck regression
  surfaced and fixed during this pass: `sealBundle`'s new explicit
  `nonce: Uint8Array` parameter annotation widened to the
  `Uint8Array<ArrayBufferLike>` variance this file already has a
  documented pattern for (`asBufferSource()`); applying that same
  pattern to the new `iv: nonce` call site restored the exact 10/10
  pre-existing typecheck/lint baseline. All four gates green.

- **Legacy Recovery: derivation path reshaped from fully-hardened to
  standard-shaped with an offset account (2026-08-22).** Operator asked
  to confirm a described recovery flow ("you put the derivation path at
  9999... it will show an address, you sign, then you have your
  descriptor -- is that correct?"). Grounding against SeedSigner's actual
  source (not memory) found the described flow does NOT work: SeedSigner's
  message-signing UI (`parse_derivation_path()`) only recognizes the
  ordinary 5-level BIP44/49/84/86-shaped path (hardened purpose/coin/
  account, then UNHARDENED change/index) and hard-rejects a custom
  hardened path like the old `m/9999'/coin'/N'/1'` with "Signing messages
  for custom derivation paths not supported" -- before ever showing an
  address or accepting a signature. The underlying signing math is
  path-agnostic; the rejection is purely a UI-layer whitelist gate, but
  that gate meant the mechanism's own worked example couldn't actually be
  carried out on the hardware it exists to support. Operator's follow-up,
  "what's the downside to moving to a regular derivation path, still
  hardened but normal," got a direct answer: an unhardened change/index
  level means anyone holding the ACCOUNT-level xpub (not the master) can
  compute that address, unlike the old fully-hardened path where nothing
  short of the seed could. Operator then asked about forking SeedSigner
  instead to accept the custom path -- researched and found technically
  feasible (~30-60 lines: a whitelist-gate fix plus deriving through the
  full hardened private-key chain instead of extending a cached xpub,
  testable without hardware via SeedSigner's own pytest suite) but
  recommended against as the FOUNDATION of recovery: reshaping the
  canonical path and forking firmware to accept the old shape are
  mutually exclusive fixes (only one path shape can be the one actually
  published on-chain), and depending on a specific patched firmware fork
  surviving decades is a worse fit for "works decades from now regardless
  of what still exists" than closing the narrower xpub-exposure risk
  directly. Operator agreed ("Yes") to the standard-shaped path.
  `legacy-recovery.ts`'s `legacyOnChainDerivationPath` now returns
  `m/84'/coin'/(900000+N)'/1/0` -- the ordinary BIP84 (native segwit)
  5-level shape, hardened purpose/coin/account and unhardened change/index,
  recognized by any hardware wallet's message-signing feature as a normal
  account. The fixed `LEGACY_ACCOUNT_OFFSET` (900,000) is the mitigation
  for the xpub-exposure question above: it keeps this "recovery account"
  far outside any real wallet's actively-used low account numbers
  (routinely exported to watch-only trackers/tax tools) or typical
  account-level gap-limit auto-discovery ranges, so an attacker would need
  the SPECIFIC account-level xpub at that exact offset+index, not just
  "some xpub from this wallet." Change=1 (the internal chain, never a
  normal receive address) is a further, minor precaution. The old
  `LEGACY_PURPOSE = "9999'"` reserved-purpose constant is gone (private,
  now `"84'"` -- a real BIP84 purpose, not a reserved one).
  `scripts/test-legacy-recovery.mjs`'s hardcoded path assertions,
  `DescriptorRetrieval.tsx`'s displayed path (now computed via
  `legacyOnChainDerivationPath` instead of a hardcoded string, so it can't
  drift from the real function again), and `tools/legacy-recovery/
  template.html`'s warning-box copy were all updated to match; the
  standalone offline tool was rebuilt (`node tools/legacy-recovery/
  build.mjs`) and re-verified end to end against a real signed transaction
  (byte-identical recovery). `LegacyRecoverySetup.tsx` needed no change --
  it already computed the path via the function, never hardcoded it.
  Nothing else about the mechanism changed: the unlock message, the
  AES-256-GCM sealing, the OP_RETURN payload framing, and the one-
  transaction billboard-payment publish flow (previous entry) are all
  untouched -- only the path SHAPE moved, not the account-level hardening
  that still requires the seed (not the master xpub) to derive. All four
  gates green; typecheck/lint match the documented pre-existing baseline
  exactly (10 pre-existing typecheck errors, 10 pre-existing lint
  warnings), none in any file this change touched.

- **Legacy Recovery on-chain publish collapsed from two transactions to
  one (2026-08-22).** Operator: "Why do I have to fund a UTXO to that
  address and then craft the transaction and then resend it why can't
  I just put the op return in the first message that funds it with a
  small amount of that that's never meant to leave just be the
  billboard." Correct, and the original design had no real reason for
  the two-step shape -- it just happened to route the publish
  transaction's INPUT through the identity address, which meant that
  address had to hold a UTXO before anything could spend from it, and
  spending required the identity key to sign a real Bitcoin
  transaction. Neither is necessary: the scanner
  (`extractOnChainCandidates`) only needs the identity address to
  appear SOMEWHERE in a transaction's outputs to find it -- it never
  cared whether that transaction spent FROM the address too. Redesigned
  so the identity address is purely a payee: `onchain-publish.ts`'s
  `buildAndSignPublishTx`/`buildAndSignPublishTxFromKeypair` gained an
  optional `payTo: { address, amountSats }` third output (dust-floor
  checked at 294 sats, fee math and the undersized-UTXO error message
  both updated to account for it) alongside the existing OP_RETURN
  output and self-change. `legacy-onchain-recovery.ts`'s
  `sealAndBuildOnChainPublishTx` (which forced the identity key to be
  both the signer and the spender) is gone, replaced by
  `sealOnChainPayload` -- pure sealing, no transaction, no keypair
  beyond the identity's own signature. `LegacyOnChainV2Card`
  (`LegacyRecoverySetup.tsx`) now asks for a SEPARATE "paying key" (any
  other already-funded local key) alongside the existing identity-key
  selector, fetches UTXOs at the payer's own address instead of the
  identity address, and builds one transaction: OP_RETURN + a small,
  editable "billboard" payment (1000 sats default, never meant to move
  again) to the identity address + change back to the payer. Net
  effect: one signature, one broadcast, and the identity key's only
  remaining job across its entire lifecycle is signing the recovery
  MESSAGE, years later -- it never touches transaction-signing logic at
  all, which is also a smaller attack surface for that key than before.
  `scripts/test-onchain-publish.mjs` gained payTo-path coverage
  (correct output count/amounts, dust-floor rejection);
  `scripts/test-legacy-onchain-recovery.mjs` and
  `scripts/verify-legacy-recovery-tool.mjs` (the latter against a real
  signed transaction, same as before) were both rewritten around the
  new two-function split with a genuinely separate payer key, proving
  the identity address only ever needs to be an output. All four gates
  green.

- **Original (v1) Legacy Recovery mechanism retired entirely
  (2026-08-21).** Operator, after the v2 on-chain mechanism shipped
  (previous entry): "I don't think we need to keep anything of the old
  version. I just didn't like it. None of it worked. None of it's gonna
  be used. It's just gonna be clutter that's in the way. I just want the
  new signature based signing." Read as full authorization to delete,
  not deprecate -- the whole hybrid XOR/Shamir, database-backed design
  is gone, code and schema alike. Deleted: `legacy-seal.ts` (v1
  orchestration), `netlify/functions/vault-legacy.js` and
  `legacy-lookup.js` (v1 storage/lookup endpoints), the `api.legacy.*`
  client block, `descriptor-backup.ts`'s `LegacyRecoveryPackageLike`/
  `legacyRecoveryPackageText`/`downloadLegacyRecoveryPackage`, and the
  `shamir-secret-sharing` dependency (`npm install` pruned it from the
  lockfile). `legacy-recovery.ts` dropped every v1-only export
  (`deriveLegacyLockBytes`, `legacyIdentityPubkeyFromXpub`,
  `detectXpubNetwork`, `signLegacyUnlockMessage`,
  `verifyLegacyUnlockSignature`, `deriveLegacyLockBytesFromSignature`,
  `lockShare`/`unlockShare`, `splitLegacySecret`/`combineLegacySecret`,
  `splitLegacySecretHybrid`, `recoverViaFastPath`/
  `recoverViaFallbackPath`, `generateLegacySecret`,
  `descriptorFingerprint` -- the last was v1's stale-seal label, moot
  once the sealed-bundle-in-a-database it labeled no longer exists) --
  file is roughly half its former size, down to shared primitives
  (`bitcoinMessageDigest`, `parseUnlockSignature`, `sealBundle`/
  `unsealBundle`) plus the on-chain mechanism, unchanged.
  `LegacyRecoverySetup.tsx` and `DescriptorRetrieval.tsx` both lost
  their entire v1 half (role-assignment/seal flow, xpub-lookup flow,
  "download recovery package") and now show only the on-chain
  publish/recovery cards that already existed alongside v1. The
  standalone offline tool (`tools/legacy-recovery/`) dropped its
  three-tab layout for a single flow -- no tabs needed with one
  mechanism -- and its Playwright verification script
  (`scripts/verify-legacy-recovery-tool.mjs`, not part of `npm test`)
  now drives that flow against a real signed transaction rather than
  the old fast/fallback paths.
  `supabase/migrations/20260821150000_drop_legacy_recovery_v1.sql` drops
  `vault_legacy_bundles`/`vault_legacy_shares`/
  `vault_legacy_onchain_shares` outright (applies automatically on push
  to main, same as every other migration here) -- the two prior
  migrations that extended those tables
  (`20260818203809_legacy_shares_signature_unlock.sql`,
  `20260820120000_legacy_recovery_descriptor_fingerprint.sql`) are left
  in place as history, never edited or deleted, per migration
  convention. `scripts/test-legacy-recovery.mjs` dropped every v1
  assertion, keeping only the on-chain mechanism's round-trip/
  determinism/tamper-detection proofs. All four gates green; typecheck/
  lint match the documented pre-existing baseline exactly, both before
  and after -- confirming the removal didn't disturb anything else.

- **Legacy Recovery v2: "all you need is your key" -- a second,
  database-free on-chain recovery mechanism (2026-08-21).** Operator,
  after using v1: "We need to look at the long term back up. I tink we
  mad it harder to back up not easier... The whole idea was that you
  would have only your key and somehow you would be able to see your
  description on chain... I just like to know any solution better than
  this because this is just redundant doing the same thing over and
  over." v1 (still fully intact, never touched or weakened -- anything
  already sealed under it keeps recovering exactly as before) needs a
  threshold of shares plus, for its fast path, a database round trip;
  the operator wanted a version where ONE key, alone, is the entire
  backup. Plan vetted for holes before any code was written, per the
  operator's explicit request, catching two design problems along the
  way: an early sketch derived the on-chain lookup address from the
  vault's own account xpub, which the operator's "I don't want to be
  leaking a information about the key" caught as a real linkability
  leak (anyone holding that xpub could watch for or discover the
  publication); and an ECDH envelope-encryption design was dropped as
  unneeded complexity once unlinkability already forced one publish per
  keyholder anyway. Final design: `legacyOnChainDerivationPath` in
  `legacy-recovery.ts` derives a FULLY HARDENED path,
  `m/9999'/<coin>'/<vault index>'/1'` (vault index = that person's own
  small per-vault counter, distinct from v1's `9999'` sub-path by its
  trailing `1'` vs v1's `0'`) -- hardened means it is computable ONLY
  from the real seed, never from this vault's xpubs, descriptor, or
  DynastyTrust's whole database. A deterministic (RFC 6979) ECDSA
  signature over a fixed message at that path IS the AES-256-GCM key
  directly (`deriveLegacyOnChainKey`, SHA-256 with a domain-separation
  tag) -- no ECDH, no envelope, and the same signature doubles as "prove
  key ownership," so recovery is nothing but signing a message
  (verbatim ask: "sign something and decrypts instead of entering
  phrase") -- works identically for a mnemonic (computed locally) or a
  hardware wallet's native "Sign Message" feature against a custom
  path, no seed phrase ever typed into any tool. The full encrypted
  bundle publishes as a single OP_RETURN (Bitcoin Core 30's 100,000-byte
  relay limit makes this trivial, unlike v1's small on-chain pad) --
  `legacy-onchain-recovery.ts` orchestrates seal + build + sign
  (`sealAndBuildOnChainPublishTx`) and scan + extract
  (`fetchLegacyOnChainCandidates`/`extractOnChainCandidates`, via
  `@scure/btc-signer`'s `Script.decode`, real-transaction round-trip
  tested in `test-legacy-onchain-recovery.mjs`, not just a fixture).
  Genuinely no database at all -- the chain IS the storage, so there is
  nothing here for a DynastyTrust outage or a stale row to break.
  Shipped in explicit operator-approved stages, each independently
  gated: (1) crypto core, unit-tested in isolation
  (`test-legacy-recovery.mjs`'s new v2 section: path
  determinism/uniqueness/non-collision-with-v1, signature determinism,
  key-derivation domain separation, full seal/unseal round-trip, AEAD
  tamper/wrong-key rejection); (2) on-chain publish/lookup plumbing;
  (3) `LegacyRecoverySetup.tsx` gained a per-role "recover with just
  this key" card (derive address, check the chain, guided UTXO-fetch-
  then-build-then-broadcast mirroring the existing v1 flow's pattern,
  plus a "download recovery note" -- unlike v1's package, nothing in it
  is secret, so it's safe to keep anywhere) and
  `DescriptorRetrieval.tsx` gained a "Sign to recover" section (no xpub
  match needed -- v2's hardened path means there is nothing a
  server-side lookup could match against, so the address itself IS the
  lookup); (4) the standalone offline tool
  (`tools/legacy-recovery/`) gained a fourth tab reusing the SAME tested
  functions (no second hand-typed implementation), rebuilt via
  `node tools/legacy-recovery/build.mjs`. All four gates green at every
  stage; typecheck/lint match the documented pre-existing baseline
  throughout.

- **Family D closed: numeric-bounds validation at every JSON body
  boundary reaching CLTV/fee/quorum arithmetic (2026-08-21).** The
  original Kimi K3 scan's per-finding text for this family wasn't
  preserved verbatim from an earlier session, so this was re-derived
  fresh via a research-agent audit of the current code rather than
  patched from memory (per this file's own grounding rule) -- the real
  gap matched the family's description either way. New
  `netlify/functions/_numeric.js`: `checkNumberBounds()`/
  `isFiniteNumber()` plus centralized `MIN_FEE_RATE_SAT_VB`/
  `MAX_FEE_RATE_SAT_VB` (previously duplicated verbatim in three
  files); `_chain.js` gained `MIN_RECOVERY_BLOCKS`/`checkTimelockFloor()`
  alongside the existing `relativeToAbsolute()`. Four batches: (1) the
  same MIN_RECOVERY_BLOCKS timelock-bypass bug already fixed for
  `compile.js`'s `recovery_after` had never been propagated to its
  siblings -- `inheritance_after` (`compile.js`, `vaults-compile.js`,
  plus `second_inheritance_after`), Bloc's `parent_solo_after`/
  `kids_decay_start_after` (`compile-bloc.js`, `vaults-compile-bloc.js`,
  which didn't even import the constant), and the generic leaf-list's
  `After`-type `unlock.blocks` (`compile-leaves.js`, the newest vault
  builder, including the Revocable Living Trust template) all had only
  a truthy check or no check at all -- `inheritance_after: 1` passed
  every existing check on a Gift Locker vault. (2) Every `fee_rate`/
  `amount_sats` range check across `psbt-binary.js`/`-bloc.js`/
  `-tranche.js` and `proposals.js` was written as `x < MIN || x > MAX`
  without first confirming `x` is a real finite number -- `NaN < MIN`
  and `NaN > MAX` both evaluate false, so non-numeric input silently
  passed. `proposals.js` mattered most here: no Rust compiler sits in
  its path, so `amount_sats`/`fee_sats`/`fee_rate`/`utxo_age_blocks`/
  `total_vault_sats` wrote straight to the `proposals` table -- which
  the audit PDF, tax summary, and activity export all treat as the
  permanent record -- with no backstop at all beyond whatever
  Postgres/PostgREST does with an out-of-type value. (3)/(4) Defense-
  in-depth for quorum/tranche fields Rust already bounds at compile/
  spend time but that had no check of their own at write time:
  `distribution-wallets.js`'s `trustee_quorum` and per-tranche
  `unlock_block` (whose `typeof` check accepted NaN, silently
  defeating `psbt-binary-tranche.js`'s own unlock gate), the
  `kids_decay` path's `quorum` in `psbt-binary-bloc.js`, and
  `compile-leaves.js`'s per-leaf `quorum`. `governance.js` (read-only
  audit/status endpoint, not fund-moving) got the same
  `amount_sats`/`utxo_age_blocks`/`total_vault_sats` fix for
  consistency. `OlderThan` (decay-ladder) leaves were deliberately left
  untouched throughout: their block count is a duration forwarded
  unconverted, so Rust's own `MAX_RELATIVE_BLOCKS` check runs against
  the real value and was never a no-op -- only the `After`/CLTV-shaped
  fields had the conversion-order bug. All four gates green across
  every batch; `netlify/functions/*.js` aren't covered by the
  eslint/tsc gates (plain JS, no build step), verified with
  `node --check` on every edited file instead.

- **Security audit follow-up: three operator design calls resolved
  (2026-08-21).** Full Kimi K3 automated security scan (146 findings)
  triaged and the confirmed-real ones fixed across this session and the
  prior one; three findings were product/design questions rather than
  bugs, put to the operator directly rather than "fixed" unilaterally:
  (1) **Tranche trustee escape hatch has no CLTV gate** -- confirmed as
  coded, not missing: `trustee_quorum` can move a beneficiary's tranche
  before its unlock height, and `psbt-binary-tranche.js`'s own error
  message says "Use the trustee escape hatch to move funds before then."
  Operator confirmed this is intentional (real-world trustee discretion,
  same structural pattern as the standard vault's founders' Recovery
  path) -- left as-is, no code change; recorded here so a future scan
  doesn't re-flag it. (2) **The signing gate's synthetic approvals axis
  was vacuous** -- `ceremonyFromProposal` was feeding the gate a single
  hardcoded `approveVoterIds: ["proposal-exists"]`/`approvalsRequired: 1`
  that any signable proposal trivially satisfied; no real per-member
  approval-vote feature exists anywhere in this app to build a genuine
  check from. Operator chose to drop the axis entirely rather than build
  the feature or leave the vacuous check in place --
  `SigningCeremony.approvalsRequired`/`approvalsCollected` and
  `CeremonyBridgeInput.approveVoterIds`/`approvalsRequired` removed from
  `packages/policy-engine/src/index.ts` (dist rebuilt + committed, this
  package's dist IS git-tracked), the two `NOT_GREEN` denial checks
  removed from `evaluateSigningGate`, `VaultDetail.tsx`'s call site and
  `scripts/test-policy.mjs`/`test-liveness-gate.mjs` updated to match.
  The gate's other axes (PSBT-exact-match, ceremony status, duress,
  governance, liveness) are unaffected and still enforce for real; quorum
  itself is enforced on-chain by the Taproot script's own required
  signature count, which this axis was never actually checking anyway.
  (3) **Legacy Recovery's on-screen unlock-signature exposure** --
  `signLegacyUnlockMessage`'s deterministic-ECDSA-signature-as-secret
  design is confirmed intentional (see the Legacy Recovery history
  below), and the retrieval page's "review the signature" step showing
  that value on-screen before use is accepted as inherent to a
  decades-out manual recovery flow, not something to mask. No code
  change. All four gates green throughout.

- **PDF/audit/tax exports + Tapit circle-membership invites for the
  custom leaf-list vault shape (2026-08-19).** Direct follow-up to the
  Revocable living trust entry below -- items 8 and 9 in Open gaps above
  were left open in that same session per the operator's instruction to
  "keep a list of the things we need to work on" rather than fixed
  silently; this pass closes both. Full detail lives in the strikethrough
  entries for items 8 and 9 above, not repeated here. Net effect: a
  custom leaf-list vault (living-trust-shaped or otherwise) now gets
  correct legal/tax documents instead of "0 of 0 signatures required,"
  and its Tapit circle members can actually be invited over the
  encrypted-messaging pipeline, matching what already worked for the
  named-field and Bloc vault shapes. All four gates green.

- **Revocable living trust shape + trust-wording toggle + trust-doc
  generation for the custom leaf-list builder (2026-08-19).** Operator
  asked, after the custom leaf-list builder shipped, whether the "heart of
  the trust part" -- lawyer docs, the judicial-system side, membership
  invites over encrypted messaging -- had kept pace with it. Grounding
  confirmed two real gaps (now items 8 and 9 in Open gaps above, left
  open and documented rather than fixed silently or ignored per the
  operator's explicit instruction to "be honest about where we haven't
  found where we go"). Also built what the operator asked for as the
  positive half of that same request, both options rather than picking
  one: (1) a new "Revocable living trust" entry in `VaultWizard.tsx`'s
  `LEAF_SHAPE_TABS` -- the most common US estate-planning trust, mapped
  onto three existing leaf primitives with trust-terminology labels:
  Grantor(s) (immediate), Successor Trustee incapacity backstop (the
  existing `older()` self-refreshing pattern, with copy that says plainly
  this is a proxy for a real incapacity determination, not the same
  thing, and that a real determination should be handled by a deliberate
  `vaults-rotate.js` handoff rather than waiting out the on-chain clock),
  and Successor Trustee distributing to Beneficiaries (a longer `after()`
  leaf). (2) A separate, complementary "Use trust wording" checkbox
  (`applyTrustLabels` in `VaultWizard.tsx`) that relabels whichever paths
  an operator has already hand-built with the same Grantor / Successor
  Trustee / Beneficiary terms, based on each path's own timing (immediate
  -> Grantor, "if untouched" -> incapacity backstop, longest `after()` ->
  distribution to Beneficiaries) rather than which shape tab was used --
  reversible, since toggling it off restores the labels captured right
  before it was turned on. (3) The actual missing connection: the
  leaf-list compile path in `VaultWizard.tsx`'s `runCompile` had a
  comment explaining why it left the generated trust doc blank ("no
  template to draw from the way Standard/Bloc do") -- that comment was
  wrong, there was a template to write, it just hadn't been written yet.
  `apps/web/src/lib/trust-doc.ts` gained `buildLeavesTrustDoc`, generating
  real purpose/distribution-rules/succession-notes prose from each path's
  actual mechanics (quorum, key count, immediate/after/older timing, decay
  ladder), the same way `buildStandardTrustDoc`/`buildBlocTrustDoc` already
  do for the other two shapes -- wired into the same `saveGeneratedTrustDoc`
  call every other vault shape already uses, so every vault built through
  the custom builder, living-trust-shaped or not, now gets a real starting
  trust doc instead of a permanently blank one. All four gates run before
  commit.

- **Legacy Recovery: stale-seal detection (2026-08-20).** Operator, thinking
  through a 20-year-out edge case: a vault gets recompiled (same leaf shape,
  different actual keys) after its Legacy Recovery bundle was already sealed
  and an on-chain pad already published -- "I'm not sure how to label that or
  make sure the person in the future doesn't get confused." Grounding
  confirmed the gap was real: `vaults-compile.js`/`compile-leaves.js` never
  touched `vault_legacy_*` at all, despite `vault_legacy_recovery.sql`'s own
  comment claiming the bundle gets "overwritten whenever the vault
  recompiles." The crypto itself already fails safely -- a stale locked
  share or on-chain pad only ever reconstructs the secret for the bundle it
  was sealed alongside, so recovering against a re-sealed vault just fails
  to decrypt (an honest error), never a silently wrong descriptor -- but
  nothing told the owner it had happened, and nothing told a future finder
  which vault-version a package belonged to. `legacy-recovery.ts` gained
  `descriptorFingerprint` (8 bytes of SHA-256 as 16 hex chars, unit-tested
  in `test-legacy-recovery.mjs`) -- a label, not a security mechanism.
  `legacy-seal.ts`'s `sealVaultLegacyRecovery` now takes the vault's raw
  `descriptor` and hashes it at seal time; `vault-legacy.js`'s POST stores
  it as `vault_legacy_bundles.sealed_descriptor_hash`
  (`20260820120000_legacy_recovery_descriptor_fingerprint.sql`, nullable --
  a bundle sealed before this migration has no retroactive fingerprint,
  treated as "unknown version," never "current") and its GET returns it.
  `LegacyRecoverySetup.tsx` recomputes the vault's CURRENT fingerprint on
  every load and shows a red "this vault's descriptor has changed since
  Legacy Recovery was last sealed -- reseal now" banner when it no longer
  matches the sealed one, plus a small mono line showing the sealed
  version/date next to the roles for a normal, matching seal.
  `descriptor-backup.ts`'s `LegacyRecoveryPackageLike` gained
  `descriptorFingerprint`/`sealedAt`, stamped near the top of every
  downloaded recovery package with an explicit note: this package still
  correctly recovers the version it was sealed for, but may not be the
  vault's current one, so compare the stamp against DynastyTrust's live
  page if it's still reachable. The standalone offline tool
  (`tools/legacy-recovery/`) was deliberately NOT changed -- the fingerprint
  is plain informational text for the human reading the package, not a
  field the recovery tool consumes -- but it was rebuilt
  (`node tools/legacy-recovery/build.mjs`) per standing instruction since
  `legacy-recovery.ts` changed. All four gates green; `legacy-recovery`
  test suite extended with round-trip + collision checks for the new
  fingerprint function.

- **Standalone protector leaf/timelock/quorum retired (2026-08-19).**
  Operator: "I don't like the protector path. I only like it as an added
  key to a quorum so as to keep a leaf honest not a leaf all of its own"
  -- followed by, on which leaf it should co-sign: "Just as a suggested
  signer just like trustee. Prolly not use much so don't need it." Read
  as authorization to remove the dedicated mechanism entirely: an
  independent overseer, if wanted, is just another key added directly to
  `founder_keys` -- no separate field, leaf, or timelock needed, since
  that person then counts toward the existing founder quorum like any
  other trustee. Removed `protector_keys`/`protector_quorum`/
  `protector_after` from `DynastyPolicy` and the protector branch from
  `build_multileaf` (`policy_compiler.rs`), the protector fields/path from
  `compiler/src/main.rs`'s compile and psbt-binary handlers, and the
  matching plumbing from every Netlify function that touched them
  (`compile.js`, `vaults.js`, `vaults-compile.js`, `vaults-rotate.js`,
  `psbt-binary.js`, `invites.js`, `invites-lookup.js`, `vault-audit-pdf.js`,
  `assistant.js`). Frontend: dropped the "Add a protector" toggle and its
  key picker from `VaultWizard.tsx`, the spend-path option and
  countdown/reminder banners from `VaultDetail.tsx`, and the config fields
  from `StandardConfig`/`VaultTemplate` (`vault-templates.ts`) -- the
  Generational Trust template's "independent protector" story is now "seat
  an overseer as one of the 5 trustee keys instead." A same-session audit
  of this mechanism (governance-layer protector tracking, an ordering
  guardrail) is reverted along with it -- see commit `66130c7`, cleanly
  undone via `git checkout 66130c7~1` for the three files it touched
  outside `policy_compiler.rs`. `vaults.protector_keys/protector_quorum/
  protector_after` columns are deliberately left in the DB schema, unused
  -- dropping them is a separate, destructive call the operator didn't
  ask for. Any vault compiled before this change that actually used the
  protector leaf keeps spending exactly as before; the Taproot tree
  already on-chain does not change retroactively. All 158 protocol +
  compiler tests pass; frontend typecheck/lint/build clean against the
  pre-existing baseline (documented below).

- **Dead BSMS/Policy Builder reference in the downloadable vault backup
  (2026-08-17).** `descriptor-backup.ts`'s Nunchuk recovery instructions told
  a future reader to go find "the BSMS export on the Policy Builder page" --
  that page was retired when `VaultWizard` absorbed it, and `VaultWizard`
  never grew a BSMS export of its own, so the instruction pointed at
  something that no longer exists at all, not just a renamed page. Since
  this file is explicitly meant to work when DynastyTrust itself is
  unreachable, a dead in-app pointer there is a real gap, not cosmetic.
  Fixed to the instruction that was already correct as the doc's own
  fallback: import the descriptor into Sparrow, then use Sparrow's own BSMS
  export to hand off to Nunchuk -- now the primary and only instruction,
  since DynastyTrust doesn't export BSMS directly. Also removed the stale
  "PDF vault backup -- function exists, no UI button" line from Open Gaps
  above: grounding for this fix found the button already wired in
  `VaultDetail.tsx` (`api.pdfUrl` + "Download PDF"), alongside a working
  descriptor QR code (`DescriptorQr.tsx`, "Show QR") -- both were already
  done, the doc just hadn't caught up.

- **The 2026-08-06 fix below was incomplete -- server-side copy still had the
  bug (2026-08-16).** `apps/web/src/lib/descriptor-keys.ts`'s `upgradeDescriptor`
  was the only copy fixed on 2026-08-06. `netlify/functions/vaults-compile.js`
  has its OWN separate, duplicate `upgradeDescriptor` function -- and that one
  runs first, server-side, consuming the raw pubkey substrings before the
  browser ever sees the descriptor. So the browser's `/0/0` fix was a silent
  no-op for every standard-shape vault compiled through `/api/vaults-compile`
  the entire time. Caught by tracing a real, live Gift Locker vault's
  descriptor, which still showed `/0/*`. Both copies now emit `/0/0`. Good
  news for anyone whose vault already has the stale text: the address was
  NEVER wrong -- `/0/*` and `/0/0` derive the identical key at index 0, so
  this is purely a descriptor-notation bug, not a fund-safety one. Run
  `supabase/migrations/20260816194321_repair_ranged_descriptor_notation.sql`
  once to patch the
  stored `descriptor` text in place; no recompile, no address change, no
  funds touched. `Bloc`/`Tranche` (`vaults-compile-bloc.js`,
  `distribution-wallets.js`) never called `upgradeDescriptor` at all -- a
  separate, already-known, still-open limitation, not touched by this fix.

- **Fixed, non-ranged key-origin descriptor (2026-08-06).** `upgradeDescriptor`
  now emits `[fp/path]xpub/0/0`, not a `/0/*` wildcard range. This vault is a
  single fixed address by design (see "Address type" above) -- a ranged
  descriptor let Nunchuk/Sparrow offer a second receive address at index 1+
  that our own compiler has no way to build a spend for (it only ever knows
  the exact `/0/0` key baked into the leaf script), so funds sent there would
  be spendable by the hardware wallet directly but invisible to this app's own
  coordinator. A fixed key expression makes every wallet that imports the
  descriptor show the exact same one address we do.

- Descriptor upgrade to Nunchuk/Sparrow key-origin form. `upgradeDescriptor`
  and `buildKeyOrigins` now run right after `api.compile()` returns, so the
  descriptor shown in the copy field and stored in Supabase is
  `pk([fp/path]xpub/0/0)`. Uses `masterFingerprint` when the keystore has
  it (software keys) and falls back to the child `fingerprint` otherwise.

- **Nunchuk key-material parity**: every pubkey sent to the compiler is
  `xpub/0/0` (first receive-chain child), not the account-level pubkey.
  Without this fix, the compiler's address and the upgraded descriptor's
  first address disagree (the descriptor was wildcard-ranged at the time
  of this fix; fixed to non-ranged 2026-08-06) -- Nunchuk import would see an
  empty balance at the address our app funded. The fingerprint is also
  now BIP32 standard (`HASH160(pub)[0..4]`) instead of the non-standard
  raw-first-4-bytes shape. `psbt-signer.ts` signs with the `/0/0` child
  private key to match the leaf-script pubkey. `repairPubkeys()` on
  boot, plus a self-heal pass in VaultDetail, migrate local keys and
  `vault_members` rows automatically. **Any vault compiled before this
  fix is permanently broken vs. Nunchuk -- the descriptor + address
  pair was wrong and is immutable. Recompile from a fresh draft.**

**Pre-existing issues that survived the restructure:**

- `lib/keystore.ts`: strict TS errors around `Uint8Array<ArrayBufferLike>`
  variance. Build still passes (esbuild tolerant); `tsc --noEmit` complains.
- `lib/psbt-signer.ts`: `HDKey.utils` typed as missing.
- 3 lint warnings: react-refresh in `components/toast/ToastProvider.tsx`
  (intentional -- types and provider co-located), and unused `copy` /
  `currentPsbt` in `pages/VaultDetail.tsx`.
- `pages/VaultDetail.tsx` still has its bespoke header + a local palette;
  migration to `<Layout>` + theme tokens is pending.

---

## What a good response looks like

When making a code change:

1. **Read the relevant files first** before writing anything.
2. **Use the design system.** Reach for `<Button>`/`<Input>`/`useToast()`/
   `colors.*` before hand-rolling a button or hex-coding a color.
3. **Make the minimal change** -- don't refactor unrelated code while fixing
   a bug.
4. **Run lint + build** before claiming done. Both must exit 0.
5. **State clearly what changed and why.** One commit per atomic unit of work.

When a build fails:

1. Read the error line number carefully.
2. Check the **JSX hazards** rule first (most common cause).
3. Check the known issues table.
4. Fix the specific error, then scan the whole file for the same pattern.
5. Don't patch on top of patches -- if a file has been patched 3+ times,
   rewrite it clean.

Don't add features that weren't asked for. Don't change working code while
fixing a bug. Don't refactor file structure without being asked.
