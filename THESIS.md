# DynastyTrust -- Complete Technical Thesis

## 1. What it is
DynastyTrust is a non-custodial Bitcoin "multi-generational vault" platform. Families,
trusts, and organizations use it to hold Bitcoin under governed, multi-signer spending
policies that encode inheritance, recovery, and supervision directly into Bitcoin
script -- no custodian, no third party holding keys. The thesis: a Bitcoin trust should
be enforced by consensus rules and timelocks, not by a company's promise. The trust
document (legal text) and the on-chain policy (miniscript) are kept in lockstep.

## 2. Core model -- spending paths compiled into one Taproot output
Every vault is a single Taproot address whose alternative spending conditions are
separate script leaves ("multileaf"). A vault has up to four conditional paths:

- Path 1 -- Founders Now (immediate):     thresh(Q_f, founder_keys)
    optional beneficiary gate:           and(thresh(Q_f, founders), thresh(Q_c, consent_keys))
- Path 2 -- Recovery (timelocked):        and(after(R), thresh(Q_r, founder_keys))
- Path 3 -- Inheritance (timelocked):     and(after(I), thresh(Q_h, heir_keys))   where I > R
- Path 4 -- Protector (optional):         and(after(P), thresh(Q_p, protector_keys))  where R < P < I

Quorums are independent per path (e.g. founders 2-of-3 now, but recovery 1-of-3 as
device-loss insurance; heirs 2-of-3; protector 1-of-1). A "plain" vault sets no heirs
and no timelocks, collapsing to a simple N-of-M multisig (optionally consent-gated).

The Protector path lets a non-spending supervisor (trust lawyer, institutional
watchdog) rescue funds after P blocks if trustees go rogue -- power enforced by the
policy, not by day-to-day key possession.

## 3. Timelocks are ABSOLUTE CLTV -- the single most important rule
All timelocks use miniscript `after(N)` which compiles to OP_CHECKLOCKTIMEVERIFY -- an
ABSOLUTE block height. `older(N)` (CSV, relative) is deliberately NOT used because BIP68
caps CSV at 65,535 blocks (~15 months), too short for multi-year inheritance windows.
This matches Liana's design.

The flow: callers/UI think in RELATIVE offsets ("6 months ~= 26,280 blocks"). The Netlify
`compile.js` function fetches the current chain tip from mempool.space and forwards
`tip + offset` to the Rust compiler. The compiler bakes that absolute height into the
leaf. The resulting absolute heights (recovery_after, inheritance_after, protector_after)
are stored in the vaults table; the UI subtracts current tip to display "unlocks in N
months". CRITICAL: if the tip is NOT added, `after(26280)` compiles to a height long past
on any live chain, so every timelocked path unlocks at funding. Equally critical: when
building a spend PSBT later, the SAME absolute heights must be used to rebuild the leaf
tree, or the merkle root differs from the funded address and finalize fails with a
control-block error. Tranche/T-vesting wallets are absolute by design (`unlock_block` set
directly). Spending a timelocked path requires `tx.lock_time = N`; the PSBT builder
accepts a `path` field ("founders_now" | "recovery" | "inheritance" | "protector") and
sets lock_time from the stored absolute height (founders_now = 0).

## 4. Address type -- always `tr_multileaf`
Default and required address type is `tr_multileaf`: each spend path is its own Taproot
leaf. Using single-leaf `tr` causes `DuplicatePubKeys` because founder keys appear in both
the founders-now and recovery expressions in one script. The internal key is an
unspendable NUMS point. PSBTs carry per-leaf control blocks so hardware wallets (target:
Nunchuk, Sparrow, Coldcard) can verify leaf membership. `wsh` (P2WSH) exists only for
legacy compatibility.

## 5. Keys never leave the browser
Private keys and BIP39 mnemonics are generated and stored in browser localStorage only.
Only xpubs and pubkey hex (public, safe) are ever sent to the server or compiler.
`lib/keystore.ts` is the single source of truth. Two modes:
- Test mode: 24-word mnemonic stored plaintext, no password, instant -- never for real funds.
- Secure mode: mnemonic encrypted with AES-256-GCM via PBKDF2 (210,000 rounds); password
  required to decrypt and sign; backup-with-verify flow (re-enter words).
