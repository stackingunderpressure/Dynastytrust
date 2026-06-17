/**
 * Type declarations for the canonical vault-templates.js single source of
 * truth. Hand-authored to match the .js module so both Vite/tsc and the
 * Netlify esbuild bundler consume the SAME physical data file with full
 * typing on the web side. No secret field exists here -- public template
 * shape + teaching content only.
 */

export type VaultMode = 'plain' | 'inheritance';

export type ScenarioSeverity = 'info' | 'warn' | 'danger';

export interface Scenario {
  title: string;
  trigger: string;
  outcome: string;
  actions?: string[];
  severity?: ScenarioSeverity;
}

/**
 * COMPILE-CRITICAL structural params. These are the exact values
 * PolicyBuilder feeds the Fly.io compiler. Do not let them drift.
 */
export interface TemplateConfig {
  mode: VaultMode;
  plannedFounders: number;
  founderQ: number;
  plannedHeirs: number;
  heirQ: number;
  /** Relative block offset; PolicyBuilder forwards tip + offset. */
  recoveryAfter: number;
  inheritanceAfter: number;
  protectorEnabled?: boolean;
  protectorAfter?: number;
  protectorQ?: number;
  plannedProtectors?: number;
  consentEnabled?: boolean;
  consentQ?: number;
  plannedConsenters?: number;
}

export interface VaultTemplate {
  id: string;
  title: string;
  tagline: string;
  /** Plain-English one-liner for Sage and the chips. */
  description: string;
  /** The longer card copy used in PolicyBuilder. */
  useCase: string;
  config: TemplateConfig;
  scenarios: Scenario[];
  /** Short-timelock sandbox variant flag. */
  testMode?: boolean;
}

export declare const VAULT_TEMPLATES: VaultTemplate[];

export declare const TEMPLATE_TITLES: Record<string, string>;

export declare function productionTemplates(): VaultTemplate[];

export declare function testTemplates(): VaultTemplate[];

export declare function templateById(id: string): VaultTemplate | undefined;

export declare function renderTemplateDigest(opts?: { includeTest?: boolean }): string;

export declare function openingChips(): string[];
