// Key-made sessions (email-free sign-in, slice 3; docs/key-signin-build-note.md).
//
// A login earned by proving a key -- today a Tapit wallet -- comes back
// with a one-time claim. Right after the browser redeems the login token,
// this hands the claim back with the NEW session's access token, so the
// server records that session as key-made (key-session.js). It then
// counts like two-step sign-in for joining a real-bitcoin vault
// (operator's chip: "Key sign-in is enough").
//
// The 24-word sign-in that lived here was removed 2026-11-13 (operator:
// "too much garble ... the most sovereign way is run your own Tapit
// wallet, sign in through it").

import { supabase } from './supabase';

const API = '/api';

/** Best effort: if it fails, sign-in still worked; only a real-bitcoin
 *  join then asks for the authenticator code instead. */
export async function recordKeySession(claim: unknown): Promise<boolean> {
  if (typeof claim !== 'string' || !claim) return false;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return false;
    const res = await fetch(`${API}/key-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ claim }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
