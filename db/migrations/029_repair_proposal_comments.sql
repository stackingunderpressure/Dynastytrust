-- ============================================================
-- 029_repair_proposal_comments.sql
-- Re-asserts 009_proposal_comments.sql's schema. This migration
-- system has no automated runner (SETUP.md: paste-and-run in the
-- Supabase SQL editor) -- 026-028 were found unapplied on this
-- project earlier, so 009 may never have actually run either.
-- Every statement below is the same idempotent shape 009 already
-- used (if not exists / drop policy if exists), so running this
-- is a safe no-op if 009 did land, and a real fix if it didn't.
-- ============================================================

create table if not exists proposal_comments (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  proposal_id    uuid not null references proposals(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,

  body           text,

  vote           text
                   check (vote in ('approve', 'abstain', 'decline')),

  constraint proposal_comments_non_empty
    check (body is not null or vote is not null)
);

create index if not exists proposal_comments_proposal_id_idx
  on proposal_comments(proposal_id);
create index if not exists proposal_comments_user_id_idx
  on proposal_comments(user_id);

alter table proposal_comments enable row level security;

drop policy if exists "members_see_comments" on proposal_comments;

create policy "members_see_comments"
  on proposal_comments for select using (
    proposal_id in (
      select id from proposals where is_vault_member(vault_id)
    )
  );

-- Realtime publication: safe to re-add, Postgres errors if a table is
-- already a publication member, so guard with a existence check.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'proposal_comments'
  ) then
    alter publication supabase_realtime add table proposal_comments;
  end if;
end $$;
