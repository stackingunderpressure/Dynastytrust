// How far a signed PSBT has got toward a path's rule, as the Send screen
// shows it. Moved out of VaultDetail.tsx so it can be tested.
//
// On a path-builder vault that is decided by who signed (a must-sign key
// counts once and nothing stands in for it; the others count only up to
// their quorum). For a shape the path list can't read by name, it is the
// number of keys that signed EVERY input -- blind review 2026-11-25,
// finding 7: it used to ADD signatures across inputs, so one signer on a
// two-coin spend read as two and a 2-of-3 looked met.
//
// A fresh-address vault's xpub keys sign with a child key per address; the
// multipath descriptor maps each back to its vault key (the same rule the
// request page and the server use).

import type { Vault } from './api';
import { signersOnEveryInput } from './psbt-signer';
import { findSpendingPath, isLeafListVault, pathSignatureStatus } from './vault-spending-paths';

export function signaturesTowardPath(vault: Vault, pathId: string, psbtHex: string): number {
  const multipath = vault.descriptor_version === 2 ? vault.descriptor_multipath ?? null : null;
  const signers = signersOnEveryInput(psbtHex, multipath);
  if (isLeafListVault(vault)) {
    const summary = findSpendingPath(vault, pathId);
    const st = summary ? pathSignatureStatus(summary, signers) : null;
    if (st?.byName) return st.have;
  }
  return signers.length;
}
