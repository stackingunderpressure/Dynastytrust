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
import { getTapitCircleMembers } from "../lib/tapit-circle-members";
import { pubkeyFromXpub } from "../lib/xpub";
import { LoadingScreen } from "../components/LoadingScreen";
import { useToast } from "../components/toast";
import { useConfirm, usePrompt } from "../components/dialog";
import { Button, Textarea } from "../components/ui";
import { NotifyCircleViaNostr } from "../components/NotifyCircleViaNostr";
import { PsbtQrDisplay } from "../components/PsbtQrDisplay";
import { PsbtQrScanner } from "../components/PsbtQrScanner";
import { useRealtimeRefresh } from "../lib/realtime";
import { normalizePsbt } from "../lib/psbt-format";
import { colors, fonts, radii, space } from "../theme";

type Session = Awaited<ReturnType<typeof api.signerSessions.list>>["sessions"][number];

function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0";
}

/** Which of the vault's key arrays are the real signers for a given
 *  proposal's leaf, and how many of them are required -- mirrors
 *  VaultDetail.tsx's buildAndSign signer-discovery switch (2026-08-11 fix:
 *  operator tested a single-key backup leaf with no timelock and the
 *  signing screen said "0 of 2 signatures needed" instead of "0 of 1").
 *  This page had the identical bug: it always showed vault.founder_quorum
 *  and vault.founder_keys regardless of which leaf the proposal actually
 *  spends from, so recovery/inheritance/backup/second_inheritance
 *  proposals all showed the wrong required count and the wrong signable-key
 *  set. Bloc vaults (bloc_policy != null) never had ANY branch here at
 *  all -- vault.founder_quorum is unset for a Bloc-only vault, so every
 *  Bloc proposal showed "0 of undefined", and worse, the caller below used
 *  to filter signable keys through vault_members, a table Bloc vaults never
 *  populate, so no one could ever sign a Bloc proposal from this page. */
function resolvePathSigners(
  vault: Vault,
  path: Proposal["path"],
): { keyArray: string[]; required: number } {
  const bp = vault.bloc_policy;
  if (bp) {
    switch (path) {
      case "parents_now":
        return { keyArray: bp.parent_pubkeys, required: bp.parents_together_quorum };
      case "coparent_kids":
        return {
          keyArray: [...bp.parent_pubkeys, ...bp.kid_pubkeys],
          required: bp.coparent_quorum + bp.kids_with_parent_quorum,
        };
      case "parent_solo":
        return { keyArray: bp.parent_pubkeys, required: bp.parent_solo_quorum };
      case "kids_decay":
        // No block-height context on this page (unlike the build-time flow
        // in VaultDetail, which picks the live rung) -- the floor quorum is
        // the safe worst-case default; still strictly better than the prior
        // vault.founder_quorum, which does not exist on a Bloc vault at all.
        return { keyArray: bp.kid_pubkeys, required: bp.kids_decay_floor_quorum };
      default:
        return { keyArray: bp.parent_pubkeys, required: bp.parents_together_quorum };
    }
  }
  switch (path) {
    case "recovery":
      return { keyArray: vault.founder_keys, required: vault.recovery_quorum ?? vault.founder_quorum };
    case "inheritance":
      return { keyArray: vault.heir_keys, required: vault.heir_quorum };
    case "backup":
      return { keyArray: vault.backup_keys, required: vault.backup_quorum ?? 0 };
    case "second_inheritance":
      return { keyArray: vault.second_heir_keys, required: vault.second_heir_quorum ?? 0 };
    case "tranche_claim":
      // Distribution-wallet claims aren't governed by the vault's own
      // leaves -- TrancheClaimModal (VaultDetail.tsx) is the only signing
      // surface for these, never this page. Empty/zero is a safe no-op.
      return { keyArray: [], required: 0 };
    case "founders_now":
    default: {
      const keyArray = [...vault.founder_keys];
      let required = vault.founder_quorum;
      if (vault.consent_keys.length > 0 && vault.consent_quorum != null) {
        keyArray.push(...vault.consent_keys);
        required += vault.consent_quorum;
      }
      return { keyArray, required };
    }
  }
}

