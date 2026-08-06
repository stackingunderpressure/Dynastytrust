import { useEffect, useRef, useState } from 'react';
import { QrImage } from '../QrImage';
import { CopyField } from './CopyField';
import { api } from '../../lib/api';
import type { Network } from '../../config';
import { colors, fonts, radii } from '../../theme';
import { Button } from '../ui';

// The step that did not exist anywhere in the app until now: a genuine
// "send Bitcoin here" screen with a QR code for the vault's receive
// address, and light polling so the wizard itself notices when the vault
// gets funded instead of leaving the user to guess and reload. The only
// QR code that existed before this (DescriptorQr, in VaultDetail) is for
// importing the wallet descriptor into Sparrow/Nunchuk -- a different
// job from receiving funds.
export function FundingStep({
  address,
  network,
  onFunded,
  onSkip,
}: {
  address: string;
  network: Network;
  /** Called once with the confirmed balance the first time it's > 0. */
  onFunded: (confirmedSats: number) => void;
  /** "I'll fund this later" -- the vault is already saved either way. */
  onSkip: () => void;
}) {
  const [confirmedSats, setConfirmedSats] = useState(0);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const notifiedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      setChecking(true);
      try {
        const res = await api.balance(address, network);
        if (cancelled) return;
        setConfirmedSats(res.confirmed_sats);
        setLastCheckedAt(new Date());
        if (res.confirmed_sats > 0 && !notifiedRef.current) {
          notifiedRef.current = true;
          onFunded(res.confirmed_sats);
        }
      } catch {
        // Transient network/mempool.space hiccup -- the next poll retries.
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void check();
    const interval = setInterval(check, 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, network]);

  const bitcoinUri = `bitcoin:${address}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center' }}>
      <p style={{ fontSize: 13, color: colors.muted, textAlign: 'center', maxWidth: 420, margin: 0 }}>
        Send Bitcoin to this address to fund your vault. This page checks
        automatically -- no need to reload.
      </p>
      <QrImage data={bitcoinUri} size={220} />
      <div style={{ width: '100%', maxWidth: 420 }}>
        <CopyField label="Receive address" value={address} />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: confirmedSats > 0 ? colors.green : colors.muted,
          background: colors.inset,
          borderRadius: radii.md,
          padding: '8px 14px',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: confirmedSats > 0 ? colors.green : checking ? colors.gold : colors.muted,
            display: 'inline-block',
          }}
        />
        {confirmedSats > 0
          ? `Funded -- ${(confirmedSats / 1e8).toFixed(8)} BTC confirmed`
          : checking
            ? 'Checking...'
            : 'Waiting for funds...'}
      </div>
      {lastCheckedAt && confirmedSats === 0 && (
        <span style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.mono }}>
          Last checked {lastCheckedAt.toLocaleTimeString()}
        </span>
      )}
      {confirmedSats === 0 && (
        <Button variant="ghost" size="sm" onClick={onSkip}>
          I'll fund this later
        </Button>
      )}
    </div>
  );
}
