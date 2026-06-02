import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  type Proposal,
  type Vault,
  type VaultMember,
  type ProposalComment,
  type ProposalVote,
} from "../lib/api";
import { supabase } from "../lib/supabase";
import { broadcastTxUrl, explorerTxUrl } from "../config";
import { listKeys, revealMnemonic, type LocalKey } from "../lib/keystore";
import {
  countSignatures,
  mergePsbts,
  signPsbtWithMnemonic,
} from "../lib/psbt-signer";
import { LoadingScreen } from "../components/LoadingScreen";
import { useToast } from "../components/toast";
import { useConfirm, usePrompt } from "../components/dialog";
import { Button, Textarea } from "../components/ui";
import { useRealtimeRefresh } from "../lib/realtime";
import { normalizePsbt } from "../lib/psbt-format";
import { colors, fonts, radii, space } from "../theme";

type Session = Awaited<ReturnType<typeof api.signerSessions.list>>["sessions"][number];

function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
}

// // -- Proposal signing page (multi-member co-signer command center)

export default function ProposalDetail() {
  const { vaultId, proposalId } = useParams<{ vaultId: string; proposalId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const askPassword = usePrompt();

  const [vault, setVault] = useState<Vault | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!vaultId || !proposalId) return;
    try {
      const [{ vaults }, { vaults: archived }] = await Promise.all([
        api.vaults.list(false),
        api.vaults.list(true),
      ]);
      const v = [...vaults, ...archived].find(x => x.id === vaultId) ?? null;
      if (!v) throw new Error("Vault not found");
      setVault(v);

      const [{ proposals }, { members: ms }, { sessions: ss }] = await Promise.all([
        api.proposals.list(vaultId),
        api.members.list(vaultId),
        api.signerSessions.list(proposalId),
      ]);
      const p = proposals.find(x => x.id === proposalId) ?? null;
      if (!p) throw new Error("Proposal not found");
      setProposal(p);
      setMembers(ms);
      setSessions(ss);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load proposal");
    } finally {
      setLoading(false);
    }
  }, [vaultId, proposalId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "signer_sessions", filter: `proposal_id=eq.${proposalId ?? ""}` },
    () => void load(),
  );
  useRealtimeRefresh(
    { table: "proposals", filter: `id=eq.${proposalId ?? ""}` },
    () => void load(),
  );

  if (loading) return <LoadingScreen />;
  if (error || !vault || !proposal) {
    // Fall back to the vault list when we have no usable vaultId, so the back
    // button never strands the user on /vaults/ (empty id).
    const back = vaultId ? `/vaults/${vaultId}` : "/vaults";
    return (
      <Page>
        <p style={{ color: colors.red, fontSize: 14 }}>{error ?? "Proposal not available"}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="ghost" onClick={() => navigate(back)}>
            {vaultId ? "Back to vault" : "Back to vaults"}
          </Button>
          <Button variant="ghost" onClick={() => navigate("/vaults")}>
            All vaults
          </Button>
        </div>
      </Page>
    );
  }

  const signedSessions = sessions.filter(s => s.signed && s.psbt_partial_hex);
  const partials = signedSessions.map(s => s.psbt_partial_hex!).filter(Boolean);
  const mergedPsbt =
    partials.length > 1
      ? (() => {
          try {
            return mergePsbts(partials);
          } catch {
            return partials[0];
          }
        })()
      : partials[0] ?? proposal.psbt_hex ?? "";
  const collected = mergedPsbt ? countSignatures(mergedPsbt) : 0;
  const required = vault.founder_quorum;
  const quorumMet = collected >= required;
  const terminal = proposal.status === "broadcast" || proposal.status === "cancelled";

  // Local keys that match a founder on this vault and haven't signed yet.
  const localKeys = listKeys().filter(k => k.status === "active" && k.origin === "software");
  const alreadySignedFingerprints = new Set(
    sessions.filter(s => s.signed && s.fingerprint).map(s => s.fingerprint as string),
  );
  const vaultMemberFingerprints = new Set(
    members.filter(m => m.fingerprint).map(m => m.fingerprint as string),
  );
  const signableKeys = localKeys.filter(
    k => vaultMemberFingerprints.has(k.fingerprint) && !alreadySignedFingerprints.has(k.fingerprint),
  );

  async function signWith(key: LocalKey) {
    if (!proposal || !vault) return;
    setBusy(true);
    try {
      const pw = key.testMnemonic
        ? undefined
        : (await askPassword({
            title: "Unlock key",
            message: `Enter the password for "${key.label}" to sign.`,
            password: true,
            confirmLabel: "Sign",
          })) ?? undefined;
      if (!key.testMnemonic && pw == null) return;
      const mnemonic = await revealMnemonic(key.keyId, pw);
      const basePsbt = mergedPsbt || proposal.psbt_hex;
      if (!basePsbt) throw new Error("No PSBT on this proposal");
      const result = await signPsbtWithMnemonic(basePsbt, mnemonic, key.derivationPath, vault.network);
      await api.signerSessions.submit({
        proposal_id: proposal.id,
        psbt_partial_hex: result.psbt_hex,
        fingerprint: key.fingerprint,
        label: key.label,
      });
      toast.success("Signed with " + key.label);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Signing failed");
    } finally {
      setBusy(false);
    }
  }

  async function broadcast() {
    if (!proposal || !vault || !mergedPsbt) return;
    setBusy(true);
    try {
      const finalized = await api.psbt.finalize(mergedPsbt);
      const res = await fetch(broadcastTxUrl(vault.network), {
        method: "POST",
        body: finalized.raw_tx_hex,
        headers: { "Content-Type": "text/plain" },
      });
      const txid = (await res.text()).trim();
      if (!res.ok || txid.length !== 64) {
        throw new Error("Broadcast failed: " + txid.slice(0, 100));
      }
      await api.proposals.update(proposal.id, { status: "broadcast", txid });
      toast.success("Transaction broadcast");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Broadcast failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!proposal) return;
    if (!(await confirm({ title: "Cancel proposal", message: "Cancel this proposal? Collected signatures will be discarded.", confirmLabel: "Cancel proposal", danger: true }))) return;
    try {
      await api.proposals.update(proposal.id, { status: "cancelled" });
      toast.success("Proposal cancelled");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel");
    }
  }

  return (
    <Page>
      <button
        onClick={() => navigate(`/vaults/${vault.id}`, { state: { vault } })}
        style={{
          background: "none",
          border: "none",
          color: colors.muted,
          fontSize: 14,
          cursor: "pointer",
          fontFamily: fonts.sans,
          marginBottom: space[4],
        }}
      >
        Back to {vault.name}
      </button>

      <SummaryCard proposal={proposal} vault={vault} />

      <ProgressCard
        collected={collected}
        required={required}
        quorumMet={quorumMet}
        status={proposal.status}
      />

      <MembersSection members={members} sessions={sessions} />

      <DiscussionSection proposalId={proposal.id} members={members} />

      {!terminal && signableKeys.length > 0 && (
        <ActionCard>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            Sign with your key
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {signableKeys.map(k => (
              <Button
                key={k.keyId}
                variant="ghost"
                disabled={busy}
                onClick={() => void signWith(k)}
                style={{ justifyContent: "flex-start", fontSize: 13 }}
              >
                {k.label}{" "}
                <span style={{ color: colors.muted, marginLeft: 8, fontSize: 11 }}>
                  ({k.fingerprint})
                </span>
              </Button>
            ))}
          </div>
        </ActionCard>
      )}

      {!terminal && (
        <ActionCard>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            Sign with hardware wallet
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>
            Export to Sparrow / Nunchuk / Coldcard, sign, paste the signed PSBT hex here.
          </div>
          <ExternalPsbt
            proposalId={proposal.id}
            onImported={() => void load()}
          />
        </ActionCard>
      )}

      {!terminal && quorumMet && (
        <Button
          disabled={busy}
          style={{ background: colors.green, width: "100%", padding: "14px", fontSize: 15 }}
          onClick={() => void broadcast()}
        >
          {busy ? "Broadcasting..." : "Broadcast transaction"}
        </Button>
      )}

      {!terminal && !quorumMet && signableKeys.length === 0 && (() => {
        // Tell the user *why* they can't sign: already signed, or no key.
        const iSigned = localKeys.some(
          k => vaultMemberFingerprints.has(k.fingerprint) && alreadySignedFingerprints.has(k.fingerprint),
        );
        const remaining = Math.max(0, required - collected);
        return (
          <div style={{ fontSize: 13, color: colors.muted, textAlign: "center", padding: "10px 0", lineHeight: 1.5 }}>
            {iSigned
              ? `You've signed. Waiting on ${remaining} more signature${remaining === 1 ? "" : "s"} to reach the ${required}-of quorum.`
              : "None of your local keys are signers on this vault. If you should be able to sign, import that seed on this device from the Key Manager."}
          </div>
        );
      })()}

      {proposal.txid && (
        <a
          href={explorerTxUrl(vault.network, proposal.txid)}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-block",
            marginTop: space[4],
            color: colors.gold,
            fontSize: 14,
          }}
        >
          View on mempool.space
        </a>
      )}

      {!terminal && (
        <Button
          variant="ghost"
          style={{ marginTop: space[3], fontSize: 12 }}
          onClick={() => void cancel()}
        >
          Cancel proposal
        </Button>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", fontFamily: fonts.sans }}>
      <main style={{ maxWidth: 680, margin: "0 auto", padding: `${space[6]}px ${space[4]}px` }}>
        {children}
      </main>
    </div>
  );
}

