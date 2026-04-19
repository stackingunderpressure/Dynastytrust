# Krux integration step-by-step

Apply against [selfcustody/krux](https://github.com/selfcustody/krux)
**v26.03.0** (the audited release). The changes touch four files in
the firmware tree. None of them require a refactor; each is an
additive insertion.

## 1. Vendor the package

```
cd src/krux
git submodule add https://github.com/stackingunderpressure/dynastytrust-krux dynasty-pkg
ln -s dynasty-pkg/src/krux/dynasty dynasty
```

After this, `from krux.dynasty import classify, check, adapt` works
inside the firmware.

## 2. Add the signing-hook helper

Copy `firmware/krux_psbt_patch.py` to `src/krux/dynasty_signing_hook.py`.

It exposes one function:

```python
def policy_guard_check(ctx, wallet, psbt):
    """Returns True if the user confirmed the spend; False to abort."""
```

## 3. Patch `src/krux/psbt.py`

Find the entry point of `PSBTSigner.sign()` (around line 473 in
v26.03.0). Insert the trust-mode hook BEFORE the embit
`psbt.sign_with(...)` call:

```diff
 def sign(self, trim=True):
+    # DynastyTrust trust-mode gate. If the active wallet has a
+    # trust-mode allowlist record, refuse to sign anything outside
+    # the approved templates. The hook returns False on either
+    # rejection or user-cancel; either way we stop here without ever
+    # calling sign_with().
+    if getattr(self.wallet, "trust_mode", False):
+        from .dynasty_signing_hook import policy_guard_check
+        if not policy_guard_check(self.ctx, self.wallet, self.psbt):
+            return False
     ...
```

The `getattr` keeps the hook fully off the hot path for non-trust
wallets — zero impact on the existing user base.

## 4. Patch `src/krux/wallet.py`

In `Wallet.load()`, after the descriptor is parsed, look up the
allowlist and tag the wallet:

```diff
 def load(self, ...):
     ...
     self.descriptor = descriptor
+    # Trust-mode tagging. If the device has been provisioned
+    # (allowlist file present + classifier accepts this descriptor),
+    # mark the wallet so PSBTSigner.sign() invokes the policy guard.
+    from .dynasty import (
+        classify_with_scripts,
+        UnsupportedError,
+        load as load_allowlist,
+    )
+    try:
+        template, _ = classify_with_scripts(descriptor)
+        from .dynasty.templates import descriptor_hash as _h
+        digest = _h(template)
+        from .krux_settings import Settings
+        al_path = Settings().persist.path("dynasty_allowlist.json")
+        firmware_test = Settings().persist.dynasty_test_mode
+        al = load_allowlist(al_path, firmware_test_mode=firmware_test)
+        if al.find(digest):
+            self.trust_mode = True
+            self.dynasty_template = template
+    except UnsupportedError:
+        # Descriptor isn't a DynastyTrust template; trust mode stays off.
+        pass
+    except Exception:
+        # Filesystem / settings hiccup; safer to default trust mode off.
+        pass
```

## 5. Patch `src/krux/krux_settings.py`

Register a build-flag-driven test-mode toggle so the wallet loader
can pull it out:

```diff
 class _PersistSettings:
+    @property
+    def dynasty_test_mode(self) -> bool:
+        # Compile-time flag, set by Makefile via -DDT_TEST_MODE=1.
+        # Default False -- production firmware never tolerates
+        # multi-role allowlists or test_mode records.
+        try:
+            from .build_config import DYNASTY_TEST_MODE
+            return bool(DYNASTY_TEST_MODE)
+        except ImportError:
+            return False
```

## 6. Add a "Provision Dynasty Vault" menu entry

In `src/krux/pages/wallet_settings.py` (or whichever page module you
prefer for the entry), wire a menu item that opens the provisioning
screen:

```python
from .dynasty_provision import ProvisionPage

def menu_extra_options(self):
    items = [
        ...,
        (("Provision Dynasty Vault"), self.provision_dynasty),
    ]
    ...

def provision_dynasty(self):
    page = ProvisionPage(self.ctx)
    page.run()
    return MENU_CONTINUE
```

## 7. Update Makefile (optional)

For developer / test builds:

```diff
+ifdef DT_TEST_MODE
+    CFLAGS += -DDYNASTY_TEST_MODE=1
+endif
```

## Verification checklist

- [ ] Build firmware (`make` for production, `DT_TEST_MODE=1 make devkit`)
- [ ] Boot the simulator (`make sim` -- Krux ships a Pygame simulator)
- [ ] Provision the simulator with a known DynastyTrust descriptor
- [ ] Load a known-good DynastyTrust PSBT — observe the confirmation
      screen with branch label, fee, and destination
- [ ] Load a PSBT with `older()` (CSV) instead of `after()` (CLTV) —
      observe rejection with a precise reason
- [ ] Load a PSBT with the wrong NUMS internal key — observe
      rejection
- [ ] Load a PSBT spending through a leaf the descriptor doesn't have —
      observe rejection
- [ ] Test on real K210 hardware (Maix Amigo + WonderMV recommended)
