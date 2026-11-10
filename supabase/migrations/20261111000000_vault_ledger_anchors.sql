-- vault_ledger_anchors: proof that a point in a vault's ledger existed
-- before a given Bitcoin block.
--
-- The ledger (20261110230000_vault_ledger.sql) makes any edit to PAST
-- entries break the chain. What a chain cannot show on its own is its
-- most recent entries being cut off, or the whole chain being replaced
-- by a different, internally consistent one by someone who controls
-- the database. An anchor closes that: the hash of (vault, position,
-- entry hash) is submitted to OpenTimestamps and ends up committed in a
-- Bitcoin block. From then on the ledger must still contain exactly
-- that entry at that position, or the mismatch is provable by anyone
-- holding the proof -- including a copy a member downloaded earlier.
--
-- Two kinds of row per anchor, both insert-only:
--   'pending'  the calendar's receipt, minutes after submission. It
--              leads from our digest to the calendar's commitment.
--   'bitcoin'  hours later: the continuation from that commitment to a
--              Bitcoin block's merkle root, plus the block height.
-- Nothing here is ever updated or deleted; an upgraded proof is a new
-- row beside the pending one.

create table if not exists vault_ledger_anchors (
  id              uuid        primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  vault_id        uuid        not null,
  seq             bigint      not null check (seq >= 1),
  entry_hash      text        not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  digest          text        not null check (digest ~ '^[0-9a-f]{64}$'),      -- what was submitted
  calendar        text        not null,
  kind            text        not null check (kind in ('pending', 'bitcoin')),
  commitment      text        not null check (commitment ~ '^[0-9a-f]{2,255}$'), -- the calendar's commitment
  proof_b64       text        not null,                                         -- the OpenTimestamps fragment
  bitcoin_height  integer     check ((kind = 'bitcoin') = (bitcoin_height is not null)),
  reason          text,                                                         -- 'milestone:<event>' | 'daily'
  unique (vault_id, seq, calendar, kind)
);

create index if not exists vault_ledger_anchors_vault_idx on vault_ledger_anchors(vault_id, seq);
create index if not exists vault_ledger_anchors_pending_idx on vault_ledger_anchors(kind, created_at);

create or replace function vault_ledger_anchors_refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'vault_ledger_anchors is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists vault_ledger_anchors_no_update on vault_ledger_anchors;
create trigger vault_ledger_anchors_no_update
  before update or delete on vault_ledger_anchors
  for each row execute function vault_ledger_anchors_refuse_change();

drop trigger if exists vault_ledger_anchors_no_truncate on vault_ledger_anchors;
create trigger vault_ledger_anchors_no_truncate
  before truncate on vault_ledger_anchors
  for each statement execute function vault_ledger_anchors_refuse_change();

alter table vault_ledger_anchors enable row level security;

drop policy if exists "members_read_vault_ledger_anchors" on vault_ledger_anchors;
create policy "members_read_vault_ledger_anchors"
  on vault_ledger_anchors for select
  using (exists (
    select 1 from vault_members m
     where m.vault_id = vault_ledger_anchors.vault_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  ));

revoke insert, update, delete, truncate on vault_ledger_anchors from anon, authenticated;

-- Vaults whose latest ledger entry has no anchor receipt yet (for the
-- daily job). Service role only.
create or replace function vault_ledger_unanchored_tips()
returns table (vault_id uuid, seq bigint)
language sql
security definer
set search_path = public
stable
as $$
  select t.vault_id, t.seq
    from (select vault_id, max(seq) as seq from vault_ledger group by vault_id) t
   where not exists (
     select 1 from vault_ledger_anchors a
      where a.vault_id = t.vault_id and a.seq = t.seq and a.kind = 'pending'
   )
$$;

revoke all on function vault_ledger_unanchored_tips() from public, anon, authenticated;
grant execute on function vault_ledger_unanchored_tips() to service_role;
