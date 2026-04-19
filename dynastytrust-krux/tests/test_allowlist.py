"""Tests for persistent allowlist storage + descriptor hashing.

Production-firmware semantics matter as much as the happy path: the
production loader must refuse multi-record blobs and any record with
``test_mode=true``. Test-mode firmware tolerates both.
"""
from __future__ import annotations

import json
import os

import pytest
from embit.descriptor import Descriptor

from krux.dynasty import (
    Allowlist,
    Provisioning,
    ProvisioningError,
    SCHEMA_VERSION,
    classify,
    descriptor_hash,
    load,
    save,
)
from tests.conftest import NUMS_HEX, make_descriptor, normal_leaf, timelock_leaf


# ---------------------------------------------------------------------------
# descriptor_hash
# ---------------------------------------------------------------------------


def test_descriptor_hash_is_64_hex():
    leaf = normal_leaf(["a" * 64], 1)
    d = Descriptor.from_string(make_descriptor([leaf]))
    h = descriptor_hash(classify(d))
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_descriptor_hash_stable_across_orderings(t_keys, h_keys):
    """Same policy with permuted leaf and key ordering -> same hash."""
    a = make_descriptor([
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 26_000),
        timelock_leaf(h_keys, 2, 100_000),
    ])
    b = make_descriptor([
        timelock_leaf(h_keys, 2, 100_000),
        normal_leaf(list(reversed(t_keys)), 2),
        timelock_leaf(list(reversed(t_keys)), 1, 26_000),
    ])
    h_a = descriptor_hash(classify(Descriptor.from_string(a)))
    h_b = descriptor_hash(classify(Descriptor.from_string(b)))
    assert h_a == h_b


def test_descriptor_hash_changes_when_keys_change(t_keys):
    keys_a = t_keys
    keys_b = sorted(t_keys[:2] + ["e" * 64])
    h_a = descriptor_hash(classify(Descriptor.from_string(
        make_descriptor([normal_leaf(keys_a, 2)])
    )))
    h_b = descriptor_hash(classify(Descriptor.from_string(
        make_descriptor([normal_leaf(keys_b, 2)])
    )))
    assert h_a != h_b


def test_descriptor_hash_changes_when_locktime_changes(t_keys):
    h_a = descriptor_hash(classify(Descriptor.from_string(
        make_descriptor([normal_leaf(t_keys, 2), timelock_leaf(t_keys, 1, 26_000)])
    )))
    h_b = descriptor_hash(classify(Descriptor.from_string(
        make_descriptor([normal_leaf(t_keys, 2), timelock_leaf(t_keys, 1, 26_001)])
    )))
    assert h_a != h_b


# ---------------------------------------------------------------------------
# Provisioning dataclass + matches()
# ---------------------------------------------------------------------------


def test_provisioning_normalises_hash_case():
    p = Provisioning(descriptor_hash="DEAD" + "0" * 60, role="founder")
    assert p.descriptor_hash == "dead" + "0" * 60


def test_provisioning_rejects_short_hash():
    with pytest.raises(ProvisioningError, match="64 lowercase hex"):
        Provisioning(descriptor_hash="dead", role="founder")


def test_provisioning_rejects_non_hex():
    with pytest.raises(ProvisioningError, match="64 lowercase hex"):
        Provisioning(descriptor_hash="z" * 64, role="founder")


def test_provisioning_rejects_unknown_role():
    with pytest.raises(ProvisioningError, match="approved set"):
        Provisioning(descriptor_hash="a" * 64, role="ceo")


def test_provisioning_matches_case_insensitively():
    p = Provisioning(descriptor_hash="a" * 64, role="founder")
    assert p.matches("A" * 64)
    assert p.matches("a" * 64)
    assert not p.matches("b" * 64)


def test_provisioning_auto_timestamp():
    p = Provisioning(descriptor_hash="a" * 64, role="founder")
    assert p.created_at.endswith("Z") and "T" in p.created_at


# ---------------------------------------------------------------------------
# Allowlist add() -- production vs test-mode firmware
# ---------------------------------------------------------------------------


def test_allowlist_add_single_in_production():
    al = Allowlist()
    p = Provisioning(descriptor_hash="a" * 64, role="founder")
    al.add(p, allow_multiple=False)
    assert al.records == [p]


def test_allowlist_add_second_rejects_in_production():
    al = Allowlist()
    al.add(Provisioning(descriptor_hash="a" * 64, role="founder"),
           allow_multiple=False)
    with pytest.raises(ProvisioningError, match="already provisioned"):
        al.add(Provisioning(descriptor_hash="b" * 64, role="heir"),
               allow_multiple=False)


