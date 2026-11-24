/**
 * use-vault-key.ts -- on opening a vault, get this member's vault keys and do
 * whatever key housekeeping is due (lib/vault-key.ts planVaultKeySync):
 * the owner creates the first key, or replaces it after a member left; any
 * member holding the key wraps it for members who don't have it yet.
 *
 * Returns the keys this member can read with (by version) and the version new
 * data should be sealed under. `status` is 'waiting' until another member has
 * shared the key with us, 'locked' while the messaging key is behind Face ID.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { supabase } from './supabase';
import { getMessagingPubkey, messagingKeyLocked } from './messaging';
import { peerKeyStatus } from './messaging-safety';
import { newVaultKey, planVaultKeySync, unwrapVaultKeys, vaultKeyCheck, wrapVaultKey } from './vault-key';

export type VaultKeyStatus = 'loading' | 'ready' | 'waiting' | 'locked' | 'error';

export interface VaultKeyHandle {
  status: VaultKeyStatus;
  keys: Map<number, Uint8Array>;
  /** Version to seal new data under; 0 when this member has no current key. */
  version: number;
  reload: () => void;
}

// One run per vault at a time across components on the same page.
const inFlight = new Map<string, Promise<{ keys: Map<number, Uint8Array>; version: number; status: VaultKeyStatus }>>();

async function syncOnce(vaultId: string): Promise<{ keys: Map<number, Uint8Array>; version: number; status: VaultKeyStatus }> {
  if (messagingKeyLocked()) return { keys: new Map(), version: 0, status: 'locked' };
  const { data } = await supabase.auth.getSession();
  const myUserId = data.session?.user.id;
  if (!myUserId) return { keys: new Map(), version: 0, status: 'error' };
  // Make sure this browser has a messaging key and it is the one published
  // on our member row, or nobody can wrap the vault key to us.
  const myPub = getMessagingPubkey();
  const { members } = await api.members.list(vaultId);
  const me = members.find(m => m.user_id === myUserId);
  if (me && me.messaging_pubkey !== myPub) await api.members.update(me.id, { messaging_pubkey: myPub });

  let state = await api.vaultKeys.get(vaultId);
  let keys = unwrapVaultKeys(state.mine, vaultId, myUserId, state.checks);
  const trusted = (userId: string, pubkey: string) => peerKeyStatus(vaultId, userId, pubkey) !== 'changed';
  const plan = planVaultKeySync(state, myUserId, keys.has(state.version), trusted);

  if (plan.kind === 'create' || plan.kind === 'rotate') {
    const key = newVaultKey();
    await api.vaultKeys.post({
      vault_id: vaultId,
      version: plan.version,
      check: vaultKeyCheck(key, vaultId, plan.version),
      wraps: wrapVaultKey(key, vaultId, plan.version, plan.recipients),
    });
    state = await api.vaultKeys.get(vaultId);
    keys = unwrapVaultKeys(state.mine, vaultId, myUserId, state.checks);
  } else if (plan.kind === 'share') {
    const key = keys.get(plan.version)!;
    await api.vaultKeys.post({
      vault_id: vaultId,
      version: plan.version,
      wraps: wrapVaultKey(key, vaultId, plan.version, plan.recipients),
    });
  }
  const version = keys.has(state.version) ? state.version : 0;
  return { keys, version, status: version > 0 ? 'ready' : 'waiting' };
}

export function useVaultKey(vaultId: string | null | undefined): VaultKeyHandle {
  const [state, setState] = useState<{ keys: Map<number, Uint8Array>; version: number; status: VaultKeyStatus }>({
    keys: new Map(),
    version: 0,
    status: 'loading',
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    let p = inFlight.get(vaultId);
    if (!p) {
      p = syncOnce(vaultId).finally(() => inFlight.delete(vaultId));
      inFlight.set(vaultId, p);
    }
    p.then(r => { if (!cancelled) setState(r); })
      .catch(() => { if (!cancelled) setState({ keys: new Map(), version: 0, status: 'error' }); });
    return () => { cancelled = true; };
  }, [vaultId, tick]);

  return { ...state, reload };
}
