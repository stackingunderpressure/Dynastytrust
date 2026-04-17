import type { LabelHTMLAttributes, CSSProperties } from 'react';
import { colors } from '../../theme';

const base: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.08em',
  color: colors.muted,
  textTransform: 'uppercase',
  marginBottom: 5,
  display: 'block',
};

export function Label({ style, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label style={{ ...base, ...style }} {...rest} />;
}
