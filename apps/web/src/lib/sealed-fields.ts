/**
 * sealed-fields.ts -- which fields of which rows are sealed with the vault key
 * (docs/zero-knowledge-storage-plan.md Z1 slice 2), and the openers lib/api.ts
 * runs on every row it returns. One table, so a field is never sealed under
 * one name and opened under another.
 *
 * The FIELD string is part of the seal's associated data: a value sealed as a
 * stipend name cannot be replayed as a vault name. Member labels and invite
 * labels share one field on purpose -- invites-claim.js copies the invite's
 * label onto the new member row as it is.
 */
import { LOCKED_TEXT, notePredecessor, openVaultJson, openVaultText } from './vault-keyring';

export const F = {
  vaultName: 'vault.name',
  keyLabel: 'vault.key_label',
  trustDoc: 'vault.trust_doc',
  memberLabel: 'member.label',
  memberKeyLabel: 'member.key_label',
  requestRuleName: 'request.rule_name',
  requestRecipient: 'request.recipient_name',
  requestReason: 'request.reason',
  requestNote: 'request.resolution_note',
  stipendName: 'stipend.name',
  stipendRecipient: 'stipend.recipient_name',
  walletName: 'wallet.name',
  walletBeneficiary: 'wallet.beneficiary_name',
  secretLabel: 'secret.label',
  secretRecipient: 'secret.recipient_label',
  attestationData: 'attestation.target_data',
  proposalMemo: 'proposal.memo',
  signerLabel: 'signer.label',
} as const;

type Row = Record<string, unknown>;

function openStr(row: Row, vaultId: string, key: string, field: string): void {
  if (key in row) row[key] = openVaultText(vaultId, field, row[key] as string | null | undefined);
}

export function openVault<T>(v: T): T {
  if (!v || typeof v !== 'object') return v;
  const row = { ...(v as Row) };
  const id = row.id as string;
  notePredecessor(id, row.predecessor_id as string | null | undefined);
  openStr(row, id, 'name', F.vaultName);
  if (Array.isArray(row.key_labels)) {
    row.key_labels = (row.key_labels as { pubkey: string; label: string }[]).map(e => ({
      ...e,
      label: openVaultText(id, F.keyLabel, e.label) as string,
    }));
  }
  if (row.trust_doc && typeof row.trust_doc === 'object') {
    row.trust_doc = openVaultJson(id, F.trustDoc, row.trust_doc) ?? {};
  }
  return row as T;
}

export function openMember<T>(m: T): T {
  const row = { ...(m as Row) };
  const vid = row.vault_id as string;
  openStr(row, vid, 'label', F.memberLabel);
  openStr(row, vid, 'key_label', F.memberKeyLabel);
  return row as T;
}

export function openInvite<T>(i: T): T {
  const row = { ...(i as Row) };
  openStr(row, row.vault_id as string, 'invited_label', F.memberLabel);
  return row as T;
}

export function openRequest<T>(r: T): T {
  const row = { ...(r as Row) };
  const vid = row.vault_id as string;
  openStr(row, vid, 'rule_name', F.requestRuleName);
  openStr(row, vid, 'recipient_name', F.requestRecipient);
  openStr(row, vid, 'reason', F.requestReason);
  openStr(row, vid, 'resolution_note', F.requestNote);
  return row as T;
}

export function openStipend<T>(s: T): T {
  const row = { ...(s as Row) };
  const vid = row.vault_id as string;
  openStr(row, vid, 'name', F.stipendName);
  openStr(row, vid, 'recipient_name', F.stipendRecipient);
  return row as T;
}

export function openWallet<T>(w: T): T {
  const row = { ...(w as Row) };
  const vid = row.vault_id as string;
  openStr(row, vid, 'name', F.walletName);
  openStr(row, vid, 'beneficiary_name', F.walletBeneficiary);
  return row as T;
}

export function openSecret<T>(s: T, vaultId: string): T {
  const row = { ...(s as Row) };
  openStr(row, vaultId, 'label', F.secretLabel);
  if (Array.isArray(row.recipients)) {
    row.recipients = (row.recipients as { label: string }[]).map(r => ({
      ...r,
      label: openVaultText(vaultId, F.secretRecipient, r.label) as string,
    }));
  }
  return row as T;
}

export function openAttestation<T>(a: T): T {
  const row = { ...(a as Row) };
  if (row.target_data && typeof row.target_data === 'object') {
    row.target_data = openVaultJson(row.vault_id as string, F.attestationData, row.target_data) ?? {};
  }
  return row as T;
}

/** A signer session's label is the signer's own key label (sealed as
 *  signer.label) or, when they gave none, their member label copied by the
 *  server (sealed as member.label). */
export function openSessionLabel(vaultId: string, label: string | null | undefined): string | null {
  if (!label) return label ?? null;
  const a = openVaultText(vaultId, F.signerLabel, label);
  if (a !== LOCKED_TEXT) return a as string;
  return openVaultText(vaultId, F.memberLabel, label) as string;
}

/** Proposals carry a sealed memo and embedded signer sessions; some carry
 *  a joined vault (proposals-mine). */
export function openProposal<T>(p: T): T {
  const row = { ...(p as Row) };
  const vid = row.vault_id as string;
  openStr(row, vid, 'memo', F.proposalMemo);
  if (Array.isArray(row.signer_sessions)) {
    row.signer_sessions = (row.signer_sessions as Row[]).map(ss => ({ ...ss, label: openSessionLabel(vid, ss.label as string | null) }));
  }
  if (row.vault && typeof row.vault === 'object') row.vault = openVault(row.vault);
  return row as T;
}
