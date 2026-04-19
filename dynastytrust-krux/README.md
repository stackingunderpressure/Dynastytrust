# dynastytrust-krux

Narrow-scope Taproot trust-policy signing extension for the [Krux](https://selfcustody.github.io/krux/) air-gapped hardware signer.

**Status.** Phases 1-3 complete -- templates, policy guard, allowlist, descriptor hash, PSBT adapter, timelock formatter, on-device UI screens, and firmware integration patches. 90/90 tests passing. The remaining work is fork-side: clone Krux v26.03.0, apply `firmware/INTEGRATION.md`, build, run on real K210 hardware.

**Goal.** Turn a general-purpose signer into a safety-first template-driven signer. A Krux running this extension refuses to sign any PSBT whose tap-script tree is not one of five approved DynastyTrust templates.

**Approved V1 templates** (all under an unspendable BIP 341 NUMS internal key):

| Label           | Template                                                            | Use case                               |
|-----------------|---------------------------------------------------------------------|----------------------------------------|
| Normal          | `thresh(TrusteeQ, trustees)`                                        | Routine trustee spend                  |
| Recovery        | `and(after(R), thresh(RecoveryQ, trustees))`                        | Trustee recovery after lost device     |
| Inheritance     | `and(after(I), thresh(HeirQ, successors))`                          | Heir spend after inheritance elapses   |
| Protector       | `and(after(P), thresh(PQ, protectors))`                             | Protector rescue                       |
| Consent         | `and(thresh(TrusteeQ, trustees), thresh(CQ, consent_keys))`         | Routine spend gated on beneficiary ack |

Every other shape is rejected by design. Miniscript is powerful; this is deliberately small.

## Layout

```
src/krux/dynasty/
  templates.py        Template definitions + canonicalizer + classifier
                      + descriptor_hash + classify_with_scripts
  policy_guard.py     Pre-sign validator (signature-shape-agnostic)
  psbt_adapter.py     embit PSBT  ->  GuardInput / GuardOutput
  allowlist.py        Persistent provisioning state (one role per device,
                      JSON on the SD card, atomic writes)
  timelock.py         Absolute block height  ->  "unlocks in ~N months"
  ui.py               On-device screens: ProvisionScreen, PathChooserScreen,
                      ConfirmScreen + run_signing_flow composition
tests/
  test_templates.py        16 tests: classifier happy + rejection paths
  test_policy_guard.py     18 tests: validator happy + adversarial corpus
  test_psbt_adapter.py      7 tests: PSBT field extraction edge cases
  test_allowlist.py        25 tests: hashing + provisioning + persistence
  test_timelock.py         12 tests: every duration bucket + 3 unlock modes
  test_ui.py               12 tests: confirm + chooser + flow composition
firmware/
  README.md                Why this is patches not a vendor fork
  INTEGRATION.md           Step-by-step on top of selfcustody/krux v26.03.0
  krux_psbt_patch.py       Drop into src/krux/dynasty_signing_hook.py
  dynasty_pages_skeleton.py  Provisioning Page subclass for the menu
```

Upstream Krux lives at [selfcustody/krux](https://github.com/selfcustody/krux). When you fork Krux to apply this trust mode, vendor this package as a submodule (instructions in `firmware/INTEGRATION.md`).

## Running the tests

```
pip install -e .
pip install pytest
pytest
```

## Why not SeedSigner?

Audit rejected it -- tapscript signing is blocked in SeedSigner with an explicit `NotImplementedError` and the lift PR has sat unreviewed since June 2025. Krux has tapscript signing + NUMS internal key handling + multi-leaf change verification shipped since Feb 2025. We build on working infrastructure.

## Publishing to its own GitHub repo

This package lives under the main DynastyTrust monorepo at
`dynastytrust-krux/` for now (one commit-signing pipeline, one deploy
cadence). When ready to publish as a standalone project:

```
# From the main repo root:
git subtree split --prefix dynastytrust-krux -b krux-export
git clone . ../dynastytrust-krux-standalone
cd ../dynastytrust-krux-standalone
git checkout krux-export
git remote remove origin
git remote add origin git@github.com:stackingunderpressure/dynastytrust-krux.git
git push -u origin main
```

`git subtree split` preserves commit history for the subtree only; no
rewrite of the main repo is needed. We can move it whenever the
firmware integration begins in Phase 3.

## License

MIT. See [LICENSE](LICENSE).
