-- ============================================================
-- 022_assistant.sql
-- Education-bot (the "Wizard") conversation store -- slice 1.
--
-- A warm, guided conversation that teaches a newbie and walks
-- them toward building ONE vault. The bot PROPOSES values; the
-- human DISPOSES (the actual vault is only ever created through
-- the existing PolicyBuilder compile + save path -- never here).
--
-- SECURITY -- READ THIS:
--   content is plain text only -- no key material may ever be
--   written here. No private key, mnemonic, password, or
--   encrypted key blob is ever stored in these tables, ever sent
--   to the model provider, or ever logged. The server assembles
--   the model context from public/safe vault fields only.
-- ============================================================

create table if not exists assistant_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Optional vault this conversation is anchored to. Null while
  -- the user is still deciding what to build. set null on delete
  -- so a deleted vault never strands a thread.
  vault_id    uuid references vaults(id) on delete set null,
  mode        text not null check (mode in ('guided','express')) default 'guided',
  -- Free-form coaching state: the last proposed values, a simple
  -- progress checklist, etc. Plain JSON only -- never key material.
  checklist   jsonb not null default '{}'::jsonb,
  next_step   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists assistant_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references assistant_threads(id) on delete cascade,
  sender      text not null check (sender in ('user','wizard')),
  -- Plain conversation text only. No key material may ever be
  -- written here.
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists assistant_threads_user_idx
  on assistant_threads(user_id, updated_at desc);
create index if not exists assistant_messages_thread_idx
  on assistant_messages(thread_id, created_at);

-- ── Row-level security ───────────────────────────────────────
-- A user only ever sees and writes their own threads + the
-- messages inside them.

alter table assistant_threads  enable row level security;
alter table assistant_messages enable row level security;

drop policy if exists "threads_select_own" on assistant_threads;
create policy "threads_select_own"
  on assistant_threads for select using (user_id = auth.uid());

drop policy if exists "threads_insert_own" on assistant_threads;
create policy "threads_insert_own"
  on assistant_threads for insert with check (user_id = auth.uid());

drop policy if exists "threads_update_own" on assistant_threads;
create policy "threads_update_own"
  on assistant_threads for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "messages_select_own" on assistant_messages;
create policy "messages_select_own"
  on assistant_messages for select using (
    thread_id in (select id from assistant_threads where user_id = auth.uid())
  );

drop policy if exists "messages_insert_own" on assistant_messages;
create policy "messages_insert_own"
  on assistant_messages for insert with check (
    thread_id in (select id from assistant_threads where user_id = auth.uid())
  );
