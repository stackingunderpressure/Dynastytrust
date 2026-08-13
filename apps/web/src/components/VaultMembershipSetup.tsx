import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTapitCircleMembers } from '../lib/tapit-circle-members';
import {
  leafScriptsForRole,
  sendVaultMembershipRequestOverNostr,
  type VaultMembershipRole,
} from '../lib/circle-membership-delivery';
import { getNostrRelays } from '../lib/nostrRelayPrefs';
import { NostrTransport } from '@dynastytrust/nostr-transport';
import { subscribeVaultMembershipAcks } from '../lib/vault-membership-ack-channel';
import { api, type VaultMembershipGrant } from '../lib/api';
import { colors, radii, space } from '../theme';
import { Button } from './ui';
import { useToast } from './toast';
import { NostrRelaySettings } from './NostrRelaySettings';

/**
 * VaultMembershipSetup -- Cut C3's owner-facing action. A Tapit circle
 * member's wallet refuses to sign anything for this vault (or, once the
 * phrase gate wires all the way through, even to be trusted as a
 * watchtower for it) until it holds a self-signed vault-membership
 * attestation naming this vault's descriptor, this member's role, and the
 * exact tapscript leaf bytes their key appears in. This card sends that
 * request. DynastyTrust never signs it -- the member's own wallet reviews
 * the claim and mints + signs it itself (see circle-membership-delivery.ts's
 * header for why).
 *
 * 2026-08-11 fix: this used to only ever look at founder_keys and always
 * send role: 'founder' -- a Tapit key sitting in any other role (heir,
 * protector, backup, consent) silently got no way to request membership
 * at all. Tapit's own receiving side (vaultTrail.ts) never restricted
 * role to a fixed set in the first place, so the restriction was purely
 * an artifact of this component's own construction, not anything the
 * protocol needed. Now scans all five of a vault's key arrays and sends
 * each Tapit-origin key found the correct role for whichever array it's
 * actually in.
 *
 * 2026-08-11 follow-up ("return roster", operator: "we need to make
 * these answers persist and then we know that we've already granted
 * membership... a return roster of it or something that tells it
 * they've accepted... a verified member that's signed it"): sends used
 * to live only in this component's own useState, gone the moment the
 * page reloaded -- indistinguishable from never having sent anything.
 * Every send now persists a vault_membership_grants row
 * (033_vault_membership_grants.sql) via api.vaultMembershipGrants, and
 * this component keeps a live Nostr subscription open for the life of
 * the mount, listening on every still-'sent' grant's ack-channel reply
 * pubkey (vault-membership-ack-channel.ts) for the member's wallet to
 * publish back accepted/declined (vaultMembershipAckChannel.ts, Tapit
 * repo) -- turning "I clicked send" into a real, durable, two-way
 * confirmed roster.
 */
const ROLE_LABELS: Record<VaultMembershipRole, string> = {
  founder: 'Founder',
  heir: 'Heir',
  protector: 'Protector',
  backup: 'Backup',
  consent: 'Consent',
  second_heir: 'Second heir',
};

const STATUS_LABEL: Record<VaultMembershipGrant['status'], string> = {
  sent: 'Sent -- awaiting response',
  accepted: 'Accepted',
  declined: 'Declined',
};

const STATUS_COLOR: Record<VaultMembershipGrant['status'], string> = {
  sent: colors.gold,
  accepted: colors.green,
  declined: colors.red,
};

interface RoleMember {
  key: import('../lib/keystore').LocalKey;
  role: VaultMembershipRole;
}

