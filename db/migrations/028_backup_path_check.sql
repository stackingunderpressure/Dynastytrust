-- ============================================================
-- 028_backup_path_check.sql
-- Allow the 'backup' spend path on proposals. 027_backup_path.sql
-- added vaults.backup_keys/backup_quorum and the compiler/psbt-binary
-- side already routes path='backup', but the proposals_path_check
-- constraint (023_bloc_vaults.sql) never listed it -- any proposal
-- recording a backup-path spend would fail the CHECK at insert time.
-- ============================================================

alter table proposals
  drop constraint if exists proposals_path_check;

alter table proposals
  add constraint proposals_path_check
  check (path in (
    'founders_now', 'recovery', 'inheritance', 'protector', 'backup',
    'parents_now', 'coparent_kids', 'parent_solo', 'kids_decay'
  ));
