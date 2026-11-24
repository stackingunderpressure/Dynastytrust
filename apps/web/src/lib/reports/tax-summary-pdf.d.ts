/** One tax year's spends and signatures. Data: rows opened on the device. */
export function buildSummaryPdf(data: {
  vault: Record<string, unknown>;
  year: number;
  members: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  signerSessions: Record<string, unknown>[];
  events: Record<string, unknown>[];
  attestations: Record<string, unknown>[];
}): Promise<Uint8Array>;
