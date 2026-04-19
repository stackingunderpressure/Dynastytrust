# Firmware integration patch

This directory holds the patch you apply to a fork of
[selfcustody/krux](https://github.com/selfcustody/krux) to wire the
DynastyTrust trust-mode signer into Krux's signing flow.

## Strategy

We do not vendor Krux's source here. Instead, this directory contains:

- `krux_psbt_patch.py` — a single drop-in `policy_guard_check()`
  function the upstream `krux/psbt.py` calls before signing
- `INTEGRATION.md` — step-by-step instructions for wiring it into your
  Krux fork (which file to edit, where to insert the call, what the
  diff looks like)
- `dynasty_pages_skeleton.py` — `krux/pages/dynasty_*.py` skeletons
  matching upstream's `Page` subclass conventions

The reason for hand-applied patches rather than a forked vendor tree:
upstream Krux moves fast (monthly releases) and a vendored fork would
diverge in days. The patch surface is small (~80 lines of integration
across 4 files); rebasing is cheap.

## When you fork Krux for this

```
git clone https://github.com/selfcustody/krux dynastytrust-krux-fw
cd dynastytrust-krux-fw
git checkout v26.03.0  # pin to the audited release
git checkout -b dynasty-trust-mode

# Vendor the dynastytrust-krux package as a submodule under src/
git submodule add https://github.com/stackingunderpressure/dynastytrust-krux src/krux/dynasty-pkg
ln -s src/krux/dynasty-pkg/src/krux/dynasty src/krux/dynasty

# Apply the patch
cp ../dynastytrust-krux/firmware/krux_psbt_patch.py src/krux/dynasty_signing_hook.py
cp ../dynastytrust-krux/firmware/dynasty_pages_skeleton.py src/krux/pages/dynasty_provision.py
# ... edit src/krux/psbt.py per INTEGRATION.md

# Build (requires Krux toolchain; see upstream BUILD.md)
make
```

## Build flags

To produce a developer/test build that allows multiple roles per
device (see `allowlist.py`), pass `DT_TEST_MODE=1` at make time. Krux
already supports `--devkit` builds; we layer this flag on top:

```
DT_TEST_MODE=1 make devkit
```

The dev banner ("DEV BUILD - DO NOT USE FOR REAL FUNDS") is shown on
boot and on every confirmation screen.

Production builds never set this flag and refuse to load any
allowlist record carrying `test_mode=true`.
