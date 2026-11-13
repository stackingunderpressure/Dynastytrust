// Types for the TypeScript callers (the download build's local server).
// The rules themselves are plain JavaScript, shared with the server
// functions; these declarations describe only what the callers use.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vaultish = Record<string, any>;
type Refusal = { ok: false; status: number; error: string };

export const MIN_RECOVERY_BLOCKS: number;
export const MAX_TIMELOCK_OFFSET_BLOCKS: number;
export const TIP_FLOOR: Record<'bitcoin' | 'testnet' | 'signet', number>;
export const TIP_SOURCE_MAX_DIFF: number;
export function checkTimelockFloor(value: unknown, fieldName: string): string | null;
export function reconcileTips(a: number, b: number, maxDiff?: number): any;
export function relativeToAbsolute(offsetBlocks: number, tipHeight: number): number;

export interface StandardKeys {
  ok: true;
  founders: Vaultish[]; heirs: Vaultish[]; consenters: Vaultish[]; backups: Vaultish[]; secondHeirs: Vaultish[];
  hasBackup: boolean; hasSecondInheritance: boolean; needsTip: boolean;
}
export function isProvisioned(k: unknown): boolean;
export function standardKeys(vault: Vaultish, directKeys: unknown, members: Vaultish[] | undefined): Refusal | StandardKeys;
export function standardCompilePayload(vault: Vaultish, keys: StandardKeys, tipHeight: number, pubkeyFromXpub: (x: string) => string): Record<string, unknown>;
export function upgradeDescriptor(descriptor: string, origins: unknown): string;
export function standardCompiledRow(vault: Vaultish, keys: StandardKeys, compiled: Record<string, unknown>, tipHeight: number): Record<string, unknown>;

export const TR_INPUT_VBYTES: number;
export const TR_OUTPUT_VBYTES: number;
export const TX_OVERHEAD: number;
export const DUST_SATS: number;
export function estimateFee(numInputs: number, numOutputs: number, feeRate: number, inputVbytes?: number): number;
export function inputVbytesFor(vault: Vaultish, path: string): number;
export function spendKeys(vault: Vaultish, pubkeyFromXpub: (x: string) => string): any;
export interface Coin { txid: string; vout: number; value: number }
export type CoinPick<C extends Coin> =
  | { ok: false; status: number; body: Record<string, unknown> }
  | { ok: true; selected: C[]; totalIn: number; finalFee: number; amountSatsFinal: number; hasChange: boolean; changeVal: number };
export function selectCoins<C extends Coin>(args: { confirmed: C[]; amount_sats: number; sweep: unknown; selected_utxos: unknown; rate: number; inputVbytes: number }): CoinPick<C>;
export function spendCompilerRequest(vault: Vaultish, keys: unknown, opts: { inputs: unknown[]; destination: string; amountSatsFinal: number; finalFee: number; network: string; path: string; keyOrigins: unknown }): Record<string, unknown>;
export function spendSummary(vault: Vaultish, picked: unknown, opts: { destination: unknown; rate: number; network: string; path: string }): Record<string, unknown>;

export const MIN_FEE_RATE_SAT_VB: number;
export const MAX_FEE_RATE_SAT_VB: number;
export function isFiniteNumber(v: unknown): boolean;
export function checkNumberBounds(value: unknown, opts: { field: string; min?: number; max?: number; integer?: boolean }): string | null;

export function assertNotPrivateExtendedKey(s: string): void;
export function pubkeyFromXpub(xpub: string): string;
