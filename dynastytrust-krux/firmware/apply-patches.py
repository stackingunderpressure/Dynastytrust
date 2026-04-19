#!/usr/bin/env python3
"""apply-patches.py -- inject DynastyTrust trust-mode hooks into Krux.

Anchor-based patcher: each insertion is identified by a unique
upstream-text anchor rather than a line number, so the script
survives small upstream drift. Every patch is idempotent: applying
twice is a no-op.

Usage:

    python3 apply-patches.py \\
        --krux-root /path/to/dynastytrust-krux-fw \\
        --package-root /path/to/dynastytrust-krux

Prints which patches landed, which were already present, and which
failed (with the unmatched anchor so you can update the script for
a newer Krux release).
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from dataclasses import dataclass
from typing import List


# A patch is "find this anchor in the file, insert this block right
# AFTER the anchor". The marker is a unique substring that lets us
# detect 'already applied' on rerun.
@dataclass
class InsertAfter:
    file_rel: str               # path relative to krux-root (src/krux/psbt.py)
    anchor: str                 # unique substring to find
    insert: str                 # block to insert (newlines included)
    marker: str                 # unique substring of `insert` that flags 'done'
    description: str            # human label for log lines


# ---------------------------------------------------------------------------
# Patch definitions
# ---------------------------------------------------------------------------

# Anchors are deliberately a few lines wide so they are unique across
# the upstream file. If a future Krux release renames a function, the
# patcher fails loudly with the anchor text -- update this list.

PATCHES: List[InsertAfter] = [

    # 1. krux/psbt.py -- inject the policy guard call at the top of
    #    PSBTSigner.sign(). The anchor is the function signature.
    InsertAfter(
        file_rel="src/krux/psbt.py",
        anchor="    def sign(self, trim=True):",
        insert="""\
        # DynastyTrust trust-mode gate. Refuses to sign anything outside
        # the approved policy templates when the wallet is in trust mode.
        if getattr(self.wallet, "trust_mode", False):
            from .dynasty_signing_hook import policy_guard_check
            if not policy_guard_check(self.ctx, self.wallet, self.psbt):
                return False
""",
        marker="dynasty_signing_hook",
        description="psbt.py: insert trust-mode gate at top of sign()",
    ),

    # 2. krux/wallet.py -- after the descriptor is parsed and stored
    #    on self, classify it and tag the wallet with trust_mode if
    #    a matching allowlist record is found. Anchor on a stable
    #    upstream comment + assignment.
    InsertAfter(
        file_rel="src/krux/wallet.py",
        anchor="self.descriptor = descriptor",
        insert="""\

        # DynastyTrust trust-mode auto-tagging. If this descriptor
        # matches a provisioned vault on the device, mark the wallet
        # so PSBTSigner.sign() invokes the policy guard.
        try:
            from .dynasty import (
                classify_with_scripts,
                descriptor_hash,
                load as _dt_load,
                UnsupportedError,
            )
            from .krux_settings import Settings as _DTSettings
            template, _ = classify_with_scripts(descriptor)
            digest = descriptor_hash(template)
            try:
                al_path = _DTSettings().persist.path("dynasty_allowlist.json")
            except Exception:
                al_path = "/sd/dynasty_allowlist.json"
            firmware_test = getattr(_DTSettings().persist,
                                    "dynasty_test_mode", False)
            al = _dt_load(al_path, firmware_test_mode=firmware_test)
            if al.find(digest):
                self.trust_mode = True
                self.dynasty_template = template
        except UnsupportedError:
            pass
        except Exception:
            pass