/** Expands xpubs to pubkey hex (Bloc's raw pubkey lists pass through
 *  untouched) so a vault's key array can be intersected with the local
 *  keystore's pubkey field -- same normalization VaultDetail.tsx's addKey
 *  and tapit-circle-members.ts already do. */
function toPubkeySet(keyArray: string[]): Set<string> {
  const set = new Set<string>();
  for (const x of keyArray) {
    if (typeof x !== "string") continue;
    if (x.length === 66) {
      set.add(x);
      continue;
    }
    try {
      set.add(pubkeyFromXpub(x));
    } catch {
      /* skip malformed rows */
    }
  }
  return set;
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
  // 2026-08-11 fix (operator: "Finalization failed: PSBT is missing
  // both witness and non-witness UTXO at index 0"). Always fold
  // proposal.psbt_hex in as the merge base, ahead of every partial, when
  // it's present -- it's the one PSBT guaranteed to carry witness_utxo/
  // tap_internal_key/tap_scripts (set unconditionally at build time,
  // compiler/src/main.rs's psbt_binary), so basing every merge on it
  // repairs even a partial that got stored trimmed (no witness_utxo at
  // all) before ExternalPsbt.addSignature/tapitSigned learned to merge
  // against the base before submitting. Previously this used partials[0]
  // as the merge base whenever more than one partial existed, and
  // partials[0] ALONE -- no proposal.psbt_hex in the picture at all --
  // whenever there was exactly one: a single trimmed hardware-wallet
  // partial (SeedSigner's own PSBTParser.trim() strips everything but
  // the signature, by design) became this proposal's live PSBT outright.
  const mergeChain = proposal.psbt_hex ? [proposal.psbt_hex, ...partials] : partials;
  const mergedPsbt =
    mergeChain.length > 1
      ? (() => {
          try {
            return mergePsbts(mergeChain);
          } catch {
            return mergeChain[0];
          }
        })()
      : mergeChain[0] ?? "";
  const collected = mergedPsbt ? countSignatures(mergedPsbt) : 0;
  const pathSigners = resolvePathSigners(vault, proposal.path);
  const required = pathSigners.required;
  const quorumMet = collected >= required;
  const terminal = proposal.status === "broadcast" || proposal.status === "cancelled";
  // Tranche claims are signed and broadcast entirely inside
  // TrancheClaimModal (VaultDetail.tsx), which has the real per-claim
  // required-signature count (beneficiary path = 1, trustee escape hatch =
  // wallet.trustee_quorum) that this page has no way to know -- it only
  // knows the proposal row, not which distribution wallet/path produced
  // it. This page is read-only history for a tranche claim: showing the
  // sign/broadcast controls here would let required=0 (this page's safe
  // placeholder) look like an already-met quorum and offer to
  // double-broadcast a claim that's either already signed elsewhere or
  // still being signed in the modal.
  const isTrancheClaim = proposal.path === "tranche_claim";

  // Local keys that match a signer on THIS proposal's leaf and haven't
  // signed yet. Matched against the proposal's own path-specific key array
  // (not vault_members, which Bloc vaults never populate at all) so this
  // works identically for standard and Bloc vaults.
  const pathSignerPubkeys = toPubkeySet(pathSigners.keyArray);
  const localKeys = listKeys().filter(k => k.status === "active" && k.origin === "software");
  const alreadySignedFingerprints = new Set(
    sessions.filter(s => s.signed && s.fingerprint).map(s => s.fingerprint as string),
  );
  const signableKeys = localKeys.filter(
    k => pathSignerPubkeys.has(k.pubkey) && !alreadySignedFingerprints.has(k.fingerprint),
  );

  // Tapit-origin signers on THIS proposal's leaf, same detection
  // VaultMembershipSetup and SendTab's NotifyCircleViaNostr already use --
  // matched against the path's own key array, since these signers don't
  // necessarily have a vault_members row/fingerprint the way a hardware or
  // software key does. "Already signed" isn't tracked per-Tapit-key here
  // (their signer_sessions rows carry a label, not a fingerprint); this
  // just reflects into the live progress bar via load() after a signature
  // lands, same as every other signing path on this page.
  const tapitSigners = getTapitCircleMembers(pathSigners.keyArray).circleMembers.map(key => ({
    key,
    status: "pending" as const,
  }));

  async function tapitSigned(psbtHex: string, label: string) {
    if (!proposal) return;
    try {
      // Same defensive merge as ExternalPsbt.addSignature below, and for
      // the same reason: guarantee every psbt_partial_hex stored in
      // signer_sessions is a COMPLETE PSBT, never a bare signature
      // fragment, regardless of what the signing wallet chose to strip
      // before handing the signature back. Tapit's own signer doesn't
      // trim today, but nothing stops a future signer (or a Tapit change)
      // from doing so, and this makes the guarantee hold structurally
      // instead of by accident of which wallets happen not to trim.
      const base = mergedPsbt || proposal.psbt_hex;
      const merged = base ? mergePsbts([base, psbtHex]) : psbtHex;
      await api.signerSessions.submit({
        proposal_id: proposal.id,
        psbt_partial_hex: merged,
        label,
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save signature");
    }
  }

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

      {isTrancheClaim ? (
        <div
          style={{
            fontSize: 12,
            color: colors.muted,
            background: colors.inset,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            padding: "10px 12px",
            marginBottom: 14,
          }}
        >
          Tranche claims are signed and broadcast from the Distributions tab,
          not from here -- this page is the request's vote, discussion, and
          audit history.
        </div>
      ) : (
        <ProgressCard
          collected={collected}
          required={required}
          quorumMet={quorumMet}
          status={proposal.status}
        />
      )}

      <MembersSection members={members} sessions={sessions} />

      <DiscussionSection proposalId={proposal.id} members={members} />

      {!terminal && !isTrancheClaim && signableKeys.length > 0 && (
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

      {!terminal && !isTrancheClaim && (
        <NotifyCircleViaNostr
          subjectId={proposal.id}
          psbtHex={mergedPsbt || proposal.psbt_hex || ""}
          vaultDescriptor={vault.descriptor}
          vaultName={vault.name}
          signers={tapitSigners}
          onSigned={(hex, label) => void tapitSigned(hex, label)}
        />
      )}

      {!terminal && !isTrancheClaim && (
        <ActionCard>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            Sign with hardware wallet
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>
            Export this transaction to your signing device, sign, then scan or paste the
            signed result back here.
          </div>
          <ExternalPsbt
            proposalId={proposal.id}
            psbtToSign={mergedPsbt || proposal.psbt_hex || ""}
            onImported={() => void load()}
          />
        </ActionCard>
      )}

      {!terminal && !isTrancheClaim && quorumMet && (
        <Button
          disabled={busy}
          style={{ background: colors.green, width: "100%", padding: "14px", fontSize: 15 }}
          onClick={() => void broadcast()}
        >
          {busy ? "Broadcasting..." : "Broadcast transaction"}
        </Button>
      )}

      {!terminal && !isTrancheClaim && !quorumMet && signableKeys.length === 0 && (() => {
        // Tell the user *why* they can't sign: already signed, or no key.
        const iSigned = localKeys.some(
          k => pathSignerPubkeys.has(k.pubkey) && alreadySignedFingerprints.has(k.fingerprint),
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

      {!terminal && !isTrancheClaim && (
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
                display: "flex",
                alignItems: "center",
                gap: 5,
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
              {hasSigned && (
                <span
                  aria-hidden
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: colors.green,
                    color: "#fff",
                    fontSize: 9,
                    fontWeight: 700,
                  }}
                >
                  ✓
                </span>
              )}
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
  psbtToSign,
  onImported,
}: {
  proposalId: string;
  psbtToSign: string;
  onImported: () => void;
}) {
  const toast = useToast();
  const [hex, setHex] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showQrDisplay, setShowQrDisplay] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);

  async function addSignature(rawHex: string) {
    setErr(null);
    setBusy(true);
    try {
      // 2026-08-11 fix (operator: "Finalization failed: PSBT is missing
      // both witness and non-witness UTXO at index 0"). Hardware signers
      // -- SeedSigner explicitly, by its own design comment on
      // PSBTParser.trim() -- export back a TRIMMED PSBT carrying only the
      // new signature, with witness_utxo/tap_internal_key/tap_scripts all
      // stripped, on the assumption that "whoever merges this back in
      // already has the original unsigned PSBT." This app's own
      // mergePsbts already handles that correctly WHEN the first PSBT in
      // its list is the full one -- but this function used to submit
      // rawHex to signerSessions AS-IS, un-merged. As long as it was the
      // only signature so far, load()'s mergedPsbt computation
      // (ProposalDetail's own `partials.length > 1 ? mergePsbts(...) :
      // partials[0] ?? proposal.psbt_hex`) used that bare trimmed hex
      // DIRECTLY as the proposal's live PSBT, discarding proposal.psbt_hex
      // (the only copy that actually has witness_utxo) entirely -- and
      // once mergePsbts(partials) DOES run for a second signer, it uses
      // partials[0] as ITS base too, so a still-trimmed first entry
      // poisons every later merge as well. Fix: merge the freshly
      // returned signature against psbtToSign (the same full PSBT this
      // component showed as the QR/copy source) BEFORE persisting it, so
      // every psbt_partial_hex ever stored in signer_sessions is
      // guaranteed to be a complete PSBT, not a bare signature fragment.
      const merged = mergePsbts([psbtToSign, rawHex]);
      await api.signerSessions.submit({
        proposal_id: proposalId,
        psbt_partial_hex: merged,
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizePsbt(hex);
    if (!normalized) {
      setErr("Not a valid PSBT. Paste hex (starts with 70736274ff) or base64 (starts with cHNidP8).");
      return;
    }
    await addSignature(normalized);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <Button
          variant="ghost"
          size="sm"
          style={{ fontSize: 12 }}
          onClick={() => setShowQrDisplay(s => !s)}
        >
          {showQrDisplay ? "Hide QR" : "Show QR"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          style={{ fontSize: 12 }}
          onClick={() => setShowQrScanner(s => !s)}
        >
          {showQrScanner ? "Hide scanner" : "Scan signed QR"}
        </Button>
      </div>
      {showQrDisplay && (
        <div style={{ marginBottom: 14 }}>
          <PsbtQrDisplay psbtHex={psbtToSign} />
          <div style={{ fontSize: 11, color: colors.muted, marginTop: 6, textAlign: "center" }}>
            UR `crypto-psbt` animated. Stateless -- no pairing needed. Point your air-gapped signer at the screen.
          </div>
        </div>
      )}
      {showQrScanner && (
        <div style={{ marginBottom: 14 }}>
          <PsbtQrScanner
            onResult={hexResult => {
              setShowQrScanner(false);
              void addSignature(hexResult);
            }}
            onCancel={() => setShowQrScanner(false)}
          />
        </div>
      )}
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
    </div>
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
      // Don't rely on the realtime subscription alone to reflect this back --
      // if it's slow, disabled, or misconfigured on the Supabase project,
      // a genuinely-saved vote just never appears until an unrelated reload,
      // which reads as "the vote doesn't get recorded" even though it did.
      await load();
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
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // 2026-08-11 audit (operator: "You can vote three or four times, it
  // may log it down, but it doesn't show you who voted for what"):
  // every vote was always correctly persisted as its own row (an
  // intentional audit trail, per proposal-comments.js's own header --
  // "the old row is kept for audit; UI dedupes to the latest per-member
  // vote") and this Map has always correctly resolved to each member's
  // CURRENT vote. The actual gap was downstream: latestVoteByUser was
  // only ever used to build the bare tally counts below (approve 2,
  // abstain 1...), never rendered as a roster naming WHO stands where
  // -- an operator scrolling a chronological comment feed had to
  // mentally track "which of Bob's four rows is current" themselves.
  // VoteRoster (below) is the fix: one row per member, their current
  // vote or "Not yet voted," by name.
  const latestVoteByUser = new Map<string, ProposalVote>();
  // Which comment id actually SET each member's current vote -- lets
  // CommentRow mark an earlier, since-superseded vote-only row as
  // "changed since" instead of presenting four identical-looking badges
  // with no way to tell which one still holds.
  const latestVoteCommentIdByUser = new Map<string, string>();
  for (const c of comments) {
    if (c.vote) {
      latestVoteByUser.set(c.user_id, c.vote);
      latestVoteCommentIdByUser.set(c.user_id, c.id);
    }
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

      <VoteRoster members={members} latestVoteByUser={latestVoteByUser} currentUserId={currentUserId} />

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
              superseded={!!c.vote && latestVoteCommentIdByUser.get(c.user_id) !== c.id}
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
            {/* 2026-08-11 fix (operator: "some weird places in the UI") --
                an unselected pill used to render as bare grey text with no
                border or background, which read as disabled/unclickable
                rather than as one of three pickable options. Every pill now
                keeps a visible border so the row reads as a real segmented
                control regardless of which (if any) is currently picked. */}
            {(["approve", "abstain", "decline"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setVote(vote === v ? "" : v)}
                style={{
                  padding: "6px 14px",
                  minHeight: 32,
                  border: `1px solid ${vote === v ? voteColor(v) : colors.border}`,
                  borderRadius: radii.sm,
                  background: vote === v ? voteColor(v) + "33" : "transparent",
                  color: vote === v ? voteColor(v) : colors.text,
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

// 2026-08-11 (operator: "it doesn't show you who voted for what or
// where why") -- the roster the tally counts never had: one row per
// vault member, their CURRENT vote (or "Not yet voted"), by name. The
// comment feed below still carries the full audit trail (every vote
// ever cast, including changed ones); this is the at-a-glance summary
// of where things actually stand right now.
function VoteRoster({
  members,
  latestVoteByUser,
  currentUserId,
}: {
  members: VaultMember[];
  latestVoteByUser: Map<string, ProposalVote>;
  currentUserId: string | null;
}) {
  if (members.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginBottom: 14,
        padding: "10px 12px",
        background: colors.inset,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
      }}
    >
      {members.map(m => {
        const v = latestVoteByUser.get(m.user_id);
        return (
          <div
            key={m.id}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
          >
            <span style={{ fontSize: 12, color: colors.text, minWidth: 0 }}>
              {m.label || "Unnamed"}
              {m.user_id === currentUserId && <span style={{ color: colors.muted }}> (you)</span>}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 7px",
                borderRadius: 4,
                background: v ? voteColor(v) + "22" : "transparent",
                color: v ? voteColor(v) : colors.muted,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                flexShrink: 0,
              }}
            >
              {v ?? "Not yet voted"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CommentRow({
  comment,
  authorLabel,
  canDelete,
  onDelete,
  superseded,
}: {
  comment: ProposalComment;
  authorLabel: string;
  canDelete: boolean;
  onDelete: () => void;
  /** True when this row's vote is NOT the author's current one -- a
   *  later comment (with or without a new vote) replaced it. The row
   *  stays in the feed (the audit trail is intentional -- see
   *  proposal-comments.js), just visibly marked so scrolling the
   *  thread never reads as "four current votes from the same person." */
  superseded: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        background: colors.inset,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        opacity: superseded ? 0.6 : 1,
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
          {superseded && (
            <span style={{ fontSize: 10, color: colors.muted, fontStyle: "italic" }}>changed since</span>
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
