import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DOWNLOAD } from './download';
import { localSupabase } from './local-server/auth';

function websiteClient(): SupabaseClient {
  const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      as string;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  if (!SUPABASE_URL)      throw new Error('Missing env: VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) throw new Error('Missing env: VITE_SUPABASE_ANON_KEY');

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true },
  });
}

// The download build (lib/download.ts) has no account and no server of
// ours: a local stand-in answers the few client calls the app makes
// (lib/local-server/auth.ts). The website build folds this to the real
// client.
export const supabase: SupabaseClient = DOWNLOAD
  ? (localSupabase as unknown as SupabaseClient)
  : websiteClient();

export type { Session, User } from '@supabase/supabase-js';
