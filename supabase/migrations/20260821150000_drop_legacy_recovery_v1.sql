-- ============================================================
-- drop_legacy_recovery_v1.sql
-- Retires the original (Shamir/XOR, database-backed) Legacy Recovery
-- mechanism entirely. Operator: "I don't think we need to keep anything
-- of the old version. I just didn't like it. None of it worked. None of
-- it's gonna be used." Replaced by the on-chain, signature-based
-- mechanism (see apps/web/src/lib/legacy-recovery.ts's header) which
-- needs no database at all -- the Bitcoin blockchain is the only place
-- a recovery bundle ever lives now.
--
-- Drops all three tables this mechanism ever used, in full, including
-- the signature-unlock columns added in
-- 20260818203809_legacy_shares_signature_unlock.sql and the fingerprint
-- column added in 20260820120000_legacy_recovery_descriptor_fingerprint.sql
-- -- those migrations are left in place as history (never edit or delete
-- a past migration), this one just reverses their effect going forward.
-- The netlify/functions/vault-legacy.js and legacy-lookup.js endpoints
-- that read/wrote these tables have been deleted from the codebase in
-- the same change.
-- ============================================================

drop table if exists vault_legacy_shares;
drop table if exists vault_legacy_onchain_shares;
drop table if exists vault_legacy_bundles;
