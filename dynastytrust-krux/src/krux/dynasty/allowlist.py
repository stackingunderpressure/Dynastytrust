"""Persistent trust-mode provisioning state.

A Krux running in trust mode is **provisioned for one vault and one
role**. The user scans the vault descriptor at setup time; the device
records the descriptor's digest plus a role label and refuses to sign
anything else until factory-reset.

The state is a single small JSON blob, stored on the SD card in
production and in any writable directory in tests:

    {
      "version": 1,
      "descriptor_hash": "<64 hex chars>",
      "role": "founder" | "trustee" | "heir" | "protector" | "consent",
      "label": "Dad's hardware signer",
      "created_at": "2026-04-19T23:30:00Z",
      "test_mode": false
    }

``test_mode`` is the firmware-build escape hatch: when the binary is
built with ``DT_TEST_MODE=1`` the load/save functions tolerate
multiple slots (a list of provisioning records) so a developer can
shuttle one device across roles. Production builds reject any
non-current-version blob and any list-shaped payload, and they refuse
to load if ``test_mode`` is true.

This module is intentionally minimal: dataclass + load + save + a
``matches()`` predicate. UI screens for capture / confirm / reset
live in :mod:`ui` (Phase 3).
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import List, Optional


SCHEMA_VERSION = 1
APPROVED_ROLES = frozenset({"founder", "trustee", "heir", "protector", "consent", "viewer"})


class ProvisioningError(ValueError):
    """Raised when the persistent allowlist file is corrupt, of an
    unsupported version, or contains a value the production build
    refuses to accept (e.g. ``test_mode=true`` on a non-test firmware).
    """


@dataclass
class Provisioning:
    """One provisioning record.

    The descriptor hash is what gates signing: every PSBT load
    re-classifies the incoming descriptor and compares against this
    field. The role and label are user-facing context for the
    confirmation screens.
    """
    descriptor_hash: str
    role: str
    label: str = ""
    created_at: str = ""
    test_mode: bool = False

    def __post_init__(self) -> None:
        if len(self.descriptor_hash) != 64 or not all(
            c in "0123456789abcdef" for c in self.descriptor_hash.lower()
        ):
            raise ProvisioningError("descriptor_hash must be 64 lowercase hex chars")
        self.descriptor_hash = self.descriptor_hash.lower()
        if self.role not in APPROVED_ROLES:
            raise ProvisioningError(
                f"role {self.role!r} not in approved set: " + ",".join(sorted(APPROVED_ROLES))
            )
        if not self.created_at:
            self.created_at = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    def matches(self, candidate_descriptor_hash: str) -> bool:
        """True iff the candidate descriptor is the one this device
        was provisioned for.
        """
        return candidate_descriptor_hash.lower() == self.descriptor_hash


@dataclass
class Allowlist:
    """The full trust-mode state on this device.

    Production builds carry a single :class:`Provisioning` in
    ``records`` (one role per device, the safer model). Test-mode
    builds may carry several. Empty ``records`` means the device is
    fresh / un-provisioned.
    """
    version: int = SCHEMA_VERSION
    records: List[Provisioning] = field(default_factory=list)
    # When loaded from disk, set to True iff the firmware build was
    # compiled with DT_TEST_MODE=1. Production loaders never set this
    # to True; if a disk file claims test_mode, production refuses.
    firmware_test_mode: bool = False

    def add(self, p: Provisioning, *, allow_multiple: bool) -> None:
        """Register a new provisioning record.

        If ``allow_multiple`` is False (production), refuses to add a
        second record. Caller is responsible for factory-reset before
        re-provisioning.
        """
        if self.records and not allow_multiple:
            raise ProvisioningError(
                "device is already provisioned; factory-reset before re-provisioning"
            )
        if p.test_mode and not self.firmware_test_mode:
            raise ProvisioningError(
                "test_mode provisioning record on production firmware; refusing"
            )
        self.records.append(p)

    def find(self, descriptor_hash: str) -> Optional[Provisioning]:
        """Return the matching provisioning record or ``None``."""
        for r in self.records:
            if r.matches(descriptor_hash):
                return r
        return None


# ---------------------------------------------------------------------------
# Persistence -- single JSON file
# ---------------------------------------------------------------------------


def load(path: str, *, firmware_test_mode: bool = False) -> Allowlist:
    """Load the persistent allowlist from disk.

    Missing file -> empty :class:`Allowlist` (un-provisioned device).
    Corrupt JSON, wrong schema version, or test-mode-on-production
    record raises :class:`ProvisioningError`.
    """
    if not os.path.exists(path):
        return Allowlist(firmware_test_mode=firmware_test_mode)

    try:
        with open(path, "r", encoding="utf-8") as f:
            blob = json.load(f)
    except (OSError, ValueError) as e:
        raise ProvisioningError(f"could not read {path}: {e}") from e

    if not isinstance(blob, dict):
        raise ProvisioningError("allowlist must be a JSON object")
    if blob.get("version") != SCHEMA_VERSION:
        raise ProvisioningError(
            f"unsupported allowlist version {blob.get('version')}; expected {SCHEMA_VERSION}"
        )
    raw_records = blob.get("records", [])
    if not isinstance(raw_records, list):
        raise ProvisioningError("allowlist 'records' must be a list")
    if len(raw_records) > 1 and not firmware_test_mode:
        raise ProvisioningError(
            "production firmware refuses multi-record allowlist (one role per device)"
        )

    records: List[Provisioning] = []
    for r in raw_records:
        if not isinstance(r, dict):
            raise ProvisioningError("each record must be a JSON object")
        try:
            rec = Provisioning(**r)
        except TypeError as e:
            raise ProvisioningError(f"unknown field in provisioning record: {e}") from e
        if rec.test_mode and not firmware_test_mode:
            raise ProvisioningError(
                "production firmware refuses a record with test_mode=true"
            )
        records.append(rec)

    return Allowlist(
        version=SCHEMA_VERSION,
        records=records,
        firmware_test_mode=firmware_test_mode,
    )


def save(allowlist: Allowlist, path: str) -> None:
    """Atomically write the allowlist to disk.

    Writes to ``path + '.tmp'`` then renames; avoids corrupted state
    if the device loses power mid-write. Caller chooses the path
    (``/sd/dynasty_allowlist.json`` on real hardware).
    """
    blob = {
        "version": allowlist.version,
        "records": [asdict(r) for r in allowlist.records],
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(blob, f, sort_keys=True)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            # Some filesystems on K210 may not support fsync. The
            # rename below is the durability primitive; fsync is best
            # effort.
            pass
    os.replace(tmp, path)
