import type { CSSProperties } from 'react';
import { colors, fonts } from '../../theme';

// A big, tappable +/- stepper for "how many people" fields. Replaces a raw
// <input type="number"> that pops the system numeric keyboard for what's
// realistically always a single-digit tap-tap-tap choice -- the keyboard,
// tiny native spinner arrows, and the risk of fat-fingering a stray digit
// were exactly the friction being asked to go away here. No keyboard ever
// needs to appear for this field now.
export function CountStepper({
  value,
  min = 1,
  max = 20,
  label,
  color,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  label: string;
  color: string;
  onChange: (n: number) => void;
}) {
  const canDec = value > min;
  const canInc = value < max;

  function stepButtonStyle(enabled: boolean, filled: boolean): CSSProperties {
    return {
      width: 44,
      height: 44,
      borderRadius: '50%',
      border: filled ? 'none' : `1px solid ${colors.border}`,
      background: filled ? color : colors.input,
      color: filled ? colors.bg : enabled ? colors.text : colors.muted,
      fontSize: 22,
      fontWeight: 700,
      fontFamily: fonts.sans,
      cursor: enabled ? 'pointer' : 'not-allowed',
      opacity: enabled ? 1 : 0.45,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      lineHeight: 1,
      transition: 'transform 100ms ease',
    };
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <button
        type="button"
        aria-label={`Fewer ${label}`}
        disabled={!canDec}
        onClick={() => canDec && onChange(value - 1)}
        style={stepButtonStyle(canDec, false)}
      >
        &minus;
      </button>

      <div style={{ minWidth: 54, textAlign: 'center' }}>
        <div
          style={{
            fontSize: 30,
            fontWeight: 800,
            color,
            fontFamily: fonts.display,
            lineHeight: 1,
          }}
        >
          {value}
        </div>
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </div>
      </div>

      <button
        type="button"
        aria-label={`More ${label}`}
        disabled={!canInc}
        onClick={() => canInc && onChange(value + 1)}
        style={stepButtonStyle(canInc, true)}
      >
        +
      </button>
    </div>
  );
}
