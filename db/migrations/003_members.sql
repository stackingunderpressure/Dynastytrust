-- ============================================================
-- 003_members.sql
-- Multi-member vaults: each vault can have multiple signers, each
-- signer has their own Supabase account, and invites are issued
-- by token. Run in Supabase SQL Editor after 002_vaults.sql.
-- ============================================================

-- ------------------------------------------------------------
-- vault_members: each row = one user acting as one role on a vault
-- ------------------------------------------------------------
create table if not exists vault_members (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  vault_id       uuid not null references vaults(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,

  -- 'owner' is the vault creator; they also typically hold a founder key.
  -- 'founder' and 'heir' map to the compiled policy paths.
  -- 'viewer' can see the vault but not sign.
  role           text not null default 'founder'
                   check (role in ('owner', 'founder', 'heir', 'viewer')),

  -- Display name for other members ("Dad", "Sister", "Lawyer").
  label          text,

  -- The key this member signs with. Null until the member uploads
  -- an xpub; a founder member without an xpub is "invited but not
  -- provisioned" and can't sign yet.
  xpub           text,
  fingerprint    text,
  key_label      text,          -- the member's local label for their own key

  status         text not null default 'active'
                   check (status in ('active', 'pending', 'removed')),

  unique (vault_id, user_id),
  unique (vault_id, fingerprint)  -- one fingerprint per vault
);

create index if not exists vault_members_vault_id_idx on vault_members(vault_id);
create index if not exists vault_members_user_id_idx  on vault_members(user_id);

-- ------------------------------------------------------------
-- vault_invites: shareable-link invite tokens
-- ------------------------------------------------------------
create table if not exists vault_invites (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  vault_id       uuid not null references vaults(id) on delete cascade,
  invited_by     uuid not null references auth.users(id) on delete cascade,
  invited_role   text not null
                   check (invited_role in ('founder', 'heir', 'viewer')),
  invited_label  text,                         -- suggested member label
  invited_email  citext,                       -- optional, not enforced

  token          text not null unique,         -- random opaque; the claim URL
  expires_at     timestamptz not null default (now() + interval '14 days'),

  claimed_at     timestamptz,
  claimed_by     uuid references auth.users(id) on delete set null
);

create index if not exists vault_invites_vault_id_idx on vault_invites(vault_id);
create index if not exists vault_invites_token_idx    on vault_invites(token);

-- citext is a separate extension; enable once per database.
create extension if not exists citext;

-- ------------------------------------------------------------
-- signer_sessions: extend so we can actually track partial PSBT
-- signatures per member. Existing rows keep working because new
-- columns are nullable.
-- ------------------------------------------------------------
alter table signer_sessions
  add column if not exists member_id        uuid references vault_members(id) on delete set null,
  add column if not exists fingerprint      text,
  add column if not exists psbt_partial_hex text;

create index if not exists signer_sessions_member_id_idx on signer_sessions(member_id);

-- ------------------------------------------------------------
-- Helper: is the calling user a member of this vault?
-- Used by RLS policies so we don't repeat the join.
-- ------------------------------------------------------------
create or replace function is_vault_member(vault_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault_members vm
    where vm.vault_id = vault_uuid
      and vm.user_id  = auth.uid()
      and vm.status   = 'active'
  );
$$;

-- ------------------------------------------------------------
-- Auto-seed vault_members when a vault is created. The creator
-- starts as an 'owner' with status='active' so they can see their
-- own vault immediately. Their xpub is left null; the frontend
-- fills it in with their founder key fingerprint after compile.
-- ------------------------------------------------------------
create or replace function vault_seed_owner_member()
returns trigger language plpgsql as $$
begin
  insert into vault_members (vault_id, user_id, role, label, status)
  values (new.id, new.user_id, 'owner', 'Owner', 'active')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists vaults_seed_owner_member on vaults;
create trigger vaults_seed_owner_member
  after insert on vaults
  for each row execute function vault_seed_owner_member();

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
alter table vault_members  enable row level security;
alter table vault_invites  enable row level security;

-- Members see their own memberships. Owners see all memberships
-- on their vaults (so they can manage who's in).
drop policy if exists "members_see_own"    on vault_members;
drop policy if exists "owner_sees_members" on vault_members;

create policy "members_see_own"
  on vault_members for select
  using (auth.uid() = user_id);

create policy "owner_sees_members"
  on vault_members for select
  using (
    exists (
      select 1 from vaults v
      where v.id = vault_members.vault_id
        and v.user_id = auth.uid()
    )
  );

-- Writes to vault_members go through the Netlify functions
-- (service_role bypasses RLS). No direct client write policy.

-- Invites: only the inviter can see their own invites via the
-- Supabase client. Claim lookups go through a Netlify function
-- that uses the service_role key.
drop policy if exists "inviter_sees_own" on vault_invites;

create policy "inviter_sees_own"
  on vault_invites for select
  using (auth.uid() = invited_by);

-- ------------------------------------------------------------
-- Extend existing policies so vault members (not just creators)
-- can read the core vault tables. Creators stay covered by the
-- existing "users_own_*" policies; we add parallel
-- "members_see_*" policies that use is_vault_member().
-- ------------------------------------------------------------
drop policy if exists "members_see_vaults"          on vaults;
drop policy if exists "members_see_vault_events"    on vault_events;
drop policy if exists "members_see_proposals"       on proposals;
drop policy if exists "members_see_signer_sessions" on signer_sessions;

create policy "members_see_vaults"
  on vaults for select
  using (is_vault_member(id));

create policy "members_see_vault_events"
  on vault_events for select
  using (is_vault_member(vault_id));

create policy "members_see_proposals"
  on proposals for select
  using (is_vault_member(vault_id));

create policy "members_see_signer_sessions"
  on signer_sessions for select
  using (
    exists (
      select 1 from proposals p
      where p.id = signer_sessions.proposal_id
        and is_vault_member(p.vault_id)
    )
  );
