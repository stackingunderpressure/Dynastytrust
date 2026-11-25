// The duress hold, enforced on the server (blind review 2026-11-25, finding
// 1: docs/audits/2026-11-25-blind-review-new-code.md). vaults.duress was
// honoured only by the Send screen and by Tapit; the request page and the
// functions behind it never read it, so a held vault could still collect
// signatures and be broadcast. Every function that builds, files, records or
// merges a spend calls this first. Fails CLOSED: if the hold cannot be read,
// nothing moves forward.
//
// What this cannot do: stop someone who holds enough keys from signing
// outside DynastyTrust (in Sparrow, Core, a hardware wallet alone). The
// hold is this app's brake and the circle's alarm, not a change to the
// vault's script.

import { json } from "./_auth.js";

export const HELD_MESSAGE =
  "Signing is halted on this vault. Nothing can be signed, filed or sent until the hold is lifted.";

/** A 409 response while `vaultId` is on hold, a 503 if the hold can't be
 *  read, or null when the spend may go on. */
export async function refuseIfHeld(supabase, vaultId) {
  const { data, error } = await supabase.from("vaults").select("duress").eq("id", vaultId).maybeSingle();
  if (error) return json(503, { error: `Could not check whether this vault is on hold, so nothing was done: ${error.message}` });
  if (data?.duress === true) return json(409, { error: HELD_MESSAGE, held: true });
  return null;
}
