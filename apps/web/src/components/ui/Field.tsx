import type { ReactNode } from 'react';
import { Label } from './Label';

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? (
        <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 6 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
