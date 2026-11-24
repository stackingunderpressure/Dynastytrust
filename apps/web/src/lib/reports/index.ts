/**
 * reports/index.ts -- the four vault reports, built in the browser
 * (zero-knowledge storage, Z1 slice 4, docs/zero-knowledge-storage-plan.md).
 *
 * The server hands over every row of the vault still sealed
 * (/api/vault-activity-export); this device opens the names, labels, notes
 * and comments with the vault key, then draws the PDF or writes the JSON
 * locally. Nothing readable is rendered on, or sent back to, the server.
 *
 * The PDF drawing code (pdf-lib) is loaded only when a report is asked for.
 */
import { api, loadVaultKeysForDisplay } from '../api';
import { ensureVaultKey } from '../use-vault-key';
import { LOCKED_TEXT, openVaultText } from '../vault-keyring';
import {
  openAttestation, openInvite, openMember, openProposal, openRequest, openSealedDeep,
  openSessionLabel, openStipend, openVault, openWallet,
} from '../sealed-fields';
import { downloadFile } from '../download-file';

type Row = Record<string, unknown>;

export interface OpenedExport {
  export_version: number;
  exported_at: string;
  vault: Row;
  members: Row[];
  invites: Row[];
  proposals: Row[];
  signer_sessions: Row[];
  proposal_comments: Row[];
  vault_requests: Row[];
  scheduled_stipends: Row[];
  distribution_wallets: Row[];
  events: Row[];
  attestations: Row[];
}

const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

/** A comment is sealed as {body, vote} under the field comment:<proposal>. */
function openComment(vaultId: string, c: Row): Row {
  if (typeof c.sealed !== 'string') return c;
  const plain = openVaultText(vaultId, `comment:${c.proposal_id as string}`, c.sealed);
  if (plain === LOCKED_TEXT) return { ...c, sealed: undefined, body: LOCKED_TEXT, vote: null };
  try {
    const v = JSON.parse(plain as string) as { body?: string | null; vote?: string | null };
    return { ...c, sealed: undefined, body: v.body ?? null, vote: v.vote ?? null };
  } catch {
    return { ...c, sealed: undefined, body: LOCKED_TEXT, vote: null };
  }
}

/** Pure: open every sealed value in an export. A value this member cannot
 *  open reads "Locked"; nothing sealed is left in the result. */
export function openExport(vaultId: string, raw: Row): OpenedExport {
  return {
    export_version: Number(raw.export_version ?? 1),
    exported_at: String(raw.exported_at ?? new Date().toISOString()),
    vault: openVault(raw.vault as Row),
    members: rows(raw.members).map(openMember),
    invites: rows(raw.invites).map(openInvite),
    proposals: rows(raw.proposals).map(openProposal),
    signer_sessions: rows(raw.signer_sessions).map(s => ({ ...s, label: openSessionLabel(vaultId, s.label as string | null) })),
    proposal_comments: rows(raw.proposal_comments).map(c => openComment(vaultId, c)),
    vault_requests: rows(raw.vault_requests).map(openRequest),
    scheduled_stipends: rows(raw.scheduled_stipends).map(openStipend),
    distribution_wallets: rows(raw.distribution_wallets).map(openWallet),
    events: rows(raw.events).map(e => ({ ...e, metadata: openSealedDeep(vaultId, e.metadata) })),
    attestations: rows(raw.attestations).map(openAttestation),
  };
}

async function loadOpened(vaultId: string): Promise<OpenedExport> {
  await Promise.all([loadVaultKeysForDisplay(), ensureVaultKey(vaultId).catch(() => null)]);
  const raw = await api.vaultExportData(vaultId);
  return openExport(vaultId, raw);
}

function safeName(name: unknown): string {
  return String(name || 'vault').replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function pdfBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** The vault backup sheet (descriptor, spending paths, QR). */
export async function downloadVaultPdf(vaultId: string): Promise<boolean> {
  const data = await loadOpened(vaultId);
  const { buildVaultPDF } = await import('./vault-pdf.js');
  const bytes = await buildVaultPDF(data.vault);
  return downloadFile(`dynastytrust_${safeName(data.vault.name)}.pdf`, pdfBlob(bytes), 'application/pdf');
}

/** The attorney-review audit trail. */
export async function downloadAuditPdf(vaultId: string): Promise<boolean> {
  const d = await loadOpened(vaultId);
  const { buildAuditPdf } = await import('./audit-pdf.js');
  const bytes = await buildAuditPdf({
    vault: d.vault,
    trustDoc: (d.vault.trust_doc as Row) ?? {},
    members: d.members,
    invites: d.invites.filter(i => !i.claimed_at),
    proposals: d.proposals,
    signerSessions: d.signer_sessions,
    comments: d.proposal_comments,
    requests: d.vault_requests,
    stipends: d.scheduled_stipends,
    distributionWallets: d.distribution_wallets,
    events: d.events,
    attestations: d.attestations,
  });
  return downloadFile(`dynastytrust_audit_${safeName(d.vault.name)}.pdf`, pdfBlob(bytes), 'application/pdf');
}

/** One tax year's spends and signatures. */
export async function downloadTaxSummary(vaultId: string, year: number): Promise<boolean> {
  const d = await loadOpened(vaultId);
  const { buildSummaryPdf } = await import('./tax-summary-pdf.js');
  const bytes = await buildSummaryPdf({
    vault: d.vault,
    year,
    members: d.members,
    proposals: d.proposals,
    signerSessions: d.signer_sessions,
    events: d.events,
    attestations: d.attestations,
  });
  return downloadFile(`dynastytrust_tax_${safeName(d.vault.name)}_${year}.pdf`, pdfBlob(bytes), 'application/pdf');
}

/** Every row of the vault as readable JSON, opened on this device. */
export async function downloadActivityJson(vaultId: string): Promise<boolean> {
  const d = await loadOpened(vaultId);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return downloadFile(
    `dynastytrust_${safeName(d.vault.name)}_activity_${ts}.json`,
    JSON.stringify(d, null, 2),
    'application/json',
  );
}
