import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { colors, fonts, radii } from '../../theme';

type Variant = 'primary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base: CSSProperties = {
  fontFamily: fonts.sans,
  borderRadius: radii.md,
  cursor: 'pointer',
  border: 'none',
};

const sizeStyles: Record<Size, CSSProperties> = {
  sm: { padding: '9px 16px', fontSize: 13 },
  md: { padding: '11px 22px', fontSize: 14 },
};

const variantStyles: Record<Variant, CSSProperties> = {
  primary: {
    background: colors.gold,
    color: colors.bg,
    fontWeight: 700,
  },
  ghost: {
    background: 'none',
    border: `1px solid ${colors.border}`,
    color: colors.sub,
    fontWeight: 400,
  },
  danger: {
    background: 'none',
    border: `1px solid ${colors.borderDanger}`,
    color: colors.red,
    fontWeight: 400,
  },
};

const disabledStyle: CSSProperties = { opacity: 0.5, cursor: 'not-allowed' };

export function Button({
  variant = 'primary',
  size = 'md',
  style,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled}
      style={{
        ...base,
        ...sizeStyles[size],
        ...variantStyles[variant],
        ...(disabled ? disabledStyle : null),
        ...style,
      }}
      {...rest}
    />
  );
}
