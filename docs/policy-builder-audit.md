# PolicyBuilder audit -- every control, and the salvage/cut/combine plan

Status: audit + plan, 2026-07-20. Scope: `apps/web/src/pages/PolicyBuilder.tsx`
(2,588 lines) and the surfaces that feed it (`StartVault.tsx`, `ChatWizard.tsx`
/ Sage, `BlocBuilder.tsx`). This is the execution spec for de-cluttering the
builder; it changes no behavior on its own.

---

## 1. The core diagnosis (why it feels discombobulating)

The page is trying to be three products at once, all stacked on one scroll with
no progressive disclosure:

1. **A template gallery** -- 11 cards, each with two buttons (22 buttons), plus
   a Dynasty Bloc promo card. That is ~25 buttons before you touch a single key.
2. **An expert field-by-field policy editor** -- mode toggle, address type,
   founder keys + quorum, recovery quorum, heir keys + quorum, protector +
   its own timelock, beneficiary consent, and two raw block-count timelocks.
   Everything renders at once in inheritance mode.
3. **Two different save flows shown simultaneously** -- "Save as draft" (invite
   co-signers, compile later) and "Compile immediately" (all keys now). They
   take overlapping-but-different inputs, and nothing tells the user which one
   they are supposed to use.

On top of that, the SAME shape can now be chosen in three places -- the
`/start` intent cards, Sage, and this in-page gallery -- so the gallery is
redundant with the front door that was built to replace it. And expert footguns
are exposed inline to a first-time user: the address-type dropdown still offers
"Taproot single leaf" (the documented `DuplicatePubKeys` footgun), timelocks are
entered in raw blocks, and the protector/consent/recovery-quorum controls (real
expert territory) sit open by default.

The fix is not to redesign the cryptography -- that part is correct and
load-bearing. The fix is to make this page do ONE job: the tune-and-compile
workbench you land in AFTER a shape has been chosen elsewhere.

---

## 2. Every control, its reason, and a verdict

Legend: KEEP (core work), CUT (remove from this page), COMBINE (merge to kill
redundancy), DEMOTE (move behind an "Advanced" disclosure).

### 2a. Template picker section ("Start from a template")

| Control | What it does | Reason it exists | Verdict |
|---|---|---|---|
| Dynasty Bloc promo card + "Open Bloc builder ->" | Navigates to `/policy/bloc` | Advertise the decaying-multisig builder | CUT -- Bloc is already reachable from `/start` ("Pass it to my kids"). Second entry point buried in a gallery is redundant. |
| "Production" grid -- 7 template cards | Visual catalog of vault shapes | Let a cold visitor pick a shape | CUT the gallery here; KEEP templates as DATA. `/start` + Sage already choose the shape and prefill this page. |
| Each card: "Use this template" | `applyTemplate()` -- sets mode, quorums, timelocks, name, trust-doc, scrolls to keys | Apply a shape in one tap | COMBINE into the prefill path (the shape arrives from `/start`/Sage); for a cold expert, replace 11 cards with one compact "shape" dropdown. |
| Each card: "What if... (N)" | Toggles the scenario playbook (trustee dies, beneficiary refuses, etc.) | Teach the failure modes before committing | KEEP the content, MOVE it. These playbooks are the wedge (teaching), but they belong at the CHOOSING step (`/start` detail or Sage), not behind a button in a dense builder grid. |
| "Test mode" grid -- 4 [TEST] cards | Same shapes with block-sized timelocks for signet | Let a developer rehearse recovery/inheritance in hours | DEMOTE -- hide behind an explicit "rehearsal / developer" toggle or `?test` flag. A first-time family should never see four signet cards. |

### 2b. Shape controls

| Control | What it does | Reason | Verdict |
|---|---|---|---|
| "Vault type" Plain / Inheritance toggle | Switches whole form between no-timelock and inheritance shapes | Let the user pick the family of vault | COMBINE/DEMOTE -- the chosen template/intent ALREADY sets this. Asking again duplicates the decision. Derive it; keep only as an advanced override. |
| "Vault name" input | Names the vault | Needed | KEEP. |
| "Address type" select (tr_multileaf / wsh / tr) | Chooses descriptor script type | Expert flexibility | DEMOTE hard. Default `tr_multileaf` always (per CLAUDE.md). Never surface "Taproot single leaf" to a normal user -- it is the `DuplicatePubKeys` footgun. Move behind Advanced. |

### 2c. Keys and quorums

