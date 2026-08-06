import { useState } from 'react';
import { colors, fonts, radii } from '../../theme';
import { Button, Label } from '../ui';

// Labeled monospace box with a copy button -- used for address,
// descriptor, miniscript policy, BSMS export. Relocated out of
// PolicyBuilder.tsx.
export function CopyField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <Label>{label}</Label>
        <Button
          variant="ghost"
          size="sm"
          style={{ padding: '3px 9px', fontSize: 11 }}
          onClick={() =>
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? 'check Copied' : 'Copy'}
        </Button>
      </div>
      <div
        style={{
          background: colors.inset,
          borderRadius: radii.md,
          padding: '10px 12px',
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.sub,
          wordBreak: 'break-all',
          lineHeight: 1.7,
          maxHeight: multiline ? 90 : 'none',
          overflowY: multiline ? 'auto' : 'visible',
        }}
      >
        {value}
      </div>
    </div>
  );
}
