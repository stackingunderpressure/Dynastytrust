"""ProvisionPage -- Krux page-module wrapper around the dynasty UI.

Drop this at ``src/krux/pages/dynasty_provision.py`` in your Krux fork.
It is the minimum glue needed to put "Provision Dynasty Vault" in
the Krux menus; the heavy lifting lives in
``krux.dynasty.ui.ProvisionScreen``.

This file follows Krux's conventions: subclasses ``Page``, accepts a
``ctx``, has a ``run()`` method that returns one of ``MENU_CONTINUE``
/ ``MENU_EXIT``.
"""
from .. import dynasty
from ..dynasty.ui import ProvisionScreen
from ..krux_settings import Settings
from . import Page

# Krux menu sentinel values; depending on Krux version the import path
# may be ``from .menu import MENU_CONTINUE``. Adjust at integration time.
try:
    from .menu import MENU_CONTINUE
except ImportError:
    MENU_CONTINUE = 0


class ProvisionPage(Page):
    """One-shot vault provisioning screen.

    Reads the existing allowlist (or starts empty), runs the
    ProvisionScreen, persists the result. Refuses to overwrite an
    existing provisioning unless the firmware is a developer build.
    """

    def __init__(self, ctx):
        super().__init__(ctx, None)
        self.ctx = ctx

    def run(self):
        path = Settings().persist.path("dynasty_allowlist.json")
        firmware_test = getattr(Settings().persist, "dynasty_test_mode", False)

        try:
            allowlist = dynasty.load(path, firmware_test_mode=firmware_test)
        except dynasty.ProvisioningError as e:
            self.ctx.display.flash_text("Allowlist error: " + str(e)[:40])
            return MENU_CONTINUE

        if allowlist.records and not firmware_test:
            self.ctx.display.flash_text(
                "Already provisioned. Factory reset to re-provision."
            )
            return MENU_CONTINUE

        screen = ProvisionScreen(
            ctx=self.ctx,
            allowlist_path=path,
            allowlist=allowlist,
        )
        screen.run()
        return MENU_CONTINUE
