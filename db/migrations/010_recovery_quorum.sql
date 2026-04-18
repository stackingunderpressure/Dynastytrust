-- ============================================================
-- 010_recovery_quorum.sql
-- Fix the "Recovery" spending path so it's materially different
-- from the "Trustees now" path.
--
-- Before this: Path 2 used the same keys + quorum as Path 1, just
-- with a timelock in front. That's Bitcoin-valid but a semantic
-- no-op -- anyone who could sign Path 2 could already sign Path 1
-- today. The recovery branch provided no real capability.
--
-- After this: a separate `recovery_quorum` is stored per vault. If
-- the trust wants "3-of-3 normally, 2-of-3 after 3 months as
-- insurance against losing one device", that's now expressible.
--
-- Existing compiled vaults keep their descriptors unchanged; this
-- column is null on legacy rows and the compiler treats null as
-- "use the founder quorum" for backwards compat.
-- ============================================================

alter table vaults
  add column if not exists recovery_quorum integer;
