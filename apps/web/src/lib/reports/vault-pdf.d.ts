/** The vault backup sheet (descriptor, paths, QR). Data: the opened vault row. */
export function buildVaultPDF(vault: Record<string, unknown>): Promise<Uint8Array>;
