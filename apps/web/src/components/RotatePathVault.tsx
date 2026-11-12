import { whoSignsShort } from '../lib/path-words';
import { mustSignPathsNotInScripts } from '../lib/must-sign-check';
import { useEffect, useMemo, useState } from 'react';
import { api, type Vault } from '../lib/api';
import { verifiedTipHeight } from '../lib/chain';
import { checkAbsoluteTimelocks } from '../lib/timelock-check';
import { planRotation, checkRotatedVault } from '../lib/rotate-plan';
import { ROTATE_EXTENSIONS } from '../lib/timelock-words';
import { downloadVault } from '../lib/descriptor-backup';
import { listKeys } from '../lib/keystore';
import { colors, fonts, radii, space } from '../theme';
import { Button, Input, Label, Modal } from './ui';

// Rotating a vault built with the path builder (security backlog J2f).
//
// A vault's dates are fixed in its script, so the only way to push an
// inheritance date out is a NEW vault with later dates and the coins
// moved to it. This dialog does the first half in one sitting:
//   1. the owner picks how much later, and confirms the keys;
//   2. the server makes a draft with the same paths, keys and quorums
//      (netlify/functions/_rotate.js) and the compiler finalizes it;
//   3. THIS BROWSER then checks the result twice before accepting it --
//      the compiled dates against tip + the chosen wait, from two chain
//      sources (the gate every new vault passes), and the compiled
//      paths against the old vault, field by field (rotate-plan.ts);
//   4. the new vault's own backup must be saved before moving on.
// Moving the coins is a normal spend from the old vault and is NOT done
// here: it needs the everyday signers, and the old vault says so until
// it is done (SuccessionBanner in VaultDetail).

type Stage =
  | { at: 'plan' }
  | { at: 'working'; step: string }
  | { at: 'refused'; problems: string[]; removed: boolean }
  | { at: 'backup'; next: Vault; saved: boolean };

const xOnly = (pubkeyHex: string): string => pubkeyHex.toLowerCase().slice(-64);

