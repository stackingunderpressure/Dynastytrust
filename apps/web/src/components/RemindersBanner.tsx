import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Vault } from '../lib/api';
import { tipHeight } from '../lib/chain';
import { colors } from '../theme';
import { getRemindersEnabled } from '../pages/Reminders';

/**
 * RemindersBanner -- compact strip surfaced on the Dashboard and
 * individual vault pages when the user has opted into banner
 * reminders (toggle on the /reminders page).
 *
 * Generates reminders live from the same data the full page uses.
 * Shows only urgent + warn items. If nothing pressing or the
 * toggle is off, renders nothing.
 *
 * Scope: this duplicates a small slice of Reminders.tsx's
 * generator. Intentional -- the banner only cares about the
 * highest-priority items and the full page's generator is
 * expensive to import in full without side-effects. When the
 * generator gets more logic, hoist it into a shared lib.
 */

interface BannerReminder {
  severity: 'urgent' | 'warn';
  title: string;
  daysUntil?: number;
  vaultName?: string;
}

function daysFromNow(d: Date): number {
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

function nextApril15(): Date {
  const now = new Date();
  const y = now.getUTCFullYear();
  const apr15 = new Date(Date.UTC(y, 3, 15));
  if (apr15.getTime() < now.getTime()) return new Date(Date.UTC(y + 1, 3, 15));
  return apr15;
}

interface RemindersBannerProps {
  /** Filter to one vault's reminders (used on VaultDetail). */
  vaultId?: string;
}

export function RemindersBanner({ vaultId }: RemindersBannerProps) {
  const navigate = useNavigate();
  const [reminders, setReminders] = useState<BannerReminder[]>([]);
  const [enabled, setEnabled] = useState(getRemindersEnabled());

  // Re-read the preference whenever the banner mounts. Future
  // refinement: subscribe to a storage event so it updates live.
  useEffect(() => {
    setEnabled(getRemindersEnabled());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.vaults.list(true);
        const vaults = vaultId
          ? res.vaults.filter(v => v.id === vaultId)
          : res.vaults;
        const networks = Array.from(new Set(vaults.map(v => v.network)));
        const tips: Record<string, number> = {};
        await Promise.all(networks.map(async n => {
          try { tips[n] = await tipHeight(n); } catch { /* skip */ }
        }));
        if (cancelled) return;
        setReminders(buildBanner(vaults, tips));
      } catch {
        /* silent -- banner is best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, vaultId]);

  if (!enabled) return null;
  if (reminders.length === 0) return null;

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.orange}`,
        borderRadius: 12,
        padding: '12px 16px',
        marginBottom: 16,
        cursor: 'pointer',
      }}
      onClick={() => navigate('/reminders')}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: colors.orange, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          Reminders ({reminders.length})
        </div>
        <div style={{ fontSize: 11, color: colors.muted }}>
          click to review
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {reminders.slice(0, 3).map((r, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 12,
              color: colors.text,
            }}
          >
            <span>
              {r.vaultName ? <span style={{ color: colors.muted }}>{r.vaultName} . </span> : null}
              {r.title}
            </span>
            {r.daysUntil != null && (
              <span style={{ color: r.severity === 'urgent' ? colors.red : colors.orange, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {r.daysUntil <= 0 ? 'NOW' : `${r.daysUntil}d`}
              </span>
            )}
          </div>
        ))}
        {reminders.length > 3 && (
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
            +{reminders.length - 3} more
          </div>
        )}
      </div>
    </div>
  );
}

function buildBanner(vaults: Vault[], tips: Record<string, number>): BannerReminder[] {
  const out: BannerReminder[] = [];
  const apr = nextApril15();
  const aprDays = daysFromNow(apr);
  const hasFounderRole = vaults.some(v => v.my_role === 'owner' || v.my_role === 'founder');

  if (hasFounderRole && aprDays <= 60 && aprDays >= 0) {
    out.push({
      severity: aprDays <= 30 ? 'urgent' : 'warn',
      title: `Form 709 / 1041 filing window -- April 15`,
      daysUntil: aprDays,
    });
  }

  for (const v of vaults) {
    const tip = tips[v.network];
    if (!tip) continue;

    if ((v.my_role === 'owner' || v.my_role === 'founder') && v.recovery_after > 0) {
      const blocks = v.recovery_after - tip;
      const d = Math.round(blocks * 10 / 60 / 24);
      if (blocks > 0 && d <= 90) {
        out.push({
          severity: 'warn',
          title: 'Recovery path unlocks soon',
          daysUntil: d,
          vaultName: v.name,
        });
      }
    }

    if (v.my_role === 'heir' && v.inheritance_after > 0) {
      const blocks = v.inheritance_after - tip;
      if (blocks <= 0) {
        out.push({
          severity: 'urgent',
          title: 'Inheritance path is spendable now',
          daysUntil: 0,
          vaultName: v.name,
        });
      } else {
        const d = Math.round(blocks * 10 / 60 / 24);
        if (d <= 90) {
          out.push({
            severity: 'warn',
            title: 'Inheritance path unlocks soon',
            daysUntil: d,
            vaultName: v.name,
          });
        }
      }
    }
  }

  return out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'urgent' ? -1 : 1;
    return (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999);
  });
}
