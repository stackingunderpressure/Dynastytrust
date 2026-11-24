# Build note: retire the Fly compiler -- one compiler, ours

Operator, 2026-11-24, on hearing a rule change must land in two compilers:
"We still need fly? Isn't our browser compiling?" -- then, choosing between
changing both now or retiring Fly first: **"Retire Fly first."**

## What would be built

Every server function that today POSTs to the Fly compiler
(`dynastytrust-compiler.fly.dev`) instead runs the SAME Rust in-process as
the committed compiler WebAssembly, exactly as the fresh-address functions
already do. After this, there is one compiler: the `.wasm` file in this repo,
held to its Rust source and to every recorded Fly answer by the tests. Fly is
left running, unused, for one release (the `git revert` target), then shut
down by the operator.

## What is true today (read from the code)

- Fly (`compiler/src/main.rs`) is a thin wrapper: all 12 routes call
  `protocol::service` (`svc::compile`, `svc::psbt_binary`, ...). The
  WebAssembly runs that same `service.rs`; `scripts/test-compiler-wasm.mjs`
  replays 231 recorded Fly answers through it, all identical.
- 14 functions still call Fly: compile, compile-bloc, compile-tranche,
  compile-leaves, vaults-compile, vaults-compile-bloc (vault creation);
  psbt-binary, psbt-binary-bloc, psbt-binary-tranche (spend building);
  psbt-merge, psbt-finalize (signing); governance, proposals
  (`/governance/audit`, `/governance/status`); vaults (`/validate-address`).
  Five go through `_compiler.js` `fetchCompiler` (timeout + cold-start
  retry), nine call `fetch` directly.
- The fresh-address pieces already run the WebAssembly in-process
  (`_ranged-wasm.js` `callWasm`, sha256-checked against its manifest).

## Blast radius

- `netlify/functions/_compiler.js`: becomes the one way to reach the
  compiler -- an in-process call returning the same status and JSON the Fly
  server would have sent, so each caller's own parsing and error wording stay
  as they are. The 14 functions switch to it; the `COMPILER_URL` /
  `COMPILER_SECRET` "not configured" branches go.
- `netlify.toml`: every one of those functions ships the `.wasm` and its
  manifest (the held hotfix a9553a4 and its test `test-wasm-bundling.mjs`
  already cover the fresh-address six; the test then covers all 20).
- Tests that stand in a fake Fly (test-compile-full-row, test-dust-change,
  test-finalize-guard, test-invite-handlers, test-vault-rules-standard /
  -leaves / -spend) mock `fetchCompiler` or `fetch`; they are pointed at the
  new call (they keep proving each function's own rules with a stand-in;
  the compiler's answers are proven by test-compiler-inprocess, all 231
  recorded Fly requests).
- Proofs and tools that talk to a compiler over HTTP (offline-harness.sh,
  offline-vault-harness.mjs, compiler-parity.mjs, bitcoin-core-proof.mjs,
  signet-core-spend.mjs) already have a WebAssembly mode or keep HTTP for
  the parity check; the Bitcoin Core proof is re-run in WebAssembly mode.
- Not changed: the browser (it never called Fly), the database, any vault,
  any address, any PSBT byte (same Rust).
- CLAUDE.md: Stack, Deployments, the env-var table, "Fly.io compiler
  endpoints" and the "Non-JSON from compiler" known issue describe Fly; they
  are rewritten to describe the one compiler.
- `deploy-compiler.yml`: left in place for the one release; removed with the
  shutdown.
- Operator-side after the release, by hand: stop the Fly app; remove
  `COMPILER_URL` and `COMPILER_SECRET` from Netlify's environment.

## Deliberately left out

The "if untouched for" rule change (`docs/untouched-only-build-note.md`) --
it comes right after this, in one place. Moving compiling into the browser
itself (the downloaded app already does that; the website keeps compiling on
its own server so a phone cannot be handed a different vault).

## Release

Held, with everything else on the branch (the Shape-step fix 6c9409a, the
bundling hotfix a9553a4, then the rule change), for the operator's word.

## Built (2026-11-24, branch only)

- `_compiler.js` answers in-process (`callWasmText`); 14 functions switched;
  every "COMPILER_URL not set" branch removed (503s, psbt-binary's JSON
  fallback, governance's no-URL shortcut -- its JS answer on a compiler
  ERROR stays); two log lines that named the removed variables fixed before
  they could throw.
- `vaults.js` address validation used to SKIP when COMPILER_URL was unset
  (fail-open); it now always validates.
- netlify.toml: 17 functions ship the .wasm (test-wasm-bundling).
- Proof: test-compiler-inprocess 3 cases (231 recorded requests identical);
  Bitcoin Core 32.1 one-address proof in WebAssembly mode 14/14; npm test
  exit 0; build exit 0; lint 0 errors / 9 warnings; typecheck the same 10.
- Left: the offline harness still starts the compiler HTTP binary (a dev
  tool; it proves the same Rust). After the release, by the operator: stop
  the Fly app, remove COMPILER_URL / COMPILER_SECRET from Netlify, then the
  deploy-compiler workflow goes.
