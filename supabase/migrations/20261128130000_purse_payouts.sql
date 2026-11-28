-- ============================================================
-- 20261128130000_purse_payouts.sql
-- The family purse, slice 2: payout requests pick a road, and the
-- family's yeses are signed (operator, 2026-11-28: "if someone from the
-- family brings something of value to the family ... we pay out 50 bucks
-- either through on-chain or lightning").
--
-- vault_requests gains:
--   road            'onchain' | 'lightning' (null = a request from before
--                   the purse, handled exactly as before)
--   invoice         the Lightning invoice, sealed with the vault key
--   invoice_sha256  its fingerprint, in the clear, so every yes is bound
--                   to the exact invoice without the server reading it
--   expires_at      after this an unanswered request lapses
--
-- purse_yeses: one signed yes per member per request. The signature is a
-- DT-ATT-v1 attestation (type purse_payout_yes) by the member's own
-- registered vault key over the request's vault, id, amount, road and
-- invoice fingerprint. Written only by /api/vault-purse-yes, which checks
-- all of that; owner and active members read.
--
-- Additive only: new columns default to null and a new table.
-- ============================================================

alter table vault_requests add column if not exists road text check (road is null or road in ('onchain', 'lightning'));
alter table vault_requests add column if not exists invoice text;
alter table vault_requests add column if not exists invoice_sha256 text check (invoice_sha256 is null or invoice_sha256 ~ '^[0-9a-f]{64}$');
alter table vault_requests add column if not exists expires_at timestamptz;

create table if not exists purse_yeses (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references vault_requests(id) on delete cascade,
  vault_id    uuid not null references vaults(id) on delete cascade,
  member_id   uuid not null references vault_members(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  pubkey      text not null check (pubkey ~ '^[0-9a-f]{64}$'),
  sig         text not null unique check (sig ~ '^[0-9a-f]{128}$'),
  target_hash text not null check (target_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  unique (request_id, member_id)
);

create index if not exists purse_yeses_request_idx on purse_yeses(request_id);

alter table purse_yeses enable row level security;

drop policy if exists "members_read_purse_yeses" on purse_yeses;
create policy "members_read_purse_yeses" on purse_yeses
  for select to authenticated
  using (
    exists (select 1 from vaults v where v.id = vault_id and v.user_id = auth.uid())
    or exists (select 1 from vault_members m where m.vault_id = purse_yeses.vault_id and m.user_id = auth.uid() and m.status = 'active')
  );

revoke insert, update, delete on purse_yeses from anon, authenticated;

-- Live updates on the Requests tab when a yes lands. Guarded so a re-run,
-- or a database without the publication (local tests), does not fail.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'purse_yeses') then
    alter publication supabase_realtime add table purse_yeses;
  end if;
end $$;
