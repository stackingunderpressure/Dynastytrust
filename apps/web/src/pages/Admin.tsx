import { useCallback, useEffect, useState } from 'react';
import { api, type AdminUsageReport } from '../lib/api';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';

/**
 * Admin.tsx -- admin-only Sage token-usage report.
 *
 * DISCREET: this page is reachable by URL only (/admin); it is NOT in
 * the main nav. The REAL gate is server-side in the admin-usage Netlify
 * function, which decides authorization from the verified JWT and the
 * ADMIN_EMAILS allow-list. A non-admin caller gets a 403; this page
 * then renders a plain no-access message with no data. The browser
 * cannot bypass the gate -- it never sees any usage data unless the
 * server returns it.
 *
 * Costs shown are an ESTIMATE at current list prices. The token counts
 * are Anthropic's exact per-call numbers; the authoritative bill is at
 * console.anthropic.com.
 */

const CONSOLE_URL = 'https://console.anthropic.com/';

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtUsd(n: number | null): string {
  if (n === null) return 'unknown';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

const cellStyle: React.CSSProperties = {
  padding: `${space[2]}px ${space[3]}px`,
  borderBottom: `1px solid ${colors.divider}`,
  fontFamily: fonts.mono,
  fontSize: 13,
  color: colors.text,
  textAlign: 'right',
};

const headCellStyle: React.CSSProperties = {
  padding: `${space[2]}px ${space[3]}px`,
  borderBottom: `1px solid ${colors.border}`,
  fontFamily: fonts.sans,
  fontSize: 11,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: colors.gold,
  textAlign: 'right',
};

export default function Admin() {
  const [report, setReport] = useState<AdminUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setDenied(false);
    try {
      const data = await api.admin.usage();
      setReport(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed';
      // The server returns 403 "Forbidden" for a non-admin caller; the
      // shared req() helper surfaces that as the thrown error message.
      if (msg.toLowerCase().includes('forbidden')) {
        setDenied(true);
      } else {
        setErr(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <p style={{ color: colors.sub, fontFamily: fonts.sans }}>Loading usage...</p>
    );
  }

  if (denied) {
    return (
      <Card>
        <p style={{ color: colors.text, fontFamily: fonts.sans, margin: 0 }}>
          You do not have access to this page.
        </p>
      </Card>
    );
  }

  if (err) {
    return (
      <Card>
        <p style={{ color: colors.red, fontFamily: fonts.sans, marginTop: 0 }}>{err}</p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!report) return null;

  const t = report.totals;
  const totalTokens =
    t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[5] }}>
      {/* Headline estimate */}
      <Card>
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: colors.gold,
            marginBottom: space[2],
          }}
        >
          Estimated cost (list prices)
        </div>
        <div
          style={{
            fontFamily: fonts.display,
            fontSize: 48,
            lineHeight: 1,
            color: colors.text,
          }}
        >
          {fmtUsd(report.estimatedCostUsd)}
        </div>
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 13,
            color: colors.sub,
            marginTop: space[3],
          }}
        >
          {fmtInt(totalTokens)} tokens across {fmtInt(report.callCount)} Sage calls
        </div>
        <p
          style={{
            fontFamily: fonts.sans,
            fontSize: 12,
            color: colors.muted,
            marginTop: space[4],
            marginBottom: 0,
            lineHeight: 1.6,
          }}
        >
          Estimated at current list prices; tokens are Anthropic's exact per-call
          counts. The authoritative bill is at{' '}
          <a
            href={CONSOLE_URL}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: colors.gold }}
          >
            console.anthropic.com
          </a>
          .
        </p>
      </Card>

      {/* Per-model breakdown */}
      <Card padding={0}>
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: colors.gold,
            padding: `${space[4]}px ${space[4]}px ${space[2]}px`,
          }}
        >
          By model
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...headCellStyle, textAlign: 'left' }}>Model</th>
                <th style={headCellStyle}>Input</th>
                <th style={headCellStyle}>Output</th>
                <th style={headCellStyle}>Cache read</th>
                <th style={headCellStyle}>Cache create</th>
                <th style={headCellStyle}>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {report.byModel.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{
                      ...cellStyle,
                      textAlign: 'center',
                      color: colors.muted,
                    }}
                  >
                    No usage recorded yet.
                  </td>
                </tr>
              ) : (
                report.byModel.map((m) => (
                  <tr key={m.model}>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: 'left',
                        color: colors.text,
                      }}
                    >
                      {m.model}
                    </td>
                    <td style={cellStyle}>{fmtInt(m.input_tokens)}</td>
                    <td style={cellStyle}>{fmtInt(m.output_tokens)}</td>
                    <td style={cellStyle}>{fmtInt(m.cache_read_tokens)}</td>
                    <td style={cellStyle}>{fmtInt(m.cache_creation_tokens)}</td>
                    <td
                      style={{
                        ...cellStyle,
                        color: m.estimatedCostUsd === null ? colors.muted : colors.gold,
                      }}
                    >
                      {fmtUsd(m.estimatedCostUsd)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Recent days */}
      <Card>
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: colors.gold,
            marginBottom: space[3],
          }}
        >
          Recent days (last 30)
        </div>
        {report.byDay.length === 0 ? (
          <p style={{ color: colors.muted, fontFamily: fonts.sans, fontSize: 13, margin: 0 }}>
            No activity in the last 30 days.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            {report.byDay.map((d) => {
              const dayTotal =
                d.input_tokens +
                d.output_tokens +
                d.cache_read_tokens +
                d.cache_creation_tokens;
              return (
                <div
                  key={d.day}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: colors.inset,
                    border: `1px solid ${colors.divider}`,
                    borderRadius: radii.md,
                    padding: `${space[2]}px ${space[3]}px`,
                  }}
                >
                  <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.sub }}>
                    {d.day}
                  </span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text }}>
                    {fmtInt(dayTotal)} tokens
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
