import { useState } from "react";
import { colors } from "../../theme";
import { Button, Textarea } from "../../components/ui";
import { normalizePsbt } from "../../lib/psbt-format";


// // -- External PSBT import

export function ExternalPsbtInput({ onImport }: { onImport: (hex: string) => void }) {
  const [psbtHex, setPsbtHex] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const hex = normalizePsbt(psbtHex);
    if (!hex) {
      setErr("Not a valid PSBT. Paste hex (starts with 70736274ff) or base64 (starts with cHNidP8).");
      return;
    }
    try {
      onImport(hex);
      setPsbtHex("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Invalid PSBT");
    }
  }

  return (
    <form onSubmit={submit}>
      <Textarea
        mono
        rows={3}
        value={psbtHex}
        onChange={e => setPsbtHex(e.target.value)}
        placeholder="Paste signed PSBT (hex or base64 both work)"
      />
      {err && <p style={{ color: colors.red, fontSize: 16, margin: "4px 0" }}>{err}</p>}
      <Button
        type="submit"
        variant="ghost"
        disabled={!psbtHex}
        style={{ marginTop: 8 }}
      >
        Add signature
      </Button>
    </form>
  );
}
