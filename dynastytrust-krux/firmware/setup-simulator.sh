#!/usr/bin/env bash
#
# setup-simulator.sh -- one-shot Krux + DynastyTrust trust mode bring-up
#
# What it does:
#   1. Clones selfcustody/krux at v26.03.0 to a sibling directory
#   2. Vendors this dynastytrust-krux package into the Krux source tree
#   3. Runs apply-patches.py to insert the trust-mode hook into the
#      upstream files
#   4. Tells you the exact command to launch the Pygame simulator
#
# What it does NOT do:
#   - Build the simulator (you run `poetry run poe simulator` after)
#   - Install Krux's own Python deps (poetry handles that on first run)
#   - Order hardware (talk to Sipeed)
#
# Run from the dynastytrust-krux/ directory:
#
#     bash firmware/setup-simulator.sh
#
# To rerun cleanly, delete the sibling clone first:
#
#     rm -rf ../dynastytrust-krux-fw
#

set -euo pipefail

# ---------------------------------------------------------------
# Configuration -- edit if you want different paths or pin
# ---------------------------------------------------------------

KRUX_REPO="https://github.com/selfcustody/krux.git"
KRUX_TAG="v26.03.0"                                # the audited release
FORK_DIR_NAME="dynastytrust-krux-fw"
PATCH_SCRIPT="firmware/apply-patches.py"

# ---------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------

# We expect to be run from the dynastytrust-krux package directory.
if [[ ! -f "pyproject.toml" ]] || ! grep -q "dynastytrust-krux" pyproject.toml; then
    echo "ERROR: run this from the dynastytrust-krux/ directory" >&2
    echo "Current cwd: $(pwd)" >&2
    exit 1
fi

# Tools we need on PATH.
for tool in git python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: $tool not on PATH" >&2
        exit 1
    fi
done

PKG_DIR="$(pwd)"
PARENT_DIR="$(cd .. && pwd)"
FORK_DIR="$PARENT_DIR/$FORK_DIR_NAME"

# ---------------------------------------------------------------
# 1. Clone Krux at the audited tag
# ---------------------------------------------------------------

if [[ -d "$FORK_DIR/.git" ]]; then
    echo "[1/4] Krux fork already exists at $FORK_DIR; skipping clone."
    echo "      To start fresh: rm -rf $FORK_DIR"
else
    echo "[1/4] Cloning Krux $KRUX_TAG into $FORK_DIR ..."
    git clone --depth 1 --branch "$KRUX_TAG" "$KRUX_REPO" "$FORK_DIR"
    cd "$FORK_DIR"
    git checkout -b dynasty-trust-mode
    cd "$PKG_DIR"
fi

# ---------------------------------------------------------------
# 2. Vendor dynastytrust-krux into the fork
# ---------------------------------------------------------------

VENDOR_LINK="$FORK_DIR/src/krux/dynasty"

if [[ -L "$VENDOR_LINK" || -e "$VENDOR_LINK" ]]; then
    echo "[2/4] dynasty package already vendored at $VENDOR_LINK"
else
    echo "[2/4] Vendoring dynastytrust-krux into the Krux source tree ..."
    # Symlink so edits in this package are picked up by the simulator
    # without re-running setup. -f to overwrite if a stale link.
    ln -snf "$PKG_DIR/src/krux/dynasty" "$VENDOR_LINK"
    echo "      symlinked $VENDOR_LINK -> $PKG_DIR/src/krux/dynasty"
fi

# ---------------------------------------------------------------
# 3. Apply the upstream patches
# ---------------------------------------------------------------

echo "[3/4] Applying upstream patches via $PATCH_SCRIPT ..."
python3 "$PATCH_SCRIPT" --krux-root "$FORK_DIR" --package-root "$PKG_DIR"

# ---------------------------------------------------------------
# 4. Print next steps
# ---------------------------------------------------------------

cat <<EOF

[4/4] Setup complete.

Next steps:

  cd $FORK_DIR

  # First-time setup (installs poetry env + deps; takes a minute)
  poetry install

  # Launch the Pygame simulator
  poetry run poe simulator

Once the simulator window opens:
  1. Pick a network (e.g. Signet) and load a 12 / 24 word seed
  2. Open Wallet > Provision Dynasty Vault
  3. Paste a DynastyTrust descriptor QR (or test descriptor below)
  4. Confirm the digest + role
  5. Load a PSBT and watch the trust-mode flow

Test descriptor (1-of-1 normal, signet-friendly):

  tr(50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0,
     pk(5650eae71664e3c6f1d54c0218bd28c6f78ece845ddd320bb7c02e28852f3c02))

To rebuild after editing files in this package, just rerun the
simulator -- the symlink picks up your changes.

EOF
