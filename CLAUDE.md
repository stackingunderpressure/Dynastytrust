# CLAUDE.md -- DynastyTrust

Read this before writing any code. Follow every rule here without exception.

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
|-- db/migrations/                     Supabase SQL migrations
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

All tables have RLS enabled. Users can only access their own data. Run
migrations from `db/migrations/` in order (`001_init.sql`, `002_vaults.sql`).

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

**Open gaps (prioritized):**

1. **Descriptor format for Nunchuk/Sparrow/Coldcard import.** The Rust compiler
   returns raw-pubkey descriptors (`pk(03abcd...)`); the saved vault descriptor
   is also raw-pubkey. Hardware wallet import expects the key-origin form
   `pk([masterFP/48'/coin'/0'/2']xpub/0/*)`. A helper `upgradeDescriptor()`
   was sketched out but never wired to a caller; it was deleted during the
   restructure as dead code. Restoring it requires:
   - Bring back `upgradeDescriptor(descriptor, KeyOriginMap)` in PolicyBuilder
   - Build the `KeyOriginMap` from the selected founder/heir keys at `save()`
     time using each `LocalKey.fingerprint`, `derivationPath`, `xpub`
   - Run the descriptor through it before persisting + before showing the
     "Output descriptor" copy field
2. **End-to-end testnet spend** verified with real signers
3. **Hardware wallet signing flow** (Coldcard PSBT export/import)
4. **Governance panel** showing real block height from mempool.space
5. **PDF vault backup** download (function exists, no UI button)

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
