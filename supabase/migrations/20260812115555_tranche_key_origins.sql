-- ============================================================
-- 037_tranche_key_origins.sql
-- BIP32 origins for tranche hardware-wallet compatibility
-- (2026-08-12). Mirrors the 2026-08-06 fix already applied to
-- the standard vault (psbt-binary.js reads fingerprint +
-- derivation_path from vault_members) and to Bloc vaults
-- (vaults.bloc_policy.key_origins) -- distribution_wallets was
-- the one vault family left out. protocol/src/psbt_builder.rs's
-- build_tranche_spend_psbt and compiler/src/main.rs's
-- /psbt-binary-tranche endpoint already accept and correctly
-- attach key_origins (tested); the gap was purely that nothing
-- ever stored or forwarded them for a tranche. Without this, a
-- real hardware wallet (SeedSigner included) has no BIP371-
-- compliant way to recognize its own key on a tranche claim's
-- leaf and correctly refuses to sign -- only the browser and
-- Tapit signers, which match by searching the leaf script bytes
-- directly, ever worked for a tranche claim.
--
-- key_origins holds one entry per key that might ever need to
-- sign a tranche -- the beneficiary and every trustee --
-- {pubkey, fingerprint, derivation_path}, same shape Bloc
-- already uses. Existing distribution_wallets rows default to
-- an empty array; hardware-wallet signing on THOSE tranches
-- keeps degrading gracefully to browser/Tapit-only until the
-- wallet is recreated, same documented fallback behavior the
-- 2026-08-06 fix already established for an empty key_origins.
-- ============================================================

alter table distribution_wallets
  add column if not exists key_origins jsonb not null default '[]'::jsonb;
