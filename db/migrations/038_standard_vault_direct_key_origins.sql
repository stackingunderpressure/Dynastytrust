-- ============================================================
-- 038_standard_vault_direct_key_origins.sql
-- BIP32 origins for a direct_keys-compiled standard vault
-- (2026-08-12). psbt-binary.js's hardware-wallet key_origins
-- lookup (the 2026-08-06 fix) reads exclusively from
-- vault_members -- but vault_members is one row per HUMAN signer
-- (unique(vault_id, user_id)), and vaults-compile.js's direct_keys
-- mode is exactly the case where a single owner brings every key
-- themselves without ever inviting anyone, so vault_members never
-- gets a row for those keys at all. The lookup silently returns
-- an empty array and every direct_keys vault degrades to
-- browser/Tapit-only signing -- the same gap Bloc vaults
-- (vaults.bloc_policy.key_origins) and tranche wallets
-- (037_tranche_key_origins.sql) already closed by storing
-- key_origins directly on the policy/vault row instead of trying
-- to force a one-row-per-key shape into a one-row-per-human table.
--
-- key_origins holds one entry per key across every role
-- (founders, heirs, protector, consent, backup, second heirs) --
-- {pubkey, fingerprint, derivation_path}, same shape Bloc and
-- tranche already use. Existing rows default to an empty array;
-- an invite-based vault (vault_members already populated) simply
-- never populates this column and keeps working exactly as before.
-- ============================================================

alter table vaults
  add column if not exists key_origins jsonb not null default '[]'::jsonb;
