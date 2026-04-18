import type { InputHTMLAttributes, TextareaHTMLAttributes, CSSProperties } from 'react';
import { forwardRef } from 'react';
import { colors, fonts, radii } from '../../theme';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

function baseStyle(mono?: boolean): CSSProperties {
  return {
    width: '100%',
    padding: '11px 13px',
    background: colors.input,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: mono ? 12 : 14,
    fontFamily: mono ? fonts.mono : fonts.sans,
    boxSizing: 'border-box',
  };
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, style, ...rest },
  ref,
) {
  return <input ref={ref} style={{ ...baseStyle(mono), ...style }} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, style, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      style={{ ...baseStyle(mono), resize: 'vertical', ...style }}
      {...rest}
    />
  );
});
