/**
 * _finalize-guard.js -- threat model item C (docs/threat-model-2026-11-13.md).
 *
 * While a vault is being set up, whoever controls the OWNER's account
 * decides who is in it: they can add their own key and finalize, and the
 * family then funds a vault the attacker can spend. A stolen password must
 * not be enough for that on real bitcoin. Finishing a real-bitcoin vault
 * therefore needs a session that passed two-step sign-in (aal2), or one
 * made by proving a key (a Tapit wallet -- key_sessions, recorded by
 * key-session.js; operator's chip: "Key sign-in is enough"). Test-coin
 * vaults are not affected.
 *
 * Applied at every place a vault becomes finished: compile.js (save),
 * vaults.js (non-draft create), vaults-compile.js, vaults-compile-bloc.js,
 * compile-leaves.js. Proven by scripts/test-finalize-guard.mjs.
 */
import { isKeySession } from "./_key-account.js";

export const FINALIZE_NEEDS_STRONG_SIGNIN =
  "Finishing a real-bitcoin vault needs a stronger sign-in than a password: turn on two-step sign-in under Keys and sign in again with your code, or sign in with your Tapit wallet. Then finish the vault. Test-coin vaults are not affected.";

/** null when allowed, else the plain reason. */
export async function realBitcoinFinalizeProblem(supabase, claims, network) {
  if (network !== "bitcoin") return null;
  if (claims?.aal === "aal2") return null;
  if (await isKeySession(supabase, claims)) return null;
  return FINALIZE_NEEDS_STRONG_SIGNIN;
}
