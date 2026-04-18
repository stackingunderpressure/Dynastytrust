-- ============================================================
-- 009_proposal_comments.sql
-- Discussion thread on each proposal. Each row is either a
-- comment, a vote, or both (a comment with a vote attached).
-- Votes are advisory and separate from the cryptographic
-- signature stream: a trustee can "approve" without signing yet,
-- or "decline" to record their objection even if the quorum
-- proceeds anyway. Creates the auditable paper trail a real
-- trust deed calls for.
-- ============================================================

create table if not exists proposal_comments (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  proposal_id    uuid not null references proposals(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,

  body           text,

  -- Optional vote. null = plain comment. The three values map to
  -- trustee positions: in favour, neutral, against.
  vote           text
                   check (vote in ('approve', 'abstain', 'decline')),

  -- Rolled forward via triggers elsewhere if needed. For now:
  -- the UI reads vault_members.label for display names.
  constraint proposal_comments_non_empty
    check (body is not null or vote is not null)
);

create index if not exists proposal_comments_proposal_id_idx
  on proposal_comments(proposal_id);
create index if not exists proposal_comments_user_id_idx
  on proposal_comments(user_id);

-- Auto-expiry window on proposals: 14 days by default. UI hides
-- expired items from the dashboard feed and shows them greyed
-- out on the history tab. Actual state transition (-> cancelled)
-- is client-side on next access -- no cron required.
alter table proposals
  add column if not exists expires_at timestamptz;

-- Backfill: existing proposals keep no expiry.
update proposals set expires_at = coalesce(expires_at, null);

-- RLS
alter table proposal_comments enable row level security;

drop policy if exists "members_see_comments"     on proposal_comments;
drop policy if exists "members_write_comments"   on proposal_comments;
drop policy if exists "authors_delete_comments"  on proposal_comments;

create policy "members_see_comments"
  on proposal_comments for select using (
    proposal_id in (
      select id from proposals where is_vault_member(vault_id)
    )
  );

-- Writes go through Netlify functions with the service role, so
-- no write policy here. The function authorises on membership.

-- Realtime
alter publication supabase_realtime add table proposal_comments;
