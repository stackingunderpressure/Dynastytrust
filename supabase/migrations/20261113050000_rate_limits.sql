-- ============================================================
-- Threat model item H (docs/threat-model-2026-11-13.md): the public,
-- signed-out endpoints (wallet-signin-challenge, key-signup,
-- username-signup) accepted unlimited requests, and expired sign-in
-- challenges were never deleted.
--
-- rate_hit(bucket, window_seconds) counts one request in the current
-- fixed window and returns the count, atomically (insert ... on conflict
-- do update), so two requests at once cannot both slip under the limit.
-- Server-only: the browser roles can neither call it nor touch the table.
-- Idempotent.
-- ============================================================

create table if not exists rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);
alter table rate_limits enable row level security;
revoke all on rate_limits from anon, authenticated;

create or replace function rate_hit(p_bucket text, p_window_seconds integer)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into rate_limits (bucket, window_start, hits)
  values (p_bucket, to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds), 1)
  on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
  returning hits;
$$;
revoke all on function rate_hit(text, integer) from public, anon, authenticated;
grant execute on function rate_hit(text, integer) to service_role;

-- Housekeeping, called by the same server code: drop windows over a day old
-- and sign-in challenges that expired over an hour ago.
create or replace function rate_housekeeping()
returns void
language sql
security definer
set search_path = public
as $$
  delete from rate_limits where window_start < now() - interval '1 day';
  delete from wallet_signin_challenges where expires_at < now() - interval '1 hour';
$$;
revoke all on function rate_housekeeping() from public, anon, authenticated;
grant execute on function rate_housekeeping() to service_role;

notify pgrst, 'reload schema';
