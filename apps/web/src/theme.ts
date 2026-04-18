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
} as const;

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
