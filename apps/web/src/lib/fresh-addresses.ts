import type { Vault } from './api';

/** A vault made with "a new address every time" (ranged slice 3): its
 *  stored descriptors are `<0;1>/*` (descriptor_version 2). Anything else
 *  has one fixed address. */
export function isFreshAddressVault(v: Pick<Vault, 'descriptor_version'>): boolean {
  return v.descriptor_version === 2;
}