def test_allowlist_add_multiple_when_allowed():
    al = Allowlist(firmware_test_mode=True)
    al.add(Provisioning(descriptor_hash="a" * 64, role="founder"),
           allow_multiple=True)
    al.add(Provisioning(descriptor_hash="b" * 64, role="heir"),
           allow_multiple=True)
    assert len(al.records) == 2


def test_allowlist_refuses_test_mode_record_on_production():
    al = Allowlist(firmware_test_mode=False)
    test_record = Provisioning(
        descriptor_hash="a" * 64, role="founder", test_mode=True,
    )
    with pytest.raises(ProvisioningError, match="test_mode"):
        al.add(test_record, allow_multiple=False)


def test_allowlist_find():
    al = Allowlist()
    p = Provisioning(descriptor_hash="a" * 64, role="founder")
    al.add(p, allow_multiple=False)
    assert al.find("a" * 64) is p
    assert al.find("A" * 64) is p  # case insensitive
    assert al.find("b" * 64) is None


# ---------------------------------------------------------------------------
# Persistence -- load + save round-trip + corruption rejection
# ---------------------------------------------------------------------------


def test_load_missing_file_returns_empty(tmp_path):
    al = load(str(tmp_path / "nope.json"))
    assert al.records == []
    assert al.version == SCHEMA_VERSION


def test_save_then_load_round_trip(tmp_path):
    path = str(tmp_path / "al.json")
    al = Allowlist()
    al.add(Provisioning(descriptor_hash="a" * 64, role="founder", label="Test"),
           allow_multiple=False)
    save(al, path)
    loaded = load(path)
    assert len(loaded.records) == 1
    assert loaded.records[0].descriptor_hash == "a" * 64
    assert loaded.records[0].role == "founder"
    assert loaded.records[0].label == "Test"


def test_load_rejects_unknown_version(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        json.dump({"version": 999, "records": []}, f)
    with pytest.raises(ProvisioningError, match="unsupported"):
        load(path)


def test_load_rejects_corrupt_json(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        f.write("not json {{{")
    with pytest.raises(ProvisioningError, match="could not read"):
        load(path)


def test_load_rejects_non_object_root(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        json.dump([], f)
    with pytest.raises(ProvisioningError, match="JSON object"):
        load(path)


def test_load_rejects_bad_records_field(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        json.dump({"version": SCHEMA_VERSION, "records": "nope"}, f)
    with pytest.raises(ProvisioningError, match="must be a list"):
        load(path)


def test_load_rejects_unknown_record_field(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        json.dump({
            "version": SCHEMA_VERSION,
            "records": [{
                "descriptor_hash": "a" * 64,
                "role": "founder",
                "extra_field": "boom",
            }],
        }, f)
    with pytest.raises(ProvisioningError, match="unknown field"):
        load(path)


def test_load_production_rejects_multi_record_file(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        json.dump({
            "version": SCHEMA_VERSION,
            "records": [
                {"descriptor_hash": "a" * 64, "role": "founder"},
                {"descriptor_hash": "b" * 64, "role": "heir"},
            ],
        }, f)
    # Production firmware (default) refuses
    with pytest.raises(ProvisioningError, match="multi-record"):
        load(path)
    # Test-mode firmware tolerates
    al = load(path, firmware_test_mode=True)
    assert len(al.records) == 2


def test_load_production_rejects_test_mode_record(tmp_path):
    path = str(tmp_path / "al.json")
    with open(path, "w") as f:
        json.dump({
            "version": SCHEMA_VERSION,
            "records": [
                {"descriptor_hash": "a" * 64, "role": "founder", "test_mode": True},
            ],
        }, f)
    with pytest.raises(ProvisioningError, match="test_mode=true"):
        load(path)


def test_save_writes_atomically(tmp_path):
    """The temp-file-then-rename dance: the destination file must
    contain the new contents, not be left half-written."""
    path = str(tmp_path / "al.json")
    al = Allowlist()
    al.add(Provisioning(descriptor_hash="a" * 64, role="founder"),
           allow_multiple=False)
    save(al, path)
    # No leftover .tmp file
    assert not os.path.exists(path + ".tmp")
    # File is well-formed JSON with our version
    with open(path) as f:
        blob = json.load(f)
    assert blob["version"] == SCHEMA_VERSION
    assert len(blob["records"]) == 1
