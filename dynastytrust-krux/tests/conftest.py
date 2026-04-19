"""Shared test fixtures.

DynastyTrust vaults emerge from the Rust compiler as taproot miniscript
descriptors of the form ``tr(NUMS,{leaves})``. The fixtures here are
hand-assembled with valid curve-on x-only pubkeys derived from fixed
sha256 scalars, so the classifier sees realistic inputs without
requiring the full Rust toolchain.
"""
from __future__ import annotations

import hashlib
import pytest
from embit.ec import PrivateKey

NUMS_HEX = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"


def _xonly(seed: str) -> str:
    """Deterministic 32-byte x-only pubkey for a fixture seed string.

    Derives a secp256k1 point from a sha256(seed) scalar so the result
    is a valid curve point that the miniscript parser will accept.
    """
    scalar = hashlib.sha256(seed.encode()).digest()
    return PrivateKey(scalar).get_public_key().xonly().hex()


@pytest.fixture
def t_keys():
    """Three trustee keys, sorted-by-hex for predictable comparisons."""
    keys = sorted(_xonly("trustee-" + str(i)) for i in range(3))
    return keys


@pytest.fixture
def h_keys():
    """Two heir keys."""
    keys = sorted(_xonly("heir-" + str(i)) for i in range(2))
    return keys


@pytest.fixture
def p_keys():
    """One protector key (single-signer typical)."""
    return [_xonly("protector-0")]


@pytest.fixture
def c_keys():
    """Two consent (beneficiary) keys."""
    keys = sorted(_xonly("consent-" + str(i)) for i in range(2))
    return keys


def _tree(leaves):
    """Build a right-leaning nested taptree string from a list of leaves.

    embit expects taptree syntax to be a binary tree: each non-terminal
    node is ``{left,right}``. A flat list ``{a,b,c,d}`` parses only when
    there are exactly two children at this level. We nest progressively
    so 3+ leaves produce a valid tree; leaf ordering is preserved.
    """
    if len(leaves) == 1:
        return leaves[0]
    if len(leaves) == 2:
        return "{" + leaves[0] + "," + leaves[1] + "}"
    return "{" + leaves[0] + "," + _tree(leaves[1:]) + "}"


def make_descriptor(leaves) -> str:
    """Assemble a ``tr(NUMS,{...})`` descriptor string.

    ``leaves`` is a list of miniscript fragment strings; we nest them
    into the canonical embit taptree syntax. Order in the input is
    preserved in the output, but the classifier canonicalises so it
    doesn't matter for the assertions.
    """
    return f"tr({NUMS_HEX},{_tree(leaves)})"


def normal_leaf(keys, quorum):
    if quorum == 1 and len(keys) == 1:
        return f"pk({keys[0]})"
    return f"multi_a({quorum}," + ",".join(keys) + ")"


def timelock_leaf(keys, quorum, height):
    body = normal_leaf(keys, quorum)
    return f"and_v(v:after({height}),{body})"


def consent_leaf(t_keys, t_quorum, c_keys, c_quorum):
    t_body = normal_leaf(t_keys, t_quorum)
    c_body = normal_leaf(c_keys, c_quorum)
    return f"and_v(v:{t_body},{c_body})"
