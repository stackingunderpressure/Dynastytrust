-- ============================================================
-- 023_assistant_usage.sql
-- Forward-only token-usage ledger for the education bot ("Sage").
--
-- Every successful Sage call writes ONE row here recording the
-- EXACT token counts Anthropic returned for that call, plus the
-- model id and the ids/timestamps needed to aggregate. The
-- admin-only usage page reads these (via the service role, after
-- a server-side admin check) and prices them at list rates as an
-- ESTIMATE -- the authoritative bill is at console.anthropic.com.
--
-- SECURITY -- READ THIS:
--   This table stores ONLY token counts + model id + ids +
--   timestamps. NO key material (private key, mnemonic, password,
--   encrypted key blob) and NO message content is ever written
--   here. Token counts carry no secret. The insert is performed
--   by the Netlify function using the service-role client (which
--   bypasses RLS); there is deliberately NO public insert policy.
-- ============================================================

create table if not exists assistant_usage (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  -- The thread the call belonged to. set null on delete so a
  -- removed thread never strands a usage row -- the counts still
  -- aggregate for billing even after the conversation is gone.
  thread_id             uuid references assistant_threads(id) on delete set null,
  -- The model id actually used for the call (e.g. claude-opus-4-8).
  model                 text not null,
  -- Exact per-call token counts from Anthropic's usage object.
  -- Non-negative integers; default 0 so an absent cache field
  -- never produces a null.
  input_tokens          int  not null default 0,
  output_tokens         int  not null default 0,
  cache_read_tokens     int  not null default 0,
  cache_creation_tokens int  not null default 0,
  created_at            timestamptz not null default now()
);

create index if not exists assistant_usage_created_idx
  on assistant_usage(created_at);
create index if not exists assistant_usage_model_idx
  on assistant_usage(model);

-- Row-level security ------------------------------------------
-- A user may read their OWN usage rows. There is no public insert
-- policy on purpose: rows are written only by the Netlify function
-- with the service-role key, which bypasses RLS. Cross-user
-- aggregation for the admin page is likewise done only by the
-- service-role client, after the function's server-side admin
-- allow-list check passes.

alter table assistant_usage enable row level security;

drop policy if exists "assistant_usage_select_own" on assistant_usage;
create policy "assistant_usage_select_own"
  on assistant_usage for select using (user_id = auth.uid());