Derivation: BIP48 multisig path `m/48'/{coin}'/0'/2'` (coin 0 mainnet, 1 test/signet).
The pubkey/key material sent to the compiler is the FIRST receive-chain child `.../0/0`
(not the account-level key), so the compiler's address and the wildcard descriptor's
first address agree -- without this, a Nunchuk import would show an empty balance at the
funded address. Fingerprint is BIP32-standard: first 4 bytes of HASH160(pubkey).
Descriptors are upgraded to key-origin form `pk([fp/path]xpub/0/*)` for HW-wallet import.

## 6. PSBT signing flow (browser-first)
1. Browser calls /api/psbt-binary (Netlify -> Fly.io Rust) to build the unsigned PSBT.
   Coin selection: UTXOs sorted by value desc, greedily chosen until >= amount + fee.
   witness_utxo attached (BIP174); for Taproot, tap_scripts (control block + leaf) and
   tap_internal_key (NUMS) attached. Sequence = 0xfffffffd (RBF on, CSV off).
2. Browser parses the PSBT in lib/psbt-signer.ts (no server).
3. Per required signer: derive privkey at m/48'/{coin}'/0'/2'/0/0, compute the BIP341
   tapscript sighash, Schnorr-sign via @noble/curves/secp256k1 (64-byte sigs).
4. Merge partial sigs in-browser with mergePsbts() (same unsigned tx required).
5. Finalize via /api/psbt-finalize (Fly.io miniscript finalizer -> raw tx hex + txid).
6. Broadcast directly from the browser to mempool.space.

## 7. Governance engine (stateless, pure logic -- protocol/src/governance.rs)
Given a policy + a block context it deterministically reports which paths are active.
Note: timelock evaluation uses UTXO age in blocks, and the engine returns active_paths,
phase (Active | RecoveryUnlocked | InheritanceUnlocked), blocks/days until each unlock
(144 blocks/day). evaluate_spend_proposal returns allowed = (timelock_satisfied AND
quorum_satisfied) plus the pending signer indices. audit_spend applies built-in rules:
GOV-001 timelock not satisfied, GOV-002 quorum not met, GOV-003 output below 546-sat
dust, GOV-004 spend exceeds balance (all blocking); GOV-005 large spend >50% (warning);
GOV-006/007 inheritance/recovery path used, GOV-008 single signer (info). The audit is
stored on the proposal as governance_audit jsonb.

## 8. Vault templates (defined in PolicyBuilder.tsx)
Each template ships config + "what happens if..." scenario playbooks + an attorney-ready
trust-doc draft (purpose, beneficiaries, distribution rules). Representative set:
- Solo Savings: 1-of-1, no heirs/timelocks.
- Couples: 2-of-2 founders, no heirs/timelocks.
- Family Inheritance (most common): founders 2-of-3; heirs 2-of-3; recovery ~6mo
  (26,280 blk), inheritance ~2yr (105,120 blk).
- Generational Trust (institutional): founders 3-of-5; heirs 2-of-3; recovery ~1yr;
  inheritance ~3yr; protector 1 party ~9mo; consent gate (a beneficiary cosigns Path 1).
- Business Treasury: 3-of-5 directors, plain mode (no heirs/timelocks).
- Lost-Device Insurance: one person holds 3 keys on 3 devices; 2-of-3 now, lower-quorum
  recovery + self-inheritance for resilience without trusted third parties.
- [TEST] variants: same shapes with tiny block offsets (8/10/15/30/45) so a full
  inheritance drama runs in an afternoon on signet.

## 9. T-vesting / distribution wallets
Separate from the main vault: scheduled distributions as independent single-tranche
Taproot wallets. Each tranche: Leaf 1 = beneficiary alone after a fixed unlock_block
(and(after(N), pk(beneficiary))); Leaf 2 = trustees any time (thresh(Q, trustees)) as an
escape hatch. Compiled per-tranche via /compile-tranche and batch-saved
(distribution_wallets table). Used for monthly/quarterly stipends.

