import { useEffect, useState } from "react";
import { api, type Vault, type BalanceResult, type StipendInterval } from "../../lib/api";
import { keyNeedsPassword, listKeys, revealMnemonic, type LocalKey } from "../../lib/keystore";
import { signPsbtWithMnemonic, mergePsbts, verifyPsbtMatchesRequest } from "../../lib/psbt-signer";
import { whoSignsShort } from "../../lib/path-words";
import { assembleLivenessGateInput } from "../../lib/liveness-gate";
import { evaluateSigningGate, ceremonyFromProposal } from "@dynastytrust/policy-engine";
import { explorerTxUrl } from "../../config";
import { sendRawTx, recordBroadcast } from "../../lib/broadcast";
import { useToast } from "../../components/toast";
import { useConfirm, usePrompt } from "../../components/dialog";
import { colors, fonts, radii, } from "../../theme";
import { Button, Input, Label } from "../../components/ui";
import { PsbtQrDisplay } from "../../components/PsbtQrDisplay";
import { PsbtQrScanner } from "../../components/PsbtQrScanner";
import { checkFreshSpendAddresses, isFreshAddressVault } from "../../lib/fresh-addresses";
import { pubkeyFromXpub } from "../../lib/xpub";
import { findSpendingPath, signaturesNeeded } from "../../lib/vault-spending-paths";
import { signaturesTowardPath as sendSignaturesToward } from "../../lib/send-signatures";
import { blocDecayLadder } from "../../lib/blocks";
import { selectStyle } from "../../components/vault-builder";
import { NotifyCircleViaNostr } from "../../components/NotifyCircleViaNostr";
import { SeedSignerNetworkHint } from "../../components/SeedSignerNetworkHint";
import { ExternalPsbtInput } from "./ExternalPsbtInput";
import { UtxosSection } from "./UtxosSection";
import { advanceDueDate, blocksToLabel, psbtBindingHash, satsToBtc } from "./shared";


// // -- Send tab
// Clean Nunchuk-style: fill form -> sign automatically -> broadcast

type SendStep = "form" | "signing" | "done";

// Optional pre-filled fields pushed from a scheduled stipend row.
// When `stipend_id` is set, successful broadcast bumps the stipend's
// next_due_at by its interval.
export interface SendPrefill {
  stipend_id?: string;
  stipend_interval?: StipendInterval;
  destination?: string;
  amount_sats?: number;
  rule_id?: string | null;
  memo?: string;
  name?: string;
  selected_utxos?: { txid: string; vout: number }[];
  // Which spending path to open the form on -- set by the "inheritance
  // is open" prompts so an heir does not have to find the right entry
  // in a dropdown. Ignored if the vault has no such path.
  path?: string;
  // Set when this send was started from a beneficiary's distribution
  // request (RequestsTab). On successful broadcast the request is
  // marked fulfilled and linked to the resulting proposal so the
  // audit trail closes the loop back to the actual payment.
  request_id?: string;
  // Set when this send is FUNDING a distribution-wallet tranche
  // (DistributionWalletsSection's "Fund" button). On successful
  // broadcast that tranche's funded_txid is patched in.
  distribution_wallet_id?: string;
  tranche_index?: number;
}

interface SigningState {
  psbt_hex: string;
  psbt_b64: string;
  summary: {
    amount_sats: number;
    fee_sats: number;
    change_sats: number;
    fee_rate: number;
    destination: string;
  };
  proposal_id?: string;
  signers: Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>;
  signaturesCollected: number;
  requiredSignatures: number;
  txid?: string;
}

