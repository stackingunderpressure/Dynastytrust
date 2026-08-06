import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  TAPIT_COSIGN_RESULT_KEY,
  clearTapitCosignCallbackUrl,
  readTapitCosignGrant,
} from "../lib/tapit-cosign";
import { Button } from "../components/ui";
import { colors, fonts, radii, space } from "../theme";

// Cut B stage B2 -- the landing page Tapit's psbt-cosign redirect points
// at. Opened in its OWN tab (see lib/tapit-cosign.ts's header comment for
// why); its only job is to hand the signed PSBT back to the ORIGINAL tab
// via a same-origin localStorage write (VaultDetail listens for the
// browser's `storage` event and merges it in automatically through the
// existing externalImport/mergePsbts path -- unchanged) and show a
// human-readable fallback (copy button) in case that tab isn't listening
// anymore (closed, reloaded, or the write happened before it mounted).
//
// This page never touches a private key. It only ever sees the PUBLIC
// signed PSBT the wallet already decided to hand back.
function readState():
  | { kind: "signed"; psbtHex: string }
  | { kind: "declined" }
  | { kind: "malformed" } {
  const grant = readTapitCosignGrant();
  if (!grant) return { kind: "declined" };
  if (typeof grant.psbt_hex !== "string" || grant.psbt_hex.length === 0) {
    return { kind: "malformed" };
  }
  return { kind: "signed", psbtHex: grant.psbt_hex };
}

export default function TapitCosignCallback() {
  const [state] = useState(readState);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (state.kind !== "signed") return;
    try {
      window.localStorage.setItem(
        TAPIT_COSIGN_RESULT_KEY,
        JSON.stringify({ psbt_hex: state.psbtHex, at: Date.now() }),
      );
    } catch {
      // localStorage can throw in locked-down browser contexts (private
      // mode, storage quota). The copy-hex fallback below still works.
    }
    clearTapitCosignCallbackUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyHex() {
    if (state.kind !== "signed") return;
    try {
      await navigator.clipboard.writeText(state.psbtHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied -- the hex is still selectable text.
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space[6],
        background: colors.bg,
        fontFamily: fonts.sans,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.lg,
          padding: 24,
        }}
      >
        {state.kind === "signed" && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>
              Signed via Tapit
            </div>
            <p style={{ marginTop: 8, fontSize: 13, color: colors.muted }}>
              You can close this tab -- your other DynastyTrust tab should
              pick this up automatically in a moment. If it doesn't, copy the
              signed PSBT below and paste it into the "Paste signed PSBT" box
              there.
            </p>
            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <Button variant="ghost" size="sm" onClick={() => void copyHex()}>
                {copied ? "Copied!" : "Copy signed PSBT"}
              </Button>
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 11,
                color: colors.muted,
                wordBreak: "break-all",
                fontFamily: fonts.mono,
                background: colors.inset,
                borderRadius: radii.md,
                padding: 10,
                maxHeight: 140,
                overflow: "auto",
              }}
            >
              {state.psbtHex}
            </div>
          </>
        )}
        {state.kind === "declined" && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>
              Signing wasn't completed
            </div>
            <p style={{ marginTop: 8, fontSize: 13, color: colors.muted }}>
              Tapit didn't return a signed transaction -- you may have
              declined the request, or the link was opened without one.
              You can close this tab and try again from your vault.
            </p>
          </>
        )}
        {state.kind === "malformed" && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>
              Something went wrong
            </div>
            <p style={{ marginTop: 8, fontSize: 13, color: colors.muted }}>
              Tapit's response could not be read. Close this tab and try
              signing again from your vault.
            </p>
          </>
        )}
        <Link
          to="/vaults"
          style={{
            display: "inline-block",
            marginTop: 20,
            fontSize: 12,
            color: colors.gold,
          }}
        >
          Go to Vaults
        </Link>
      </div>
    </div>
  );
}
