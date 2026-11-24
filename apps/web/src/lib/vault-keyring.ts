/**
 * vault-keyring.ts -- this browser's vault keys, and the one place text is
 * sealed before it is sent and opened after it comes back (zero-knowledge
 * storage, docs/zero-knowledge-storage-plan.md, Z1 slice 2).
 *
 * lib/api.ts calls sealVaultText / openVaultText for every field the server
 * never needs to read (vault name, member and key labels, requests, stipends,
 * distribution wallets, sent-secret labels, the trust document), so pages keep
 * reading plain `vault.name` and never handle ciphertext themselves.
 *
 * Keys arrive two ways: use-vault-key.ts syncs one vault when it is opened
 * (and does the key housekeeping), and loadAllMyVaultKeys() fetches every
 * wrap addressed to this member in one call, for lists such as the dashboard.
 *
 * A value that will not open (no key yet, or tampered) is shown as LOCKED_TEXT,
 * never as ciphertext, and is never written back. A plain (legacy) value is
 * shown as it is.
 *
 * A replacement vault (vaults-rotate) starts with the values its predecessor
 * sealed. They are bound to the predecessor's id, so opening falls back along
 * predecessor_id; new writes use the successor's own key.
 */
import { isSealed, openField, sealField, unwrapVaultKeys, type VaultKeyWrapRow } from './vault-key';

export const LOCKED_TEXT = 'Locked';

interface Ring {
  keys: Map<number, Uint8Array>;
  version: number; // current version this member holds; 0 = none
}

const rings = new Map<string, Ring>();
const predecessors = new Map<string, string>();

export function setVaultKeys(vaultId: string, keys: Map<number, Uint8Array>, version: number): void {
  const prev = rings.get(vaultId);
  const merged = new Map(prev?.keys ?? []);
  for (const [v, k] of keys) merged.set(v, k);
  rings.set(vaultId, { keys: merged, version: Math.max(version, prev?.version ?? 0) });
}

export function vaultKeyVersion(vaultId: string): number {
  return rings.get(vaultId)?.version ?? 0;
}

export function notePredecessor(vaultId: string, predecessorId: string | null | undefined): void {
  if (predecessorId) predecessors.set(vaultId, predecessorId);
}

/** Load every vault-key wrap addressed to me, across all my vaults. */
export async function loadAllMyVaultKeys(
  fetchAll: () => Promise<{ vaults: { vault_id: string; version: number; checks: Record<string, string>; mine: VaultKeyWrapRow[] }[] }>,
  myUserId: string,
): Promise<void> {
  const { vaults } = await fetchAll();
  for (const v of vaults) {
    const keys = unwrapVaultKeys(v.mine, v.vault_id, myUserId, v.checks);
    setVaultKeys(v.vault_id, keys, keys.has(v.version) ? v.version : 0);
  }
}

/** Plain text for display. Legacy plain values pass through; a sealed value
 *  this member cannot open reads LOCKED_TEXT. null/undefined stay as they are. */
export function openVaultText<T extends string | null | undefined>(vaultId: string, field: string, value: T): T | string {
  if (!isSealed(value)) return value;
  let id: string | undefined = vaultId;
  for (let hops = 0; id && hops < 8; hops++) {
    const ring = rings.get(id);
    if (ring) {
      const plain = openField(ring.keys, id, field, value);
      if (plain !== null) return plain;
    }
    id = predecessors.get(id);
  }
  return LOCKED_TEXT;
}

/** JSON (trust document, attestation snapshot) sealed as { zk: "<sealed>" }. */
export function openVaultJson<T>(vaultId: string, field: string, value: T): T | null {
  const z = (value as { zk?: unknown } | null)?.zk;
  if (!isSealed(z)) return value;
  const plain = openVaultText(vaultId, field, z);
  if (plain === LOCKED_TEXT) return null;
  try {
    return JSON.parse(plain as string) as T;
  } catch {
    return null;
  }
}

export class VaultKeyNotReady extends Error {
  constructor() {
    super("This vault's key isn't on this device yet. Open the vault once, or wait for a member to share it.");
  }
}

/** Seal text under this vault's current key. Throws VaultKeyNotReady when the
 *  key is not here; never falls back to sending plain text. Empty strings and
 *  null are sent as they are (they say nothing). */
export function sealVaultText<T extends string | null | undefined>(vaultId: string, field: string, plain: T): T | string {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isSealed(plain)) return plain; // already sealed (e.g. copied from a row)
  const ring = rings.get(vaultId);
  const key = ring && ring.version > 0 ? ring.keys.get(ring.version) : undefined;
  if (!ring || !key) throw new VaultKeyNotReady();
  return sealField(key, ring.version, vaultId, field, plain as string);
}

export function sealVaultJson(vaultId: string, field: string, value: unknown): { zk: string } {
  return { zk: sealVaultText(vaultId, field, JSON.stringify(value ?? {})) as string };
}

/** Test hook: forget every key in this browser session. */
export function clearVaultKeyring(): void {
  rings.clear();
  predecessors.clear();
}
