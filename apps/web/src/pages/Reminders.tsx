import { useCallback, useEffect, useState } from 'react';
import { api, type Vault } from '../lib/api';
import { tipHeight } from '../lib/chain';
import { colors } from '../theme';
import { Button } from '../components/ui';
import { useToast } from '../components/toast';
import { GroupReadiness } from '../components/GroupReadiness';

/**
 * Reminders.tsx -- role-aware legal + governance reminders.
 *
 * Two surfaces:
 *   1. This page. Always accessible. Shows every active reminder +
 *      countdown + relevant warning for every role the user holds
 *      across every vault. Works whether or not banner reminders
 *      are enabled.
 *   2. Banner reminders elsewhere in the app (Dashboard etc).
 *      Toggled by the preference stored in localStorage under
 *      'dt:reminders:enabled'. When off, reminders still live here
 *      but do not nag the user on other pages.
 */

const PREF_KEY = 'dt:reminders:enabled';

export function getRemindersEnabled(): boolean {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw === null ? true : raw === '1';
  } catch { return true; }
}

function setRemindersEnabled(enabled: boolean): void {
  try { localStorage.setItem(PREF_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------

// IRS + FinCEN form references. Links go to the "About" page for
// each form so users get the current PDF + the instructions + the
// tax-topic writeup in one jump. We never deep-link to the raw
// PDF because URLs change with form revisions; the About page is
// stable across revisions.
const FORMS = {
  F709: {
    name: 'Form 709',
    desc: 'US gift (and GST) tax return',
    url: 'https://www.irs.gov/forms-pubs/about-form-709',
  },
  F1041: {
    name: 'Form 1041',
    desc: 'US income tax return for estates and trusts',
    url: 'https://www.irs.gov/forms-pubs/about-form-1041',
  },
  F1041K1: {
    name: 'Schedule K-1 (Form 1041)',
    desc: "Beneficiary's share of income, deductions, credits",
    url: 'https://www.irs.gov/forms-pubs/about-schedule-k-1-form-1041',
  },
  F706: {
    name: 'Form 706',
    desc: 'US estate (and GST) tax return',
    url: 'https://www.irs.gov/forms-pubs/about-form-706',
  },
  F3520: {
    name: 'Form 3520',
    desc: 'Annual return to report transactions with foreign trusts',
    url: 'https://www.irs.gov/forms-pubs/about-form-3520',
  },
  F3520A: {
    name: 'Form 3520-A',
    desc: 'Annual info return of foreign trust with US owner',
    url: 'https://www.irs.gov/forms-pubs/about-form-3520-a',
  },
  F8938: {
    name: 'Form 8938',
    desc: 'Statement of specified foreign financial assets',
    url: 'https://www.irs.gov/forms-pubs/about-form-8938',
  },
  FBAR: {
    name: 'FinCEN 114 (FBAR)',
    desc: 'Report of foreign bank and financial accounts',
    url: 'https://www.fincen.gov/report-foreign-bank-and-financial-accounts-fbar',
  },
  F8949: {
    name: 'Form 8949',
    desc: 'Sales and other dispositions of capital assets',
    url: 'https://www.irs.gov/forms-pubs/about-form-8949',
  },
  F4868: {
    name: 'Form 4868',
    desc: 'Individual tax return extension (to October 15)',
    url: 'https://www.irs.gov/forms-pubs/about-form-4868',
  },
  F7004: {
    name: 'Form 7004',
    desc: 'Business / trust tax extension (to September 30 for 1041)',
    url: 'https://www.irs.gov/forms-pubs/about-form-7004',
  },
} as const;

type FormKey = keyof typeof FORMS;

// ---------------------------------------------------------------

type Severity = 'info' | 'warn' | 'urgent';

interface Reminder {
  id: string;
  severity: Severity;
  role: string;
  vaultId?: string;
  vaultName?: string;
  title: string;
  body: string;
  dueAt?: Date;
  daysUntil?: number;
  filingReference?: string;
  forms?: FormKey[];
}

const sevColor = (s: Severity) =>
  s === 'urgent' ? colors.red :
  s === 'warn' ? colors.orange :
  colors.blue;

function daysFromNow(d: Date): number {
  return Math.round((d.getTime() - Date.now()) / (86400000));
}

// Next April 15 in UTC. If already past, roll to next year.
function nextApril15(): Date {
  const now = new Date();
  const y = now.getUTCFullYear();
  const apr15 = new Date(Date.UTC(y, 3, 15));
  if (apr15.getTime() < now.getTime()) return new Date(Date.UTC(y + 1, 3, 15));
  return apr15;
}

function nextOctober15(): Date {
  const now = new Date();
  const y = now.getUTCFullYear();
  const oct15 = new Date(Date.UTC(y, 9, 15));
  if (oct15.getTime() < now.getTime()) return new Date(Date.UTC(y + 1, 9, 15));
  return oct15;
}

// Approx blocks-to-days at 10 minutes per block.
function blocksToDays(blocks: number): number {
  return Math.round(blocks * 10 / 60 / 24);
}

// ---------------------------------------------------------------

function buildReminders(vaults: Vault[], tips: Record<string, number>): Reminder[] {
  const out: Reminder[] = [];

  // Calendar-based reminders (apply to every user).
  const apr = nextApril15();
  const oct = nextOctober15();
  const aprDays = daysFromNow(apr);
  const octDays = daysFromNow(oct);

  const hasAnyFounderVault = vaults.some(v => v.my_role === 'owner' || v.my_role === 'founder');
  const hasAnyBeneficiary = vaults.some(v => v.my_role === 'beneficiary' || v.my_role === 'heir');

  if (hasAnyFounderVault) {
    if (aprDays <= 120 && aprDays >= 0) {
      out.push({
        id: 'tax-709-' + apr.getFullYear(),
        severity: aprDays <= 30 ? 'urgent' : aprDays <= 60 ? 'warn' : 'info',
        role: 'founder',
        title: 'Gift-tax return (Form 709) may be due',
        body:
          'If you moved Bitcoin into a vault last calendar year and a single ' +
          'recipient received value above the annual exclusion ($19,000 in 2025), ' +
          'Form 709 is due April 15. The annual exclusion covers many small family ' +
          'vaults. Above that threshold, filing is mandatory even if no gift tax is owed.',
        dueAt: apr,
        daysUntil: aprDays,
        filingReference: 'Form 709',
        forms: ['F709', 'F4868'],
      });
    }
    out.push({
      id: 'tax-1041-' + apr.getFullYear(),
      severity: aprDays <= 30 ? 'warn' : 'info',
      role: 'founder',
      title: 'Fiduciary return (Form 1041) -- if your vault is non-grantor',
      body:
        'Non-grantor trusts file Form 1041 annually on income generated by trust ' +
        'property. Most inheritance-style dynasty trusts are grantor trusts during ' +
        'the grantor\'s life and switch to non-grantor at death. If yours is ' +
        'non-grantor, 1041 is due April 15. Beneficiaries who received distributions ' +
        'need a K-1. Confirm status with a CPA.',
      dueAt: apr,
      daysUntil: aprDays,
      filingReference: 'Form 1041',
      forms: ['F1041', 'F1041K1', 'F7004'],
    });
    if (octDays <= 180 && octDays >= 0 && aprDays < 0) {
      out.push({
        id: 'tax-ext-' + oct.getFullYear(),
        severity: 'info',
        role: 'founder',
        title: 'Extended filing deadline (October 15)',
        body:
          'If you filed Form 4868 or 7004 for an extension, the final deadline is ' +
          'October 15. Returns filed after this date accrue late-filing penalties.',
        dueAt: oct,
        daysUntil: octDays,
      });
    }
  }

  if (hasAnyBeneficiary) {
    out.push({
      id: 'bene-k1-' + apr.getFullYear(),
      severity: aprDays <= 30 ? 'warn' : 'info',
      role: 'beneficiary',
      title: 'Report K-1 income from trust distributions',
      body:
        'Distributions from a non-grantor trust are reportable income. The trustee ' +
        'issues a Schedule K-1. Include it on your Form 1040. Distributions from a ' +
        'grantor trust are NOT separately taxable to you -- the grantor pays on ' +
        'their own return. Confirm trust type with the trustee or a CPA. If you ' +
        'later sell BTC you received, Form 8949 captures the capital gain.',
      dueAt: apr,
      daysUntil: aprDays,
      filingReference: 'Schedule K-1',
      forms: ['F1041K1', 'F8949'],
    });
  }

  // Per-vault reminders driven by absolute CLTV timelocks + role.
  for (const v of vaults) {
    const tip = tips[v.network];
    if (!tip) continue;

    if ((v.my_role === 'owner' || v.my_role === 'founder') && v.recovery_after > 0) {
      const blocks = v.recovery_after - tip;
      if (blocks > 0) {
        const d = blocksToDays(blocks);
        out.push({
          id: `recovery-${v.id}`,
          severity: d <= 90 ? 'warn' : 'info',
          role: 'founder',
          vaultId: v.id,
          vaultName: v.name,
          title: `Recovery path unlocks in ~${d} days`,
          body:
            'After this block height, the founder quorum can spend even without ' +
            'cooperation from any single founder. Useful if a co-founder goes ' +
            'silent. No filing required -- informational countdown.',
          daysUntil: d,
        });
      }
    }

    if (v.my_role === 'heir' && v.inheritance_after > 0) {
      const blocks = v.inheritance_after - tip;
      if (blocks > 0) {
        const d = blocksToDays(blocks);
        out.push({
          id: `inheritance-${v.id}`,
          severity: d <= 90 ? 'warn' : 'info',
          role: 'heir',
          vaultId: v.id,
          vaultName: v.name,
          title: `Inheritance path unlocks in ~${d} days`,
          body:
            'After this block height, the heir quorum can spend unilaterally. ' +
            'Receiving a distribution triggers tax reporting (K-1 income for ' +
            'non-grantor trusts, step-up basis may apply for inherited property). ' +
            'Have a CPA review before moving funds.',
          daysUntil: d,
        });
      } else {
        out.push({
          id: `inheritance-live-${v.id}`,
          severity: 'urgent',
          role: 'heir',
          vaultId: v.id,
          vaultName: v.name,
          title: 'Inheritance path is now spendable',
          body:
            'The heir quorum can spend now. Coordinate with co-heirs. Before moving ' +
            'funds: confirm basis, confirm K-1 or 1041 filings, talk to a CPA. ' +
            'Also confirm whether a death declaration and probate process has ' +
            'completed, depending on your trust wrapper. Form 706 may have been ' +
            'required on the grantor\'s side.',
          forms: ['F706', 'F1041', 'F1041K1'],
        });
      }
    }

    if (v.my_role === 'protector' && v.protector_after) {
      const blocks = v.protector_after - tip;
      if (blocks > 0) {
        const d = blocksToDays(blocks);
        out.push({
          id: `protector-${v.id}`,
          severity: 'info',
          role: 'protector',
          vaultId: v.id,
          vaultName: v.name,
          title: `Protector path unlocks in ~${d} days`,
          body:
            'After this block height, the protector signature can unilaterally ' +
            'trigger the protector spending path. Reserved for emergencies. ' +
            'Compensation received for protector action is ordinary income.',
          daysUntil: d,
        });
      }
    }
  }

  // Annual review reminder, one per vault, fires in the final 60d of each year of age.
  for (const v of vaults) {
    const created = new Date(v.created_at);
    const now = new Date();
    const ageMs = now.getTime() - created.getTime();
    const years = Math.floor(ageMs / (365.25 * 86400000));
    if (years < 1) continue;
    const nextAnniversary = new Date(created.getTime());
    nextAnniversary.setUTCFullYear(created.getUTCFullYear() + years + 1);
    const daysToAnniversary = daysFromNow(nextAnniversary);
    if (daysToAnniversary <= 60 && daysToAnniversary >= 0) {
      out.push({
        id: `annual-${v.id}-${years + 1}`,
        severity: 'info',
        role: v.my_role || 'member',
        vaultId: v.id,
        vaultName: v.name,
        title: 'Annual vault review coming up',
        body:
          'A year since this vault was created. Good cadence: verify every ' +
          'signer\'s seed backup, re-attest to any trust-doc changes, confirm ' +
          'members\' contact info, and update the trust wrapper if jurisdictions ' +
          'or beneficiaries changed.',
        dueAt: nextAnniversary,
        daysUntil: daysToAnniversary,
      });
    }
  }

  // Sort: urgent first, then warn, then info. Within severity, soonest first.
  const rank = (s: Severity) => s === 'urgent' ? 0 : s === 'warn' ? 1 : 2;
  out.sort((a, b) => {
    const r = rank(a.severity) - rank(b.severity);
    if (r !== 0) return r;
    return (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999);
  });

  return out;
}

// ---------------------------------------------------------------

const ROLE_GUIDANCE: Record<string, { label: string; body: string }> = {
  owner: {
    label: 'Primary trustee / grantor',
    body:
      'You funded the vault and hold the primary signing key. Gift-tax exposure ' +
      'on large funding events (Form 709 above the annual exclusion). If the ' +
      'trust is non-grantor, fiduciary return (Form 1041) annually. You also ' +
      'bear a fiduciary duty to beneficiaries: self-dealing and commingling ' +
      'trust funds are the two failures that attract personal liability.',
  },
  founder: {
    label: 'Trustee / co-grantor',
    body:
      'You hold a founders-now signing key. Same fiduciary expectations as the ' +
      'primary trustee, scaled to your role. Compensation, if any, is ordinary ' +
      'income to you. Every spend you sign should match a trust-doc rule and ' +
      'be memorialized in the governance log.',
  },
  heir: {
    label: 'Successor / heir',
    body:
      'Holder of the inheritance path. No tax obligation until you receive a ' +
      'distribution. When the inheritance timelock elapses and you claim: ' +
      'step-up in basis may apply (inherited property rules), K-1 income ' +
      'reporting for non-grantor trusts. Confirm with a CPA before moving ' +
      'funds. Moving early on a forged death certificate is fraud.',
  },
  protector: {
    label: 'Protector',
    body:
      'Limited fiduciary in most jurisdictions. Actions reviewable by courts. ' +
      'Protector cannot also be the grantor or a beneficiary without undoing ' +
      'the trust\'s asset protection. Accepting off-book payments from any ' +
      'party undoes the role.',
  },
  beneficiary: {
    label: 'Beneficiary',
    body:
      'Distributions are generally taxable income (K-1 from non-grantor trusts; ' +
      'nontaxable to you from grantor trusts). Receiving Bitcoin creates a ' +
      'basis for your own future capital-gains reporting. Large distributions ' +
      'from foreign trusts require Form 3520; FBAR if you gain signing ' +
      'authority over a foreign account over $10k.',
  },
  viewer: {
    label: 'Observer',
    body:
      'Read-only access. No fiduciary role, no filings. Audit-only capacity.',
  },
};

// ---------------------------------------------------------------

export default function Reminders() {
  const toast = useToast();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [tips, setTips] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(getRemindersEnabled());

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.vaults.list(true);
      setVaults(res.vaults);
      const networks = Array.from(new Set(res.vaults.map(v => v.network)));
      const tipsOut: Record<string, number> = {};
      await Promise.all(networks.map(async n => {
        try { tipsOut[n] = await tipHeight(n); } catch { /* skip */ }
      }));
      setTips(tipsOut);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    setRemindersEnabled(next);
  }

  const reminders = buildReminders(vaults, tips);
  const myRoles = Array.from(new Set(vaults.map(v => v.my_role).filter(Boolean))) as string[];

  if (loading) {
    return <p style={{ color: colors.muted, fontSize: 13 }}>Loading reminders...</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 880 }}>
      <Toggle enabled={enabled} onToggle={toggle} />

      <GroupReadiness />

      {reminders.length === 0 ? (
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: '20px 22px',
            color: colors.sub,
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          Nothing pressing. No tax deadlines within window, no timelocks
          unlocking soon, no annual reviews overdue.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {reminders.map(r => <ReminderCard key={r.id} r={r} />)}
        </div>
      )}

      <RoleGuidance roles={myRoles} />

      <FormsReference />

      <FullReference />
    </div>
  );
}

