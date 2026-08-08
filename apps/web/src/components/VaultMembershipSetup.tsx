import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getTapitCircleMembers } from '../lib/tapit-circle-members';
import { leafScriptsForRole, sendVaultMembershipRequestOverNostr } from '../lib/circle-membership-delivery';
import { colors, radii, space } from '../theme';
import { Button } from './ui';
import { useToast } from './toast';

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
 */
export function VaultMembershipSetup({
  vaultDescriptor,
  vaultName,
  founderKeys,
  leafScripts,
}: {
  vaultDescriptor: string | null;
  vaultName: string;
  founderKeys: string[];
  leafScripts: Record<string, string> | null;
}) {
  const toast = useToast();
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Map<string, 'delivered' | 'queued'>>(new Map());

  const { circleMembers, bareFounderPubkeys } = getTapitCircleMembers(founderKeys);
  const founderLeaves = leafScriptsForRole(leafScripts, 'founder');

  if (circleMembers.length === 0) {
    if (bareFounderPubkeys.length === 0) return null;
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
          This vault has {bareFounderPubkeys.length} founder key{bareFounderPubkeys.length === 1 ? '' : 's'} that
          look like they came from Tapit, but none of them match a Tapit-origin key in this
          browser's Key Manager right now --{' '}
          <Link to="/keys" style={{ color: colors.gold }}>open Key Manager</Link>.
        </p>
      </div>
    );
  }

  const ready = vaultDescriptor !== null && founderLeaves.length > 0;

  async function grant(keyId: string, xOnlyPubkey: string, label: string) {
    if (!ready || !vaultDescriptor) return;
    setBusyKeyId(keyId);
    try {
      const result = await sendVaultMembershipRequestOverNostr({
        vaultDescriptor,
        vaultName,
        role: 'founder',
        leafScripts: founderLeaves,
        recipientXOnlyPubkey: xOnlyPubkey,
      });
      setSentTo(prev => new Map(prev).set(keyId, result.delivered ? 'delivered' : 'queued'));
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
        it and holds its own copy; nothing is signed on your end.
      </p>

      {!ready && vaultDescriptor !== null && (
        <p style={{ fontSize: 12, color: colors.gold, marginBottom: 10 }}>
          No leaf scripts on file for this vault yet -- recompile to refresh them before sending.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {circleMembers.map(k => (
          <div key={k.keyId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
              {k.label} <span style={{ color: colors.muted }}>({k.persona})</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12, flexShrink: 0 }}
              disabled={!ready || busyKeyId === k.keyId}
              onClick={() => void grant(k.keyId, k.tapitXOnlyPubkey!, k.label)}
            >
              {sentTo.get(k.keyId) === 'delivered'
                ? 'Sent'
                : sentTo.get(k.keyId) === 'queued'
                  ? 'Queued -- retrying'
                  : busyKeyId === k.keyId
                    ? 'Sending…'
                    : 'Grant membership'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
