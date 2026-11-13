-- Threat model item J (docs/threat-model-2026-11-13.md), 2026-11-13.
--
-- Username and Tapit accounts live at never-mailed addresses
-- (users.dynastytrust.family, keys.dynastytrust.family). From now on this
-- app's own functions mark each one they make in app_metadata.dt_made_by,
-- which Supabase's public sign-up cannot set, and every function refuses
-- an unmarked account at those addresses (_placeholder-guard.js).
--
-- 1. Mark the accounts that already exist, so no real person is locked out.
--    Caveat, stated honestly: an account someone made through the public
--    sign-up at such an address BEFORE today cannot be told apart from ours
--    and is marked too. The username door opened 2026-11-13 and the
--    addresses were never published; the live check found no reason to
--    expect any.
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('dt_made_by', 'backfill-2026-11-13')
 where (lower(email) like '%@users.dynastytrust.family' or lower(email) like '%@keys.dynastytrust.family')
   and not (coalesce(raw_app_meta_data, '{}'::jsonb) ? 'dt_made_by');

-- 2. Who holds a placeholder address (username-signup.js uses this to
--    remove an unmarked squatter on a name). Answers only for the two
--    placeholder domains, and only to the server.
drop function if exists public.placeholder_account(text);
create function public.placeholder_account(p_email text)
returns table (id uuid, confirmed boolean, made_by text)
language sql
security definer
set search_path = ''
as $$
  select u.id, u.email_confirmed_at is not null, u.raw_app_meta_data ->> 'dt_made_by'
    from auth.users u
   where lower(u.email) = lower(p_email)
     and (lower(p_email) like '%@users.dynastytrust.family' or lower(p_email) like '%@keys.dynastytrust.family');
$$;

revoke all on function public.placeholder_account(text) from public;
revoke all on function public.placeholder_account(text) from anon, authenticated;
grant execute on function public.placeholder_account(text) to service_role;
