import { colors, fonts } from '../theme';

interface PageHeaderProps {
  title: string;
  sub?: string;
}

export function PageHeader({ title, sub }: PageHeaderProps) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h1
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: colors.text,
          fontFamily: fonts.display,
          margin: '0 0 6px',
        }}
      >
        {title}
      </h1>
      {sub ? (
        <p style={{ fontSize: 14, color: colors.muted, margin: 0 }}>{sub}</p>
      ) : null}
    </div>
  );
}
