-- ============================================================
-- 041_vault_key_labels.sql
-- Per-key custom labels, independent of vault_members and independent
-- of BIP32 origin completeness (2026-08-15, operator: "the vault with
-- the circle of people on tap it, they're not really founders. They
-- should be labeled like trustees, almost -- the one founder key is
-- the owner and anybody else can be the trustees... make sure that
-- each spot of every vault and every key has a spot to assign that
-- label to it where it needs to be").
--
-- Why not key_origins (038_standard_vault_direct_key_origins.sql /
-- 037_tranche_key_origins.sql)? That column exists for hardware-wallet
-- BIP32 origin data and is only ever populated for a key that has a
-- REAL fingerprint + derivation_path -- a Tapit-origin key deliberately
-- has neither (Cut C2: "no invented xpub", keystore.ts's
-- importTapitPubkey leaves fingerprint/derivationPath empty), so it
-- never gets a key_origins entry at all. The exact "circle of people on
-- Tapit" population the operator is naming would be silently excluded
-- from any labeling mechanism built on top of key_origins. key_labels
-- keys off the bare pubkey alone -- the one thing every key, of every
-- origin, always has -- so it covers Tapit, hardware, and software
-- keys uniformly.
--
-- Shape: jsonb array of {pubkey, label}. Not a map/object keyed by
-- pubkey because Postgres jsonb object keys can't be indexed/queried
-- as cleanly as an array the app already knows how to linear-scan (the
-- same array-of-objects shape key_origins already uses).
-- ============================================================

alter table vaults
  add column if not exists key_labels jsonb not null default '[]'::jsonb;

alter table distribution_wallets
  add column if not exists key_labels jsonb not null default '[]'::jsonb;