function SummaryCard({ proposal, vault }: { proposal: Proposal; vault: Vault }) {
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 20,
        marginBottom: space[3],
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: colors.muted,
          marginBottom: space[1],
        }}
      >
        {vault.name.toUpperCase()} / {vault.network === "bitcoin" ? "MAINNET" : "TESTNET"}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: colors.text,
          fontFamily: fonts.display,
          marginBottom: space[1],
        }}
      >
        {satsToBtc(proposal.amount_sats)}
        <span style={{ fontSize: 16, color: colors.muted }}> BTC</span>
      </div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 12,
          color: colors.sub,
          wordBreak: "break-all",
          marginBottom: space[2],
        }}
      >
        To: {proposal.destination}
      </div>
      {proposal.memo && (
        <div style={{ fontSize: 12, color: colors.sub }}>Note: {proposal.memo}</div>
      )}
    </div>
  );
}

function ProgressCard({
  collected,
  required,
  quorumMet,
  status,
}: {
  collected: number;
  required: number;
  quorumMet: boolean;
  status: string;
}) {
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 16,
        marginBottom: space[3],
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: colors.muted }}>Signatures</span>
        <span style={{ fontSize: 13, color: quorumMet ? colors.green : colors.orange }}>
          {collected} / {required} required
        </span>
      </div>
      <div style={{ height: 4, background: colors.border, borderRadius: 2 }}>
        <div
          style={{
            height: "100%",
            borderRadius: 2,
            background: quorumMet ? colors.green : colors.gold,
            width: `${Math.min(100, (collected / required) * 100)}%`,
            transition: "width 0.3s",
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: colors.muted, marginTop: space[2] }}>Status: {status}</div>
    </div>
  );
}

