-- Lock the stray public.keys table (operator, 2026-11-24: Supabase advisor
-- "Table publicly accessible -- rls_disabled_in_public", table public.keys).
--
-- No migration, function, script or commit in this repo has ever created or
-- used a table named `keys` -- it was made by hand, outside version control.
-- With RLS off, anyone holding the project URL and the public anon key (both
-- ship in the web app) can read, edit and delete it. Turning RLS on with NO
-- policies closes that to the anon and authenticated roles entirely; the
-- service role (which every Netlify function uses) bypasses RLS, so nothing
-- in the app can break -- nothing in the app reads it.
--
-- Additive and reversible (`alter table public.keys disable row level
-- security` undoes it). A no-op where the table does not exist. Whether to
-- DROP the table is the operator's call once its contents are known.

do $$
begin
  if to_regclass('public.keys') is not null then
    execute 'alter table public.keys enable row level security';
    execute 'revoke all on table public.keys from anon, authenticated';
  end if;
end $$;
