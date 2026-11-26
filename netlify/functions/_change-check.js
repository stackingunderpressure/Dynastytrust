// Change on a fresh-address vault must pay a change address this vault
// actually handed out (blind review 2026-11-25, finding 3:
// docs/audits/2026-11-25-blind-review-new-code.md). Without it a member
// could file a spend whose change sat at change/1000000 -- every co-signer's
// own-address check passed, the app watches only a few past its counter, and
// a restoring wallet (gap limit 20) never finds the money. Operator's chip,
// 2026-11-25: recorded addresses only.
//
// Every output that SAYS it is one of the vault's change addresses (a BIP371
// derivation on branch 1) must match, script for script, a change row in
// vault_addresses -- which only _ranged-spend.js writes, after deriving it.

import { parsePsbt, toHex } from "@dynastytrust/bip341-psbt-signer";

const CHANGE = 1;

/** A sentence saying why the change is refused, or null when it is fine. */
export async function changeProblem(supabase, vault, psbtHex) {
  if (vault?.descriptor_version !== 2 || !psbtHex) return null;
  let p;
  try {
    p = parsePsbt(psbtHex);
  } catch (e) {
    return `The transaction could not be read: ${e instanceof Error ? e.message : "unreadable"}`;
  }
  const claimed = [];
  p.tx.outputs.forEach((out, n) => {
    for (const d of p.outputMaps?.[n]?.tapBip32Derivation ?? []) {
      if (d.path.length < 2) continue;
      const [branch, index] = d.path.slice(-2);
      if (branch === CHANGE) { claimed.push({ n, index, script: toHex(out.scriptPubkey) }); break; }
    }
  });
  if (!claimed.length) return null;
  const { data, error } = await supabase
    .from("vault_addresses").select("idx, script_pubkey").eq("vault_id", vault.id).eq("branch", CHANGE).in("idx", claimed.map((c) => c.index));
  if (error) return `The change address could not be checked: ${error.message}`;
  for (const c of claimed) {
    const row = (data ?? []).find((r) => r.idx === c.index);
    if (!row || String(row.script_pubkey).toLowerCase() !== c.script.toLowerCase()) {
      return `The change goes to change address ${c.index.toLocaleString("en-US")}, which this vault never handed out. A wallet restoring the vault might never find it, so this spend was refused. Build it again from the app.`;
    }
  }
  return null;
}