function MembersSection({ members, sessions }: { members: VaultMember[]; sessions: Session[] }) {
  const signed = new Set(sessions.filter(s => s.signed && s.fingerprint).map(s => s.fingerprint));
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        overflow: "hidden",
        marginBottom: space[3],
      }}
    >
      <div
        style={{
          padding: "10px 16px",
          borderBottom: `1px solid ${colors.border}`,
          fontSize: 13,
          fontWeight: 600,
          color: colors.text,
        }}
      >
        Members
      </div>
      {members.map(m => {
        const hasSigned = m.fingerprint ? signed.has(m.fingerprint) : false;
        return (
          <div
            key={m.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 16px",
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <div>
              <div style={{ fontSize: 13, color: colors.text }}>{m.label ?? "Unnamed"}</div>
              <div style={{ fontSize: 11, color: colors.muted }}>
                {m.role}
                {m.fingerprint ? ` / ${m.fingerprint}` : " / no key yet"}
              </div>
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.06em",
                padding: "3px 8px",
                borderRadius: 4,
                background: hasSigned ? `${colors.green}22` : "transparent",
                color: hasSigned ? colors.green : colors.muted,
                textTransform: "uppercase",
              }}
            >
              {hasSigned ? "Signed" : m.fingerprint ? "Pending" : "No key"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActionCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.lg,
        padding: 16,
        marginBottom: space[3],
      }}
    >
      {children}
    </div>
  );
}

function ExternalPsbt({
  proposalId,
  onImported,
}: {
  proposalId: string;
  onImported: () => void;
}) {
  const toast = useToast();
  const [hex, setHex] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const normalized = normalizePsbt(hex);
    if (!normalized) {
      setErr("Not a valid PSBT. Paste hex (starts with 70736274ff) or base64 (starts with cHNidP8).");
      return;
    }
    setBusy(true);
    try {
      await api.signerSessions.submit({
        proposal_id: proposalId,
        psbt_partial_hex: normalized,
        label: "Hardware wallet",
      });
      setHex("");
      toast.success("Signature added");
      onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add signature");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Textarea
        mono
        rows={3}
        value={hex}
        onChange={e => setHex(e.target.value)}
        placeholder="Paste signed PSBT (hex or base64 both work)"
      />
      {err && <p style={{ color: colors.red, fontSize: 12, margin: "4px 0" }}>{err}</p>}
      <Button
        type="submit"
        variant="ghost"
        disabled={!hex || busy}
        style={{ marginTop: 8 }}
      >
        {busy ? "Adding..." : "Add signature"}
      </Button>
    </form>
  );
}

// // -- Discussion + votes
// Every trustee can record an "approve / abstain / decline" vote and
// attach a free-text reason. Votes are separate from signatures --
// a trustee can decline without blocking the signing quorum, which
// preserves their dissent in the audit log. A blue "approve",
// grey "abstain", or red "decline" badge sits next to each row.