| Control | What it does | Reason | Verdict |
|---|---|---|---|
| Founder/Signing SlotHint | "N of M slots filled" + empty slot chips | Show progress toward the template's planned count | KEEP (this is good UX). |
| Founder KeyPicker (select to add, "x" to remove) | Adds/removes founder keys from the local keyring | Core -- pick who signs | KEEP. |
| Founder QuorumPicker (1..M buttons) | Sets how many founders must sign | Core | KEEP. |
| "Recovery quorum after timelock" QuorumPicker + warning | Sets Path 2 quorum, warns if >= normal quorum | Make the recovery path grant a real new capability | DEMOTE -- real expert control. Collapse into "Advanced governance." Default (founderQ-1) is already sensible. |
| Heir KeyPicker + SlotHint + QuorumPicker | Picks heirs and their quorum (inheritance only) | Core inheritance | KEEP. |
| Protector KeyPicker + QuorumPicker + "Protector timelock (blocks)" input + 2 warnings | Optional independent rescuer with its own timelock | Institutional shape (Generational Trust) | DEMOTE -- collapse into "Advanced governance," off by default. Most families never use it. Timelock in raw blocks -> use human presets. |
| Beneficiary consent KeyPicker + QuorumPicker + warning | Optional cosign gate on Path 1 | Give a beneficiary veto without custody | DEMOTE -- same drawer as protector. |

### 2d. Timelocks

| Control | What it does | Reason | Verdict |
|---|---|---|---|
| "Recovery after" + "Inheritance after": 5 preset buttons each (6mo/1yr/2yr/3yr/5yr) | Set timelock durations in human terms | Core -- and the presets are the RIGHT surface | KEEP the presets as the primary control. |
| Raw "blocks" number input + "blocks (~10 min each)" | Enter an exact block offset | Expert precision | DEMOTE -- hide the raw block field behind Advanced; `blocksToHuman()` already renders the friendly value. Blocks are jargon a family should not have to touch. |

### 2e. The two save flows (the biggest single problem)

| Control | What it does | Reason | Verdict |
|---|---|---|---|
| "Save as draft": Planned founder/heir count inputs + "Save draft vault" | Creates the vault shape now, invite co-signers later, compile when full (`createDraft`) | Multi-member vaults where co-signers supply their own xpubs | COMBINE. This is one of two parallel creation paths shown at once. |
| "Compile immediately": "Compile ->" / "Recompile" | Sends all local keys to the Fly compiler, returns descriptor (`compile`) | Single-operator who holds every xpub | COMBINE. |
| "Planned founder count" vs the founder KeyPicker/slots | Two representations of the same number | Draft needs a count; compile needs actual keys | COMBINE -- the slots ARE the plan. An empty slot means "invite later"; a filled slot means "I have this key." One model, not two inputs. |

### 2f. Compile output + save (KEEP -- this is the product)

| Control | What it does | Reason | Verdict |
|---|---|---|---|
| CopyField x4: address, descriptor, miniscript, BSMS | Copy the compiled artifacts for Nunchuk/Sparrow/Coldcard | The descriptor + PSBT seam IS the architecture-of-record wedge | KEEP all four. |
| DescriptorQr (in backup modal) | Sparrow-ready QR | Frictionless import | KEEP. |
| TOS checkbox + links | Records terms acceptance with the vault | Audit trail / legal | KEEP. |
| "Save vault ->" | Persists the compiled vault (`save`) | Core | KEEP. |
| BackupNudgeModal: "Download backup file", metal-backup checkbox, "Open vault" | Forces descriptor download + metal-backup ack before proceeding | Safety -- lose the descriptor, lose the vault | KEEP (this is exactly the right kind of friction). |

---

## 3. The plan -- salvage, cut, combine

### Salvage (this is the real work, keep it)
- The KeyPickers, QuorumPickers, SlotHint, validation errors/warnings.
- Compile -> the four CopyFields -> TOS -> Save -> BackupNudgeModal.
- The timelock PRESET buttons (human durations).
- Templates as DATA (config + trustDoc + scenarios) -- reused as prefill and as
  teaching content, just not rendered as a 22-button gallery here.
- The "What if..." scenario playbooks -- moved to the choosing step.

### Cut (remove from this page)
- The 11-card template gallery and its 22 buttons.
- The Dynasty Bloc promo card (redundant second entry to `/policy/bloc`).
- The four [TEST] cards from the default view (behind a developer toggle).
- "Taproot single leaf" as a user-visible option.

### Combine (kill the redundancy)
- **The two save flows -> one readiness-driven action.** A single primary button
  that reads state: if every slot has a local key -> "Compile & review"; if any
  slot is still empty (co-signers to invite) -> "Save draft & invite." The other
  becomes a quiet secondary link. Never both shouting at once.
- **Planned counts -> the slots themselves.** Delete the separate "Planned
  founder/heir count" inputs. Adding a key fills a slot; leaving a slot empty IS
  the plan to invite. One mental model.
- **Recovery quorum + protector + consent -> one "Advanced governance" drawer,**
  collapsed by default, auto-expanded only when the chosen template uses them
  (Generational Trust). Family Inheritance never opens it.
- **Vault type + address type -> derived, not asked.** The shape sets the mode;
  address type is always tr_multileaf. Both live in an Advanced override only.

---

## 4. Proposed new shape of /policy (the workbench)

