-- ============================================================
-- 20261128140000_purse_paying.sql
-- The family purse, slice 3: the treasurer pays an approved Lightning
-- payout from the family's wallet (Nostr Wallet Connect), and the
-- payment's receipt is checked and kept.
--
-- vault_requests gains payment_hash: the invoice's payment hash, in the
-- clear. It reveals nothing about who is paid. Every signer's phone checks
-- it against the invoice before signing; the server checks the receipt
-- against it, so the server never needs to read the invoice.
--
-- purse_payments: one row per request (the primary key is the request, so
-- two phones cannot both start paying it). 'started' counts against the
-- monthly cap until it ends 'paid' (with a preimage whose sha256 is the
-- payment hash -- only the person paid could have handed it back) or
-- 'failed' (the wallet said no, so nothing left). Written only by
-- /api/vault-purse-pay; owner and active members read.
--
-- Additive only.
-- ============================================================

alter table vault_requests add column if not exists payment_hash text check (payment_hash is null or payment_hash ~ '^[0-9a-f]{64}$');

create table if not exists purse_payments (
  request_id   uuid primary key references vault_requests(id) on delete cascade,
  vault_id     uuid not null references vaults(id) on delete cascade,
  amount_sats  bigint not null check (amount_sats > 0),
  status       text not null check (status in ('started', 'paid', 'failed')),
  started_by   uuid not null references auth.users(id) on delete cascade,
  started_at   timestamptz not null default now(),
  preimage     text check (preimage is null or preimage ~ '^[0-9a-f]{64}$'),
  fee_sats     bigint check (fee_sats is null or fee_sats >= 0),
  failure      text,
  ended_at     timestamptz,
  check ((status = 'paid') = (preimage is not null))
);

create index if not exists purse_payments_vault_idx on purse_payments(vault_id, started_at);

alter table purse_payments enable row level security;

drop policy if exists "members_read_purse_payments" on purse_payments;
create policy "members_read_purse_payments" on purse_payments
  for select to authenticated
  using (
    exists (select 1 from vaults v where v.id = vault_id and v.user_id = auth.uid())
    or exists (select 1 from vault_members m where m.vault_id = purse_payments.vault_id and m.user_id = auth.uid() and m.status = 'active')
  );

revoke insert, update, delete on purse_payments from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'purse_payments') then
    alter publication supabase_realtime add table purse_payments;
  end if;
end $$;
