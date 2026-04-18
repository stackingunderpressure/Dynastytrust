-- ============================================================
-- 013_scheduled_stipends.sql
-- Recurring distributions on a schedule: monthly living expenses,
-- quarterly college tuition, annual charitable grants, trustee
-- fees. The app shows "stipends due" on the Dashboard; a trustee
-- taps through to a pre-filled Send form and signs. Bitcoin
-- signatures still required every time; this just removes the
-- "remember to file a request" friction.
--
-- Not Bitcoin-enforced vesting -- that's T-vesting with CLTV
-- tranches. This is purely a UX schedule layer over the existing
-- proposal/signing pipeline.
-- ============================================================

create table if not exists scheduled_stipends (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  vault_id           uuid not null references vaults(id) on delete cascade,
  name               text not null,
  recipient_name     text,
  destination        text,              -- optional: pre-filled destination addr
  rule_id            text,              -- links to trust_doc.rules[].id
  amount_sats        bigint not null,

  interval_kind      text not null
                       check (interval_kind in ('weekly', 'monthly', 'quarterly', 'annually')),
  next_due_at        timestamptz not null,
  last_proposed_at   timestamptz,
  last_proposal_id   uuid references proposals(id) on delete set null,

  active             boolean not null default true
);

create index if not exists scheduled_stipends_vault_id_idx on scheduled_stipends(vault_id);
create index if not exists scheduled_stipends_next_due_idx on scheduled_stipends(next_due_at)
  where active = true;

drop trigger if exists scheduled_stipends_updated_at on scheduled_stipends;
create trigger scheduled_stipends_updated_at before update on scheduled_stipends
  for each row execute function touch_updated_at();

alter table scheduled_stipends enable row level security;

drop policy if exists "members_see_stipends" on scheduled_stipends;
create policy "members_see_stipends"
  on scheduled_stipends for select using (is_vault_member(vault_id));

alter publication supabase_realtime add table scheduled_stipends;
