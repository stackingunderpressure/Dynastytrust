import { useEffect, useState } from "react";
import { api, type Vault, type DistributionTranche } from "../../lib/api";
import { listKeys } from "../../lib/keystore";
import { keyNetworkMatches } from "../../lib/network";
import { useToast } from "../../components/toast";
import { colors, fonts, radii } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { pubkeyFromXpub } from "../../lib/xpub";
import { buildPsbtKeyOrigins } from "../../lib/descriptor-keys";
import { tipHeight } from "../../lib/chain";
import { blocksToLabel } from "./shared";


export function DistributionWalletCreator({
  vault,
  onCancel,
  onSaved,
}: {
  vault: Vault;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [beneficiaryXpub, setBeneficiaryXpub] = useState("");
  const [beneficiaryKeyId, setBeneficiaryKeyId] = useState("");
  // Kept as raw text, not a number: a fully-controlled number input bound
  // straight to a number state snaps back to that number the instant the
  // field is empty (Number('') || fallback equals whatever it already
  // was), so backspacing to retype a new value never actually clears the
  // field. Text state lets each field sit empty mid-edit.
  const [trancheCountText, setTrancheCountText] = useState("12");
  const [amountPerTrancheBtc, setAmountPerTrancheBtc] = useState("0.01");
  const [intervalBlocksText, setIntervalBlocksText] = useState("4380"); // ~1 month
  const [firstUnlockBlockText, setFirstUnlockBlockText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trancheCount = Number(trancheCountText) || 0;
  const intervalBlocks = Number(intervalBlocksText) || 0;
  const firstUnlockBlock = firstUnlockBlockText && firstUnlockBlockText.trim() !== ''
    ? Number(firstUnlockBlockText) || 0
    : null;

  const localKeys = listKeys().filter(k =>
    k.status === "active" && keyNetworkMatches(k.network, vault.network),
  );

  useEffect(() => {
    // Default first unlock = current tip + one interval
    tipHeight(vault.network)
      .then(h => setFirstUnlockBlockText(String(h + 4380)))
      .catch(() => setFirstUnlockBlockText("100000"));
  }, [vault.network]);

  // vault.founder_keys already holds pubkey hex (the /0/0 child,
  // per the Nunchuk key-material parity fix) for any vault compiled
  // under the current PolicyBuilder -- calling pubkeyFromXpub on
  // that unconditionally threw, since HDKey.fromExtendedKey rejects
  // a bare hex string. Mirror the same defensive length check
  // buildAndSign already uses for this exact ambiguity (a handful
  // of pre-fix vaults may still hold a bare xpub) instead of
  // assuming one shape.
  function deriveTrusteePubkeys(): string[] {
    const pubkeys: string[] = [];
    for (const x of vault.founder_keys) {
      if (typeof x !== "string") continue;
      if (x.length === 66) { pubkeys.push(x); continue; }
      try {
        pubkeys.push(pubkeyFromXpub(x));
      } catch {
        /* skip malformed rows */
      }
    }
    return pubkeys;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name required"); return; }
    const amountSats = Math.round(parseFloat(amountPerTrancheBtc || "0") * 1e8);
    if (amountSats < 546) { setErr("Amount per tranche must be at least 546 sats"); return; }
    if (trancheCount < 1 || trancheCount > 60) { setErr("Tranche count must be 1-60"); return; }
    if (!firstUnlockBlock || firstUnlockBlock < 1) { setErr("First unlock block required"); return; }

    let beneficiaryPubkey = "";
    let beneficiaryXpubEffective = beneficiaryXpub.trim();

    if (beneficiaryKeyId) {
      const k = localKeys.find(k => k.keyId === beneficiaryKeyId);
      if (!k) { setErr("Pick a beneficiary key"); return; }
      beneficiaryXpubEffective = k.xpub;
      beneficiaryPubkey = pubkeyFromXpub(k.xpub);
    } else if (beneficiaryXpubEffective) {
      try {
        beneficiaryPubkey = pubkeyFromXpub(beneficiaryXpubEffective);
      } catch {
        setErr("Invalid beneficiary xpub");
        return;
      }
    } else {
      setErr("Pick a local beneficiary key or paste an xpub");
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      const trusteeKeys = await deriveTrusteePubkeys();

      // BIP32 origins for hardware-wallet compatibility (2026-08-12 fix --
      // the same 2026-08-06 fix already applied to the standard vault and
      // to Bloc, never extended to tranches, so a real hardware wallet had
      // no way to recognize its own key on a tranche claim's leaf and
      // correctly refused to sign). Trustees come from vault_members, the
      // same source the standard vault's own fix reads from; the
      // beneficiary comes from the locally selected key, if one was
      // picked, since it's already in hand with its own fingerprint and
      // derivation path. A pasted xpub with no local key behind it has no
      // derivation path available and is skipped -- same graceful
      // degradation buildPsbtKeyOrigins documents for any missing key.
      let keyOrigins: { pubkey: string; fingerprint: string; derivation_path: string }[] = [];
      try {
        const { members } = await api.members.list(vault.id);
        const trusteeSelected = members
          .filter(
            (m): m is typeof m & { pubkey: string; fingerprint: string; derivation_path: string } =>
              !!m.pubkey && !!m.fingerprint && !!m.derivation_path && trusteeKeys.includes(m.pubkey),
          )
          .map(m => ({
            pubkey: m.pubkey,
            keyId: m.id,
            label: m.label ?? "",
            persona: "",
            xpub: "",
            fingerprint: m.fingerprint,
            derivationPath: m.derivation_path,
            network: vault.network,
          }));
        const beneficiarySelected = beneficiaryKeyId
          ? localKeys.filter(k => k.keyId === beneficiaryKeyId)
          : [];
        keyOrigins = buildPsbtKeyOrigins([...trusteeSelected, ...beneficiarySelected]);
      } catch {
        /* non-fatal: this wallet just won't have hardware-wallet
           recognition until it's recreated once vault_members is
           reachable -- browser and Tapit signing are unaffected. */
      }

      const tranches: DistributionTranche[] = [];
      for (let i = 0; i < trancheCount; i++) {
        const unlock = firstUnlockBlock + i * intervalBlocks;
        const compiled = await api.distributionWallets.compileTranche({
          network: vault.network,
          beneficiary_key: beneficiaryPubkey,
          trustee_keys: trusteeKeys,
          trustee_quorum: vault.founder_quorum,
          unlock_block: unlock,
        });
        tranches.push({
          index: i,
          unlock_block: unlock,
          amount_sats: amountSats,
          address: compiled.address,
          descriptor: compiled.descriptor,
        });
      }
      await api.distributionWallets.create({
        vault_id: vault.id,
        name: name.trim(),
        beneficiary_name: beneficiaryName.trim() || undefined,
        beneficiary_xpub: beneficiaryXpubEffective,
        beneficiary_pubkey: beneficiaryPubkey,
        trustee_keys: trusteeKeys,
        trustee_quorum: vault.founder_quorum,
        network: vault.network,
        tranches,
        key_origins: keyOrigins,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={create}
      style={{
        border: `1px solid ${colors.gold}44`,
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div>
        <Label>Plan name</Label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Sarah 2026 annual"
        />
      </div>
      <div>
        <Label>Beneficiary name (optional)</Label>
        <Input
          value={beneficiaryName}
          onChange={e => setBeneficiaryName(e.target.value)}
          placeholder="Sarah"
        />
      </div>
      <div>
        <Label>Beneficiary key</Label>
        {localKeys.length > 0 && (
          <select
            value={beneficiaryKeyId}
            onChange={e => { setBeneficiaryKeyId(e.target.value); setBeneficiaryXpub(""); }}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              color: colors.text,
              fontFamily: fonts.sans,
              fontSize: 17,
              marginBottom: 6,
            }}
          >
            <option value="">-- Pick a local key --</option>
            {localKeys.map(k => (
              <option key={k.keyId} value={k.keyId}>
                {k.label} ({k.persona})
              </option>
            ))}
          </select>
        )}
        <Input
          mono
          value={beneficiaryXpub}
          onChange={e => { setBeneficiaryXpub(e.target.value); setBeneficiaryKeyId(""); }}
          placeholder="...or paste a beneficiary xpub"
          disabled={!!beneficiaryKeyId}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <Label>Tranche count</Label>
          <Input
            type="number"
            min={1}
            max={60}
            value={trancheCountText}
            onChange={e => setTrancheCountText(e.target.value)}
          />
        </div>
        <div>
          <Label>BTC per tranche</Label>
          <Input
            mono
            value={amountPerTrancheBtc}
            onChange={e => setAmountPerTrancheBtc(e.target.value)}
          />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <Label>Interval (blocks)</Label>
          <Input
            type="number"
            min={144}
            value={intervalBlocksText}
            onChange={e => setIntervalBlocksText(e.target.value)}
          />
          <div style={{ fontSize: 15, color: colors.muted, marginTop: 4 }}>
            {blocksToLabel(intervalBlocks)} . 4380 =~ 1 month, 13140 =~ 3 months, 52560 =~ 1 year
          </div>
        </div>
        <div>
          <Label>First unlock block</Label>
          <Input
            type="number"
            value={firstUnlockBlockText ?? ""}
            onChange={e => setFirstUnlockBlockText(e.target.value)}
          />
          <div style={{ fontSize: 15, color: colors.muted, marginTop: 4 }}>
            Absolute height where the first tranche unlocks.
          </div>
        </div>
      </div>
      {err && <div style={{ color: colors.orange, fontSize: 16 }}>{err}</div>}
      <div style={{ fontSize: 15, color: colors.muted }}>
        Compiles one Taproot address per tranche via the Fly.io
        compiler. Each tranche: beneficiary alone after its unlock
        block, or trustees any time (escape hatch).
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 16 }} type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" style={{ fontSize: 16 }} type="submit" disabled={busy}>
          {busy ? `Compiling ${trancheCount} tranches...` : `Create (${trancheCount} tranches)`}
        </Button>
      </div>
    </form>
  );
}
