import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { downloadTextFile } from '../lib/download-file';
import {
  entryStanding,
  fetchMerkleRoots,
  heightsToCheck,
  ledgerEventWords,
  ledgerExportFile,
  verifyAnchors,
  verifyLedger,
  MAX_BLOCK_LOOKUPS,
  type AnchorCheck,
  type LedgerAnchor,
  type LedgerCheck,
  type LedgerEntry,
} from '../lib/ledger-verify';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';
import { useToast } from '../components/toast';

// The sealed record of one vault (security backlog 15d). Everything on
// this page is checked HERE, in the member's browser, from the raw rows
// -- the hash chain is re-walked and every Bitcoin proof is replayed and
// matched to the real block (lib/ledger-verify.ts). The server sends its
// own verdict too; it is only ever shown as a second opinion, and a
// disagreement between the two is itself reported.

interface Loaded {
  entries: LedgerEntry[];
  anchors: LedgerAnchor[];
  chain: LedgerCheck;
  stamps: AnchorCheck;
  serverChainOk: boolean;
  serverStampsOk: boolean;
  names: Record<string, string>;
  me: string | null;
  checkedAt: Date;
}

const STANDING: Record<'bitcoin' | 'receipt' | 'waiting', { label: string; color: string }> = {
  bitcoin: { label: 'In Bitcoin', color: colors.green },
  receipt: { label: 'Receipt held', color: colors.gold },
  waiting: { label: 'Waiting for stamp', color: colors.sub },
};

/** The sealed details, laid out to read; if they are not readable as
 *  JSON the exact sealed text is shown instead of guessing. */
function sealedDetails(e: LedgerEntry): string {
  try {
    return JSON.stringify(e.payload ?? JSON.parse(e.payload_canon), null, 2);
  } catch {
    return e.payload_canon;
  }
}

/** A Bitcoin proof this browser could not compare with the real block
 *  is never shown in green. */
const UNCHECKED = { label: 'Proof held, unchecked', color: colors.orange };

const BROKEN = { label: 'Does not check out', color: colors.red };

