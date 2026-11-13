import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { runGateChecks, type GateCheck } from '../lib/vault-gate';
import { listKeys } from '../lib/keystore';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';

/** The key this person joined this vault with, if it is held on this phone. */
async function joinedKeyOnThisPhone(vaultId: string): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) return null;
  const { members } = await api.members.list(vaultId);
  const row = members.find(m => m.user_id === me && m.status === 'active' && m.pubkey);
  if (!row?.pubkey) return null;
  const local = listKeys().find(k => k.status === 'active' && k.pubkey === row.pubkey);
  return local ? row.pubkey : null;
}
import { colors, fonts, radii, space } from '../theme';
import { Button } from './ui';

/**
 * Nothing of a vault is shown until THIS phone has re-derived the vault's
 * address from its own descriptor and found it equal to the stored one
 * (security backlog items 9 + 5). Operator, 2026-11-13: "What about
 * compiler in browser?" -- chose "Verify first", and on a mismatch
 * "Refuse to show it".
 *
 * Until now the phone believed whatever address the database handed it.
 * A changed address row -- a bug, a bad migration, or someone with
 * database access -- would have been shown as the deposit address with
 * nothing to catch it. The check runs rust-miniscript, the same library
 * the Fly compiler uses, built into the page (lib/descriptor-check.ts).
 *
 * Fail closed: a mismatch, a descriptor that will not compile, or a
 * checker that did not load all stop the vault here. Only the last one
 * offers Retry, because only it can be a passing hiccup.
 */
export function VaultAddressGate({
  vault,
  onBack,
  children,
}: {
  vault: { id?: string; address?: string | null; descriptor?: string | null; network: string };
  onBack: () => void;
  children: ReactNode;
}) {
  const [check, setCheck] = useState<GateCheck | null>(null);
  const run = useCallback(() => {
    let cancelled = false;
    setCheck(null);
    runGateChecks(vault, () => (vault.id ? joinedKeyOnThisPhone(vault.id) : Promise.resolve(null)))
      .then(c => { if (!cancelled) setCheck(c); });
    return () => { cancelled = true; };
  }, [vault]);
  useEffect(() => run(), [run]);

  if (check && (check.status === 'match' || check.status === 'not_applicable')) return <>{children}</>;

  const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: 0 };
  const mono: React.CSSProperties = { fontFamily: fonts.mono, fontSize: 16, color: colors.text, wordBreak: 'break-all', margin: 0 };

  if (!check) {
    return (
      <div style={{ padding: space[6], textAlign: 'center' }}>
        <p style={sub}>Checking this vault's address on your phone...</p>
      </div>
    );
  }

  const title =
    check.status === 'pin_changed' ? 'Stop: this vault is not the one this phone first saw'
      : check.status === 'own_key_missing' ? 'Stop: your key is not in this vault'
      : check.status === 'mismatch' ? 'Stop: this vault\'s address does not match its own recipe'
      : check.status === 'unreadable' ? 'Stop: this vault\'s address could not be checked'
        : 'This vault could not be checked yet';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[3], padding: space[4], margin: `${space[4]}px 0`, background: colors.dangerBg, border: `1px solid ${colors.borderDanger}`, borderRadius: radii.md }}>
      <p style={{ fontSize: 20, fontWeight: 700, color: colors.red, margin: 0, lineHeight: 1.4 }}>{title}</p>
      {check.status === 'mismatch' && (
        <>
          <p style={sub}>
            Your phone worked out this vault's address from its descriptor, the recipe that decides who can spend.
            It is not the address this app was given. Do not send money to either address, and do not sign anything
            for this vault, until this is looked into.
          </p>
          <div>
            <p style={{ ...sub, fontSize: 16 }}>Address the app was given:</p>
            <p style={mono}>{check.stored}</p>
          </div>
          <div>
            <p style={{ ...sub, fontSize: 16 }}>Address the recipe pays to:</p>
            <p style={mono}>{check.derived}</p>
          </div>
        </>
      )}
      {check.status === 'pin_changed' && (
        <>
          <p style={sub}>
            The first time this phone opened this vault, on {new Date(check.pinnedAt).toLocaleDateString()}, its address
            was different. A finished vault's address can never change, so something replaced this vault's recipe since.
            Do not send money to it or sign for it. Call the other people in the vault, by voice, and compare the address
            each of you wrote down.
          </p>
          <div>
            <p style={{ ...sub, fontSize: 16 }}>Address this phone first saw:</p>
            <p style={mono}>{check.pinned}</p>
          </div>
          <div>
            <p style={{ ...sub, fontSize: 16 }}>Address it shows now:</p>
            <p style={mono}>{check.now}</p>
          </div>
        </>
      )}
      {check.status === 'own_key_missing' && (
        <p style={sub}>
          You joined this vault with a key that is on this phone, but the vault's recipe does not include it. Whoever
          made this vault could spend it without you. Do not send money to it. Ask the owner, by voice, what happened
          before doing anything else.
        </p>
      )}
      {check.status === 'unreadable' && (
        <p style={sub}>
          Your phone could not turn this vault's descriptor into an address ({check.reason}), so it cannot confirm
          where money sent here would go. Do not send money to this vault or sign for it until this is looked into.
        </p>
      )}
      {check.status === 'unchecked' && (
        <p style={sub}>
          The part of the app that checks the address on your phone did not load ({check.reason}). The vault stays
          hidden until it does, so you never see an address that was not checked. Try again.
        </p>
      )}
      <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
        <Button variant="ghost" style={{ minHeight: 44 }} onClick={onBack}>Back to vaults</Button>
        {check.status === 'unchecked' && <Button style={{ minHeight: 44 }} onClick={() => run()}>Try again</Button>}
      </div>
    </div>
  );
}
