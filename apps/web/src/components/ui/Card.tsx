import type { HTMLAttributes, CSSProperties } from 'react';
import { colors, radii, space } from '../../theme';

type Tone = 'surface' | 'raised';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
  padding?: number;
}

const toneStyles: Record<Tone, CSSProperties> = {
  surface: { background: colors.surface },
  raised: { background: colors.raised },
};

export function Card({ tone = 'surface', padding = space[6], style, ...rest }: CardProps) {
  return (
    <div
      style={{
        ...toneStyles[tone],
        border: `1px solid ${colors.border}`,
        borderRadius: radii.lg,
        padding,
        ...style,
      }}
      {...rest}
    />
  );
}
