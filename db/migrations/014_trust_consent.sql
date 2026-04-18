-- ============================================================
-- 014_trust_consent.sql
-- Optional beneficiary-consent gate on Path 1 (founders-now).
-- When set, every "normal" spend needs both the trustee quorum
-- AND a beneficiary quorum to sign. The timelocked recovery /
-- inheritance / protector paths are intentionally unaffected --
-- those exist precisely to rescue funds when a beneficiary
-- won't or can't cosign (legal dispute, incapacitation, etc).
--
-- Real-world shape: Sarah holds a key, trustees hold theirs. A
-- monthly spend needs 2-of-3 trustees AND Sarah. If trustees try
-- to take her money, she refuses to sign -- they wait 3 months,
-- then recovery path opens, and at that point the protector or
-- successor can step in with timelocked authority.
--
-- Only the Rust compiler enforces this via Bitcoin script; the
-- schema columns just round-trip the config.
-- ============================================================

alter table vaults
  add column if not exists consent_keys   jsonb not null default '[]'::jsonb,
  add column if not exists consent_quorum integer;
