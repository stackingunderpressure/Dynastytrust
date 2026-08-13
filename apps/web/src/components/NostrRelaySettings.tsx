import { useState } from 'react';
import { getNostrRelays, setNostrRelays, clearNostrRelays, hasCustomNostrRelays } from '../lib/nostrRelayPrefs';
import { DEFAULT_RELAYS } from '../lib/tapit-nostr-cosign';
import { colors, radii, fonts } from '../theme';
import { Button, Textarea } from './ui';

/**
 * Collapsed-by-default "Relays (advanced)" control, shared by
 * VaultMembershipSetup.tsx and CirclePhraseSetup.tsx -- both send over
 * Nostr and both read the same localStorage-backed preference
 * (nostrRelayPrefs.ts), so setting it once here applies to both. Mirrors
 * Tapit Wallet's own Settings screen relay editor: one wss:// URL per
 * line, save or restore defaults.
 */
export function NostrRelaySettings() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => getNostrRelays().join('\n'));
  const [status, setStatus] = useState<string | null>(null);
  const custom = hasCustomNostrRelays();

  function save() {
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const { saved, dropped } = setNostrRelays(lines);
    if (saved.length === 0) {
      setStatus('Need at least one wss:// relay -- kept the previous list.');
      setText(getNostrRelays().join('\n'));
      return;
    }
    setText(saved.join('\n'));
    setStatus(dropped > 0 ? `Saved. Skipped ${dropped} line(s) that weren't a wss:// URL.` : 'Saved.');
  }

  function restoreDefaults() {
    clearNostrRelays();
    setText(DEFAULT_RELAYS.join('\n'));
    setStatus('Back to the default relays.');
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          fontSize: 11,
          color: colors.muted,
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        {open ? 'Hide' : 'Relays (advanced)'}{custom && !open ? ' -- custom' : ''}
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
          }}
        >
          <p style={{ fontSize: 11.5, color: colors.muted, margin: '0 0 8px', lineHeight: 1.5 }}>
            One wss:// URL per line. This applies to every membership
            request and safety-phrase delivery sent from this browser --
            not just this vault. Run your own relay and put it here if
            you'd rather not rely on the public defaults; the recipient's
            Tapit Wallet still needs to be listening on at least one
            relay you both share, or delivery won't happen.
          </p>
          <Textarea
            mono
            value={text}
            onChange={e => setText(e.target.value)}
            rows={Math.max(4, text.split('\n').length)}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            style={{ fontSize: 12 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button size="sm" style={{ fontSize: 11 }} onClick={save}>
              Save relays
            </Button>
            <Button variant="ghost" size="sm" style={{ fontSize: 11 }} onClick={restoreDefaults}>
              Restore defaults
            </Button>
          </div>
          {status && (
            <p style={{ fontSize: 11, color: colors.muted, marginTop: 8, fontFamily: fonts.sans }}>
              {status}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
