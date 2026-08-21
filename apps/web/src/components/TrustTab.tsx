/**
 * TrustTab.tsx -- Governance attestations for a vault.
 *
 * Three panels:
 *   - Trust doc attestation: every member Schnorr-signs the hash
 *     of the current trust_doc JSON. An attorney-reviewable audit
 *     trail of who agreed to what.
 *   - Proof of life: founders sign a timestamped nonce
 *     periodically. Heirs see "last heard from: X days ago".
 *   - Death declaration: witnesses sign the same target_hash to
 *     declare a subject deceased. Governance signal only -- the
 *     on-chain CLTV is immutable, but this informs rotation +
 *     inheritance preparation and is included in the audit PDF.
 *
 * Signing reuses the member's Bitcoin key (same /0/0 child used
 * for PSBT sigs) under a domain-separated tag (see lib/attest.ts),
 * so attestations cannot be replayed against a Bitcoin sighash.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Vault,
  VaultMember,
  VaultAttestation,
  AttestationType,
} from '../lib/api';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { listKeys, revealMnemonic } from '../lib/keystore';
import {
  signAttestation,
  trustDocHash,
  proofOfLifeHash,
  deathDeclarationHash,
  descriptorAttestationHash,
  verifyAttestation,
} from '../lib/attest';
import { useToast } from './toast';
import { usePrompt } from './dialog';
import { useRealtimeRefresh } from '../lib/realtime';
import { colors, fonts } from '../theme';
import { Button, Input, Label, Textarea } from './ui';

function shortHash(h: string): string {
  return h.slice(0, 12) + '...' + h.slice(-8);
}

// Build the password callback signWithLocalKey expects from a prompt dialog.
function buildPasswordRequester(
  ask: (opts: {
    title: string;
    message: string;
    password: boolean;
    confirmLabel: string;
  }) => Promise<string | null>,
) {
  return (label: string) =>
    ask({
      title: 'Unlock key',
      message: `Enter the password for "${label}" to sign.`,
      password: true,
      confirmLabel: 'Sign',
    });
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.round(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.round(months / 12) + 'y ago';
}

function attestNetwork(n: Vault['network']): 'testnet' | 'signet' | 'mainnet' {
  if (n === 'bitcoin') return 'mainnet';
  if (n === 'signet') return 'signet';
  return 'testnet';
}

export function TrustTab({ vault }: { vault: Vault }) {
  const toast = useToast();
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [attestations, setAttestations] = useState<VaultAttestation[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [m, a, { data }] = await Promise.all([
        api.members.list(vault.id),
        api.attestations.list(vault.id),
        supabase.auth.getSession(),
      ]);
      setMembers(m.members);
      setAttestations(a.attestations);
      setUserId(data.session?.user?.id ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [vault.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeRefresh(
    { table: 'vault_attestations', filter: `vault_id=eq.${vault.id}` },
    load,
  );

  const me = useMemo(
    () => members.find(m => m.user_id === userId) ?? null,
    [members, userId],
  );

  if (loading) {
    return <p style={{ color: colors.muted, fontSize: 13 }}>Loading trust activity...</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        style={{
          fontSize: 13,
          color: colors.muted,
          lineHeight: 1.55,
          padding: 12,
          background: colors.input,
          borderRadius: 10,
          border: `1px solid ${colors.border}`,
        }}
      >
        <strong style={{ color: colors.gold }}>Trust governance layer.</strong>{' '}
        Bitcoin enforces the script. This layer gives you the court-admissible
        paper trail: members sign the vault descriptor and trust doc hashes,
        founders post proof-of-life, witnesses sign death declarations. All
        signatures use the same Bitcoin key that moves the coins, under a
        domain-separated tag so an attestation cannot be replayed as a
        transaction signature.
      </div>

      <DescriptorPanel
        vault={vault}
        me={me}
        members={members}
        attestations={attestations}
        onDone={load}
      />
      <TrustDocPanel
        vault={vault}
        me={me}
        members={members}
        attestations={attestations}
        onDone={load}
      />
      <ProofOfLifePanel
        vault={vault}
        me={me}
        members={members}
        attestations={attestations}
        onDone={load}
      />
      <DeathDeclarationPanel
        vault={vault}
        me={me}
        members={members}
        attestations={attestations}
        onDone={load}
      />
    </div>
  );
}

function PanelShell({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 12,
        padding: '16px 18px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: accent,
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

async function signWithLocalKey(opts: {
  pubkey: string | null | undefined;
  attestationType: AttestationType;
  targetHash: string;
  network: Vault['network'];
  // Supplied by the calling component so the password is collected through a
  // styled dialog rather than the native window.prompt.
  requestPassword: (label: string) => Promise<string | null>;
}): Promise<{ signature: string; pubkey: string }> {
  if (!opts.pubkey) throw new Error('You have no pubkey on this vault yet');
  const keys = listKeys();
  const match = keys.find(
    k => k.status === 'active' && k.pubkey === opts.pubkey,
  );
  if (!match) {
    throw new Error(
      "No local key matches your vault pubkey. Import the mnemonic on this device.",
    );
  }
  const pw = match.testMnemonic
    ? undefined
    : (await opts.requestPassword(match.label)) ?? undefined;
  if (!match.testMnemonic && !pw) throw new Error('Password required');
  const mnemonic = await revealMnemonic(match.keyId, pw);
  const res = signAttestation({
    mnemonic,
    derivationPath: match.derivationPath,
    network: attestNetwork(opts.network),
    attestationType: opts.attestationType,
    targetHash: opts.targetHash,
  });
  return res;
}

function MemberAttestList({
  attestations,
  members,
  emptyLabel,
}: {
  attestations: VaultAttestation[];
  members: VaultMember[];
  emptyLabel: string;
}) {
  if (attestations.length === 0) {
    return <p style={{ color: colors.muted, fontSize: 12, margin: 0 }}>{emptyLabel}</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {attestations.map(a => {
        const member = members.find(m => m.user_id === a.user_id);
        // A valid signature alone only proves SOME key signed this --
        // it must also be the member's own registered vault key
        // (attest.ts signs with the same /0/0 child as PSBT signing
        // precisely so this can be checked), or the "signed" checkmark
        // doesn't actually prove the real, known member attested.
        const ok =
          !!member?.pubkey &&
          a.pubkey.toLowerCase() === member.pubkey.toLowerCase() &&
          verifyAttestation({
            attestationType: a.attestation_type,
            targetHash: a.target_hash,
            signature: a.signature,
            pubkey: a.pubkey,
          });
        return (
          <div
            key={a.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 10,
              fontSize: 12,
              color: colors.text,
              padding: '4px 0',
            }}
          >
            <span>
              {member?.label || '(unknown member)'}{' '}
              <span style={{ color: colors.muted, fontFamily: fonts.mono, fontSize: 11 }}>
                {a.pubkey.slice(0, 10)}...
              </span>
            </span>
            <span style={{ color: ok ? colors.green : colors.red, fontSize: 11 }}>
              {ok ? '[valid]' : '[bad sig]'} · {relativeTime(a.signed_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// A set of superseded attestations can span multiple distinct past
// versions (the trust doc or descriptor may have changed more than
// once). Lumping every stale signature into one flat list would hide
// which people signed the SAME past version vs different ones --
// group by target_hash, newest group first, so each group is one
// verifiable, independently-hashed document with its own signer list.
function PastVersionsList({
  attestations,
  members,
}: {
  attestations: VaultAttestation[];
  members: VaultMember[];
}) {
  const byHash = new Map<string, VaultAttestation[]>();
  for (const a of attestations) {
    const arr = byHash.get(a.target_hash) ?? [];
    arr.push(a);
    byHash.set(a.target_hash, arr);
  }
  const groups = Array.from(byHash.entries()).sort(
    ([, a], [, b]) =>
      Math.max(...b.map(x => Date.parse(x.signed_at))) -
      Math.max(...a.map(x => Date.parse(x.signed_at))),
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groups.map(([hash, sigs]) => (
        <div
          key={hash}
          style={{ background: colors.input, borderRadius: 8, padding: '8px 10px' }}
        >
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.muted,
              marginBottom: 6,
              wordBreak: 'break-all',
            }}
          >
            {shortHash(hash)}
          </div>
          <MemberAttestList attestations={sigs} members={members} emptyLabel="" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------
// DescriptorPanel -- members attest to the vault's compiled
// descriptor + address. Protects against a server-side address
// swap: changing either invalidates every prior signature and the
// panel surfaces that immediately ("0 of N attested to the current
// descriptor").
// ---------------------------------------------------------------

function DescriptorPanel({
  vault,
  me,
  members,
  attestations,
  onDone,
}: {
  vault: Vault;
  me: VaultMember | null;
  members: VaultMember[];
  attestations: VaultAttestation[];
  onDone: () => void;
}) {
  const toast = useToast();
  const reqPw = buildPasswordRequester(usePrompt());
  const [busy, setBusy] = useState(false);

  const hasDescriptor = !!vault.descriptor && !!vault.address;
  const currentHash = useMemo(() => {
    if (!hasDescriptor) return '';
    return descriptorAttestationHash(vault.descriptor!, vault.address!);
  }, [vault.descriptor, vault.address, hasDescriptor]);

  const sigsForCurrent = attestations.filter(
    a => a.attestation_type === 'descriptor' && a.target_hash === currentHash,
  );
  const totalMembers = members.filter(m => m.status !== 'removed').length;
  const iHaveSigned = !!me && sigsForCurrent.some(a => a.user_id === me.user_id);

  // Any stale descriptor attestations (type=descriptor but target_hash
  // doesn't match the current digest) indicate either a past version
  // of the descriptor or -- alarmingly -- that the current address has
  // been altered since members last attested.
  const allDescriptorSigs = attestations.filter(a => a.attestation_type === 'descriptor');
  const staleCount = allDescriptorSigs.length - sigsForCurrent.length;

  async function attest() {
    if (!me || !hasDescriptor) return;
    setBusy(true);
    try {
      const { signature, pubkey } = await signWithLocalKey({
        pubkey: me.pubkey,
        attestationType: 'descriptor',
        targetHash: currentHash,
        network: vault.network,
        requestPassword: reqPw,
      });
      await api.attestations.create({
        vault_id: vault.id,
        attestation_type: 'descriptor',
        target_hash: currentHash,
        target_data: { descriptor: vault.descriptor, address: vault.address },
        signature,
        pubkey,
      });
      toast.success('Descriptor attested');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to attest');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell title="Descriptor attestation" accent={colors.blue}>
      <div style={{ fontSize: 13, color: colors.text, marginBottom: 10, lineHeight: 1.5 }}>
        Members sign the hash of the vault's compiled descriptor plus its
        receive address. This binds the members' keys to the exact on-chain
        output -- an attacker who swaps the address in our database cannot
        forge a matching signature, and the counter drops to "0 of N" so you
        know before funding.
      </div>
      {!hasDescriptor ? (
        <div style={{ fontSize: 12, color: colors.muted, fontStyle: 'italic' }}>
          Vault has not been compiled yet. Compile first, then members attest.
        </div>
      ) : (
        <>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.muted,
              marginBottom: 12,
              wordBreak: 'break-all',
            }}
          >
            Descriptor + address hash: {shortHash(currentHash)}
          </div>
          <div
            style={{
              fontSize: 12,
              color: colors.sub,
              marginBottom: 8,
              fontWeight: 600,
            }}
          >
            Attested: {sigsForCurrent.length} / {totalMembers} members
            {staleCount > 0 && (
              <span style={{ color: colors.orange, marginLeft: 8 }}>
                ({staleCount} stale from prior descriptor -- if you did not
                rotate the vault, this is a signal the address changed under
                members and needs verification before spending)
              </span>
            )}
          </div>
          <MemberAttestList
            attestations={sigsForCurrent}
            members={members}
            emptyLabel="No members have attested to this descriptor yet."
          />
          {staleCount > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>
                Past versions ({staleCount})
              </summary>
              <div style={{ marginTop: 8 }}>
                <PastVersionsList
                  attestations={allDescriptorSigs.filter(a => a.target_hash !== currentHash)}
                  members={members}
                />
              </div>
            </details>
          )}
          {me && !iHaveSigned && (
            <div style={{ marginTop: 12 }}>
              <Button size="sm" onClick={attest} disabled={busy}>
                {busy ? 'Signing...' : 'Sign this descriptor'}
              </Button>
            </div>
          )}
          {iHaveSigned && (
            <div style={{ marginTop: 10, fontSize: 12, color: colors.green }}>
              You attested this descriptor.
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
}

function TrustDocPanel({
  vault,
  me,
  members,
  attestations,
  onDone,
}: {
  vault: Vault;
  me: VaultMember | null;
  members: VaultMember[];
  attestations: VaultAttestation[];
  onDone: () => void;
}) {
  const toast = useToast();
  const reqPw = buildPasswordRequester(usePrompt());
  const [busy, setBusy] = useState(false);

  const currentHash = useMemo(() => trustDocHash(vault.trust_doc ?? {}), [vault.trust_doc]);
  const allTrustDocSigs = attestations.filter(a => a.attestation_type === 'trust_doc');
  const sigsForCurrent = allTrustDocSigs.filter(a => a.target_hash === currentHash);
  const staleSigs = allTrustDocSigs.filter(a => a.target_hash !== currentHash);
  const totalMembers = members.filter(m => m.status !== 'removed').length;
  const iHaveSigned = !!me && sigsForCurrent.some(a => a.user_id === me.user_id);

  async function attest() {
    if (!me) return;
    setBusy(true);
    try {
      const { signature, pubkey } = await signWithLocalKey({
        pubkey: me.pubkey,
        attestationType: 'trust_doc',
        targetHash: currentHash,
        network: vault.network,
        requestPassword: reqPw,
      });
      await api.attestations.create({
        vault_id: vault.id,
        attestation_type: 'trust_doc',
        target_hash: currentHash,
        target_data: { trust_doc_snapshot: vault.trust_doc ?? {} },
        signature,
        pubkey,
      });
      toast.success('Trust doc attested');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to attest');
    } finally {
      setBusy(false);
    }
  }

  const empty = !vault.trust_doc || Object.keys(vault.trust_doc).length === 0;

  return (
    <PanelShell title="Trust doc attestation" accent={colors.gold}>
      <div style={{ fontSize: 13, color: colors.text, marginBottom: 10, lineHeight: 1.5 }}>
        Each member signs the hash of the current trust doc to confirm they
        have read and agreed to the terms. If the doc changes, everyone
        re-attests to the new version.
      </div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.muted,
          marginBottom: 12,
        }}
      >
        Doc hash: {empty ? '(empty doc)' : shortHash(currentHash)}
      </div>
      <div
        style={{
          fontSize: 12,
          color: colors.sub,
          marginBottom: 8,
          fontWeight: 600,
        }}
      >
        Attested: {sigsForCurrent.length} / {totalMembers} members
      </div>
      <MemberAttestList
        attestations={sigsForCurrent}
        members={members}
        emptyLabel="No members have attested to this version yet."
      />
      {staleSigs.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>
            Past versions ({staleSigs.length})
          </summary>
          <div style={{ marginTop: 8 }}>
            <PastVersionsList attestations={staleSigs} members={members} />
          </div>
        </details>
      )}
      {me && !iHaveSigned && !empty && (
        <div style={{ marginTop: 12 }}>
          <Button size="sm" onClick={attest} disabled={busy}>
            {busy ? 'Signing...' : 'Sign this trust doc'}
          </Button>
        </div>
      )}
      {iHaveSigned && (
        <div style={{ marginTop: 10, fontSize: 12, color: colors.green }}>
          You signed this version.
        </div>
      )}
    </PanelShell>
  );
}

function ProofOfLifePanel({
  vault,
  me,
  members,
  attestations,
  onDone,
}: {
  vault: Vault;
  me: VaultMember | null;
  members: VaultMember[];
  attestations: VaultAttestation[];
  onDone: () => void;
}) {
  const toast = useToast();
  const reqPw = buildPasswordRequester(usePrompt());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const founders = members.filter(
    m => (m.role === 'owner' || m.role === 'founder') && m.status !== 'removed',
  );
  const iAmFounder = !!me && (me.role === 'owner' || me.role === 'founder');

  const polSigs = attestations
    .filter(a => a.attestation_type === 'proof_of_life')
    .sort((a, b) => b.signed_at.localeCompare(a.signed_at));

  // Latest check-in per founder.
  const latestByFounder = new Map<string, VaultAttestation>();
  for (const a of polSigs) {
    if (!latestByFounder.has(a.user_id)) latestByFounder.set(a.user_id, a);
  }

  async function checkIn() {
    if (!me) return;
    setBusy(true);
    try {
      const signedAt = new Date().toISOString();
      const hash = proofOfLifeHash(vault.id, signedAt, note);
      const { signature, pubkey } = await signWithLocalKey({
        pubkey: me.pubkey,
        attestationType: 'proof_of_life',
        targetHash: hash,
        network: vault.network,
        requestPassword: reqPw,
      });
      await api.attestations.create({
        vault_id: vault.id,
        attestation_type: 'proof_of_life',
        target_hash: hash,
        target_data: { signed_at: signedAt, note },
        signature,
        pubkey,
      });
      toast.success('Check-in recorded');
      setNote('');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to check in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelShell title="Proof of life" accent={colors.green}>
      <div style={{ fontSize: 13, color: colors.text, marginBottom: 12, lineHeight: 1.5 }}>
        Founders sign a fresh timestamp periodically. Heirs and beneficiaries
        see "last heard from" so silent drift doesn't get mistaken for
        ordinary quiet periods.
      </div>

      {founders.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 12 }}>No founders yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {founders.map(f => {
            const latest = latestByFounder.get(f.user_id);
            return (
              <div
                key={f.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  color: colors.text,
                  padding: '4px 0',
                  borderBottom: `1px dashed ${colors.border}`,
                }}
              >
                <span>{f.label || '(unlabeled founder)'}</span>
                <span style={{ color: latest ? colors.green : colors.orange }}>
                  {latest ? 'last heard from ' + relativeTime(latest.signed_at) : 'no check-in yet'}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {iAmFounder && me && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Label>Optional note</Label>
            <Input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="'All good, annual check-in'"
            />
          </div>
          <Button onClick={checkIn} disabled={busy}>
            {busy ? 'Signing...' : "I'm alive"}
          </Button>
        </div>
      )}

      {polSigs.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>
            Full check-in history ({polSigs.length})
          </summary>
          <div style={{ marginTop: 8 }}>
            <MemberAttestList
              attestations={polSigs}
              members={members}
              emptyLabel=""
            />
          </div>
        </details>
      )}
    </PanelShell>
  );
}

function DeathDeclarationPanel({
  vault,
  me,
  members,
  attestations,
  onDone,
}: {
  vault: Vault;
  me: VaultMember | null;
  members: VaultMember[];
  attestations: VaultAttestation[];
  onDone: () => void;
}) {
  const toast = useToast();
  const reqPw = buildPasswordRequester(usePrompt());
  const [subject, setSubject] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // A "declaration" = unique target_hash. Group sigs by hash to show
  // "N witnesses have signed this declaration".
  const sigs = attestations.filter(a => a.attestation_type === 'death_declaration');
  const byHash = new Map<string, VaultAttestation[]>();
  for (const a of sigs) {
    const arr = byHash.get(a.target_hash) ?? [];
    arr.push(a);
    byHash.set(a.target_hash, arr);
  }

  async function declare() {
    if (!me) return;
    if (!subject) { toast.error('Select a subject'); return; }
    setBusy(true);
    try {
      const hash = deathDeclarationHash(vault.id, subject, effectiveDate);
      const { signature, pubkey } = await signWithLocalKey({
        pubkey: me.pubkey,
        attestationType: 'death_declaration',
        targetHash: hash,
        network: vault.network,
        requestPassword: reqPw,
      });
      await api.attestations.create({
        vault_id: vault.id,
        attestation_type: 'death_declaration',
        target_hash: hash,
        target_data: { subject_user_id: subject, effective_date: effectiveDate, notes },
        signature,
        pubkey,
      });
      toast.success('Declaration signed');
      setNotes('');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function cosign(firstSig: VaultAttestation) {
    if (!me) return;
    setBusy(true);
    try {
      const { signature, pubkey } = await signWithLocalKey({
        pubkey: me.pubkey,
        attestationType: 'death_declaration',
        targetHash: firstSig.target_hash,
        network: vault.network,
        requestPassword: reqPw,
      });
      await api.attestations.create({
        vault_id: vault.id,
        attestation_type: 'death_declaration',
        target_hash: firstSig.target_hash,
        target_data: firstSig.target_data,
        signature,
        pubkey,
      });
      toast.success('Co-signed declaration');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const selectStyle = {
    width: '100%',
    padding: '11px 13px',
    background: colors.input,
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.sans,
    boxSizing: 'border-box' as const,
  };

  return (
    <PanelShell title="Death declaration" accent={colors.red}>
      <div style={{ fontSize: 13, color: colors.text, marginBottom: 12, lineHeight: 1.5 }}>
        A governance signal only. Bitcoin timelocks are immutable -- this does
        not unlock the inheritance path on-chain. It records a witnessed
        declaration in the audit trail so trustees can prepare for rotation
        when the on-chain timelock elapses.
      </div>

      {byHash.size > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {Array.from(byHash.entries()).map(([hash, hashSigs]) => {
            const first = hashSigs[0];
            const subjectId = (first.target_data as { subject_user_id?: string })?.subject_user_id;
            const subjectMember = members.find(m => m.user_id === subjectId);
            const iSigned = !!me && hashSigs.some(a => a.user_id === me.user_id);
            return (
              <div
                key={hash}
                style={{
                  background: colors.input,
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                  {subjectMember?.label || '(unknown subject)'} -- {hashSigs.length} signature
                  {hashSigs.length === 1 ? '' : 's'}
                </div>
                <div style={{ fontSize: 11, color: colors.muted, marginTop: 2, fontFamily: fonts.mono }}>
                  {shortHash(hash)}
                </div>
                <div style={{ marginTop: 6 }}>
                  <MemberAttestList
                    attestations={hashSigs}
                    members={members}
                    emptyLabel=""
                  />
                </div>
                {me && !iSigned && (
                  <div style={{ marginTop: 8 }}>
                    <Button size="sm" onClick={() => cosign(first)} disabled={busy}>
                      Co-sign this declaration
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
          No declarations filed.
        </p>
      )}

      {me && (
        <details>
          <summary style={{ fontSize: 12, color: colors.muted, cursor: 'pointer' }}>
            File a new declaration
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div>
              <Label>Subject</Label>
              <select
                value={subject}
                onChange={e => setSubject(e.target.value)}
                style={selectStyle}
              >
                <option value="">-- Select a member --</option>
                {members
                  .filter(m => m.status !== 'removed' && m.user_id)
                  .map(m => (
                    <option key={m.id} value={m.user_id || ''}>
                      {m.label || '(unlabeled)'} -- {m.role}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <Label>Effective date</Label>
              <Input
                type="date"
                value={effectiveDate}
                onChange={e => setEffectiveDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Supporting notes</Label>
              <Textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Link to death certificate, coroner's report, etc."
              />
            </div>
            <div>
              <Button onClick={declare} disabled={busy || !subject}>
                {busy ? 'Signing...' : 'Sign declaration'}
              </Button>
            </div>
          </div>
        </details>
      )}
    </PanelShell>
  );
}

