-- ============================================================
-- 20261128120000_vault_purse.sql
-- The family purse's rules (operator, 2026-11-28: "I want it a feature of
-- dynasty after a game ... if someone from the family brings something of
-- value to the family ... we pay out 50 bucks either through on-chain or
-- lightning way after the game even ends"; "Game master sets it at the
-- start, family vote later"; "With all inputs configurable").
--
-- One row per vault: the purse settings and who may change them. The
-- vault owner sets them while governance = 'owner'; the owner may hand
-- them to the family once ('family'), and that is one-way: after it every
-- change needs the family's yeses (a later slice). Every change is also
-- sealed into vault_ledger by the function, with who and when.
--
-- Written only by /api/vault-purse (service role); the owner and active
-- members may read their vault's row.
--
-- Additive only: a new table. No existing row changes.
-- ============================================================

create table if not exists vault_purse (
  vault_id         uuid primary key references vaults(id) on delete cascade,
  settings         jsonb not null default '{}'::jsonb,
  governance       text not null default 'owner' check (governance in ('owner', 'family')),
  handed_over_at   timestamptz,
  handed_over_by   uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null,
  check ((governance = 'family') = (handed_over_at is not null))
);

alter table vault_purse enable row level security;

drop policy if exists "members_read_purse" on vault_purse;
create policy "members_read_purse" on vault_purse
  for select to authenticated
  using (
    exists (select 1 from vaults v where v.id = vault_id and v.user_id = auth.uid())
    or exists (select 1 from vault_members m where m.vault_id = vault_purse.vault_id and m.user_id = auth.uid() and m.status = 'active')
  );

revoke insert, update, delete on vault_purse from anon, authenticated;
