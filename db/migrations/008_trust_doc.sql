-- ============================================================
-- 008_trust_doc.sql
-- Adds a structured "trust document" record to each vault. This
-- is the human-readable side of the trust: purpose, named
-- beneficiaries, distribution rules, and successor-trustee notes.
-- Shape isn't enforced by the DB -- the frontend owns it -- but
-- the field always exists and can't be null.
-- ============================================================

alter table vaults
  add column if not exists trust_doc jsonb not null default '{}'::jsonb;