""",
        marker="DynastyTrust trust-mode auto-tagging",
        description="wallet.py: tag wallet with trust_mode after descriptor load",
    ),
]


# ---------------------------------------------------------------------------
# Drop-in files (full file copies, not in-place patches)
# ---------------------------------------------------------------------------

@dataclass
class DropIn:
    src_rel_to_pkg: str      # path under dynastytrust-krux/
    dst_rel_to_krux: str     # path under dynastytrust-krux-fw/
    description: str


DROP_INS: List[DropIn] = [
    DropIn(
        src_rel_to_pkg="firmware/krux_psbt_patch.py",
        dst_rel_to_krux="src/krux/dynasty_signing_hook.py",
        description="install signing-hook helper",
    ),
    DropIn(
        src_rel_to_pkg="firmware/dynasty_pages_skeleton.py",
        dst_rel_to_krux="src/krux/pages/dynasty_provision.py",
        description="install provisioning Page",
    ),
]


# ---------------------------------------------------------------------------
# Patch application
# ---------------------------------------------------------------------------


def apply_insert_after(patch: InsertAfter, krux_root: str) -> str:
    """Apply one InsertAfter patch. Returns 'applied', 'skipped', or 'failed:<reason>'."""
    abs_path = os.path.join(krux_root, patch.file_rel)
    if not os.path.exists(abs_path):
        return f"failed: file not found at {abs_path}"

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    if patch.marker in content:
        return "skipped (already applied)"

    if patch.anchor not in content:
        return f"failed: anchor not found ({patch.anchor[:60]}...)"

    # Insert the block immediately after the first occurrence of the anchor.
    idx = content.index(patch.anchor) + len(patch.anchor)
    # Ensure we land on a fresh line: anchor probably ends with `:` and a
    # newline; if not, prepend one.
    prefix = "\n" if not content[idx:idx + 1] == "\n" else ""
    new_content = content[:idx] + prefix + patch.insert + content[idx:]

    # Backup original once.
    backup_path = abs_path + ".pre-dynasty.bak"
    if not os.path.exists(backup_path):
        shutil.copy2(abs_path, backup_path)

    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    return "applied"


def apply_drop_in(drop: DropIn, krux_root: str, package_root: str) -> str:
    src = os.path.join(package_root, drop.src_rel_to_pkg)
    dst = os.path.join(krux_root, drop.dst_rel_to_krux)
    if not os.path.exists(src):
        return f"failed: source missing {src}"
    if os.path.exists(dst):
        # Compare hashes so unmodified copies are reported as 'skipped'
        # while modifications are flagged.
        with open(src, "rb") as f1, open(dst, "rb") as f2:
            if f1.read() == f2.read():
                return "skipped (unchanged)"
            return "failed: destination exists with different content; remove or merge manually"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return "applied"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--krux-root", required=True,
                        help="path to the cloned Krux fork")
    parser.add_argument("--package-root", required=True,
                        help="path to the dynastytrust-krux package")
    args = parser.parse_args()

    krux_root = os.path.abspath(args.krux_root)
    package_root = os.path.abspath(args.package_root)

    if not os.path.isdir(krux_root):
        print(f"ERROR: --krux-root not a directory: {krux_root}", file=sys.stderr)
        return 1
    if not os.path.isdir(package_root):
        print(f"ERROR: --package-root not a directory: {package_root}", file=sys.stderr)
        return 1

    print(f"Applying patches to {krux_root}")
    print(f"Source package: {package_root}")
    print()

    failures = 0

    print("== Drop-in files ==")
    for d in DROP_INS:
        result = apply_drop_in(d, krux_root, package_root)
        print(f"  [{result}] {d.description} -> {d.dst_rel_to_krux}")
        if result.startswith("failed"):
            failures += 1

    print()
    print("== In-place patches ==")
    for p in PATCHES:
        result = apply_insert_after(p, krux_root)
        print(f"  [{result}] {p.description}")
        if result.startswith("failed"):
            failures += 1

    print()
    if failures:
        print(f"ERROR: {failures} patch(es) failed. See messages above.", file=sys.stderr)
        print("Likely cause: upstream Krux changed since v26.03.0. Update this", file=sys.stderr)
        print("script's anchor strings or apply the patches manually per", file=sys.stderr)
        print("firmware/INTEGRATION.md.", file=sys.stderr)
        return 2

    print("All patches applied or already present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
