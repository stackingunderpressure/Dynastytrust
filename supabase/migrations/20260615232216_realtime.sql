-- ============================================================
-- 005_realtime.sql
-- Enable Supabase Realtime on the tables the web app subscribes to.
-- Run once in Supabase SQL Editor after 004.
-- ============================================================
--
-- Realtime works by publishing row changes on the
-- supabase_realtime publication. Clients connect over websocket
-- and receive INSERT/UPDATE/DELETE events filtered by RLS, so
-- users only see changes to rows they could SELECT anyway.

alter publication supabase_realtime add table proposals;
alter publication supabase_realtime add table signer_sessions;
alter publication supabase_realtime add table vault_members;
alter publication supabase_realtime add table vault_events;

-- If you ever need to undo:
--   alter publication supabase_realtime drop table <name>;