// ---------------------------------------------------------------

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        padding: '14px 18px',
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
          Banner reminders across the app
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 4, lineHeight: 1.5 }}>
          When on, urgent reminders surface as banners on the Dashboard and
          vault pages. When off, they live only here. This page is always
          available either way.
        </div>
      </div>
      <Button variant={enabled ? 'primary' : 'ghost'} size="sm" onClick={onToggle}>
        {enabled ? 'On' : 'Off'}
      </Button>
    </div>
  );
}

function ReminderCard({ r }: { r: Reminder }) {
  const accent = sevColor(r.severity);
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 12,
        padding: '14px 18px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
          {r.title}
        </div>
        {r.daysUntil != null && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: accent,
              whiteSpace: 'nowrap',
            }}
          >
            {r.daysUntil <= 0 ? 'NOW' : `${r.daysUntil}d`}
          </div>
        )}
      </div>
      {(r.vaultName || r.filingReference) && (
        <div style={{ fontSize: 11, color: colors.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {r.vaultName && `${r.vaultName} . `}{r.role}{r.filingReference && ` . ${r.filingReference}`}
        </div>
      )}
      <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.55 }}>
        {r.body}
      </div>
      {r.forms && r.forms.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.forms.map(key => {
            const f = FORMS[key];
            return (
              <a
                key={key}
                href={f.url}
                target="_blank"
                rel="noreferrer"
                title={f.desc}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '4px 10px',
                  background: colors.input,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 999,
                  color: colors.gold,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.name} &raquo;
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FormsReference() {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: colors.gold,
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        IRS + FinCEN forms reference
      </div>
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: '14px 18px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 10,
        }}
      >
        {(Object.keys(FORMS) as FormKey[]).map(k => {
          const f = FORMS[k];
          return (
            <a
              key={k}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'block',
                padding: '8px 10px',
                background: colors.input,
                borderRadius: 8,
                color: colors.text,
                textDecoration: 'none',
                border: `1px solid ${colors.border}`,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: colors.gold }}>{f.name}</div>
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 2, lineHeight: 1.4 }}>{f.desc}</div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function RoleGuidance({ roles }: { roles: string[] }) {
  if (roles.length === 0) return null;
  const unique = Array.from(new Set(roles));
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: colors.gold,
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        Role-specific warnings
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {unique.map(r => {
          const g = ROLE_GUIDANCE[r];
          if (!g) return null;
          return (
            <div
              key={r}
              style={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: '14px 18px',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, marginBottom: 4 }}>
                {g.label}
              </div>
              <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.55 }}>{g.body}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FullReference() {
  return (
    <div
      style={{
        background: colors.input,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: '16px 20px',
        fontSize: 13,
        color: colors.sub,
        lineHeight: 1.6,
      }}
    >
      <div style={{ color: colors.gold, fontWeight: 700, marginBottom: 6 }}>
        Full legal framework reference
      </div>
      The shorthand above is a starting point. For detailed per-role filing
      guidance, international considerations, and the minimum-compliance
      posture, see{' '}
      <a
        href="/legal/legal-framework-for-users.md"
        target="_blank"
        rel="noreferrer"
        style={{ color: colors.gold, textDecoration: 'underline' }}
      >
        the legal framework guide
      </a>
      {' and the '}
      <a
        href="/legal/terms-of-service.md"
        target="_blank"
        rel="noreferrer"
        style={{ color: colors.gold, textDecoration: 'underline' }}
      >
        terms of service
      </a>
      . Not legal or tax advice. Talk to a crypto-literate attorney and CPA
      before acting.
    </div>
  );
}

