/**
 * xpub.ts -- derive the compressed pubkey hex at the xpub's own
 * position. Matches what the keystore stores for browser-generated
 * keys so the server-side compile can substitute the pubkey into the
 * miniscript regardless of how the member provisioned their key.
 *
 * NOTE: deliberately returns the account-level pubkey (same as the
 * existing keystore convention). Mixing derived-child pubkeys in
 * here would diverge from browser keys and break
 * upgradeDescriptor's substitution step.
 */

import { HDKey } from '@scure/bip32';

export function pubkeyFromXpub(xpub: string): string {
  const hd = HDKey.fromExtendedKey(xpub.trim());
  if (!hd.publicKey) throw new Error('Could not derive pubkey from xpub');
  return Array.from(hd.publicKey)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
