# Build Note -- Super Sovereign Mode, re-grounded (2026-11-13)

Written before any code. The design is `docs/super-sovereign-mode.md`
(eight phases, "design note, not implemented"). This note checks each phase
against the code as it is today and proposes the first slice.

## The ask, in the operator's words

"At one point we were talking about Dynasty trust also having a sovereign
package that runs on Nostr relays instead of emailing the Internet, and all
of that -- I don't know if we ever did anything with that." Chip: "DynastyTrust
sovereign plan."

## Where each phase stands today (read from the code, not the plan)

| Phase (from the design) | Today | Evidence |
|---|---|---|
| 1. Client-side compile (drop Fly) | **Started, checking only.** The browser runs rust-miniscript, but only to re-derive an address. Building vaults and PSBTs is still the Fly compiler (13 endpoints). | `protocol-wasm/src/lib.rs` exposes one function, `descriptor_address`. `compiler/src/main.rs` routes `/compile*`, `/psbt-*`, `/governance/*`. The `protocol` crate's dependencies are all pure Rust (bitcoin, miniscript, serde, hex, thiserror), so it can build for the browser. |
| 2. Docker compose self-host | **Not started.** No compose file, no Dockerfile for the app. | repo root |
| 3. Local identity (no email) | **Partly.** Username and Tapit sign-in exist, but each is still a Supabase account. | `username-signup.js`, `key-signup.js`, `wallet-signin-verify.js` |
| 4. Signed event log | **Partly, server-authored.** `vault_ledger` is hash-chained, append-only and OpenTimestamps-anchored, but the server writes it; members do not sign entries. | `netlify/functions/_ledger.js`, `vault_ledger`, `vault_ledger_anchors` |
| 5. Nostr relay transport | **Partly, for side channels.** Nostr carries Tapit sign-in, co-sign requests and replies, circle safety phrases and their acks, membership notices, with user relay settings and an outbox. Vault state itself (vaults, members, proposals, messages) lives only in Supabase. | `packages/nostr-transport`, `apps/web/src/lib/*nostr*`, `circle-*`, `psbt-cosign-response-channel.ts`, `nostrRelayPrefs.ts` |
| 6. Tauri single download | **Not started.** | -- |
| 7. Onion peer transport | **Not started.** | -- |
| 8. Signed releases + IPFS pin | **Not started.** | -- |
| (chain source) Own node instead of mempool.space | **Not started.** Balances, fees and broadcast use mempool.space only (threat model K). | `netlify/functions/_chain.js`, `apps/web/src/lib/chain.ts` |

Server footprint today: 50 Netlify functions, about 30 Supabase tables.

## The first slice proposed: the whole compiler in the browser

Phase 1, finished. Build the same `protocol` crate the Fly compiler uses into
the browser module (`protocol-wasm`), exposing: compile (named-field,
leaf-list, Bloc, tranche), PSBT build for each shape, merge and finalize.
Same Rust code, same library versions, so the results must be byte-identical;
the proof is that they ARE, not that they should be:

- run every vault in the offline harness (76 compiled vaults today) and every
  PSBT case through BOTH the Fly compiler and the browser module, and require
  identical descriptors, addresses and PSBT bytes;
- the Bitcoin Core proof (`scripts/bitcoin-core-proof.mjs`) spends a vault
  built by the browser module.

Why first: it is the one hosted piece that holds no data, so it can move
without touching accounts, and it removes a server that today must be
trusted to build the right vault. Every later phase needs it.

## Decisions that are yours

1. **Where the browser compiler is used.** (a) Only as sovereign
   groundwork: built and proven, the hosted site keeps calling Fly
   (Recommended for the first slice -- no change for families). (b) The
   hosted site switches to it too and Fly is retired; the server must then
   re-check what the browser built (same module in Node) before saving.
2. **Which slice after this one.** Own chain source (your node instead of
   mempool.space; also closes threat model K), or the self-host package
   (phase 2), or local identity (phase 3).
3. **Download size.** Building vaults needs miniscript's policy compiler;
   the browser module grows (today's check-only module is small). Accept the
   larger first-load, or load it only when a vault is being built
   (Recommended).

## Blast radius

- `protocol-wasm/` (new exports, rebuilt `.wasm`, its source-hash manifest
  and `scripts/test-protocol-wasm.mjs`), `protocol/` only if a function needs
  a browser-safe entry point (no behaviour change allowed).
- `apps/web/src/lib/descriptor-check.ts` (loads the module today) and a new
  browser compiler wrapper. With decision 1(a) no page, function, table or
  message changes; with 1(b): `api.ts` compile/PSBT calls, `compile.js`,
  `vaults-compile*.js`, `compile-leaves.js`, `psbt-*.js`, the finalize guard,
  the tip-plus-offset timelock conversion (today server-side), the Fly
  deploy workflow, `COMPILER_URL` / `COMPILER_SECRET`.
- `netlify.toml` CSP already allows WebAssembly (`'wasm-unsafe-eval'`).
- Money-touching: vault addresses, timelock heights and PSBTs. That is why
  the proof is parity against the existing compiler on every known case
  before anything uses it.

## Deliberately left out of this slice

- Accounts, the database, Nostr for vault state, the desktop app, Tor,
  onion peers, release signing (phases 2-8).
- Any change families can see (with 1a).
- Governance endpoints (`/governance/*`): read-only helpers, next slice.

## Then

One slice end to end: browser module with parity proven on every harness
case, gates green, the Core spend from a browser-built vault, on the branch;
nothing to main until the ship chip.

## Decisions taken (operator chips, 2026-11-13)

Groundwork only (the live site keeps the Fly compiler); next slice: your
own Bitcoin node; load the compiler only when building. Then, after
reading the code: about 2,000 of main.rs's lines were request logic inside
the server's handlers, not in the shared library -- the operator chose to
MOVE that logic into the library (one copy), not copy it.

## Built (slice 1, on the branch)

- Step 1 (b54c343): `protocol/src/service.rs` holds the 12 handlers' logic;
  `compiler/src/main.rs` keeps same-named thin wrappers. Proven unchanged:
  231 recorded server answers (`scripts/fixtures/compiler-reference.jsonl`)
  replayed against the reshaped server, 39 + 130 Rust tests, the harness.
- Step 2: `compiler-wasm/` runs `service::handle` in the browser;
  `apps/web/src/lib/browser-compiler.ts` loads it on first use; nothing in
  the app calls it yet. 2,831,736 bytes (1.55 MB compressed), no imports.
  All 231 answers reproduced (181 byte-identical; 50 identical JSON with
  the `leaf_scripts` HashMap in another order -- the server itself varies
  that order run to run). Bitcoin Core 32.1 proof, 14 checks, run with NO
  compiler server: every compiler call answered by the browser module.
