-- ============================================================
-- 002_vaults.sql
-- Creates all tables required by Netlify Functions.
-- Run this in Supabase SQL Editor after 001_init.sql
-- ============================================================

-- ── Vaults ────────────────────────────────────────────────────────────────────
create table if not exists vaults (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  name                text not null default 'Vault',
  network             text not null default 'testnet'
                        check (network in ('testnet', 'bitcoin')),
  address             text not null,
  descriptor          text not null,
  miniscript_policy   text not null,
  address_type        text not null default 'tr'
                        check (address_type in ('wsh', 'tr', 'tr_multileaf')),

  founder_quorum      integer not null default 2,
  heir_quorum         integer not null default 2,
  recovery_after      integer not null default 26000,
  inheritance_after   integer not null default 52560,
  founder_keys        jsonb not null default '[]',
  heir_keys           jsonb not null default '[]',

  archived            boolean not null default false
);

-- Index for fast user lookups
create index if not exists vaults_user_id_idx on vaults(user_id);

-- Auto-update updated_at
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vaults_updated_at on vaults;
create trigger vaults_updated_at
  before update on vaults
  for each row execute function touch_updated_at();

-- ── Vault Events (audit log) ───────────────────────────────────────────────────
create table if not exists vault_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  vault_id    uuid not null references vaults(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  event_type  text not null,  -- 'created', 'psbt_generated', 'signed', 'broadcast', etc.
  metadata    jsonb not null default '{}'
);

create index if not exists vault_events_vault_id_idx on vault_events(vault_id);
create index if not exists vault_events_user_id_idx  on vault_events(user_id);

-- ── Proposals (spend proposals) ───────────────────────────────────────────────
create table if not exists proposals (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  vault_id          uuid not null references vaults(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,

  path              text not null default 'founders_now'
                      check (path in ('founders_now', 'recovery', 'inheritance')),
  destination       text not null,
  amount_sats       bigint not null,
  fee_sats          bigint not null default 0,
  fee_rate          numeric,
  utxo_age_blocks   integer not null default 0,
  total_vault_sats  bigint not null default 0,
  memo              text,

  -- PSBT lifecycle
  psbt_hex          text,
  psbt_b64          text,
  psbt_signed_hex   text,
  txid              text,

  status            text not null default 'draft'
                      check (status in ('draft', 'pending', 'signed', 'broadcast', 'cancelled')),

  -- Governance audit result from compiler
  governance_audit  jsonb
);

create index if not exists proposals_vault_id_idx on proposals(vault_id);
create index if not exists proposals_user_id_idx  on proposals(user_id);

drop trigger if exists proposals_updated_at on proposals;
create trigger proposals_updated_at
  before update on proposals
  for each row execute function touch_updated_at();

-- ── Signer Sessions ───────────────────────────────────────────────────────────
create table if not exists signer_sessions (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  proposal_id   uuid not null references proposals(id) on delete cascade,
  signer_index  integer not null,
  signer_role   text not null default 'founder'
                  check (signer_role in ('founder', 'heir')),
  label         text,
  signed        boolean not null default false,
  signed_at     timestamptz
);

create index if not exists signer_sessions_proposal_id_idx on signer_sessions(proposal_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Enable RLS on all tables (service_role key bypasses RLS — used by functions)
alter table vaults         enable row level security;
alter table vault_events   enable row level security;
alter table proposals      enable row level security;
alter table signer_sessions enable row level security;

-- Policies: users can only see their own data via direct client access
-- (The Netlify functions use the service_role key so they bypass these)
create policy "users_own_vaults"
  on vaults for all using (auth.uid() = user_id);

create policy "users_own_vault_events"
  on vault_events for all using (auth.uid() = user_id);

create policy "users_own_proposals"
  on proposals for all using (auth.uid() = user_id);

create policy "users_own_signer_sessions"
  on signer_sessions for all
  using (
    exists (
      select 1 from proposals p
      where p.id = signer_sessions.proposal_id
        and p.user_id = auth.uid()
    )
  );
