-- vault_ledger: the tamper-evident record of everything that happens to a vault.
--
-- WHY. vault_events is an ordinary table: nothing links one row to the
-- next, and its original policy ("for all using auth.uid() = user_id")
-- let any signed-in user UPDATE or DELETE their own event rows straight
-- from the browser. A record that can be edited without trace is not a
-- record. Operator, 2026-11-10: "the chain of actions all the way from
-- the beginning to the end ... tamper evident ... records of every
-- single thing."
--
-- WHAT. Each ledger entry carries the hash of the entry before it:
--
--   entry_hash = sha256( prev_hash \n vault_id \n seq \n recorded_at \n
--                        actor_user_id \n event_type \n payload_canon )
--
-- so changing, removing or reordering ANY earlier entry changes every
-- hash after it. The first entry of a vault chains from a fixed genesis
-- value. `payload_canon` is the exact text that was hashed (canonical
-- JSON written by netlify/functions/_ledger.js); it is stored verbatim
-- so anyone can recompute the hash from the row alone.
--
-- HOW IT IS KEPT HONEST.
--   * Rows are written only through append_vault_ledger(), which takes a
--     per-vault lock, checks the new entry really extends the current
--     tip (seq = last + 1, prev_hash = last entry_hash) and RECOMPUTES
--     the hash itself -- a buggy or compromised caller cannot insert a
--     wrong hash or fork the chain.
--   * A trigger refuses every UPDATE and DELETE, for every role
--     including the service role. The table is append-only.
--   * vault_id is deliberately NOT a foreign key: the ledger outlives
--     the vault row, so deleting a vault cannot erase its history.
--   * Members of a vault can read its ledger (to verify it). Nobody can
--     write to it from the browser.
--
-- Later slices sign entries with the actor's vault key and anchor the
-- tip hash to Bitcoin via OpenTimestamps; this migration is the chain
-- they both sit on.

create table if not exists vault_ledger (
  vault_id       uuid        not null,
  seq            bigint      not null check (seq >= 1),
  recorded_at    text        not null,            -- ISO-8601 UTC, exactly as hashed
  actor_user_id  uuid,                            -- null for system entries
  event_type     text        not null check (length(event_type) between 1 and 80),
  payload        jsonb       not null default '{}',
  payload_canon  text        not null,            -- the exact canonical JSON that was hashed
  prev_hash      text        not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash     text        not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  inserted_at    timestamptz not null default now(),
  primary key (vault_id, seq)
);

create unique index if not exists vault_ledger_entry_hash_idx on vault_ledger(vault_id, entry_hash);

-- Append-only, for everyone.
create or replace function vault_ledger_refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'vault_ledger is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists vault_ledger_no_update on vault_ledger;
create trigger vault_ledger_no_update
  before update or delete on vault_ledger
  for each row execute function vault_ledger_refuse_change();

drop trigger if exists vault_ledger_no_truncate on vault_ledger;
create trigger vault_ledger_no_truncate
  before truncate on vault_ledger
  for each statement execute function vault_ledger_refuse_change();

-- The one way in. Returns the stored row.
create or replace function append_vault_ledger(
  p_vault_id      uuid,
  p_seq           bigint,
  p_prev_hash     text,
  p_entry_hash    text,
  p_recorded_at   text,
  p_actor_user_id uuid,
  p_event_type    text,
  p_payload_canon text
) returns vault_ledger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last     vault_ledger;
  v_expected text;
  v_row      vault_ledger;
  c_genesis  constant text := repeat('0', 64);
begin
  -- One writer per vault at a time, so two appends cannot both read the
  -- same tip and fork the chain.
  perform pg_advisory_xact_lock(hashtextextended(p_vault_id::text, 0));

  select * into v_last from vault_ledger
   where vault_id = p_vault_id order by seq desc limit 1;

  if p_seq <> coalesce(v_last.seq, 0) + 1 then
    raise exception 'ledger conflict: expected seq %, got %', coalesce(v_last.seq, 0) + 1, p_seq
      using errcode = 'serialization_failure';
  end if;
  if p_prev_hash <> coalesce(v_last.entry_hash, c_genesis) then
    raise exception 'ledger conflict: prev_hash does not match the current tip'
      using errcode = 'serialization_failure';
  end if;

  v_expected := encode(sha256(convert_to(
    p_prev_hash || E'\n' || p_vault_id::text || E'\n' || p_seq::text || E'\n' ||
    p_recorded_at || E'\n' || coalesce(p_actor_user_id::text, '') || E'\n' ||
    p_event_type || E'\n' || p_payload_canon, 'UTF8')), 'hex');
  if v_expected <> p_entry_hash then
    raise exception 'ledger entry_hash does not match its contents'
      using errcode = 'check_violation';
  end if;

  insert into vault_ledger (vault_id, seq, recorded_at, actor_user_id, event_type, payload, payload_canon, prev_hash, entry_hash)
  values (p_vault_id, p_seq, p_recorded_at, p_actor_user_id, p_event_type, p_payload_canon::jsonb, p_payload_canon, p_prev_hash, p_entry_hash)
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function append_vault_ledger(uuid, bigint, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function append_vault_ledger(uuid, bigint, text, text, text, uuid, text, text) to service_role;

alter table vault_ledger enable row level security;

-- Read: any active member of the vault. No insert/update/delete policy
-- exists, so the browser can never write here.
drop policy if exists "members_read_vault_ledger" on vault_ledger;
create policy "members_read_vault_ledger"
  on vault_ledger for select
  using (exists (
    select 1 from vault_members m
     where m.vault_id = vault_ledger.vault_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  ));

revoke insert, update, delete, truncate on vault_ledger from anon, authenticated;

-- Close the hole in the old events table: its "for all" policy let a
-- signed-in user rewrite or delete their own event rows from the
-- browser. Every write already goes through the server (service role),
-- so the browser only ever needs to read.
drop policy if exists "users_own_vault_events" on vault_events;
drop policy if exists "users_read_own_vault_events" on vault_events;
create policy "users_read_own_vault_events"
  on vault_events for select using (auth.uid() = user_id);
revoke insert, update, delete, truncate on vault_events from anon, authenticated;