export function RotatePathVault({
  vault,
  onClose,
  onOpenNew,
}: {
  vault: Vault;
  onClose: () => void;
  onOpenNew: (v: Vault) => void;
}) {
  const paths = useMemo(() => vault.leaves ?? [], [vault.leaves]);
  const [tip, setTip] = useState<number | null>(null);
  const [tipErr, setTipErr] = useState<string | null>(null);
  const [name, setName] = useState(`${vault.name} v2`);
  const [shift, setShift] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState<Stage>({ at: 'plan' });
  const [err, setErr] = useState<string | null>(null);
  // Kept so a failed finalize can be retried without making a second draft.
  const [draftId, setDraftId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    verifiedTipHeight(vault.network)
      .then(h => { if (live) setTip(h); })
      .catch(e => { if (live) setTipErr(e instanceof Error ? e.message : 'Could not read the Bitcoin chain'); });
    return () => { live = false; };
  }, [vault.network]);

  const plan = tip != null && shift != null ? planRotation(paths, tip, shift, new Date()) : null;

  // Who each key is, in the owner's own words where we have them.
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const k of listKeys()) m.set(xOnly(k.pubkey), k.label);
    for (const l of vault.key_labels ?? []) if (l.label) m.set(xOnly(l.pubkey), l.label);
    return m;
  }, [vault.key_labels]);
  const prints = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of vault.key_origins ?? []) m.set(xOnly(o.pubkey), o.fingerprint);
    return m;
  }, [vault.key_origins]);

  async function create() {
    if (!plan || plan.problems.length > 0 || !confirmed) return;
    setErr(null);
    try {
      let id = draftId;
      if (!id) {
        setStage({ at: 'working', step: 'Making the new vault with the same paths and keys...' });
        const made = await api.vaults.rotate({
          vault_id: vault.id,
          overrides: { name: name.trim() || undefined, leaf_offsets: plan.offsets },
        });
        id = made.vault.id;
        setDraftId(id);
      }
      setStage({ at: 'working', step: 'Finalizing its Bitcoin address...' });
      const res = await api.vaults.compileLeaves(id, vault.key_origins ?? []);

      setStage({ at: 'working', step: 'Checking the new vault against this one...' });
      const checkTip = await verifiedTipHeight(vault.network);
      const dates = checkAbsoluteTimelocks(
        plan.rows.map(r => {
          const compiled = res.vault.leaves?.find(l => l.id === r.id)?.unlock;
          return {
            label: r.label,
            kind: 'after' as const,
            offsetBlocks: r.offsetBlocks,
            // A missing or differently-typed path is a mismatch, never a pass.
            absoluteBlocks: compiled && compiled.type === 'after' ? compiled.blocks : -1,
          };
        }),
        checkTip,
        vault.network,
      );
      // The new address has to really require this vault's must-sign keys.
      const weak = mustSignPathsNotInScripts(res.vault.leaves, res.vault.leaf_scripts)
        .map(name => `the new address does not require the must-sign key on "${name}"`);
      const problems = [...dates.problems, ...checkRotatedVault(vault, res.vault), ...weak];
      if (problems.length > 0) {
        // A refused vault must not stay linked as this vault's successor:
        // the old vault's "Sweep to successor" button would point at it.
        let removed = false;
        try { await api.vaults.remove(id); removed = true; } catch { /* said below */ }
        setDraftId(null);
        setStage({ at: 'refused', problems, removed });
        return;
      }
      // The full row (name, descriptor) for the backup file and the link.
      const { vaults } = await api.vaults.list(true);
      const next = vaults.find(v => v.id === id) ?? { ...vault, ...res.vault };
      setStage({ at: 'backup', next, saved: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setStage({ at: 'plan' });
    }
  }

  const busy = stage.at === 'working';
  const p: React.CSSProperties = { fontSize: 15, color: colors.sub, lineHeight: 1.6, margin: `0 0 ${space[3]}px` };

  if (stage.at === 'refused') {
    return (
      <Modal title="The new vault was NOT accepted" onClose={onClose}>
        <p style={{ ...p, color: colors.red }}>
          The vault that came back does not match this one, so it is not safe to move coins to it:
        </p>
        <ul style={{ ...p, color: colors.text, paddingLeft: space[5] }}>
          {stage.problems.map(x => <li key={x}>{x}</li>)}
        </ul>
        <p style={p}>
          {stage.removed
            ? 'It has been deleted, so nothing points at it.'
            : 'It could NOT be deleted automatically: delete it from the dashboard now, and do not send anything to it.'}{' '}
          You can try again. If it happens twice, stop and contact support. Your coins have not moved and this
          vault is unchanged.
        </p>
        <Button style={{ minHeight: 44 }} onClick={onClose}>Close</Button>
      </Modal>
    );
  }

  if (stage.at === 'backup') {
    const next = stage.next;
    return (
      <Modal title="New vault ready -- two things left" onClose={onClose}>
        <p style={{ ...p, color: colors.green }}>
          {next.name} has the same paths, the same keys and the later dates. This browser checked it against the
          old vault and against the Bitcoin chain.
        </p>
        <p style={{ ...p, color: colors.text }}>
          1. Save its backup. The new vault has a new address, so the backup you keep for the old vault does not
          cover it. Store this one the same way.
        </p>
        <Button
          variant={stage.saved ? 'ghost' : 'primary'}
          style={{ minHeight: 44, marginBottom: space[4] }}
          onClick={async () => {
            if (await downloadVault(next)) setStage({ at: 'backup', next, saved: true });
          }}
        >
          {stage.saved ? 'Backup saved -- save again' : 'Save the new vault backup'}
        </Button>
        <p style={{ ...p, color: colors.text }}>
          2. Move the coins. They are still in the old vault, under the old dates, until you do. Open the old
          vault and tap Sweep to successor; it needs the everyday signers, like any spend.
        </p>
        <p style={p}>
          If you use long-horizon recovery, publish it again for the new vault -- the old publication only
          describes the old one.
        </p>
        <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
          <Button variant="ghost" style={{ minHeight: 44 }} disabled={!stage.saved} onClick={onClose}>
            Stay on the old vault
          </Button>
          <Button style={{ minHeight: 44 }} disabled={!stage.saved} onClick={() => onOpenNew(next)}>
            Open the new vault
          </Button>
        </div>
        {!stage.saved && <p style={{ ...p, marginTop: space[3], fontSize: 15 }}>Save the backup to continue.</p>}
      </Modal>
    );
  }

  return (
    <Modal title="Rotate vault" onClose={busy ? () => {} : onClose}>
      <p style={p}>
        A vault's dates are fixed for good. To push them out, this makes a new vault with the same paths, the
        same keys and later dates. You then move the coins to it.
      </p>

      <div style={{ marginBottom: space[4] }}>
        <Label>New vault name</Label>
        <Input value={name} onChange={e => setName(e.target.value)} disabled={busy} />
      </div>

      <Label>Move every dated path</Label>
      <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap', marginBottom: space[3] }}>
        {ROTATE_EXTENSIONS.map(x => (
          <Button
            key={x.label}
            type="button"
            variant={shift === x.extraBlocks ? 'primary' : 'ghost'}
            style={{ minHeight: 44 }}
            // Once the draft exists its dates are set; a retry finishes that one.
            disabled={busy || !!draftId}
            onClick={() => setShift(x.extraBlocks)}
          >
            {x.extraBlocks === 0 ? 'Keep the same dates' : `${x.label} later`}
          </Button>
        ))}
      </div>

      {tipErr && <p style={{ ...p, color: colors.red }}>The Bitcoin chain could not be read from two sources, so no dates can be planned: {tipErr}</p>}
      {tip == null && !tipErr && <p style={p}>Checking the chain...</p>}
      {tip != null && shift == null && <p style={p}>Choose how much later the dated paths should open.</p>}

      {plan && (
        <div style={{ background: colors.inset, borderRadius: radii.md, padding: space[3], marginBottom: space[3] }}>
          {plan.rows.map(r => (
            <div key={r.id} style={{ fontSize: 15, color: colors.text, lineHeight: 1.6 }}>
              {r.label}: {r.oldWords} <span style={{ color: colors.muted }}>becomes</span>{' '}
              <span style={{ color: colors.gold }}>{r.newWords}</span>
            </div>
          ))}
          {plan.problems.map(x => (
            <div key={x} style={{ fontSize: 15, color: colors.red, lineHeight: 1.6, marginTop: space[2] }}>{x}</div>
          ))}
        </div>
      )}

      <Label>The keys that carry over</Label>
      <div style={{ background: colors.inset, borderRadius: radii.md, padding: space[3], marginBottom: space[3] }}>
        {paths.map(path => (
          <div key={path.id} style={{ marginBottom: space[2] }}>
            <div style={{ fontSize: 15, color: colors.text }}>
              {path.label} <span style={{ color: colors.muted }}>-- {whoSignsShort(path.quorum, path.keys.length, (path.required_keys ?? []).length)} must sign</span>
            </div>
            {[...(path.required_keys ?? []), ...path.keys].map((k, idx) => (
              <div key={k} style={{ fontSize: 15, color: colors.sub, lineHeight: 1.6, paddingLeft: space[3] }}>
                {idx < (path.required_keys ?? []).length ? 'must sign: ' : ''}{names.get(xOnly(k)) ?? 'Unnamed key'}{' '}
                <span style={{ fontFamily: fonts.mono, color: colors.muted }}>
                  {prints.get(xOnly(k)) ?? `...${k.slice(-8)}`}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <label style={{ display: 'flex', gap: space[2], alignItems: 'flex-start', fontSize: 15, color: colors.text, lineHeight: 1.5, marginBottom: space[3], minHeight: 44 }}>
        <input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} style={{ marginTop: 4 }} />
        These are the right keys. I understand the new vault gets a new address and its own backup, and that
        nothing is protected until the coins are moved.
      </label>

      {err && (
        <p style={{ ...p, color: colors.red }}>
          {err}
          {draftId ? ' The new vault exists as a draft; trying again will finish that same one.' : ''}
        </p>
      )}
      {busy && <p style={{ ...p, color: colors.gold }}>{stage.step}</p>}

      <div style={{ display: 'flex', gap: space[2], justifyContent: 'flex-end' }}>
        <Button variant="ghost" type="button" style={{ minHeight: 44 }} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          style={{ minHeight: 44 }}
          disabled={busy || !plan || plan.problems.length > 0 || !confirmed}
          onClick={() => void create()}
        >
          {busy ? 'Working...' : draftId ? 'Try again' : 'Create the new vault'}
        </Button>
      </div>
    </Modal>
  );
}
