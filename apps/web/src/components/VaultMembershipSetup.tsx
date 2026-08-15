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
  left: 'Left the vault',
};

// Longer disclosure shown under the button, not in it -- 'left' needs the
// extra sentence (2026-08-15: their key stays a valid on-chain signer
// until this vault is actually recompiled without them) but that's too
// long for the Resend button's own label.
const STATUS_DETAIL: Partial<Record<VaultMembershipGrant['status'], string>> = {
  left: ' -- key still valid on-chain until this vault is recompiled',
};

const STATUS_COLOR: Record<VaultMembershipGrant['status'], string> = {
  sent: colors.gold,
  accepted: colors.green,
  declined: colors.red,
  left: colors.gold,
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
      // 'left' answers an 'accepted' grant, not a 'sent' one -- the
      // pending-reply-key subscription above only covers still-'sent'
      // grants, so a 'left' ack for THIS grant won't arrive on this
      // subscription; it's handled by the separate listener below.
      if (!grant || grant.status !== 'sent' || ack.decision === 'left') return;
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

  // Second listener, scoped to already-'accepted' grants: the only ack a
  // member's wallet can still publish after accepting is 'left' (2026-08-15,
  // the leave-vault soft disconnect) -- there's nothing else left to answer.
  // Kept separate from the 'sent'-scoped listener above rather than merged,
  // since the two watch disjoint reply-key sets that change independently.
  const acceptedReplyKeys = grants.filter(g => g.status === 'accepted').map(g => g.reply_privkey);
  const acceptedKeysSignature = acceptedReplyKeys.slice().sort().join(',');
  useEffect(() => {
    if (acceptedReplyKeys.length === 0) return;
    const transport = new NostrTransport({ relays: getNostrRelays() });
    const sub = subscribeVaultMembershipAcks(transport, acceptedReplyKeys, ack => {
      if (ack.decision !== 'left') return;
      const grant = grantsRef.current.find(g => g.reply_pubkey === ack.replyPubkey);
      if (!grant || grant.status !== 'accepted') return;
      void api.vaultMembershipGrants.updateStatus(grant.id, 'left').then(res => {
        setGrants(prev => prev.map(g => (g.id === res.grant.id ? res.grant : g)));
        toast.info(
          `${grant.recipient_label} left the ${ROLE_LABELS[grant.role as VaultMembershipRole] ?? grant.role} membership for ${vaultName} -- their key is still valid on-chain until this vault is recompiled.`,
        );
      });
    });
    return () => {
      sub.close();
      transport.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedKeysSignature]);

  const { circleMembers, barePubkeys } = getTapitCircleMembers(founderKeys);

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

  // "Make sure there's no branch work left over somewhere" -- a grant
  // this app once sent and the member's wallet accepted (or later left),
  // for a (role, key_id) pair that no longer shows up in the vault's
  // CURRENT role arrays. That happens when the vault was recompiled with
  // a different key set, or the member's key changed, after the grant
  // was answered -- the grant row just sits there, invisible, since the
  // per-key rows below only render for keys presently in a role. Only
  // detectable for keys this browser's Key Manager still holds locally
  // (same tolerance the "no matching key" messages above already carry --
  // this app never learns a key it has no local record of).
  const orphanedGrants = grants.filter(
    g => (g.status === 'accepted' || g.status === 'left')
      && !members.some(m => m.role === g.role && m.key.keyId === g.key_id),
  );
  const orphanedGrantsPanel = orphanedGrants.length > 0 && (
    <div
      style={{
        background: `${colors.gold}0d`,
        border: `1px solid ${colors.gold}44`,
        borderRadius: radii.md,
        padding: '12px 14px',
        marginTop: 10,
        fontSize: 12,
        color: colors.sub,
      }}
    >
      <div style={{ fontWeight: 600, color: colors.gold, marginBottom: 4 }}>
        {orphanedGrants.length} membership grant{orphanedGrants.length === 1 ? '' : 's'} out of sync
      </div>
      <div>
        {orphanedGrants.map(g => g.recipient_label).join(', ')} {orphanedGrants.length === 1 ? 'was' : 'were'} granted
        the {orphanedGrants.map(g => ROLE_LABELS[g.role as VaultMembershipRole] ?? g.role).join(', ')} role, but that
        key no longer appears there -- the vault was likely recompiled with a different key set since. Recheck whether
        {orphanedGrants.length === 1 ? ' this person' : ' these people'} should still hold that role.
      </div>
    </div>
  );

  if (circleMembers.length === 0) {
    // This card used to just disappear here -- which is indistinguishable
    // from "nothing to see" whether the vault genuinely has no Tapit
    // circle member OR it does and this browser's Key Manager just
    // doesn't hold a matching local key for it (a different device, a
    // cleared keystore, a key that was later archived). Say which one is
    // actually true instead of going silent either way.
    if (barePubkeys.length === 0 && !orphanedGrantsPanel) return null;
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
        {barePubkeys.length > 0 && (
          <p style={{ fontSize: 12, color: colors.sub, margin: 0 }}>
            This vault has {barePubkeys.length} founder key{barePubkeys.length === 1 ? '' : 's'} that
            look like they came from Tapit (no extended public key attached), but none of them match a
            Tapit-origin key in this browser's Key Manager right now. If you added that key on a different
            device or browser, add it here too before you can send membership to that person --{' '}
            <Link to="/keys" style={{ color: colors.gold }}>open Key Manager</Link>.
          </p>
        )}
        {orphanedGrantsPanel}
      </div>
    );
  }

  if (members.length === 0) {
    if (anyBarePubkeys === 0 && !orphanedGrantsPanel) return null;
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
        {anyBarePubkeys > 0 && (
          <p style={{ fontSize: 12, color: colors.sub, margin: 0 }}>
            This vault has {anyBarePubkeys} key{anyBarePubkeys === 1 ? '' : 's'} that
            look like they came from Tapit, but none of them match a Tapit-origin key in this
            browser's Key Manager right now --{' '}
            <Link to="/keys" style={{ color: colors.gold }}>open Key Manager</Link>.
          </p>
        )}
        {orphanedGrantsPanel}
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
                  {STATUS_DETAIL[g.status] ?? ''}
                  {g.responded_at ? ` -- ${new Date(g.responded_at).toLocaleString()}` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {orphanedGrantsPanel}
      <NostrRelaySettings />
    </div>
  );
}