export default function VaultLedger() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const vaultName = (location.state as { vaultName?: string } | null)?.vaultName ?? null;

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  const check = useCallback(async () => {
    if (!id) return;
    setChecking(true);
    setError(null);
    try {
      const [led, mem, sess] = await Promise.all([
        api.ledger.get(id),
        api.members.list(id).catch(() => null),
        supabase.auth.getSession(),
      ]);
      const chain = verifyLedger(led.entries);
      // Look the stamped blocks up from two independent sources. If
      // they cannot be reached the proofs are still replayed, and the
      // page says plainly that the blocks themselves were not checked.
      let roots: Record<number, string> | null;
      try {
        roots = await fetchMerkleRoots(heightsToCheck(led.anchors));
      } catch {
        roots = null;
      }
      const stamps = verifyAnchors(led.entries, led.anchors, roots);
      const names: Record<string, string> = {};
      for (const m of mem?.members ?? []) {
        if (m.user_id) names[m.user_id] = m.label || m.role;
      }
      setData({
        entries: [...led.entries].sort((a, b) => Number(b.seq) - Number(a.seq)),
        anchors: led.anchors,
        chain,
        stamps,
        serverChainOk: led.verification.ok,
        serverStampsOk: led.anchoring.ok,
        names,
        me: sess.data.session?.user.id ?? null,
        checkedAt: new Date(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setChecking(false);
    }
  }, [id]);

  useEffect(() => {
    void check();
  }, [check]);

  if (!id) return <p style={{ color: colors.red }}>Vault not found.</p>;

  const who = (userId: string | null): string => {
    if (!userId) return 'The system';
    if (data?.me && userId === data.me) return 'You';
    return data?.names[userId] ?? 'A former member';
  };

  async function download() {
    if (!data || !id) return;
    const ordered = [...data.entries].sort((a, b) => Number(a.seq) - Number(b.seq));
    const saved = await downloadTextFile(
      `dynastytrust-sealed-record-${id.slice(0, 8)}.json`,
      ledgerExportFile(id, ordered, data.anchors, new Date().toISOString()),
      'application/json',
    );
    if (saved) toast.success('Record saved. The file explains how to check it without us.');
  }

  const intact = !!data && data.chain.ok && data.stamps.ok;
  const count = data?.entries.length ?? 0;
  const waiting = data ? data.entries.filter(e => Number(e.seq) > data.stamps.anchoredThrough).length : 0;

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: space[3] }}>
      <div>
        <Button variant="ghost" size="sm" style={{ minHeight: 44 }} onClick={() => navigate(`/vaults/${id}`)}>
          Back to {vaultName ?? 'the vault'}
        </Button>
      </div>

      {checking && !data && (
        <Card>
          <p style={{ color: colors.sub, margin: 0 }}>Checking the record in this browser...</p>
        </Card>
      )}

      {error && (
        <Card style={{ borderColor: colors.borderDanger, background: colors.dangerBg }}>
          <p style={{ color: colors.red, margin: 0, lineHeight: 1.6 }}>
            The record could not be loaded, so nothing was checked: {error}
          </p>
        </Card>
      )}

      {data && (
        <>
          <Card
            style={{
              borderColor: intact ? colors.green : colors.red,
              background: intact ? colors.successBg : colors.dangerBg,
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 22, color: intact ? colors.green : colors.red }}>
              {intact ? (count === 0 ? 'Nothing sealed yet' : 'Record intact') : 'Record does NOT check out'}
            </div>
            {intact && count > 0 && (
              <p style={{ color: colors.text, lineHeight: 1.6, marginBottom: 0 }}>
                {count} {count === 1 ? 'entry' : 'entries'}, each one locked to the one before it. Checked in
                this browser at {data.checkedAt.toLocaleTimeString()}.
              </p>
            )}
            {intact && count === 0 && (
              <p style={{ color: colors.text, lineHeight: 1.6, marginBottom: 0 }}>
                Sealing was switched on 11 November 2026. Anything done on this vault before that day is in
                its activity feed but was never sealed. The next action on this vault becomes entry 1.
              </p>
            )}
            {!data.chain.ok && (
              <p style={{ color: colors.text, lineHeight: 1.6, marginBottom: 0 }}>
                The chain is broken: {data.chain.reason}. Do not rely on this vault's history until this is
                explained.
              </p>
            )}
            {[...new Set(data.stamps.problems)].map(p => (
              <p key={p} style={{ color: colors.text, lineHeight: 1.6, marginBottom: 0 }}>
                Bitcoin stamp problem: {p}.
              </p>
            ))}
            {(data.serverChainOk !== data.chain.ok || (data.stamps.blocksChecked && data.serverStampsOk !== data.stamps.ok)) && (
              <p style={{ color: colors.orange, lineHeight: 1.6, marginBottom: 0 }}>
                The server's own check and this browser's check disagree. Trust this browser's result and
                tell us.
              </p>
            )}
          </Card>

          <Card>
            <div style={{ fontFamily: fonts.display, fontSize: 18, color: colors.gold }}>Bitcoin stamps</div>
            {data.anchors.length === 0 && (
              <p style={{ color: colors.text, lineHeight: 1.6 }}>
                Nothing from this record has been sent for stamping yet. The big moments -- the vault being
                created or finalized, a spend going out, a member joining or leaving -- are sent at once.
                Everything else is sent once a day.
              </p>
            )}
            {data.stamps.confirmedThrough > 0 && data.stamps.blocksChecked && (
              <p style={{ color: colors.text, lineHeight: 1.6 }}>
                <span style={{ color: colors.green }}>Proven in Bitcoin</span> through entry{' '}
                {data.stamps.confirmedThrough}, in block {data.stamps.bitcoinHeight?.toLocaleString()}.
              </p>
            )}
            {data.stamps.confirmedThrough > 0 && !data.stamps.blocksChecked && (
              <p style={{ color: colors.text, lineHeight: 1.6 }}>
                <span style={{ color: colors.orange }}>Bitcoin proof held, block not checked</span> through
                entry {data.stamps.confirmedThrough}. The proof points at block{' '}
                {data.stamps.bitcoinHeight?.toLocaleString()}.
              </p>
            )}
            {data.stamps.confirmedThrough > 0 && data.stamps.blocksChecked && (
              <p style={{ color: colors.sub, lineHeight: 1.6 }}>
                This browser replayed the proof and matched it to the real block, as reported by two
                independent sources.
                {data.stamps.blocksUnchecked > 0 &&
                  ` Only the newest ${MAX_BLOCK_LOOKUPS} blocks were looked up; ${data.stamps.blocksUnchecked} older ${data.stamps.blocksUnchecked === 1 ? 'proof was' : 'proofs were'} replayed without looking the block up.`}
              </p>
            )}
            {data.stamps.confirmedThrough > 0 && !data.stamps.blocksChecked && (
              <p style={{ color: colors.orange, lineHeight: 1.6 }}>
                The two Bitcoin sources could not both be reached just now, so this browser could not
                compare the proof with the real block. Treat it as unconfirmed and tap Check again.
              </p>
            )}
            {data.stamps.anchoredThrough > data.stamps.confirmedThrough && (
              <p style={{ color: colors.text, lineHeight: 1.6 }}>
                <span style={{ color: colors.gold }}>Receipt held</span> through entry{' '}
                {data.stamps.anchoredThrough}. A receipt is a timestamp service's promise to put the stamp in
                a Bitcoin block; that usually takes a few hours.
              </p>
            )}
            {data.anchors.length > 0 && waiting > 0 && (
              <p style={{ color: colors.sub, lineHeight: 1.6 }}>
                {waiting} newer {waiting === 1 ? 'entry is' : 'entries are'} waiting for the next daily stamp.
              </p>
            )}
            <p style={{ color: colors.sub, lineHeight: 1.6, marginBottom: 0, fontSize: 15 }}>
              Why this matters: each entry carries the fingerprint of the one before it, so changing any
              old entry breaks every entry after it. Once the newest fingerprint is inside a Bitcoin block,
              the history up to that point is fixed. Nobody -- not DynastyTrust, not whoever runs its
              database -- can rewrite it without this page turning red.
            </p>
          </Card>

          <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
            <Button variant="primary" style={{ minHeight: 44, flex: '1 1 160px' }} disabled={checking} onClick={() => void check()}>
              {checking ? 'Checking...' : 'Check again'}
            </Button>
            <Button variant="ghost" style={{ minHeight: 44, flex: '1 1 160px' }} disabled={count === 0} onClick={() => void download()}>
              Save a copy
            </Button>
          </div>

          {count > 0 && (
            <Card padding={space[3]}>
              {data.entries.map(e => {
                const seq = Number(e.seq);
                const where = entryStanding(seq, data.stamps);
                // From the first entry that fails the chain onward, nothing is vouched for.
                const broken = !data.chain.ok && seq >= data.chain.brokenAt;
                const standing = broken ? BROKEN : where === 'bitcoin' && !data.stamps.blocksChecked ? UNCHECKED : STANDING[where];
                const open = openSeq === seq;
                return (
                  <div key={seq} style={{ borderBottom: `1px solid ${colors.divider}` }}>
                    <button
                      type="button"
                      onClick={() => setOpenSeq(open ? null : seq)}
                      aria-expanded={open}
                      style={{
                        display: 'flex',
                        gap: space[3],
                        alignItems: 'flex-start',
                        width: '100%',
                        minHeight: 44,
                        padding: `${space[3]}px ${space[1]}px`,
                        background: 'transparent',
                        border: 'none',
                        color: colors.text,
                        textAlign: 'left',
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      <span style={{ fontFamily: fonts.mono, color: colors.muted, minWidth: 28 }}>{seq}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 15 }}>{ledgerEventWords(e.event_type)}</span>
                        <span style={{ display: 'block', fontSize: 15, color: colors.sub, marginTop: 2 }}>
                          {who(e.actor_user_id)} - {new Date(e.recorded_at).toLocaleString()}
                        </span>
                      </span>
                      <span style={{ fontSize: 14, color: standing.color, whiteSpace: 'nowrap', paddingTop: 2 }}>
                        {standing.label}
                      </span>
                    </button>
                    {open && (
                      <div
                        style={{
                          background: colors.inset,
                          borderRadius: radii.md,
                          padding: space[3],
                          marginBottom: space[3],
                          fontSize: 15,
                          color: colors.sub,
                        }}
                      >
                        <div style={{ marginBottom: space[2] }}>Details that were sealed:</div>
                        <pre
                          style={{
                            fontFamily: fonts.mono,
                            fontSize: 14,
                            color: colors.text,
                            margin: 0,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {sealedDetails(e)}
                        </pre>
                        <div style={{ margin: `${space[3]}px 0 ${space[1]}px` }}>Fingerprint of this entry:</div>
                        <div style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.text, wordBreak: 'break-all' }}>
                          {e.entry_hash}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
