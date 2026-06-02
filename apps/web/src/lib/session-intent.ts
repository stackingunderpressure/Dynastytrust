// Tracks whether the most recent sign-out was the user clicking "Sign out"
// (intentional) versus a token expiry. Supabase fires the same SIGNED_OUT
// event for both, so we set this flag right before an explicit signOut() and
// consume it in the auth listener to decide whether to warn about expiry.
let intentional = false;

export function markIntentionalSignOut(): void {
  intentional = true;
}

export function consumeIntentionalSignOut(): boolean {
  const v = intentional;
  intentional = false;
  return v;
}