export function VaultMembershipSetup({
  vaultId,
  vaultDescriptor,
  vaultName,
  founderKeys,
  heirKeys,
  protectorKeys,
  backupKeys,
  consentKeys,
  secondHeirKeys,
  leafScripts,
}: {
  vaultId: string;
  vaultDescriptor: string | null;
  vaultName: string;
  founderKeys: string[];
  heirKeys: string[];
  protectorKeys: string[];
  backupKeys: string[];
  consentKeys: string[];
  secondHeirKeys: string[];
  leafScripts: Record<string, string> | null;
}) {
  const toast = useToast();
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [grants, setGrants] = useState<VaultMembershipGrant[]>([]);
  const grantsRef = useRef<VaultMembershipGrant[]>([]);
  grantsRef.current = grants;

  // Load the persisted roster on mount / whenever the vault changes.
  useEffect(() => {
    let alive = true;
    void api.vaultMembershipGrants.list(vaultId).then(res => {
      if (alive) setGrants(res.grants);
    }).catch(() => {
      // Non-fatal -- the per-member Grant/Resend buttons still work with
      // an empty roster, just without persisted status showing yet.
    });
    return () => {
      alive = false;
    };
  }, [vaultId]);

  // Live ack listener: one long-lived NostrTransport for the life of this
  // mount, re-subscribed whenever the set of still-'sent' reply pubkeys
  // changes (a new grant added, or one just answered and dropped off the
  // list). No `since` cutoff, so an ack that arrived while this page was
  // closed still gets caught on the next mount -- same resilience pattern
  // vaultMembershipChannel.ts uses on the Tapit side.
  const pendingReplyKeys = grants.filter(g => g.status === 'sent').map(g => g.reply_privkey);
  const pendingKeysSignature = pendingReplyKeys.slice().sort().join(',');
  useEffect(() => {
    if (pendingReplyKeys.length === 0) return;
    const transport = new NostrTransport({ relays: getNostrRelays() });
    const sub = subscribeVaultMembershipAcks(transport, pendingReplyKeys, ack => {
      const grant = grantsRef.current.find(g => g.reply_pubkey === ack.replyPubkey);
      if (!grant || grant.status !== 'sent') return;
      void api.vaultMembershipGrants.updateStatus(grant.id, ack.decision).then(res => {
        setGrants(prev => prev.map(g => (g.id === res.grant.id ? res.grant : g)));
        toast[ack.decision === 'accepted' ? 'success' : 'error'](
          `${grant.recipient_label} ${ack.decision} the ${ROLE_LABELS[grant.role as VaultMembershipRole] ?? grant.role} membership for ${vaultName}`,
        );
      });
    });
    return () => {
      sub.close();
      transport.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKeysSignature]);

  const { circleMembers, barePubkeys } = getTapitCircleMembers(founderKeys);

  if (circleMembers.length === 0) {
    // This card used to just disappear here -- which is indistinguishable
    // from "nothing to see" whether the vault genuinely has no Tapit
    // circle member OR it does and this browser's Key Manager just
    // doesn't hold a matching local key for it (a different device, a
    // cleared keystore, a key that was later archived). Say which one is
    // actually true instead of going silent either way.
    if (barePubkeys.length === 0) return null;
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          padding: space[5],
          marginBottom: space[4],
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
          Circle membership
        </div>
        <p style={{ fontSize: 12, color: colors.sub, margin: 0 }}>
          This vault has {barePubkeys.length} founder key{barePubkeys.length === 1 ? '' : 's'} that
          look like they came from Tapit (no extended public key attached), but none of them match a
          Tapit-origin key in this browser's Key Manager right now. If you added that key on a different
          device or browser, add it here too before you can send membership to that person --{' '}
          <Link to="/keys" style={{ color: colors.gold }}>open Key Manager</Link>.
        </p>
      </div>
    );
  }

  const roleArrays: [VaultMembershipRole, string[]][] = [
    ['founder', founderKeys],
    ['heir', heirKeys],
    ['protector', protectorKeys],
    ['backup', backupKeys],
    ['consent', consentKeys],
    ['second_heir', secondHeirKeys],
  ];

  // Any bare (Tapit-shaped) pubkey across every role, whether or not a
  // matching local key was found for it -- feeds the "circle exists but
  // this browser doesn't hold a matching key" message below.
  let anyBarePubkeys = 0;
  const members: RoleMember[] = [];
  const seenKeyIds = new Set<string>();
  for (const [role, keys] of roleArrays) {
    const { circleMembers: cm, barePubkeys: bp } = getTapitCircleMembers(keys);
    anyBarePubkeys += bp.length;
    for (const key of cm) {
      if (seenKeyIds.has(key.keyId)) continue; // same local key named in >1 array
      seenKeyIds.add(key.keyId);
      members.push({ key, role });
    }
  }

  if (members.length === 0) {
    if (anyBarePubkeys === 0) return null;
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          padding: space[5],
          marginBottom: space[4],
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
          Circle membership
        </div>
        <p style={{ fontSize: 12, color: colors.sub, margin: 0 }}>
          This vault has {anyBarePubkeys} key{anyBarePubkeys === 1 ? '' : 's'} that
          look like they came from Tapit, but none of them match a Tapit-origin key in this
          browser's Key Manager right now --{' '}
          <Link to="/keys" style={{ color: colors.gold }}>open Key Manager</Link>.
        </p>
      </div>
    );
  }

  const ready = vaultDescriptor !== null && leafScripts !== null;

  async function grant(keyId: string, role: VaultMembershipRole, xOnlyPubkey: string, label: string, persona: string) {
    if (!ready || !vaultDescriptor) return;
    const roleLeaves = leafScriptsForRole(leafScripts, role);
    if (roleLeaves.length === 0) {
      toast.error(`No leaf scripts on file for the ${ROLE_LABELS[role].toLowerCase()} role -- recompile to refresh them.`);
      return;
    }
    setBusyKeyId(keyId);
    try {
      const result = await sendVaultMembershipRequestOverNostr({
        vaultDescriptor,
        vaultName,
        role,
        leafScripts: roleLeaves,
        recipientXOnlyPubkey: xOnlyPubkey,
        relays: getNostrRelays(),
      });
      const saved = await api.vaultMembershipGrants.create({
        vault_id: vaultId,
        role,
        key_id: keyId,
        recipient_label: label,
        recipient_persona: persona,
        recipient_pubkey: xOnlyPubkey,
        request_event_id: result.eventId,
        reply_pubkey: result.replyPublicKey,
        reply_privkey: result.replyPrivateKey,
      });
      setGrants(prev => [...prev.filter(g => g.id !== saved.grant.id), saved.grant]);
      toast.success(
        result.delivered
          ? `Membership request sent to ${label}`
          : `Queued for ${label} -- no relay confirmed yet, will keep retrying`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        padding: space[5],
        marginBottom: space[4],
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
        Circle membership
      </div>
      <p style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
        Each circle member's Tapit wallet needs to hold a membership record for this vault before
        it will recognize a spend request as real. Send it once per member -- their wallet reviews
        it and holds its own copy, then sends back a confirmation you'll see appear below.
      </p>

      {!ready && vaultDescriptor !== null && (
        <p style={{ fontSize: 12, color: colors.gold, marginBottom: 10 }}>
          No leaf scripts on file for this vault yet -- recompile to refresh them before sending.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {members.map(({ key: k, role }) => {
          const g = grants.find(x => x.role === role && x.key_id === k.keyId) ?? null;
          return (
            <div key={k.keyId} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
                  {k.label}{' '}
                  <span style={{ color: colors.muted }}>
                    ({k.persona}, {ROLE_LABELS[role]})
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ fontSize: 12, flexShrink: 0 }}
                  disabled={!ready || busyKeyId === k.keyId}
                  onClick={() => void grant(k.keyId, role, k.tapitXOnlyPubkey!, k.label, k.persona)}
                >
                  {busyKeyId === k.keyId
                    ? 'Sending…'
                    : g
                      ? g.status === 'sent'
                        ? 'Sent -- resend?'
                        : `Resend (${STATUS_LABEL[g.status]})`
                      : 'Grant membership'}
                </Button>
              </div>
              {g && (
                <div style={{ fontSize: 11, color: STATUS_COLOR[g.status], paddingLeft: 2 }}>
                  {STATUS_LABEL[g.status]}
                  {g.responded_at ? ` -- ${new Date(g.responded_at).toLocaleString()}` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <NostrRelaySettings />
    </div>
  );
}