The page stops being a gallery and becomes the place you land AFTER `/start` or
Sage has chosen a shape:

1. **Thin context header** -- "Building: Family Inheritance" with a "change"
   link back to `/start`. No gallery. (Cold expert with no prefill: one compact
   "shape" dropdown here instead of 11 cards.)
2. **Name** (Advanced reveals address type).
3. **Keys** -- founders (slots + quorum), heirs (slots + quorum). Empty slot
   reads "Invite a co-signer." The slots are the plan.
4. **Timelocks** -- human presets only (Advanced reveals raw blocks).
5. **Advanced governance (collapsed)** -- recovery quorum, protector, consent.
6. **One primary action** that reads readiness: "Compile & review" when keys are
   all present, else "Save draft & invite co-signers."
7. **Compile result -> TOS -> Save -> BackupNudge** -- unchanged.

Net effect: from ~25 always-visible buttons and two competing save flows down to
a handful of controls and one obvious next step, with every expert footgun behind
a disclosure and the teaching content moved to where the shape is actually chosen.

---

## 5. Suggested execution order (each a shippable slice)

1. **Collapse the two save flows into one readiness-driven action** and delete
   the "Planned count" inputs (slots become the plan). Biggest clarity win.
2. **Remove the gallery**: when prefilled (the normal path) hide the template
   grid entirely; for a cold expert, a single shape dropdown. Move the "What
   if..." playbooks to `/start`/Sage.
3. **Advanced-governance drawer** for recovery quorum + protector + consent;
   default address type and hide the single-leaf option.
4. **Timelocks**: presets primary, raw blocks behind Advanced.
5. **Developer toggle** for the [TEST] shapes; drop the Bloc promo card.

Each step is independent, keeps gates green, and shrinks the page without
touching the compile/PSBT core.

---

## 6. Progress

**2026-07-20 -- Slice 1 shipped + guardrail installed.**

- The two competing save flows are merged. "Save as draft" and "Compile
  immediately" are gone; in their place is one "Create your vault" section with a
  single readiness-driven primary action: when every planned slot holds a key you
  hold it defaults to "Compile & review," otherwise "Save draft & invite
  co-signers," with a quiet secondary link to force the other path. The
  createDraft / compile / save capabilities themselves are unchanged -- only how
  they are triggered.
- The planned-count inputs moved out of the old draft section and up into the key
  pickers ("How many founders in total?" / "How many heirs in total?"), so the
  slots ARE the plan -- a filled slot is a key you hold, an empty slot is a
  co-signer to invite. One model, not two.
- Footgun removed: the `tr` single-leaf address option is no longer offered
  (tr_multileaf and wsh remain); it was the documented DuplicatePubKeys trap.
- New gate `scripts/check-policy-builder.mjs`, wired into `npm test`, locks in
  the invariants so this cannot regress: safe address default, no single-leaf
  option, compile sends save:false, save records the TOS version, no alert(),
  both creation paths preserved, the merged flow stays merged, and a 2,700-line
  budget to stop re-bloat.
- Gates: build pass, lint pass (7 pre-existing warnings, none new), npm test pass
  (policy + rung-digest + policy-builder guardrail), typecheck unchanged (14
  pre-existing errors, none in PolicyBuilder). Runtime was NOT driven -- the
  sandbox has no Supabase/compiler and `/policy` is behind auth -- so the flow is
  verified by static gates, the new guardrail, and reading, not by exercising it
  in a browser. Worth a manual pass on device before funding a real vault.

**2026-07-20 -- Slice 2 shipped.**

- The 11-card, 22-button gallery is gone. When a shape arrives prefilled from
  `/start` or Sage (the normal path) the page shows a compact "Building: X"
  summary with that shape's what-if playbook; a cold expert with no shape picks
  from a single "Vault shape" dropdown. "Change shape" reopens the chooser.
- The failure-mode "what if..." teaching is preserved but shown ONCE, tied to
  the chosen shape (one `ScenarioToggle`), instead of a toggle on every card.
- The four signet [TEST] shapes are hidden behind a "Show rehearsal shapes"
  toggle -- a first-time family never sees them.
- The big gold Dynasty Bloc promo card is gone; the Bloc builder is now a quiet
  one-line link for the expert who needs it (and it is still on `/start`).
- Guardrail extended: the `TemplateCard` gallery must not return and the chooser
  must track the chosen shape via `templateId`. Line budget ratcheted 2700 ->
  2650. Gates green: build pass, lint pass (7 pre-existing warnings), npm test
  pass, typecheck unchanged (14 pre-existing, none in PolicyBuilder). Runtime
  still not driven in-sandbox -- verified by static gates + guardrail + reading.

**Still open: slices 3-5** (the advanced-governance drawer for recovery
quorum / protector / consent + demote the vault-type and address-type controls,
timelock presets-first with raw blocks behind Advanced, and a final pass on any
remaining redundancy).
