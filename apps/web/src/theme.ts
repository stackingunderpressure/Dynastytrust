// JS-side mirror of src/styles/core.css tokens.
// Inline style objects read from here; CSS uses the same values as custom
// properties. When you change one, change both.

export const colors = {
  bg: '#07070F',
  header: '#0A0A12',
  surface: '#0F0F1A',
  raised: '#141422',
  input: '#161622',
  border: '#1E1E30',
  borderDanger: '#3A1A1A',

  gold: '#C9A84C',
  goldDim: '#8B6914',
  text: '#E8E4D8',
  muted: '#5A5570',
  sub: '#9994A8',

  red: '#E05C5C',
  green: '#52C47A',
  blue: '#4A90D9',
  orange: '#E09050',

  // Semantic dark background tints used by inline-styled message boxes,
  // insets, and badges. Centralized here so pages stop hand-typing hex.
  inset: '#0A0A14',        // darkest panel / code / row inset
  dangerBg: '#1A0A0A',     // danger / error message background
  successBg: '#0A1A14',    // success message background
  badgeTestnet: '#0A1F14', // network badge -- testnet / signet
  badgeMainnet: '#2A1F0A', // network badge -- mainnet (gold tint)
  goldBg: '#1A1400',       // gold-tinted panel background
  divider: '#1A1A28',      // subtle divider / border tint
  qrModule: '#F4F0CE',     // QR "dark" module color on the gold theme
} as const;

// Categorical hues for distinguishing personas / members at a glance.
// The first three reuse semantic colors; the rest are distinct extra hues.
export const personaPalette = [
  colors.gold,
  colors.blue,
  colors.green,
  '#B06AE0',
  '#E06A6A',
  '#6AB8E0',
] as const;

export const fonts = {
  display: '"Playfair Display", Georgia, serif',
  sans: '"DM Sans", system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
} as const;

export const theme = { colors, fonts, radii, space } as const;

export type Theme = typeof theme;