export function SendTab({ vault, balance, onDone, prefill, onPickCoins }: {
  vault: Vault;
  balance: BalanceResult | null;
  onDone: () => void;
  prefill?: SendPrefill | null;
  /** Choose exactly which coins to spend (or undefined: the app picks). */
  onPickCoins?: (p: SendPrefill) => void;
}) {
  const askPassword = usePrompt();
  const toast = useToast();
  const [step, setStep] = useState<SendStep>("form");
  const [dest, setDest] = useState(prefill?.destination ?? "");
  const [amountBtc, setAmountBtc] = useState(
    prefill?.amount_sats ? satsToBtc(prefill.amount_sats) : "",
  );
  const [feeRate, setFeeRate] = useState("");
  const [memo, setMemo] = useState(prefill?.memo ?? "");
  const [ruleId, setRuleId] = useState<string>(prefill?.rule_id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signing, setSigning] = useState<SigningState | null>(null);
  // Set when the spend was sent but recording it in the vault's history
  // failed (lib/broadcast.ts) -- never shown as a failed send.
  const [recordErr, setRecordErr] = useState<string | null>(null);
  async function recordAgain() {
    if (!signing?.proposal_id || !signing.txid) return;
    const pid = signing.proposal_id, txid = signing.txid;
    setBusy(true);
    try {
      await recordBroadcast(() => api.proposals.update(pid, { status: "broadcast", txid }));
      setRecordErr(null);
    } catch (e) {
      setRecordErr(e instanceof Error ? e.message : "Could not record it");
    } finally {
      setBusy(false);
    }
  }
  // The review screen replaces the form: bring its top into view, not
  // leave the person at the bottom where "Review & sign" was.
  const reviewing = signing != null;
  useEffect(() => {
    if (!reviewing) return;
    requestAnimationFrame(() => {
      const target = document.querySelector("[data-dt-tabs]");
      if (!target) return;
      const bar = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - bar - 8, behavior: "smooth" });
    });
  }, [reviewing]);
  const [pickCoins, setPickCoins] = useState(false);
  const confirmCancel = useConfirm();
  const [copied, setCopied] = useState<string | null>(null);
  const [slowHint, setSlowHint] = useState(false);
  const [showQrDisplay, setShowQrDisplay] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  // 2026-08-15 (operator: "did max spend should be no change but there
  // was some back to wallet miscalculation") -- the old "Max" button
  // wrote a GUESSED amount (balance minus a flat 2000-sat fee estimate)
  // into the plain amount field, which then went through the normal
  // fixed-amount build path; whenever the real fee differed from that
  // guess, the leftover became an unrequested change output. sweep
  // instead sends no amount at all -- psbt-binary.js (standard vaults)
  // / psbt-binary-bloc.js (Dynasty Bloc, same-day follow-up: "fix the
  // other ones") compute the exact fee for the real input count first,
  // then derive amount = totalIn - fee server-side, so there is nothing
  // left to become change.
  const [sweep, setSweep] = useState(false);

  // Dynasty Bloc: which of the four spend paths this proposal uses, and
  // (for the decaying kids-alone path) which rung. Ignored entirely for
  // standard vaults, which only ever propose founders_now.
  const bp = vault.bloc_policy;
  const blocLadder = bp ? blocDecayLadder(bp) : [];
  const [blocPath, setBlocPath] = useState<"parents_now" | "coparent_kids" | "parent_solo" | "kids_decay">("parents_now");
  const [blocRungIdx, setBlocRungIdx] = useState(0);

  // A custom leaf-list vault never populates founder_keys/heir_keys/
  // recovery_after/inheritance_after -- those sit at their bare DB
  // defaults (same discriminator VaultPhaseCard/VaultStructureTree
  // already use). Operator, pasting the live Send tab for exactly this
  // vault shape: the "Spend path" dropdown offered "Founders now (2 of
  // 0)" / "Recovery (2 of 0 founders)" -- both read off those unpopulated
  // defaults -- and attempting to sign with "founders_now" hit "Compiler
  // error: Unknown path: founders_now", since psbt-binary.js's leaf-list
  // branch (leafListSignerCounts) only recognizes a real vault.leaves[].id
  // as a valid path, never the five named-field path ids. This was never
  // a display-only bug like the others in this history -- a leaf-list
  // vault could not actually be spent from through this tab at all.
  const isLeafList = Array.isArray(vault.leaves) && vault.leaves.length > 0;

  // Standard (non-Bloc) vault: which leaf this proposal spends through.
  // founders_now is always available; the rest only show up once the
  // vault actually has that leaf configured (psbt-binary.js's
  // leafSignerCounts/leafCountForTree only know how to size these five).
  // None of this applies to a leaf-list vault -- see isLeafList above.
  const hasRecovery = !isLeafList && vault.recovery_after > 0;
  const hasInheritance = !isLeafList && vault.heir_keys.length > 0 && vault.inheritance_after > 0;
  const hasBackup = !isLeafList && vault.backup_keys.length > 0 && vault.backup_quorum != null;
  const hasSecondInheritance =
    !isLeafList && vault.second_heir_keys.length > 0 && vault.second_heir_quorum != null && vault.second_inheritance_after != null;
  // Leaf-list vaults use the leaf's own id as `path` (psbt-binary.js's
  // leafListSignerCounts); default to the first immediately-spendable
  // leaf, matching founders_now's "always available" role for the
  // named-field shape. Falls back to the first leaf if none is
  // immediate, rather than crashing on an edge-case vault.
  const [standardPath, setStandardPath] = useState<string>(() => {
    if (isLeafList) {
      const leaves = vault.leaves!;
      if (prefill?.path && leaves.some(l => l.id === prefill.path)) return prefill.path;
      return leaves.find(l => l.unlock.type === "immediate")?.id ?? leaves[0].id;
    }
    const available: Record<string, boolean> = {
      recovery: hasRecovery, inheritance: hasInheritance, backup: hasBackup, second_inheritance: hasSecondInheritance,
    };
    return prefill?.path && available[prefill.path] ? prefill.path : "founders_now";
  });

  // How far a signed PSBT has got toward THIS path's rule
  // (lib/send-signatures.ts).
  const signaturesTowardPath = (psbtHex: string) => sendSignaturesToward(vault, standardPath, psbtHex);

  const confirmedSats = balance?.confirmed_sats ?? 0;
  const amountSats = Math.round(parseFloat(amountBtc || "0") * 1e8);
  const rules = vault.trust_doc?.rules ?? [];
  const selectedRule = rules.find(r => r.id === ruleId);

  const useSweep = sweep;

  async function buildAndSign(e: React.FormEvent) {
    e.preventDefault();
    if (!useSweep) {
      if (amountSats < 546) { setErr("Minimum 546 sats (dust limit)"); return; }
      if (amountSats > confirmedSats) { setErr("Insufficient confirmed balance"); return; }
    }
    // Enforce the structured trust rule if one is picked or if the
    // trust has rules defined at all (in which case every spend
    // should be categorised).
    if (rules.length > 0 && !selectedRule) {
      setErr("Pick a distribution rule. Every spend on this trust must be categorised.");
      return;
    }
    // Sweep doesn't know the real amount until the backend computes it
    // (totalIn minus the exact fee) -- checked again below, right after
    // psbtRes comes back, using the real number instead of a guess.
    if (!useSweep && selectedRule?.max_sats && amountSats > selectedRule.max_sats) {
      setErr(
        `Amount exceeds the cap on rule "${selectedRule.name}" (max ${satsToBtc(selectedRule.max_sats)} BTC per spend).`,
      );
      return;
    }
    if (selectedRule?.requires_comment && !memo.trim()) {
      setErr(`Rule "${selectedRule.name}" requires a reason. Fill in the memo field.`);
      return;
    }
    // Dynasty Bloc requires a rung quorum when the kids-alone path is
    // chosen -- checked up front so a bad selection never reaches the
    // compiler as a malformed request.
    let blocRungQuorum: number | undefined;
    if (bp && blocPath === "kids_decay") {
      const rung = blocLadder[blocRungIdx];
      if (!rung) { setErr("Pick a kids-alone rung."); return; }
      blocRungQuorum = rung.q;
    }

    setBusy(true); setErr(null); setSlowHint(false);
    const slowTimer = window.setTimeout(() => setSlowHint(true), 1500);

    try {
      // 1. Build PSBT via Fly.io. Dynasty Bloc vaults (bloc_policy set)
      // go through the Bloc-specific endpoint, which knows how to look
      // up the saved policy + key origins from vault_id; every other
      // vault uses the standard founders/heirs endpoint.
      let psbtRes: {
        ok: boolean;
        psbt_hex: string;
        psbt_b64: string;
        summary: {
          amount_sats: number;
          fee_sats: number;
          change_sats: number;
          fee_rate: number;
          destination: string;
          addresses_combined?: number;
          waiting?: { txid: string; vout: number; value_sats: number; blocks_left: number }[];
        };
        status?: string;
        message?: string;
      };
      const path: string = bp ? blocPath : standardPath;

      if (bp) {
        const blocRes = await api.psbtBloc({
          vault_id: vault.id,
          destination: dest.trim(),
          ...(useSweep ? { sweep: true } : { amount_sats: amountSats }),
          fee_rate: feeRate ? parseFloat(feeRate) : undefined,
          path: blocPath,
          quorum: blocRungQuorum,
        });
        // psbtBloc's summary omits destination/fee_rate (it doesn't
        // need to echo back what the caller already sent) -- fold the
        // known request-side values in so the rest of this flow (and
        // the signing screen's summary card) can stay shape-agnostic.
        psbtRes = {
          ok: blocRes.ok,
          psbt_hex: blocRes.psbt_hex,
          psbt_b64: blocRes.psbt_b64,
          summary: {
            amount_sats: blocRes.summary.amount_sats,
            fee_sats: blocRes.summary.fee_sats,
            change_sats: blocRes.summary.change_sats,
            fee_rate: feeRate ? parseFloat(feeRate) : 0,
            destination: dest.trim(),
          },
        };
      } else {
        psbtRes = await api.psbt.generate({
          vault_id: vault.id,
          destination: dest.trim(),
          ...(useSweep ? { sweep: true } : { amount_sats: amountSats }),
          fee_rate: feeRate ? parseFloat(feeRate) : undefined,
          path: standardPath,
          selected_utxos: prefill?.selected_utxos,
        }) as typeof psbtRes;
      }

      if (psbtRes.status === "no_utxos") {
        setErr("No confirmed UTXOs. Fund the vault and wait for confirmation.");
        setBusy(false);
        return;
      }

      // Re-derive what the PSBT actually pays from its own bytes before
      // trusting the server's summary text at all -- see
      // verifyPsbtMatchesRequest's doc comment (Kimi K3 scan Family A).
      // ownAddress/feeSats/changeSats: every input must be this vault's
      // own coin, change must come back to this vault, and the real fee
      // must be the one the confirm screen will show -- all from the
      // PSBT's bytes, so no coordinator can redirect what is signed.
      // Without the vault's own address the gate cannot tell this vault's
      // coins from anyone else's -- refuse rather than skip that half.
      if (!vault.address) {
        setErr("Refusing to sign: this vault has no address on file, so the transaction cannot be checked against it.");
        setBusy(false);
        return;
      }
      // A vault with a new address every time: its coins and change are
      // checked against the addresses THIS device derives (ranged slice 5).
      const fresh = isFreshAddressVault(vault);
      const psbtCheck = verifyPsbtMatchesRequest(psbtRes.psbt_hex, {
        destination: dest.trim(),
        amountSats: psbtRes.summary.amount_sats,
        network: vault.network,
        ownAddress: fresh ? undefined : vault.address,
        feeSats: psbtRes.summary.fee_sats,
        changeSats: psbtRes.summary.change_sats,
      });
      const ownCheck = psbtCheck.ok && fresh ? await checkFreshSpendAddresses(vault, psbtRes.psbt_hex) : psbtCheck;
      if (!psbtCheck.ok || !ownCheck.ok) {
        const reason = !psbtCheck.ok ? psbtCheck.reason : !ownCheck.ok ? ownCheck.reason : '';
        setErr(`Refusing to sign: ${reason}. This PSBT does not match what you requested -- try again, and contact support if this persists.`);
        setBusy(false);
        return;
      }
      // Operator's chip (2026-11-24): when a spend combines coins from
      // several addresses, say so before anyone signs.
      const combined = psbtRes.summary.addresses_combined ?? 1;
      if (fresh && combined > 1) {
        toast.info(`This payment uses coins from ${combined} of this vault's addresses, so anyone looking can tell those addresses belong together.`);
      }
      // Operator's chip: an "if left untouched" path spends only the coins
      // whose own wait is over -- say what is still waiting, and for how long.
      const waiting = psbtRes.summary.waiting ?? [];
      if (waiting.length > 0) {
        const soonest = Math.min(...waiting.map(w => w.blocks_left));
        const held = waiting.reduce((t, w) => t + w.value_sats, 0);
        toast.info(`${waiting.length === 1 ? 'One coin' : `${waiting.length} coins`} (${satsToBtc(held)} BTC) ${waiting.length === 1 ? 'has' : 'have'} not sat untouched long enough for this path yet, so ${waiting.length === 1 ? 'it is' : 'they are'} left out. The next is ready in about ${blocksToLabel(soonest)}.`);
      }

      // Sweep only learns the real amount here, once the backend has
      // computed totalIn minus the exact fee -- re-check the rule cap
      // against that real number before ever saving a proposal for it.
      if (useSweep && selectedRule?.max_sats && psbtRes.summary.amount_sats > selectedRule.max_sats) {
        setErr(
          `Sweeping the full balance (${satsToBtc(psbtRes.summary.amount_sats)} BTC) exceeds the cap on rule "${selectedRule.name}" (max ${satsToBtc(selectedRule.max_sats)} BTC per spend). Enter a specific amount under the cap instead.`,
        );
        setBusy(false);
        return;
      }

      // 2. Save proposal. Uses the backend's own summary.amount_sats
      // (the real, post-fee amount) rather than the client's amountSats
      // -- for a sweep those differ by definition (amountSats is 0/blank
      // client-side); for a normal spend the backend already enforces
      // they're identical, so this is never a behavior change there.
      const propRes = await api.proposals.create({
        vault_id: vault.id,
        destination: dest.trim(),
        amount_sats: psbtRes.summary.amount_sats,
        path,
        memo: selectedRule
          ? `Rule: ${selectedRule.name}${memo.trim() ? ` -- ${memo.trim()}` : ""}`
          : memo || undefined,
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        fee_sats: psbtRes.summary.fee_sats,
      });

      // 3. Find local software keys
      // Only local keys whose /0/0 pubkey actually appears among this
      // vault's eligible signers for the chosen path should be offered
      // as signers. Anything else just adds confusion -- if it's in
      // the keyring but can't help this spend, don't show it. Derive
      // each vault xpub to pubkey hex and intersect with the local
      // keystore.
      // Tapit-origin keys hold no local key material and can never sign
      // in-browser, but they DO need to appear here so NotifyCircleViaNostr
      // (below) can find them and deliver the request to the right
      // person's Tapit inbox -- excluding them left that button with
      // nothing to ever show.
      const allLocalKeys = listKeys().filter(
        k => k.status === "active" && (k.origin === "software" || k.origin === "tapit"),
      );
      const vaultSignerPubkeys = new Set<string>();
      const addKey = (x: string) => {
        if (typeof x !== 'string') return;
        if (x.length === 66) {
          // Legacy rows / Bloc's pubkey lists store pubkey hex directly.
          vaultSignerPubkeys.add(x);
          return;
        }
        try {
          vaultSignerPubkeys.add(pubkeyFromXpub(x));
        } catch {
          /* skip malformed rows */
        }
      };
      let requiredSignatures: number;
      if (bp) {
        // parents_now / parent_solo / kids_decay each draw signers from
        // one side only; coparent_kids draws from both.
        if (blocPath === "parents_now" || blocPath === "parent_solo") {
          bp.parent_pubkeys.forEach(addKey);
        } else if (blocPath === "kids_decay") {
          bp.kid_pubkeys.forEach(addKey);
        } else {
          bp.parent_pubkeys.forEach(addKey);
          bp.kid_pubkeys.forEach(addKey);
        }
        requiredSignatures =
          blocPath === "parents_now" ? bp.parents_together_quorum
          : blocPath === "coparent_kids" ? bp.coparent_quorum + bp.kids_with_parent_quorum
          : blocPath === "parent_solo" ? bp.parent_solo_quorum
          : (blocRungQuorum ?? bp.kids_decay_floor_quorum);
      } else if (isLeafList) {
        // vault.leaves[].keys are xpubs (or, on a legacy row, raw pubkey
        // hex) -- addKey already handles both shapes. standardPath here
        // is a real leaf id (see its useState initializer above), so
        // this is just "find the leaf the picker chose."
        const leaf = vault.leaves!.find(l => l.id === standardPath);
        const summary = findSpendingPath(vault, standardPath);
        if (leaf && summary) {
          // Must-sign keys (and the consent group, where a vault has one)
          // sign on top of the quorum of the others.
          [...summary.requiredKeys, ...summary.keys, ...(summary.consent?.keys ?? [])].forEach(addKey);
          requiredSignatures = signaturesNeeded(summary);
        } else {
          requiredSignatures = 0;
        }
      } else {
        // 2026-08-11 fix (operator: tested a single-key backup leaf with
        // no timelock and the signing screen said "0 of 2 signatures
        // needed" instead of "0 of 1") -- this used to always pull
        // founder_keys/founder_quorum no matter which of the vault's
        // leaves standardPath actually selected, so every non-founders
        // path (recovery, inheritance, backup,
        // second_inheritance) showed the wrong signer set and the wrong
        // required-signature count, even though the PSBT itself (built
        // server-side via api.psbt.generate's own path param) was
        // correctly scoped to the real leaf the whole time -- this was a
        // display/signer-discovery bug only, never a signing-authority
        // bug. founders_now ANDs in beneficiary consent when configured
        // (policy_compiler.rs's founder_thresh: and(trustee_thresh,
        // consent_thresh)) -- both quorums are required, not either/or,
        // so their counts add rather than override.
        switch (standardPath) {
          case "recovery":
            vault.founder_keys.forEach(addKey);
            requiredSignatures = vault.recovery_quorum ?? vault.founder_quorum;
            break;
          case "inheritance":
            vault.heir_keys.forEach(addKey);
            requiredSignatures = vault.heir_quorum;
            break;
          case "backup":
            vault.backup_keys.forEach(addKey);
            requiredSignatures = vault.backup_quorum ?? 0;
            break;
          case "second_inheritance":
            vault.second_heir_keys.forEach(addKey);
            requiredSignatures = vault.second_heir_quorum ?? 0;
            break;
          case "founders_now":
          default:
            vault.founder_keys.forEach(addKey);
            requiredSignatures = vault.founder_quorum;
            if (vault.consent_keys.length > 0 && vault.consent_quorum != null) {
              vault.consent_keys.forEach(addKey);
              requiredSignatures += vault.consent_quorum;
            }
            break;
        }
      }
      // Dedupe by pubkey (keep the first matching LocalKey record) --
      // same fix already applied in tapit-circle-members.ts for the
      // Members/circle-phrase UI (operator, 2026-08-11: "Why two tapit
      // sends for one key?"), needed again here because this Send flow
      // builds its own independent signer list rather than sharing that
      // helper. If the local keystore holds two LocalKey rows pointing
      // at the same real pubkey (e.g. the same Tapit key imported twice
      // under two keyIds), an unfiltered intersection renders two
      // identical "Founder (Tapit)" rows in NotifyCircleViaNostr and
      // sends the same psbt-cosign request twice to the same wallet.
      const seenSignerPubkeys = new Set<string>();
      const signingKeys = allLocalKeys.filter(k => {
        if (!vaultSignerPubkeys.has(k.pubkey)) return false;
        if (seenSignerPubkeys.has(k.pubkey)) return false;
        seenSignerPubkeys.add(k.pubkey);
        return true;
      });

      setSigning({
        psbt_hex: psbtRes.psbt_hex,
        psbt_b64: psbtRes.psbt_b64,
        summary: psbtRes.summary,
        proposal_id: propRes.proposal.id,
        signers: signingKeys.map(key => ({ key, status: "pending" })),
        signaturesCollected: 0,
        requiredSignatures,
      });
      setStep("signing");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to build transaction");
    } finally {
      window.clearTimeout(slowTimer);
      setBusy(false);
      setSlowHint(false);
    }
  }

  async function signWithKey(keyIndex: number) {
    if (!signing) return;
    const signerEntry = signing.signers[keyIndex];
    const key = signerEntry.key;

    // Update status to signing, clearing any error from a previous attempt
    // so the row reads cleanly on retry.
    setSigning(prev => {
      if (!prev) return prev;
      const signers = [...prev.signers];
      signers[keyIndex] = { ...signers[keyIndex], status: "signing", error: undefined };
      return { ...prev, signers };
    });

    try {
      // Fail-closed gate: refuse to sign unless this exactly matches an
      // approved, non-duress, live proposal (docs/threat-model-and-fail-
      // closed.md section 4 -- "fail closed everywhere the app has
      // discretion"). Checked before the password prompt so a blocked
      // sign never bothers to ask for a key.
      const { proposals } = await api.proposals.list(vault.id);
      const proposal = signing.proposal_id ? proposals.find(p => p.id === signing.proposal_id) : undefined;
      if (!proposal) {
        throw new Error("could not find the proposal this spend is supposed to match");
      }

      // Liveness axis (2026-08-06): the previously-documented blocker --
      // tapit-attest's OpenTimestampsProvider re-export transitively pulling
      // in a broken `opentimestamps` npm package that failed to resolve under
      // Vite -- no longer reproduces (verified directly: importing
      // assembleLivenessGateInput here and running `npm run build` succeeds
      // cleanly). Node's own module resolution already falls back to
      // `index.js` when a package's declared `main` file is missing, and the
      // installed Vite/Rollup version now does the same. Wired for real: GET
      // the vault's held signals + resolved circle config, then fold them
      // into the gate exactly as liveness-gate.ts's own doc comment
      // prescribes. `config: null` (no liveness circle configured on this
      // vault) is the gate's own documented safe default -- undefined,
      // "not liveness-gated" -- same as before this wire. A FAILED fetch is
      // different from an absent config: we cannot tell whether this vault
      // has a circle we simply failed to see, so per the fail-closed
      // doctrine ("missing a piece -> build nothing",
      // docs/threat-model-and-fail-closed.md section 4) this blocks signing
      // rather than silently bypassing the liveness axis. Duress is still
      // enforced below via vault.duress independent of this.
      let liveness: ReturnType<typeof assembleLivenessGateInput>;
      try {
        const { config, proofs, redFlags } = await api.liveness.get(vault.id);
        // Uses the freshly-fetched proposal's own path (not a hardcoded
        // "founders_now") so this holds for Dynasty Bloc's four spend
        // paths too, not just the standard vault's single normal path.
        liveness = config
          ? assembleLivenessGateInput({ config, path: proposal.path, proofs, redFlags })
          : undefined;
      } catch (e) {
        throw new Error(
          "Could not confirm this vault's liveness status -- refusing to sign until it can be verified: " +
            (e instanceof Error ? e.message : "network error"),
        );
      }

      // Fetch duress fresh from the server immediately before gating,
      // rather than trusting `vault.duress` off React state -- that prop
      // already has `duressOverride` (a purely client-side, optimistic
      // value set locally right after the setDuress call, see line ~204)
      // layered on top of it. A stolen unlocked session (or a malicious
      // co-signer at the victim's own keyboard) could otherwise clear a
      // real halt through the app's own toggle control and sign before
      // the next full page load ever re-synced state from the server.
      // Same fail-closed posture as the liveness fetch just above: a
      // failed fetch blocks signing rather than silently treating it as
      // "not halted" (Kimi K3 scan #142).
      let freshDuress: boolean;
      try {
        const [{ vaults: activeVaults }, { vaults: archivedVaults }] = await Promise.all([
          api.vaults.list(false),
          api.vaults.list(true),
        ]);
        const fresh = [...activeVaults, ...archivedVaults].find(v => v.id === vault.id);
        if (!fresh) throw new Error("Vault not found");
        freshDuress = fresh.duress;
      } catch (e) {
        throw new Error(
          "Could not confirm this vault's duress status -- refusing to sign until it can be verified: " +
            (e instanceof Error ? e.message : "network error"),
        );
      }

      const ceremony = ceremonyFromProposal({
        proposal: {
          proposalId: proposal.id,
          vaultId: vault.id,
          status: proposal.status,
          destination: proposal.destination,
          amountSats: proposal.amount_sats,
          path: proposal.path,
        },
        authorizedPsbtHash: proposal.psbt_hex ? psbtBindingHash(proposal.psbt_hex) : "",
        // No separate per-member approval-vote step exists in this app
        // (operator decision, Kimi K3 scan #142 follow-up: dropped the
        // synthetic voter axis from the gate entirely rather than keep a
        // check that always trivially passed itself). Quorum is enforced
        // by the Taproot script's own required signature count.
        duress: freshDuress,
      });

      // request.destination/amountSats deliberately come from `signing`
      // (the browser's own in-memory record of what was built and shown to
      // the human), NOT from the freshly-fetched proposal used for
      // `ceremony` above -- comparing the two closes the "compromised
      // device shows one destination but signs another" gap (P5 in the
      // threat model doc).
      //
      // The exact-PSBT-hash check is only meaningful against the PRISTINE,
      // never-mutated proposal.psbt_hex: signing.psbt_hex legitimately
      // changes as earlier signatures get merged in across a multi-signer
      // session, so re-hashing it after the first signature would produce
      // a false PSBT_HASH_MISMATCH. Checked strictly only for the first
      // signature in a session; every other check (destination, amount,
      // path, status, duress, liveness) still applies to later signers.
      const requestPsbtHash =
        signing.signaturesCollected === 0 ? psbtBindingHash(signing.psbt_hex) : ceremony.authorizedPsbtHash;

      const gate = evaluateSigningGate({
        request: {
          vaultId: vault.id,
          psbtHash: requestPsbtHash,
          destination: signing.summary.destination,
          amountSats: signing.summary.amount_sats,
          // Matches ceremony.path (also proposal.path) so the gate's
          // own PATH_MISMATCH check passes for any of Dynasty Bloc's
          // spend paths, not just the standard vault's founders_now.
          path: proposal.path,
        },
        ceremony,
        vault: { vaultId: vault.id, address: vault.address ?? "" },
        psbtBindsToVault: true,
        liveness,
      });

      if (!gate.allow) {
        throw new Error("Fail-closed gate blocked signing: " + gate.denials.map(d => d.message).join(" "));
      }

      // Get mnemonic
      let pw: string | undefined;
      if (keyNeedsPassword(key)) {
        const result = await askPassword({
          title: "Unlock key",
          message: `Enter the password for "${key.label}" to sign.`,
          password: true,
          confirmLabel: "Sign",
        });
        if (result === null) {
          setSigning(prev => {
            if (!prev) return prev;
            const signers = [...prev.signers];
            signers[keyIndex] = { ...signers[keyIndex], status: "pending" };
            return { ...prev, signers };
          });
          return;
        }
        pw = result;
      }

      const mnemonic = await revealMnemonic(key.keyId, pw);

      // Get current best PSBT (may already have some sigs)
      const currentPsbt = signing.psbt_hex;

      // Sign
      const result = await signPsbtWithMnemonic(
        currentPsbt,
        mnemonic,
        key.derivationPath,
        vault.network
      );

      // Merge with existing signed PSBTs from other keys
      const signedByOthers = signing.signers
        .filter((s, i) => i !== keyIndex && s.status === "signed")
        .map(s => (s as typeof s & { psbt: string }).psbt)
        .filter(Boolean);

      const allPsbts = [result.psbt_hex, ...signedByOthers];
      const mergedHex = allPsbts.length > 1 ? mergePsbts(allPsbts) : result.psbt_hex;
      const totalSigs = signaturesTowardPath(mergedHex);

      // Persist this signer's partial PSBT so other members see progress.
      // Fire-and-forget; a failure here doesn't block the UI because the
      // local merged PSBT is still usable for broadcast by this user.
      if (signing.proposal_id) {
        api.signerSessions
          .submit({
            proposal_id: signing.proposal_id,
            psbt_partial_hex: result.psbt_hex,
            fingerprint: key.fingerprint,
            label: key.label,
          })
          .catch(() => {
            /* silent -- surfaces next time the proposal is opened */
          });
      }

      setSigning(prev => {
        if (!prev) return prev;
        const signers = [...prev.signers];
        (signers[keyIndex] as typeof signers[number] & { psbt: string }).psbt = result.psbt_hex;
        signers[keyIndex] = { ...signers[keyIndex], status: "signed" };
        return { ...prev, signers, psbt_hex: mergedHex, signaturesCollected: totalSigs };
      });

    } catch (e) {
      setSigning(prev => {
        if (!prev) return prev;
        const signers = [...prev.signers];
        signers[keyIndex] = { ...signers[keyIndex], status: "error", error: e instanceof Error ? e.message : "Failed" };
        return { ...prev, signers };
      });
    }
  }

  // Shared "an external signer just gave us a PSBT" handler. Used
  // by the textarea paste flow, the QR scanner, and the Tapit
  // cross-tab handoff (Cut B stage B2) so the merge + signer-session
  // logging only lives in one place. label distinguishes the source
  // in the audit trail without needing a proposal-level column --
  // signers can genuinely mix methods (one via mnemonic, one via
  // Tapit, one via hardware), so per-signature attribution here is
  // the honest place for it, not a single proposals.signing_method.
  function externalImport(importedHex: string, label: string = "Hardware wallet") {
    if (!signing) return;
    const merged = mergePsbts([signing.psbt_hex, importedHex]);
    const totalSigs = signaturesTowardPath(merged);
    if (signing.proposal_id) {
      api.signerSessions
        .submit({
          proposal_id: signing.proposal_id,
          psbt_partial_hex: importedHex,
          label,
        })
        .catch(() => {
          /* best-effort; local merge is authoritative for this browser */
        });
    }
    setSigning(prev =>
      prev ? { ...prev, psbt_hex: merged, signaturesCollected: totalSigs } : prev,
    );
  }

  async function broadcast() {
    if (!signing) return;
    setBusy(true);
    try {
      // Finalize via Fly.io
      const finalized = await api.psbt.finalize(signing.psbt_hex);

      // Sending again a transaction the network already has counts as sent
      // (lib/broadcast.ts), so this button can safely be pressed twice.
      const txid = await sendRawTx(vault.network, finalized.raw_tx_hex, finalized.txid);
      // From here the money has moved: nothing below may call it a failure.
      setSigning(prev => prev ? { ...prev, txid } : prev);

      // Update proposal. mempool.space can take a few seconds to show a
      // transaction that was just sent; the record is retried, and if it
      // still fails the done screen says so and offers to record it.
      let recorded = true;
      if (signing.proposal_id) {
        const pid = signing.proposal_id;
        try {
          await recordBroadcast(() => api.proposals.update(pid, { status: "broadcast", txid }));
          setRecordErr(null);
        } catch (e) {
          recorded = false;
          setRecordErr(e instanceof Error ? e.message : "Could not record it");
        }

        // Close the loop on a beneficiary's distribution request: it
        // was pending/approved while this proposal was being built,
        // now the payment actually happened, so mark it fulfilled and
        // link it to the proposal that paid it. Non-fatal -- the funds
        // already moved; a failure here is an audit-trail gap to fix
        // later, not a reason to hide the successful broadcast.
        if (prefill?.request_id) {
          try {
            await api.vaultRequests.update(prefill.request_id, {
              status: "fulfilled",
              linked_proposal_id: signing.proposal_id,
            });
          } catch {
            /* non-fatal: broadcast already happened */
          }
        }
      }

      // Close the loop on a distribution-wallet tranche funding: this
      // send originated from the "Fund" button on a specific tranche,
      // so stamp that tranche's funded_txid. Fetch fresh rather than
      // trust a closed-over copy of the wallet, since the whole
      // tranches array must be sent back on PATCH (distribution
      // wallets have no per-tranche update endpoint). Non-fatal for
      // the same reason as the request-fulfillment closure above.
      if (prefill?.distribution_wallet_id && prefill.tranche_index != null) {
        try {
          const { wallets } = await api.distributionWallets.list(vault.id);
          const dw = wallets.find(w => w.id === prefill.distribution_wallet_id);
          if (dw) {
            const tranches = dw.tranches.map(t =>
              t.index === prefill.tranche_index ? { ...t, funded_txid: txid } : t,
            );
            await api.distributionWallets.update(dw.id, { tranches });
          }
        } catch {
          /* non-fatal: broadcast already happened */
        }
      }

      // Advance the stipend's next_due_at by its interval so the
      // schedule ticks forward without manual bookkeeping.
      if (prefill?.stipend_id && prefill.stipend_interval) {
        const next = advanceDueDate(new Date(), prefill.stipend_interval).toISOString();
        try {
          await api.stipends.update(prefill.stipend_id, {
            next_due_at: next,
            last_proposed_at: new Date().toISOString(),
            last_proposal_id: signing.proposal_id ?? null,
          });
        } catch {
          /* non-fatal: broadcast already happened */
        }
      }

      setStep("done");
      // As before: on to History after a moment -- unless the record still
      // needs doing, which the done screen offers.
      if (recorded) setTimeout(onDone, 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Broadcast failed");
    } finally {
      setBusy(false);
    }
  }

  // Done screen
  if (step === "done" && signing?.txid) {
    return (
      <div
        style={{
          background: colors.successBg,
          border: `1px solid ${colors.green}44`,
          borderRadius: 16,
          padding: 32,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 52, marginBottom: 12 }}>sent</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: colors.green, marginBottom: 8 }}>
          Transaction broadcast
        </div>
        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 15,
            color: colors.muted,
            marginBottom: 20,
            wordBreak: "break-all",
          }}
        >
          {signing.txid}
        </div>
        <a
          href={explorerTxUrl(vault.network, signing.txid)}
          target="_blank"
          rel="noreferrer"
          style={{ color: colors.gold, fontSize: 17 }}
        >
          View on mempool.space
        </a>
        {recordErr ? (
          <div style={{ marginTop: 20, textAlign: "left", fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>
            The money is sent. It isn't in this vault's history yet: {recordErr}
            <Button style={{ width: "100%", marginTop: 12, minHeight: 44 }} disabled={busy} onClick={() => void recordAgain()}>
              {busy ? "Recording..." : "Record it in history"}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // Signing screen
  if (step === "signing" && signing) {
    const quorumMet = signing.signaturesCollected >= signing.requiredSignatures;
    const needed = signing.requiredSignatures - signing.signaturesCollected;

    function copyPsbt(text: string, id: string) {
      navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1600);
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Summary card */}
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 14 }}>
            Transaction
          </div>
          {[
            ["To", signing.summary.destination],
            ["Amount", `${satsToBtc(signing.summary.amount_sats)} BTC`],
            ["Fee", `${satsToBtc(signing.summary.fee_sats)} BTC (~${signing.summary.fee_rate} sat/vb)`],
            ["Change back", `${satsToBtc(signing.summary.change_sats)} BTC`],
          ].map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <span style={{ fontSize: 17, color: colors.muted }}>{k}</span>
              <span
                style={{
                  fontSize: 17,
                  color: colors.text,
                  fontFamily: k === "To" ? fonts.mono : "inherit",
                  wordBreak: "break-all",
                  textAlign: "right",
                  maxWidth: "60%",
                }}
              >
                {v}
              </span>
            </div>
          ))}

          {/* Signature progress */}
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 16, color: colors.muted }}>Signatures</span>
              <span style={{ fontSize: 16, color: quorumMet ? colors.green : colors.orange }}>
                {signing.signaturesCollected} / {signing.requiredSignatures} required
              </span>
            </div>
            <div style={{ height: 4, background: colors.border, borderRadius: 2 }}>
              <div
                style={{
                  height: "100%",
                  borderRadius: 2,
                  background: quorumMet ? colors.green : colors.gold,
                  width: `${Math.min(100, (signing.signaturesCollected / signing.requiredSignatures) * 100)}%`,
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>
        </div>

        {/* Browser keys signing -- Tapit-origin keys hold no local private
            material (importTapitPubkey stores pubkey only, see keystore.ts)
            so they can never actually unlock here; they're excluded from
            this list and only ever offered via "Notify circle via Nostr"
            below, which is what they were always meant for. Filtering by
            index (not a plain .filter()) keeps each row's signWithKey(i)
            call pointed at the right entry in the full signing.signers
            array, which NotifyCircleViaNostr and the quorum progress bar
            above both still read unfiltered. */}
        {signing.signers.some(s => s.key.origin !== "tapit") && (
          <div
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 20,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
              Sign with browser keys
            </div>
            <div style={{ fontSize: 16, color: colors.muted, marginBottom: 14 }}>
              Tap a key to sign.{" "}
              {signing.requiredSignatures > 1
                ? `Need ${signing.requiredSignatures} signatures.`
                : "Only 1 signature needed."}
            </div>
            {signing.signers.map((signer, i) => {
              if (signer.key.origin === "tapit") return null;
              const statusIcon =
                signer.status === "signed"
                  ? "Signed"
                  : signer.status === "signing"
                    ? "Signing..."
                    : signer.status === "error"
                      ? "Error"
                      : "Tap to sign";
              const accent =
                signer.status === "signed"
                  ? colors.green
                  : signer.status === "error"
                    ? colors.red
                    : signer.status === "signing"
                      ? colors.gold
                      : colors.muted;
              return (
                <div
                  key={signer.key.keyId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 14px",
                    borderRadius: 10,
                    marginBottom: 8,
                    background: signer.status === "signed" ? `${colors.green}0D` : colors.inset,
                    border: `1px solid ${signer.status === "signed" ? `${colors.green}44` : colors.border}`,
                    cursor:
                      signer.status === "pending" || signer.status === "error"
                        ? "pointer"
                        : "default",
                    opacity: signer.status === "signing" ? 0.7 : 1,
                  }}
                  onClick={() =>
                    (signer.status === "pending" || signer.status === "error") &&
                    void signWithKey(i)
                  }
                >
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 500, color: colors.text }}>
                      {signer.key.label}
                    </div>
                    <div style={{ fontSize: 15, color: colors.muted }}>
                      {signer.key.persona} / {signer.key.fingerprint}
                      {signer.key.testMnemonic ? " / test key" : ""}
                    </div>
                    {signer.error && (
                      <div style={{ fontSize: 15, color: colors.red, marginTop: 4 }}>
                        {signer.error} -- tap to retry
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: accent }}>
                    {statusIcon}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* "Sign via Tapit" (Cut B stage B2 -- window.open a new tab to
            Tapit's /sign route) is retired from this vault flow: it forced
            a fresh browser tab to re-establish its own Tapit session,
            which read as "trying to log me in" (operator, 2026-08-08).
            NotifyCircleViaNostr below does the same job silently over
            Nostr with no navigation and no second tab. 2026-08-15: the
            Tranche distribution-wallet claim flow (TrancheClaimModal,
            below in this file) hit the identical bug and got the same
            fix -- startTapitCosign/lib/tapit-cosign.ts's window.open
            cross-tab bridge has no remaining caller anywhere in this
            repo as of that fix. */}
        {/* Enough signatures: Broadcast is the next thing, right here
            (operator, 2026-11-25: "No buried ... buttons"). The other ways
            to sign are no longer needed. */}
        {quorumMet && err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
        {quorumMet && (
          <Button
            disabled={busy}
            style={{ background: colors.green, width: "100%", padding: "14px", fontSize: 18, minHeight: 52 }}
            onClick={() => void broadcast()}
          >
            {busy ? "Broadcasting..." : err ? "Retry broadcast" : "Broadcast transaction"}
          </Button>
        )}

        {!quorumMet && (
        <NotifyCircleViaNostr
          subjectId={signing.proposal_id ?? ""}
          psbtHex={signing.psbt_hex}
          vaultDescriptor={vault.descriptor}
          vaultName={vault.name}
          signers={signing.signers}
          onSigned={(hex, label) => externalImport(hex, label)}
        />
        )}

        {/* Hardware wallet / external PSBT */}
        {!quorumMet && (
        <div
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            Sign with hardware wallet
          </div>
          <div style={{ fontSize: 16, color: colors.muted, marginBottom: 14 }}>
            Export this transaction to your signing device, then paste or scan the signed result back here.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => copyPsbt(signing.psbt_hex, "hex")}
            >
              {copied === "hex" ? "Copied!" : "Copy PSBT hex"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => copyPsbt(signing.psbt_b64, "b64")}
            >
              {copied === "b64" ? "Copied!" : "Copy base64"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => setShowQrDisplay(s => !s)}
            >
              {showQrDisplay ? "Hide QR" : "Show QR"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 16 }}
              onClick={() => setShowQrScanner(s => !s)}
            >
              {showQrScanner ? "Hide scanner" : "Scan signed QR"}
            </Button>
          </div>
          {showQrDisplay && (
            <div style={{ marginBottom: 14 }}>
              <PsbtQrDisplay psbtHex={signing.psbt_hex} />
              <div style={{ fontSize: 15, color: colors.muted, marginTop: 6, textAlign: "center" }}>
                UR `crypto-psbt` animated. Stateless -- no pairing needed. Point your air-gapped signer at the screen.
              </div>
              <SeedSignerNetworkHint network={vault.network} />
            </div>
          )}
          {showQrScanner && (
            <div style={{ marginBottom: 14 }}>
              <PsbtQrScanner
                onResult={hex => {
                  setShowQrScanner(false);
                  // Reuse the existing import path so signer-sessions
                  // logging + state-set logic stays in one place.
                  externalImport(hex);
                }}
                onCancel={() => setShowQrScanner(false)}
              />
            </div>
          )}
          <ExternalPsbtInput onImport={externalImport} />
        </div>
        )}

        {/* Still short: how many more, under the ways to sign. */}
        {err && !quorumMet && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}
        {!quorumMet && (
          <div style={{ fontSize: 17, color: colors.muted, textAlign: "center", padding: "10px 0" }}>
            {needed} more signature{needed !== 1 ? "s" : ""} needed
          </div>
        )}

        <Button
          variant="ghost"
          style={{ width: "100%", marginTop: 20, minHeight: 44, color: colors.red }}
          onClick={async () => {
            // This used to only clear the form: the spend stayed open in
            // History, waiting on signatures nobody meant to give.
            const id = signing?.proposal_id;
            if (id && !signing?.txid && signing && signing.signaturesCollected > 0) {
              const ok = await confirmCancel({ title: "Cancel this spend?", message: "The signatures collected so far are discarded.", confirmLabel: "Cancel this spend", danger: true });
              if (!ok) return;
            }
            if (id && !signing?.txid) {
              try {
                await api.proposals.update(id, { status: "cancelled" });
              } catch (e) {
                setErr(`This spend could not be cancelled: ${e instanceof Error ? e.message : "failed"}. It is still open in History.`);
                return;
              }
            }
            setStep("form");
            setSigning(null);
            setErr(null);
          }}
        >
          Cancel this spend
        </Button>
        {signing?.proposal_id && !signing.txid && (
          <Button
            variant="ghost"
            style={{ width: "100%" }}
            onClick={() => {
              setStep("form");
              setSigning(null);
              setErr(null);
            }}
          >
            Leave it open for the others to sign
          </Button>
        )}
      </div>
    );
  }

  // Form screen
  return (
    <>
    {/* Operator's chips, 2026-11-24: the coins and when each path opens for
        each one; picking coins is optional -- the app picks the fewest. */}
    {/* Optional, so closed: the form comes first (operator, 2026-11-25,
        docs/screen-cleanse-build-note.md). */}
    {vault.status !== "draft" && onPickCoins && (
      <div style={{ marginBottom: 14, maxWidth: 480 }}>
        <button
          type="button"
          onClick={() => setPickCoins(v => !v)}
          aria-expanded={pickCoins}
          style={{ background: "none", border: "none", padding: "10px 0", minHeight: 44, fontSize: 16, color: colors.sub, cursor: "pointer", textDecoration: "underline", textAlign: "left" }}
        >
          {pickCoins ? "Hide the coins" : "Choose which coins to spend (optional -- the app picks if you don't)"}
        </button>
        {pickCoins && (
          <div style={{ fontSize: 15, color: colors.muted, lineHeight: 1.5, marginBottom: 8 }}>
            Left to itself, the app spends your largest confirmed coins first. If you are not spending the full
            balance, that can join separate deposits in one public transaction. Pick coins here if that matters.
          </div>
        )}
        {pickCoins && (
          <UtxosSection vault={vault} onSendPrefill={p => onPickCoins({ ...(prefill ?? {}), ...p })} refreshKey={`${balance?.total_sats ?? ""}:${balance?.utxo_count ?? ""}`} balance={balance} />
        )}
      </div>
    )}
    <form
      onSubmit={e => void buildAndSign(e)}
      style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 480 }}
    >
      {prefill?.selected_utxos && prefill.selected_utxos.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            background: colors.gold + "11",
            border: `1px solid ${colors.gold}44`,
            borderRadius: radii.md,
            fontSize: 16,
            color: colors.gold,
          }}
        >
          Locked to {prefill.selected_utxos.length} UTXO
          {prefill.selected_utxos.length === 1 ? "" : "s"}:{" "}
          <span style={{ fontFamily: fonts.mono, fontSize: 15 }}>
            {prefill.selected_utxos.map(u => `${u.txid.slice(0, 8)}:${u.vout}`).join(", ")}
          </span>
          {prefill.selected_utxos.length > 1 && (
            <div style={{ marginTop: 4, color: colors.muted }}>
              Spending these together publicly links them to the same
              owner forever, even if they arrived separately.
            </div>
          )}
          {onPickCoins && (
            <div style={{ marginTop: 6 }}>
              <Button type="button" variant="ghost" size="sm" style={{ fontSize: 15, minHeight: 44 }}
                onClick={() => onPickCoins({ ...(prefill ?? {}), selected_utxos: undefined })}>
                Let the app choose the coins
              </Button>
            </div>
          )}
        </div>
      )}

      {bp && (
        <div>
          <Label>Spend path</Label>
          <select
            value={blocPath}
            onChange={e => { setBlocPath(e.target.value as typeof blocPath); setBlocRungIdx(0); }}
            style={selectStyle}
          >
            <option value="parents_now">Parents together ({bp.parents_together_quorum} of {bp.parent_pubkeys.length}) -- now</option>
            <option value="coparent_kids">One parent + the kids ({bp.coparent_quorum} parent + {bp.kids_with_parent_quorum} of {bp.kid_pubkeys.length} kids) -- now</option>
            <option value="parent_solo">One parent alone ({bp.parent_solo_quorum} of {bp.parent_pubkeys.length}) -- after timelock</option>
            <option value="kids_decay">Kids alone (decaying quorum) -- after timelock</option>
          </select>
          {blocPath === "kids_decay" && (
            <select
              value={blocRungIdx}
              onChange={e => setBlocRungIdx(Number(e.target.value))}
              style={{ ...selectStyle, marginTop: 8 }}
            >
              {blocLadder.map((rung, i) => (
                <option key={i} value={i}>
                  {rung.q} of {bp.kid_pubkeys.length} kids -- after block {rung.absAfter.toLocaleString()}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {!bp && (hasRecovery || hasInheritance || hasBackup || hasSecondInheritance) && (
        <div>
          <Label>Spend path</Label>
          <select
            value={standardPath}
            onChange={e => setStandardPath(e.target.value as typeof standardPath)}
            style={selectStyle}
          >
            <option value="founders_now">
              Founders now ({vault.founder_quorum} of {vault.founder_keys.length}) -- no waiting
            </option>
            {hasRecovery && (
              <option value="recovery">
                Recovery ({vault.recovery_quorum ?? vault.founder_quorum} of {vault.founder_keys.length} founders) -- after timelock
              </option>
            )}
            {hasInheritance && (
              <option value="inheritance">
                Inheritance ({vault.heir_quorum} of {vault.heir_keys.length} heirs) -- after timelock
              </option>
            )}
            {hasBackup && (
              <option value="backup">
                Backup ({vault.backup_quorum} of {vault.backup_keys.length}) -- anytime, no timelock
              </option>
            )}
            {hasSecondInheritance && (
              <option value="second_inheritance">
                Second inheritance ({vault.second_heir_quorum} of {vault.second_heir_keys.length} heirs) -- after its own timelock
              </option>
            )}
          </select>
          {standardPath !== "founders_now" && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 5 }}>
              {standardPath === "backup"
                ? "This path has no timelock, but it needs a separate set of keys from the day-to-day founders."
                : standardPath === "second_inheritance"
                  ? "This path is a separate heir group from the main inheritance path, with its own timelock -- only spendable once that timelock has passed."
                  : "This path is only spendable once its timelock has passed -- the compiler will reject the build otherwise."}
            </div>
          )}
        </div>
      )}

      {/* Leaf-list vault: the path picker uses each leaf's own id, not the
          named-field ids above -- see isLeafList's header comment. Hidden
          entirely for a single-leaf vault, matching the named-field
          dropdown's own "only show a picker once there's a real choice"
          behavior. */}
      {!bp && isLeafList && vault.leaves!.length > 1 && (
        <div>
          <Label>Spend path</Label>
          <select
            value={standardPath}
            onChange={e => setStandardPath(e.target.value)}
            style={selectStyle}
          >
            {vault.leaves!.map(leaf => (
              <option key={leaf.id} value={leaf.id}>
                {leaf.label} ({whoSignsShort(leaf.quorum, leaf.keys.length, leaf.required_keys?.length ?? 0)})
                {leaf.unlock.type === "immediate"
                  ? " -- no waiting"
                  : leaf.unlock.type === "after"
                    ? ` -- after block ${leaf.unlock.blocks.toLocaleString()}`
                    : " -- once untouched for a while"}
              </option>
            ))}
          </select>
          {vault.leaves!.find(l => l.id === standardPath)?.unlock.type !== "immediate" && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 5 }}>
              This path is only spendable once its timelock has passed -- the compiler will reject
              the build otherwise.
            </div>
          )}
        </div>
      )}

      <div>
        <Label>Send to</Label>
        <Input
          mono
          value={dest}
          onChange={e => setDest(e.target.value)}
          required
          placeholder="tb1p... or bc1p..."
        />
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <Label>Amount (BTC)</Label>
          {sweep ? (
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 17,
                color: colors.text,
              }}
            >
              Entire confirmed balance -- exact amount is computed when you build (fee comes off the top, no change back to the vault)
            </div>
          ) : (
            <Input
              type="number"
              step="0.00000001"
              min="0.00000546"
              value={amountBtc}
              onChange={e => setAmountBtc(e.target.value)}
              required
              placeholder="0.001"
            />
          )}
          {confirmedSats > 0 && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 5 }}>
              {satsToBtc(confirmedSats)} BTC available
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  color: colors.gold,
                  cursor: "pointer",
                  fontSize: 15,
                  marginLeft: 8,
                }}
                onClick={() => {
                  setSweep(s => !s);
                  setAmountBtc("");
                }}
              >
                {sweep ? "Enter amount instead" : "Max"}
              </button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <Label>Fee (sat/vb)</Label>
          <Input
            type="number"
            step="0.1"
            min="1"
            value={feeRate}
            onChange={e => setFeeRate(e.target.value)}
            placeholder="Auto"
          />
        </div>
      </div>

      {rules.length > 0 && (
        <div>
          <Label>Distribution rule</Label>
          <select
            value={ruleId}
            onChange={e => setRuleId(e.target.value)}
            style={{
              width: "100%",
              padding: "11px 13px",
              background: colors.input,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              color: colors.text,
              fontSize: 17,
              fontFamily: fonts.sans,
              boxSizing: "border-box",
            }}
          >
            <option value="">-- pick a rule --</option>
            {rules.map(r => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.max_sats ? ` (max ${satsToBtc(r.max_sats)} BTC)` : ""}
              </option>
            ))}
          </select>
          {selectedRule?.notes && (
            <div style={{ fontSize: 15, color: colors.muted, marginTop: 6 }}>
              {selectedRule.notes}
            </div>
          )}
        </div>
      )}

      <div>
        <Label>
          {selectedRule?.requires_comment
            ? "Reason (required by this rule)"
            : "Memo (optional)"}
        </Label>
        <Input
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder={
            selectedRule?.requires_comment
              ? "Why this spend? Which clause of the trust does it satisfy?"
              : "Note"
          }
        />
      </div>

      {err && <p style={{ color: colors.red, fontSize: 17, margin: 0 }}>{err}</p>}

      <Button
        type="submit"
        disabled={busy}
        style={{ padding: "14px", fontSize: 17 }}
      >
        {busy ? (slowHint ? "Waking compiler..." : "Building transaction...") : "Review & sign"}
      </Button>
    </form>
    </>
  );
}
