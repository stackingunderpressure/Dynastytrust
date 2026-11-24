-- ============================================================
-- ONE-TIME RESET OF TEST DATA -- run by hand, deliberately. NOT a migration.
--
-- Why: zero-knowledge storage (docs/zero-knowledge-storage-plan.md) starts
-- scrambling data from now on. Rows written before it stay readable, and the
-- history ledger can't be rewritten, so the operator chose (2026-11-24) to
-- start clean while there are no real users.
--
-- What it deletes: every vault and everything hanging off a vault (members,
-- invites, proposals, signatures, comments, requests, stipends, distribution
-- wallets, messages, attestations, liveness signals, membership grants,
-- circle-phrase deliveries, vault keys, the history ledger and its anchors),
-- plus sent secrets and assistant threads.
-- What it keeps: user accounts, sign-in identities, messaging-key backups.
--
-- The ledger tables refuse deletes by design (append-only triggers); this
-- script disables those triggers ONLY inside this transaction and re-enables
-- them before committing. If anything fails, the whole thing rolls back.
--
-- How: Supabase dashboard -> SQL editor -> paste -> run. Check the counts it
-- prints first. Irreversible once committed.
-- ============================================================

begin;

select 'before' as at,
  (select count(*) from vaults) as vaults,
  (select count(*) from proposals) as proposals,
  (select count(*) from vault_ledger) as ledger_entries;

alter table vault_ledger disable trigger vault_ledger_no_update;
alter table vault_ledger disable trigger vault_ledger_no_truncate;
alter table vault_ledger_anchors disable trigger vault_ledger_anchors_no_update;
alter table vault_ledger_anchors disable trigger vault_ledger_anchors_no_truncate;

delete from vault_ledger_anchors;
delete from vault_ledger;
delete from vaults;            -- cascades to every vault-scoped table
delete from sent_secrets;
delete from assistant_threads; -- cascades to assistant_messages

alter table vault_ledger enable trigger vault_ledger_no_update;
alter table vault_ledger enable trigger vault_ledger_no_truncate;
alter table vault_ledger_anchors enable trigger vault_ledger_anchors_no_update;
alter table vault_ledger_anchors enable trigger vault_ledger_anchors_no_truncate;

select 'after' as at,
  (select count(*) from vaults) as vaults,
  (select count(*) from proposals) as proposals,
  (select count(*) from vault_ledger) as ledger_entries;

commit;