## 10. Stack and topology
- Frontend: React 19 + TypeScript + Vite, deployed on Netlify (dynastytrust.family).
  Routed app (react-router-dom), shared design system (Button/Input/Label/Card/Field +
  toast), session guard (RequireAuth), centralized config/theme. Pages: Landing, Auth,
  KeyManager, Keyring, PolicyBuilder, Dashboard, VaultDetail, ProposalDetail, InviteClaim,
  Reminders. Dashboards are role-aware (trustee/heir/protector/beneficiary).
- Backend: Netlify serverless functions (Node ESM) -- compile.js (tip+offset -> Fly),
  vaults.js (CRUD + role attach), proposals.js, psbt-binary/-merge/-finalize.js,
  balance.js, governance.js, distribution-wallets.js, vault-pdf.js, plus _auth.js (JWT
  verify) and _supabase.js (admin client). Auth is Supabase JWT bearer.
- Compiler: Rust (Axum) on Fly.io (dynastytrust-compiler.fly.dev). Endpoints: /health,
  /compile, /compile-tranche, /psbt-binary, /psbt-finalize, /psbt-merge,
  /governance/status, /governance/audit. All but /health require
  Authorization: Bearer <COMPILER_SECRET> (must match the Netlify env exactly, else you
  get non-JSON responses). Spins down when idle (~2-3s cold start).
- Protocol: Rust library (policy_compiler.rs, psbt_builder.rs, governance.rs) shared by
  the compiler. Pins: bitcoin 0.31.2, miniscript 11.2.3.
- Database: Supabase (Postgres), RLS on every table.
- Bitcoin data/broadcast: mempool.space (mainnet, testnet, signet).

## 11. Database schema (key tables)
- vaults: id, user_id, name, network, address, descriptor, miniscript_policy,
  address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after,
  inheritance_after (absolute heights), protector_keys/quorum/after, consent_keys/quorum,
  founder_keys/heir_keys (jsonb), trust_doc (jsonb), status (draft|compiled|archived),
  planned_*_count, predecessor_id, archived, created/updated_at.
- proposals: id, vault_id, path, destination, amount_sats, fee_sats, utxo_age_blocks,
  psbt_hex/_b64/_signed_hex, txid, status, governance_audit (jsonb), memo, timestamps.
- vault_members: vault_id, user_id, role (owner|founder|heir|protector|beneficiary|viewer),
  xpub, fingerprint, pubkey, derivation_path, key_label, status.
- distribution_wallets: vault_id, beneficiary key material, trustee_keys/quorum,
  tranches (jsonb: index, unlock_block, amount_sats, address, descriptor, funded/claimed txid).
- vault_events, signer_sessions: activity feed + per-signer partial-sig tracking.

## 12. Env vars
Frontend (baked into Vite bundle): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
Backend (Netlify runtime): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPILER_URL
(https://dynastytrust-compiler.fly.dev), COMPILER_SECRET (must match Fly.io).

## 13. Known gotchas (institutional memory)
- DuplicatePubKeys -> you used `tr`, default to `tr_multileaf`.
- "pubkey hex should be 66 digits" -> sending an xpub where pubkey hex is expected.
- "not a signer for any input" -> keys regenerated after compile; recompile the vault.
- Non-JSON from compiler -> COMPILER_SECRET mismatch.
- "Buffer is not defined" -> never use Node Buffer in browser; hex via
  Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('').
- Any vault compiled before the Nunchuk /0/0-child + BIP32-fingerprint fix is permanently
  mismatched vs Nunchuk (descriptor+address pair is immutable) -- recompile from a fresh draft.

## 14. One-paragraph summary
DynastyTrust turns a Bitcoin Taproot output into a programmable trust: a multi-leaf
script with an immediate founders path, an absolute-CLTV recovery path, an inheritance
path for heirs, and an optional protector path -- each with its own quorum. Relative
human-friendly timelock offsets are converted to absolute block heights at compile time
(tip + offset) and stored; spends must reuse those exact heights. Keys and mnemonics live
only in the browser (plaintext test mode or AES-256-GCM secure mode), signing is BIP341
Schnorr done client-side, and the server/compiler only ever see public xpubs/pubkeys. A
stateless Rust governance engine reports active paths and audits proposed spends; a React
frontend pairs each policy with an editable, attorney-ready trust document and role-aware
dashboards. Compilation and PSBT assembly run on a Fly.io Rust service; state lives in
Supabase with RLS; chain data and broadcast go through mempool.space.
