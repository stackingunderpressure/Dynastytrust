-- ============================================================
-- 027_backup_path.sql
-- "Anytime, harder" fallback leaf (2026-08-08). An untimelocked
-- branch over a SEPARATE key set the owner controls directly --
-- e.g. keys physically split across several locations -- at a
-- quorum typically stricter than founder_quorum. Occupies the
-- same conceptual slot the timelocked recovery branch does, but
-- is spendable immediately: the friction is retrieving enough of
-- the backup keys, not waiting out a clock.
--
-- Mutually exclusive with the timelocked recovery branch
-- (recovery_after > 0) -- the Rust compiler rejects a policy that
-- sets both (BackupConflictsWithRecovery). Not a vault_members
-- role: these are the owner's own keys, configured directly at
-- compile time (direct_keys mode), never invited or held by
-- someone else -- no vault_members/vault_invites role-enum change
-- needed, unlike protector_path's 012 migration.
-- ============================================================

alter table vaults
  add column if not exists backup_keys     jsonb not null default '[]'::jsonb,
  add column if not exists backup_quorum   integer;
