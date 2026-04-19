import { Component, type ReactNode, type ErrorInfo } from 'react';
import { colors, fonts, space } from '../theme';

/**
 * ErrorBoundary -- catches runtime errors anywhere in the authed
 * app and renders a readable fallback instead of a blank screen.
 *
 * Without this, a thrown error inside a route's subtree can unmount
 * the whole app and leave the user looking at an empty page. With
 * it, the error message (and stack in dev builds) renders so the
 * user can copy it back to support and we can see what broke.
 */

interface Props { children: ReactNode; }
interface State { error: Error | null; info: ErrorInfo | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep info for the fallback. Also console.error so DevTools
    // shows the original stack in case the user shares it.
    this.setState({ info });
    console.error('[DynastyTrust error boundary]', error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div
        style={{
          minHeight: '100vh',
          background: colors.bg,
          color: colors.text,
          fontFamily: fonts.sans,
          padding: space[6],
        }}
      >
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div
            style={{
              fontFamily: fonts.display,
              fontSize: 14,
              letterSpacing: '0.16em',
              color: colors.gold,
              textTransform: 'uppercase',
              marginBottom: space[3],
            }}
          >
            DynastyTrust
          </div>
          <h1
            style={{
              fontFamily: fonts.display,
              fontSize: 28,
              fontWeight: 700,
              marginTop: 0,
              marginBottom: space[2],
            }}
          >
            Something went wrong on this page.
          </h1>
          <p style={{ fontSize: 14, color: colors.sub, lineHeight: 1.55, marginBottom: space[5] }}>
            Your coins are safe -- the app never holds keys. This is a bug
            in the UI that crashed the current view. Reload or navigate
            away to recover. If it reproduces, send us the error text below.
          </p>
          <div style={{ display: 'flex', gap: space[3], marginBottom: space[6], flexWrap: 'wrap' }}>
            <button
              onClick={() => window.location.assign('/vaults')}
              style={btn('primary')}
            >
              Go to Vaults
            </button>
            <button onClick={() => window.location.reload()} style={btn('ghost')}>
              Reload
            </button>
            <button onClick={this.reset} style={btn('ghost')}>
              Try to recover this view
            </button>
          </div>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              color: colors.red,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: '14px 16px',
              whiteSpace: 'pre-wrap',
              overflowX: 'auto',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              {error.name}: {error.message}
            </div>
            {error.stack && (
              <div style={{ color: colors.muted, fontSize: 11, lineHeight: 1.55 }}>
                {error.stack.split('\n').slice(0, 12).join('\n')}
              </div>
            )}
            {info?.componentStack && (
              <div style={{ color: colors.muted, fontSize: 11, lineHeight: 1.55, marginTop: 10 }}>
                {info.componentStack.split('\n').slice(0, 10).join('\n')}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
}

function btn(variant: 'primary' | 'ghost'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '10px 18px',
    fontSize: 14,
    borderRadius: 8,
    border: '1px solid',
    cursor: 'pointer',
    fontFamily: fonts.sans,
  };
  if (variant === 'primary') {
    return { ...base, background: colors.gold, color: colors.bg, borderColor: colors.gold };
  }
  return { ...base, background: 'transparent', color: colors.text, borderColor: colors.border };
}
