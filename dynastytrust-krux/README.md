# dynastytrust-krux

Narrow-scope Taproot trust-policy signing extension for the [Krux](https://selfcustody.github.io/krux/) air-gapped hardware signer.

**Status.** Phase 1 -- policy template module + canonicalizer + tests. No UI, no signing wired. The Krux firmware integration happens in later phases.

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
  templates.py        Template definitions + AST canonicalizer + classifier
  allowlist.py        (Phase 2) Per-wallet persistent trust-mode state
  policy_guard.py     (Phase 2) Pre-sign validator hook
  timelock.py         (Phase 3) Absolute-block -> "unlocks in N months"
  ui.py               (Phase 3) Screens: approval prompt, path display, toggle
tests/
  test_templates.py   Canonicalize + classify + reject cases
```

Upstream Krux lives at [selfcustody/krux](https://github.com/selfcustody/krux). This is a separate package that will integrate as a submodule or vendored extension when we reach Phase 3 firmware wiring.

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
