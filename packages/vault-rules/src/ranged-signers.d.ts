export interface MultipathKey { fingerprint: number; path: number[]; hd: unknown; key00: string }
export function multipathKeys(multipath: string | null | undefined): MultipathKey[];
export function canonicalSigner(
  sigPubkey: string,
  derivations: { pubkey: Uint8Array; fingerprint: number; path: number[] }[] | undefined,
  keys: MultipathKey[],
): string;
