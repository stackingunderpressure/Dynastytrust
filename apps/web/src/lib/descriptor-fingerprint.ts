/**
 * descriptor-fingerprint.ts -- a short, deterministic fingerprint of a
 * vault's compiled descriptor, meant to be written down once (on the
 * paper backup, the PDF export) and compared later, out of band,
 * against whatever descriptor a signer or coordinator is about to use.
 *
 * This closes a real, previously-unaddressed hole in the vault's
 * threat model: nothing today stops a signer from importing a
 * DIFFERENT descriptor than the one that actually funded a vault (a
 * compromised app substitutes it, a copy-paste grabs a stale or
 * attacker-supplied version, a QR is swapped) -- every future
 * signature that signer produces would then be perfectly correct
 * against the wrong tree, with nothing at signing time able to catch
 * it, since the signer's whole job at that point is trusting the tree
 * it was told to trust. Comparing DynastyTrust's own displayed
 * fingerprint against a descriptor DynastyTrust also generated proves
 * nothing about a substitution DynastyTrust itself performed
 * maliciously or was tricked into performing -- the fingerprint only
 * has value once it has been captured once, separately (written on
 * paper alongside the vault's other backup material), and is compared
 * later against a channel a single compromised party can't touch. The
 * fingerprint is a labeling/comparison aid, not a security mechanism
 * on its own -- same honest framing as the txid fingerprint in
 * PsbtQrDisplay.tsx and the stale-seal descriptorFingerprint this
 * mirrors from Legacy Recovery's now-retired v1 design.
 *
 * Plain SHA-256 over the descriptor's UTF-8 bytes, first 8 hex chars,
 * shown as two 4-char groups -- same convention as
 * psbtTransactionFingerprint (PsbtQrDisplay.tsx). Deliberately NOT
 * mirrored server-side: every caller here already has the descriptor
 * string in hand (loaded from the vaults table), so there's no
 * separate server computation path that could drift out of sync the
 * way upgradeDescriptor's two independent copies once did.
 */

import { sha256 } from '@noble/hashes/sha256';

export function descriptorFingerprint(descriptor: string): string {
  const hash = sha256(new TextEncoder().encode(descriptor));
  const hex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8);
}

export function formatDescriptorFingerprint(descriptor: string): string {
  const fp = descriptorFingerprint(descriptor);
  return `${fp.slice(0, 4)} ${fp.slice(4, 8)}`;
}
