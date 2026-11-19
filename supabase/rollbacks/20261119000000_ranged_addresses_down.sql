-- ============================================================
-- Undo 20261119000000_ranged_addresses.sql -- run BY HAND only.
-- Lives outside supabase/migrations/ so the deploy never runs it.
--
-- Refuses, changing nothing, if any vault is v2 or any address was ever
-- issued: an issued address may hold coins, and its record is never
-- discarded quietly. Run inside one transaction; any failure undoes all.
-- ============================================================

do $$
begin
  if exists (select 1 from vaults where descriptor_version = 2) then
    raise exception 'refusing rollback: a vault uses ranged (v2) addresses';
  end if;
  if to_regclass('public.vault_addresses') is not null
     and exists (select 1 from vault_addresses) then
    raise exception 'refusing rollback: addresses have been issued';
  end if;
end $$;

drop trigger if exists vaults_freeze_compiled on vaults;
drop function if exists vaults_freeze_compiled();
drop function if exists reserve_vault_address_index(uuid, smallint);
drop trigger if exists vault_addresses_guard on vault_addresses;
drop table if exists vault_addresses;
drop function if exists vault_addresses_guard();
drop table if exists vault_address_branches;
alter table vaults drop constraint if exists vaults_descriptor_version_shape;
alter table vaults drop column if exists ranged_format;
alter table vaults drop column if exists descriptor_change;
alter table vaults drop column if exists descriptor_receive;
alter table vaults drop column if exists descriptor_multipath;
alter table vaults drop column if exists descriptor_version;

notify pgrst, 'reload schema';
