-- ============================================================
-- 011_beneficiaries_and_requests.sql
-- First-class beneficiary role and a distribution-request queue
-- so the family can use the app without being trustees.
--
-- Before this, the only ways a non-trustee family member touched
-- the vault were:
--   * as a 'viewer' (read-only; nothing else)
--   * as a name in trust_doc.beneficiaries (no account, no
--     visibility)
--   * side-channel: "text the trustee, ask for money"
--
-- After this, a beneficiary has their own Supabase account, sees
-- the trust document, signature progress, activity, and history,
-- and can file a distribution request against one of the trust's
-- rules. Trustees see a Requests tab, can approve (turns into a
-- proposal pre-filled with amount + rule + reason) or decline
-- with a note. The whole loop stays in the app with a
-- permanent audit record.
-- ============================================================

-- 1. Widen role enum to include 'beneficiary'.
alter table vault_members drop constraint if exists vault_members_role_check;
alter table vault_members
  add constraint vault_members_role_check
  check (role in ('owner', 'founder', 'heir', 'viewer', 'beneficiary'));

-- Invites should also accept the new role.
alter table vault_invites drop constraint if exists vault_invites_invited_role_check;
alter table vault_invites
  add constraint vault_invites_invited_role_check
  check (invited_role in ('founder', 'heir', 'viewer', 'beneficiary'));

-- 2. Distribution request queue. A beneficiary (or any member)
--    asks for money; trustees resolve. Pending requests show up
--    on the vault's Requests tab and on the requester's
--    Dashboard until resolved.
create table if not exists vault_requests (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  vault_id         uuid not null references vaults(id) on delete cascade,
  requested_by     uuid not null references auth.users(id) on delete cascade,

  -- Which distribution rule the requester wants to draw against.
  -- Free text, matches DistributionRule.id from trust_doc.rules.
  rule_id          text,
  -- Convenience snapshot so history survives rule rename / delete.
  rule_name        text,

  amount_sats      bigint not null,
  recipient_name   text,
  reason           text,

  status           text not null default 'pending'
                     check (status in ('pending', 'approved', 'declined', 'fulfilled', 'cancelled')),
  -- If a trustee approves and creates a proposal, the link goes
  -- here; fulfilled means the proposal was broadcast.
  linked_proposal_id uuid references proposals(id) on delete set null,

  resolved_by      uuid references auth.users(id) on delete set null,
  resolved_at      timestamptz,
  resolution_note  text
);

create index if not exists vault_requests_vault_id_idx on vault_requests(vault_id);
create index if not exists vault_requests_requested_by_idx on vault_requests(requested_by);
create index if not exists vault_requests_status_idx on vault_requests(status);

drop trigger if exists vault_requests_updated_at on vault_requests;
create trigger vault_requests_updated_at before update on vault_requests
  for each row execute function touch_updated_at();

-- RLS
alter table vault_requests enable row level security;

drop policy if exists "members_see_vault_requests" on vault_requests;
create policy "members_see_vault_requests"
  on vault_requests for select using (is_vault_member(vault_id));

-- Writes go through Netlify functions.

-- Publish for realtime so trustees see new requests live.
alter publication supabase_realtime add table vault_requests;
