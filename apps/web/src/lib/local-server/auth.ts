// The download build's stand-in for the Supabase client
// (docs/download-and-run-build-note.md: "No account: the download opens
// straight to your keys and vaults"). One person, this computer: a fixed
// local "you" is always signed in, no second step is ever owed, and live
// updates do nothing (nothing else writes to this computer's records).
//
// Every account action -- password, email code, Tapit, authenticator
// setup -- answers plainly that it is not in the download, the same way the
// local server answers calls that need other people. Nothing here reaches
// the network. Only the parts of the client the app actually calls are
// provided (counted from the code, 2026-11-14).

import { LOCAL_USER } from './store';

const NOT_HERE = 'The downloaded DynastyTrust has no account: it opens straight to your keys and vaults on this computer.';

/** The one person using this copy of the app. Typed loosely: the pages read
 *  only user.id, user.email, user_metadata and access_token. */
export const LOCAL_SESSION = {
  access_token: 'local',
  refresh_token: 'local',
  token_type: 'bearer',
  expires_in: 0,
  expires_at: undefined,
  user: {
    id: LOCAL_USER,
    email: undefined,
    aud: 'local',
    app_metadata: {},
    user_metadata: { display_name: 'You' },
    created_at: '1970-01-01T00:00:00.000Z',
  },
};

const refused = async () => ({ data: { user: null, session: null }, error: new Error(NOT_HERE) });
const mfaRefused = async () => ({ data: null, error: new Error(NOT_HERE) });

type Listener = (event: string, session: typeof LOCAL_SESSION | null) => void;

/** A realtime channel that never fires. */
function quietChannel() {
  const ch = {
    on: () => ch,
    subscribe: () => ch,
    unsubscribe: async () => 'ok' as const,
  };
  return ch;
}

export const localSupabase = {
  auth: {
    getSession: async () => ({ data: { session: LOCAL_SESSION }, error: null }),
    getUser: async () => ({ data: { user: LOCAL_SESSION.user }, error: null }),
    onAuthStateChange(cb: Listener) {
      // Supabase reports the current session once on subscribe; so do we.
      queueMicrotask(() => cb('INITIAL_SESSION', LOCAL_SESSION));
      return { data: { subscription: { unsubscribe() { /* nothing to stop */ } } } };
    },
    // Signing out of a computer you own means nothing here; the app's own
    // key passwords still guard every secure key.
    signOut: async () => ({ error: null }),
    signInWithPassword: refused,
    signUp: refused,
    verifyOtp: refused,
    resend: refused,
    resetPasswordForEmail: async () => ({ data: null, error: new Error(NOT_HERE) }),
    updateUser: refused,
    mfa: {
      // No authenticator, and the "assurance level" is always enough: there
      // is no account for a second step to protect.
      listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] }, error: null }),
      enroll: mfaRefused,
      unenroll: mfaRefused,
      challenge: mfaRefused,
      verify: mfaRefused,
      challengeAndVerify: mfaRefused,
    },
  },
  channel: (_name: string) => quietChannel(),
  removeChannel: async (_ch: unknown) => 'ok' as const,
};
