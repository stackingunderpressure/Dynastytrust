/** The attorney-review audit trail. Data: every row, opened on the device. */
export function buildAuditPdf(data: {
  vault: Record<string, unknown>;
  trustDoc: Record<string, unknown>;
  members: Record<string, unknown>[];
  invites: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  signerSessions: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  stipends: Record<string, unknown>[];
  distributionWallets: Record<string, unknown>[];
  events: Record<string, unknown>[];
  attestations: Record<string, unknown>[];
}): Promise<Uint8Array>;