function DiscussionSection({
  proposalId,
  members,
}: {
  proposalId: string;
  members: VaultMember[];
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [comments, setComments] = useState<ProposalComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [body, setBody] = useState("");
  const [vote, setVote] = useState<ProposalVote | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.proposalComments.list(proposalId);
      setComments(res.comments);
    } catch (e) {
      /* silent; banner below renders on submit errors */
      void e;
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setCurrentUserId(data.session?.user.id ?? null);
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: "proposal_comments", filter: `proposal_id=eq.${proposalId}` },
    () => void load(),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!body.trim() && !vote) {
      setErr("Write a message or pick a vote (or both).");
      return;
    }
    setBusy(true);
    try {
      await api.proposalComments.create({
        proposal_id: proposalId,
        body: body.trim() || undefined,
        vote: vote || undefined,
      });
      setBody("");
      setVote("");
      toast.success(vote ? `Vote recorded: ${vote}` : "Comment posted");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not post");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ title: "Delete comment", message: "Delete this comment?", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.proposalComments.remove(id);
      toast.success("Deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // Latest vote per member -- later rows supersede earlier ones.
  const latestVoteByUser = new Map<string, ProposalVote>();
  for (const c of comments) {
    if (c.vote) latestVoteByUser.set(c.user_id, c.vote);
  }
  const tally = { approve: 0, abstain: 0, decline: 0 };
  for (const v of latestVoteByUser.values()) tally[v]++;

  function authorLabel(userId: string): string {
    const m = members.find(x => x.user_id === userId);
    return m?.label || "Member";
  }

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: 16,
        marginTop: space[3],
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: colors.muted,
            textTransform: "uppercase",
          }}
        >
          Discussion
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
          <span style={{ color: colors.green }}>approve {tally.approve}</span>
          <span style={{ color: colors.muted }}>abstain {tally.abstain}</span>
          <span style={{ color: colors.red }}>decline {tally.decline}</span>
        </div>
      </div>

      {loading ? (
        <p style={{ color: colors.muted, fontSize: 13 }}>Loading...</p>
      ) : comments.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 13, marginBottom: 14 }}>
          No discussion yet. Record your position or note context before signing.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
          {comments.map(c => (
            <CommentRow
              key={c.id}
              comment={c}
              authorLabel={authorLabel(c.user_id)}
              canDelete={c.user_id === currentUserId}
              onDelete={() => void remove(c.id)}
            />
          ))}
        </div>
      )}

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Textarea
          rows={2}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Add context. What rule does this spend fall under? Tax category? Reason for urgency?"
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div
            style={{
              display: "flex",
              gap: 4,
              background: colors.input,
              borderRadius: radii.md,
              padding: 3,
            }}
          >
            {(["approve", "abstain", "decline"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setVote(vote === v ? "" : v)}
                style={{
                  padding: "6px 14px",
                  border: "none",
                  borderRadius: radii.sm,
                  background: vote === v ? voteColor(v) + "33" : "transparent",
                  color: vote === v ? voteColor(v) : colors.muted,
                  fontSize: 12,
                  fontFamily: fonts.sans,
                  cursor: "pointer",
                  textTransform: "capitalize",
                  fontWeight: vote === v ? 600 : 400,
                }}
              >
                {v}
              </button>
            ))}
          </div>
          <Button type="submit" size="sm" disabled={busy} style={{ marginLeft: "auto" }}>
            {busy ? "Posting..." : vote ? "Record vote" : "Post comment"}
          </Button>
        </div>
        {err && <p style={{ color: colors.red, fontSize: 12, margin: 0 }}>{err}</p>}
      </form>
    </div>
  );
}

function CommentRow({
  comment,
  authorLabel,
  canDelete,
  onDelete,
}: {
  comment: ProposalComment;
  authorLabel: string;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        background: "#0A0A14",
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{authorLabel}</span>
          {comment.vote && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 7px",
                borderRadius: 4,
                background: voteColor(comment.vote) + "22",
                color: voteColor(comment.vote),
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {comment.vote}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: colors.muted }}>
            {new Date(comment.created_at).toLocaleString()}
          </span>
          {canDelete && (
            <button
              onClick={onDelete}
              style={{
                background: "none",
                border: "none",
                color: colors.muted,
                cursor: "pointer",
                fontSize: 11,
                padding: 0,
              }}
            >
              delete
            </button>
          )}
        </div>
      </div>
      {comment.body && (
        <div style={{ fontSize: 13, color: colors.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
          {comment.body}
        </div>
      )}
    </div>
  );
}

function voteColor(v: ProposalVote): string {
  switch (v) {
    case "approve":
      return colors.green;
    case "decline":
      return colors.red;
    default:
      return colors.muted;
  }
}
