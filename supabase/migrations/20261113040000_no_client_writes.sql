-- ============================================================
-- Threat model item A (docs/threat-model-2026-11-13.md).
--
-- The browser never writes a table directly: every write goes through a
-- Netlify function with the service role, which applies the rules (draft
-- only, owner only, sealed record, confirmed keys...). But June-era
-- policies still let any signed-in user write some tables directly
-- through Supabase's REST API with the public anon key -- most dangerously
-- `users_own_vaults ... for all`, which let an owner's session rewrite a
-- finalized vault's descriptor AND address together, past every server
-- check and past the in-browser address check (a self-consistent swap).
--
-- This removes EVERY client write policy still live (16, listed by reading
-- every migration), adds back plain owner READ where a `for all` policy
-- used to provide it, and revokes table write privileges from the browser
-- roles outright (the pattern vault_ledger already uses), so a future
-- write policy added by mistake still cannot open a table.
-- The service role (Netlify functions) bypasses RLS and is unaffected.
-- Idempotent.
-- ============================================================

-- The three `for all` policies, replaced by read-only ones.
drop policy if exists "users_own_vaults" on vaults;
drop policy if exists "owner_reads_own_vaults" on vaults;
create policy "owner_reads_own_vaults" on vaults for select using (auth.uid() = user_id);

drop policy if exists "users_own_proposals" on proposals;
drop policy if exists "owner_reads_own_proposals" on proposals;
create policy "owner_reads_own_proposals" on proposals for select using (auth.uid() = user_id);

drop policy if exists "users_own_signer_sessions" on signer_sessions;
drop policy if exists "proposer_reads_own_signer_sessions" on signer_sessions;
create policy "proposer_reads_own_signer_sessions" on signer_sessions for select using (
  exists (select 1 from proposals p where p.id = signer_sessions.proposal_id and p.user_id = auth.uid())
);

-- Insert / update / delete policies the app never uses from the browser.
drop policy if exists "messages_delete_own" on assistant_messages;
drop policy if exists "messages_insert_own" on assistant_messages;
drop policy if exists "threads_delete_own" on assistant_threads;
drop policy if exists "threads_insert_own" on assistant_threads;
drop policy if exists "threads_update_own" on assistant_threads;
drop policy if exists "owner_update_own_phrase_deliveries" on circle_phrase_deliveries;
drop policy if exists "owner_upsert_own_phrase_deliveries" on circle_phrase_deliveries;
drop policy if exists "owner_update_own_backup" on messaging_key_backups;
drop policy if exists "owner_upsert_own_backup" on messaging_key_backups;
drop policy if exists "owner_delete_own_secrets" on sent_secrets;
drop policy if exists "owner_insert_own_secrets" on sent_secrets;
drop policy if exists "owner_insert_own_grants" on vault_membership_grants;
drop policy if exists "owner_update_own_grants" on vault_membership_grants;

-- Belt and braces: the browser roles cannot write ANY table here, now or
-- later (the browser makes no direct table calls at all -- read from the
-- code 2026-11-13: no supabase.from(...) or .rpc(...) in apps/web/src).
-- Reads stay governed by the SELECT policies.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;

notify pgrst, 'reload schema';
