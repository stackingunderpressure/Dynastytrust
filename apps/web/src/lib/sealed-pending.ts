/**
 * sealed-pending.ts -- text that must be stored sealed but could not be yet,
 * because this device does not hold the vault key at that moment: a new
 * member's own label when they join (the key reaches them when another member
 * next opens the vault), or a new vault's name when its key could not be made
 * right away. It waits here, on this device only, and use-vault-key.ts seals
 * and saves it as soon as the key arrives. It is never sent in the clear.
 */
export interface PendingSeal {
  name?: string;        // vault name (owner)
  label?: string;       // my member label
  key_label?: string;   // my member key label
}

const KEY = (vaultId: string) => `dt-zk-pending:${vaultId}`;

export function loadPending(vaultId: string): PendingSeal | null {
  try {
    const raw = localStorage.getItem(KEY(vaultId));
    return raw ? (JSON.parse(raw) as PendingSeal) : null;
  } catch {
    return null;
  }
}

export function savePending(vaultId: string, add: PendingSeal): void {
  try {
    localStorage.setItem(KEY(vaultId), JSON.stringify({ ...(loadPending(vaultId) ?? {}), ...add }));
  } catch {
    /* storage blocked: the text is simply not kept */
  }
}

export function clearPending(vaultId: string): void {
  try {
    localStorage.removeItem(KEY(vaultId));
  } catch {
    /* ignore */
  }
}
