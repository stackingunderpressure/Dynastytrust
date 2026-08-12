import { useState, useEffect, useCallback, useRef } from "react";
import {
  listAllKeys, generateTestKey, generateSoftwareKey, importXpub,
  updateKeyStatus, deleteKey, revealMnemonic, secureTestKey,
  exportKeyring, importKeyringJson, renameKey, parseXpubText,
  DEFAULT_PERSONAS, type LocalKey, type Network,
} from "../lib/keystore";
import { useToast } from "../components/toast";
import { useConfirm } from "../components/dialog";
import { colors, fonts, radii, space, personaPalette } from "../theme";
import { Button, Input, Label, Textarea } from "../components/ui";
import { QrImage } from "../components/QrImage";
import { XpubQrScanner } from "../components/XpubQrScanner";
import { WalletLinkCard } from "../components/WalletLinkCard";
import { BackupFlow } from "../components/vault-builder/BackupFlow";

// Shared select styling (kept inline since the UI primitives only cover
// inputs, textareas, labels, and buttons right now).
const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  color: colors.text,
  fontSize: 16, // iOS Safari zooms on focus below 16px
  fontFamily: fonts.sans,
  boxSizing: "border-box",
};

function WordGrid({ words }: { words: string[] }) {
  const [vis, setVis] = useState(false);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setVis(v => !v)}>
          {vis ? "Hide" : "Reveal words"}
        </Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5 }}>
        {words.map((w, i) => (
          <div
            key={i}
            style={{
              background: colors.inset,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: "6px 10px",
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 10, color: colors.muted, minWidth: 16, flexShrink: 0 }}>{i + 1}</span>
            <span
              style={{
                fontSize: 12,
                fontFamily: fonts.mono,
                color: vis ? colors.text : "transparent",
                textShadow: vis ? "none" : `0 0 8px ${colors.muted}`,
                userSelect: vis ? "text" : "none",
              }}
            >
              {w}
            </span>
          </div>
        ))}
      </div>
      {vis && (
        <Button
          variant="ghost"
          size="sm"
          style={{ width: "100%", marginTop: 10, fontSize: 12 }}
          onClick={() => navigator.clipboard.writeText(words.join(" "))}
        >
          Copy all 24 words
        </Button>
      )}
    </div>
  );
}

function PersonaPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState("");
  const [show, setShow] = useState(false);
  const extras = value && !DEFAULT_PERSONAS.includes(value) ? [value] : [];
  const all = [...DEFAULT_PERSONAS, ...extras];
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {all.map(p => (
          <Button
            key={p}
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(p);
              setShow(false);
            }}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              borderColor: value === p ? colors.gold : colors.border,
              color: value === p ? colors.gold : colors.sub,
              background: value === p ? colors.gold + "18" : "transparent",
            }}
          >
            {p}
          </Button>
        ))}
        <Button variant="ghost" size="sm" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setShow(s => !s)}>
          + Custom
        </Button>
      </div>
      {show && (
        <div style={{ display: "flex", gap: 8 }}>
          <Input style={{ flex: 1 }} placeholder="Custom persona" value={custom} onChange={e => setCustom(e.target.value)} />
          <Button
            variant="ghost"
            onClick={() => {
              if (custom.trim()) {
                onChange(custom.trim());
                setShow(false);
              }
            }}
          >
            Set
          </Button>
        </div>
      )}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: space[4],
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: "28px 32px",
          width: "100%",
          maxWidth: wide ? 660 : 520,
          maxHeight: "92vh",
          overflowY: "auto",
          fontFamily: fonts.sans,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: colors.text, fontFamily: fonts.display, margin: 0 }}>
            {title}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: colors.muted, fontSize: 18, cursor: "pointer" }}>
            x
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function QuickModal({ onDone, onClose }: { onClose: () => void; onDone: (key: LocalKey, mnemonic: string) => void }) {
  const [label, setLabel] = useState("");
  const [persona, setPersona] = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork] = useState<Network>("testnet");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const { key, mnemonic } = generateTestKey({ label: label.trim() || persona, network, persona });
    onDone(key, mnemonic);
  }
  return (
    <Modal title="Quick test key" onClose={onClose}>
      <div style={{ padding: "10px 14px", background: colors.successBg, border: `1px solid ${colors.green}44`, borderRadius: radii.md, marginBottom: 18 }}>
        <p style={{ fontSize: 13, color: colors.green, margin: 0 }}>
          No password needed. Mnemonic stored in browser. Testnet only.
        </p>
      </div>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Label>Label</Label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={persona} />
        </div>
        <div>
          <Label>Persona</Label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div>
          <Label>Network</Label>
          <select style={selectStyle} value={network} onChange={e => setNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="signet">Signet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" style={{ background: colors.green }}>
            Generate instantly
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TestKeyCreated({ keyData, mnemonic, onClose }: { keyData: LocalKey; mnemonic: string; onClose: () => void }) {
  return (
    <Modal title="Key created" onClose={onClose} wide>
      <div style={{ padding: "10px 14px", background: colors.successBg, border: `1px solid ${colors.green}44`, borderRadius: radii.md, marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: colors.green, margin: 0 }}>
          <strong>{keyData.label}</strong> created for <strong>{keyData.persona}</strong>. Recovery phrase below - tap
          "Reveal words" to see it.
        </p>
      </div>
      <WordGrid words={mnemonic.split(" ")} />
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <Button variant="ghost" style={{ flex: 1 }} onClick={onClose}>
          Done - back up later
        </Button>
        <Button style={{ flex: 1 }} onClick={onClose}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}

function SecureModal({ onDone, onClose }: { onClose: () => void; onDone: (key: LocalKey, mnemonic: string) => void }) {
  const [label, setLabel] = useState("");
  const [persona, setPersona] = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork] = useState<Network>("testnet");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setErr("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { key, mnemonic } = await generateSoftwareKey({ label: label.trim() || persona, network, password, persona });
      onDone(key, mnemonic);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Secure key" onClose={onClose}>
      <p style={{ fontSize: 13, color: colors.muted, marginBottom: 20, lineHeight: 1.5 }}>
        Mnemonic encrypted with your password. Use for real funds.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Label>Label</Label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={persona} />
        </div>
        <div>
          <Label>Persona</Label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div>
          <Label>Network</Label>
          <select style={selectStyle} value={network} onChange={e => setNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="signet">Signet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        <div>
          <Label>Encryption password</Label>
          <Input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="Min 8 characters" />
        </div>
        <div>
          <Label>Confirm password</Label>
          <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </div>
        {err && <p style={{ color: colors.red, fontSize: 13, margin: 0 }}>{err}</p>}
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Generating..." : "Generate"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RevealModal({
  keyData,
  onClose,
  onBackedUp,
}: {
  keyData: LocalKey;
  onClose: () => void;
  onBackedUp: () => void;
}) {
  const [pw, setPw] = useState("");
  const isTest = !!keyData.testMnemonic;
  const [mnemonic, setMn] = useState<string | null>(isTest ? keyData.testMnemonic! : null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doBackup, setDoBackup] = useState(false);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setMn(await revealMnemonic(keyData.keyId, pw));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (doBackup && mnemonic)
    return (
      <BackupFlow
        keyData={keyData}
        mnemonic={mnemonic}
        onDone={() => {
          onBackedUp();
          onClose();
        }}
      />
    );

  return (
    <Modal title="Recovery phrase" onClose={onClose} wide>
      {!mnemonic && !isTest ? (
        <form onSubmit={unlock} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: colors.muted }}>
            Enter password for <strong style={{ color: colors.text }}>{keyData.label}</strong>.
          </p>
          <div>
            <Label>Password</Label>
            <Input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus />
          </div>
          {err && <p style={{ color: colors.red, fontSize: 13 }}>{err}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Decrypting..." : "Reveal"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          {isTest ? (
            <div style={{ padding: "10px 14px", background: colors.successBg, border: `1px solid ${colors.green}44`, borderRadius: radii.md, marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: colors.green, margin: 0 }}>Test key - no password needed.</p>
            </div>
          ) : (
            <div style={{ padding: "10px 14px", background: colors.dangerBg, border: `1px solid ${colors.borderDanger}`, borderRadius: radii.md, marginBottom: 14 }}>
              <p style={{ fontSize: 12, color: colors.red, margin: 0 }}>Keep this private. Close when done.</p>
            </div>
          )}
          <WordGrid words={mnemonic!.split(" ")} />
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <Button variant="ghost" style={{ flex: 1 }} onClick={onClose}>
              Close
            </Button>
            {!keyData.backedUp && (
              <Button style={{ flex: 1 }} onClick={() => setDoBackup(true)}>
                Verify backup
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function SecureUpgradeModal({ keyData, onDone, onClose }: { keyData: LocalKey; onDone: () => void; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== confirm) {
      setErr("Passwords do not match");
      return;
    }
    if (pw.length < 8) {
      setErr("Min 8 characters");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await secureTestKey(keyData.keyId, pw);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add password to key" onClose={onClose}>
      <p style={{ fontSize: 13, color: colors.muted, marginBottom: 18, lineHeight: 1.5 }}>
        Encrypt <strong style={{ color: colors.text }}>{keyData.label}</strong> with a password. The plaintext mnemonic will be deleted from storage.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Label>Password</Label>
          <Input type="password" value={pw} onChange={e => setPw(e.target.value)} required minLength={8} autoFocus />
        </div>
        <div>
          <Label>Confirm</Label>
          <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </div>
        {err && <p style={{ color: colors.red, fontSize: 13 }}>{err}</p>}
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Encrypting..." : "Add password"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [persona, setPersona] = useState(DEFAULT_PERSONAS[0]);
  const [network, setNetwork] = useState<Network>("testnet");
  const [xpub, setXpub] = useState("");
  const [path, setPath] = useState("m/48'/1'/0'/2'");
  // The ONLY trustworthy source of the master fingerprint hardware-wallet
  // signing needs -- there is no way to derive it from a bare xpub after
  // the fact (see keystore.ts's importXpub doc comment). Populated from a
  // scanned/imported [fingerprint/path]xpub string when available; editable
  // so a bare-xpub paste can still get one by typing what the signer's own
  // screen shows.
  const [masterFingerprint, setMasterFingerprint] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [showQrScan, setShowQrScan] = useState(false);
  const exportFileRef = useRef<HTMLInputElement>(null);

  function handleNetwork(n: Network) {
    setNetwork(n);
    setPath("m/48'/" + (n === "mainnet" ? "0" : "1") + "'/0'/2'");
  }

  function handleQrResult(scannedXpub: string, scannedPath: string | null, scannedFingerprint: string | null) {
    setXpub(scannedXpub);
    if (scannedPath) setPath(scannedPath);
    if (scannedFingerprint) setMasterFingerprint(scannedFingerprint);
    setFileName(null);
    setShowQrScan(false);
  }

  async function handleExportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a fix
    if (!file) return;
    setErr(null);
    const text = await file.text();
    const parsed = parseXpubText(text);
    if (!parsed) {
      setErr(`Couldn't find an xpub in "${file.name}". Paste it in manually below instead.`);
      return;
    }
    setXpub(parsed.xpub);
    // null only means this specific export had no path info (a bare
    // xpub, no brackets) -- leave whatever was already in the field
    // rather than blank out a value that might already be correct.
    if (parsed.path) setPath(parsed.path);
    if (parsed.fingerprint) setMasterFingerprint(parsed.fingerprint);
    setFileName(file.name);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const fp = masterFingerprint.trim().toLowerCase();
    if (fp && !/^[0-9a-f]{8}$/.test(fp)) {
      setErr("Fingerprint must be 8 hex characters, e.g. c8fe8d4e.");
      return;
    }
    try {
      importXpub({
        label: label.trim() || persona,
        persona,
        network,
        xpub: xpub.trim(),
        derivationPath: path.trim(),
        masterFingerprint: fp || undefined,
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed");
    }
  }

  return (
    <Modal title="Import xpub" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Label>Label</Label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={persona} />
        </div>
        <div>
          <Label>Persona</Label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div>
          <Label>Network</Label>
          <select style={selectStyle} value={network} onChange={e => handleNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="signet">Signet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        {showQrScan ? (
          <XpubQrScanner onResult={handleQrResult} onCancel={() => setShowQrScan(false)} />
        ) : (
          <>
            <div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button type="button" variant="ghost" style={{ flex: 1 }} onClick={() => setShowQrScan(true)}>
                  Scan QR
                </Button>
                <Button type="button" variant="ghost" style={{ flex: 1 }} onClick={() => exportFileRef.current?.click()}>
                  {fileName ? `Loaded: ${fileName}` : "Import from file"}
                </Button>
              </div>
              <input ref={exportFileRef} type="file" accept=".json,.txt" style={{ display: "none" }} onChange={handleExportFile} />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 5, textAlign: "center" }}>
                Scan a QR from your signing device, or import its export file. Or paste manually below.
              </div>
            </div>
            <div>
              <Label>xpub / tpub</Label>
              <Textarea mono rows={3} value={xpub} onChange={e => { setXpub(e.target.value); setFileName(null); }} required placeholder="xpub6... or tpub..." />
            </div>
            <div>
              <Label>Derivation path</Label>
              <Input mono value={path} onChange={e => setPath(e.target.value)} />
            </div>
            <div>
              <Label>Master fingerprint</Label>
              <Input
                mono
                value={masterFingerprint}
                onChange={e => setMasterFingerprint(e.target.value)}
                placeholder="e.g. c8fe8d4e -- from the signer's export"
              />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 5 }}>
                Filled in automatically from a scan or file import. Without it, this key
                won't be recognized by a hardware wallet at spend time -- a bare xpub
                alone can't supply it, so type it in if you pasted the xpub manually.
              </div>
            </div>
            {err && <p style={{ color: colors.red, fontSize: 13 }}>{err}</p>}
            <div style={{ display: "flex", gap: 10 }}>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Import</Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}

function EditModal({ keyData, onDone, onClose }: { keyData: LocalKey; onDone: () => void; onClose: () => void }) {
  const [label, setLabel] = useState(keyData.label);
  const [persona, setPersona] = useState(keyData.persona);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    renameKey(keyData.keyId, label.trim() || keyData.label, persona);
    onDone();
  }

  return (
    <Modal title="Edit key" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Label>Label</Label>
          <Input value={label} onChange={e => setLabel(e.target.value)} required autoFocus />
        </div>
        <div>
          <Label>Persona</Label>
          <PersonaPicker value={persona} onChange={setPersona} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function DetailModal({
  k,
  onClose,
  onReveal,
  onSecure,
  onArchive,
  onDelete,
  onEdit,
}: {
  k: LocalKey;
  onClose: () => void;
  onReveal: () => void;
  onSecure: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }
  const keyType = k.testMnemonic
    ? "Test key (plaintext - no password)"
    : k.origin === "tapit"
      ? "Tapit Wallet key (no local key material)"
      : k.origin === "imported_xpub"
        ? "Imported xpub"
        : "Secure key (encrypted)";

  const rows: [string, string][] = [
    ["Persona", k.persona],
    ["Type", keyType],
    ["Network", k.network.toUpperCase()],
    ...(k.origin === "tapit"
      ? ([] as [string, string][])
      : ([["Fingerprint", k.fingerprint], ["Path", k.derivationPath]] as [string, string][])),
    ["Backed up", k.backedUp ? "Yes" : "No"],
    ["Status", k.status],
    ["Created", new Date(k.createdAt).toLocaleDateString()],
  ];

  return (
    <Modal title={k.label} onClose={onClose} wide>
      <div style={{ background: colors.inset, borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        {rows.map(([rowLabel, value]) => (
          <div
            key={rowLabel}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "9px 14px",
              borderBottom: `1px solid ${colors.border}`,
            }}
          >
            <span style={{ fontSize: 12, color: colors.muted }}>{rowLabel}</span>
            <span
              style={{
                fontSize: 13,
                color: colors.text,
                fontFamily: ["Fingerprint", "Path"].includes(rowLabel) ? fonts.mono : "inherit",
              }}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
      {k.origin === "tapit" ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
            This key has no xpub -- Tapit's identity key isn't a BIP32 wallet, it's a single fixed
            public key. Manage or back up the underlying key from inside Tapit itself; this is a
            read-only copy of the public key you imported.
          </div>
          {k.tapitXOnlyPubkey && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <Label>Tapit public key (as reported, 32 bytes)</Label>
                <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => copy(k.tapitXOnlyPubkey!, "tapit")}>
                  {copied === "tapit" ? "Copied" : "Copy"}
                </Button>
              </div>
              <div style={{ background: colors.inset, borderRadius: radii.md, padding: "10px 12px", fontFamily: fonts.mono, fontSize: 11, color: colors.sub, wordBreak: "break-all" }}>
                {k.tapitXOnlyPubkey}
              </div>
            </>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, gap: 6 }}>
            <Label>Extended public key (xpub)</Label>
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 11 }}
                onClick={() => setShowQr(v => !v)}
              >
                {showQr ? "Hide QR" : "Show QR"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                style={{ padding: "3px 9px", fontSize: 11 }}
                onClick={() => copy(k.xpub, "xpub")}
              >
                {copied === "xpub" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          {showQr && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: 16,
                background: colors.inset,
                borderRadius: radii.md,
                marginBottom: 8,
              }}
            >
              <QrImage
                data={JSON.stringify({
                  xpub: k.xpub,
                  xfp: k.masterFingerprint ?? k.fingerprint,
                  path: k.derivationPath,
                })}
              />
              <div style={{ fontSize: 11, color: colors.muted, textAlign: "center" }}>
                Scan into another wallet or another DynastyTrust browser to import this xpub.
              </div>
            </div>
          )}
          <div style={{ background: colors.inset, borderRadius: radii.md, padding: "10px 12px", fontFamily: fonts.mono, fontSize: 11, color: colors.sub, wordBreak: "break-all", lineHeight: 1.6 }}>
            {k.xpub}
          </div>
        </div>
      )}
      {k.pubkey && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <Label>Public key (hex)</Label>
            <Button variant="ghost" size="sm" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => copy(k.pubkey, "pub")}>
              {copied === "pub" ? "Copied" : "Copy"}
            </Button>
          </div>
          <div style={{ background: colors.inset, borderRadius: radii.md, padding: "10px 12px", fontFamily: fonts.mono, fontSize: 11, color: colors.sub, wordBreak: "break-all" }}>
            {k.pubkey}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="ghost" style={{ fontSize: 13 }} onClick={onEdit}>
          Edit
        </Button>
        {k.origin === "software" && (
          <Button variant="ghost" style={{ fontSize: 13 }} onClick={onReveal}>
            {k.testMnemonic ? "View recovery phrase" : "View / backup"}
          </Button>
        )}
        {k.testMnemonic && (
          <Button
            variant="ghost"
            style={{ fontSize: 13, color: colors.gold, borderColor: colors.goldDim }}
            onClick={onSecure}
          >
            Add password
          </Button>
        )}
        {k.status === "active" && (
          <Button variant="ghost" style={{ fontSize: 13 }} onClick={onArchive}>
            Archive
          </Button>
        )}
        {k.status === "archived" && (
          <Button
            variant="ghost"
            style={{ fontSize: 13 }}
            onClick={() => {
              updateKeyStatus(k.keyId, "active");
              onClose();
            }}
          >
            Restore
          </Button>
        )}
        <Button variant="danger" style={{ fontSize: 13, marginLeft: "auto" }} onClick={onDelete}>
          Delete
        </Button>
      </div>
    </Modal>
  );
}

type ModalState =
  | { type: "quick" }
  | { type: "secure" }
  | { type: "import" }
  | { type: "test-created"; key: LocalKey; mnemonic: string }
  | { type: "backup"; key: LocalKey; mnemonic: string }
  | { type: "reveal"; key: LocalKey }
  | { type: "detail"; key: LocalKey }
  | { type: "upgrade"; key: LocalKey }
  | { type: "edit"; key: LocalKey };

export default function KeyManager() {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<LocalKey[]>([]);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [filter, setFilter] = useState<"active" | "archived" | "all">("active");
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setKeys(listAllKeys()), []);
  useEffect(() => {
    reload();
  }, [reload]);

  const personas = ["all", ...Array.from(new Set(keys.map(k => k.persona)))];
  const [personaFilter, setPersonaFilter] = useState("all");

  const visible = keys.filter(k => {
    if (filter === "active" && k.status !== "active") return false;
    if (filter === "archived" && k.status === "active") return false;
    if (personaFilter !== "all" && k.persona !== personaFilter) return false;
    if (
      search &&
      !k.label.toLowerCase().includes(search.toLowerCase()) &&
      !k.fingerprint.includes(search.toLowerCase())
    )
      return false;
    return true;
  });

  const palette = personaPalette;
  const personaColors: Record<string, string> = {};
  Array.from(new Set(keys.map(k => k.persona))).forEach((p, i) => {
    personaColors[p] = palette[i % palette.length];
  });

  async function handleArchive(keyId: string) {
    if (!(await confirm({ title: "Archive key", message: "Archive this key? It will be hidden from the active list but not deleted." }))) return;
    updateKeyStatus(keyId, "archived");
    reload();
    setModal(null);
  }
  async function handleDelete(keyId: string) {
    const key = keys.find(k => k.keyId === keyId);
    if (
      !(await confirm({
        title: "Delete key",
        message: `Permanently delete ${key?.label ? `"${key.label}"` : "this key"}? This cannot be undone. If this key signs a funded vault, make sure you have its recovery phrase backed up first.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    deleteKey(keyId);
    reload();
    setModal(null);
  }

  function doExport() {
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([exportKeyring()], { type: "application/json" })),
      download: "dynastytrust-keyring-" + Date.now() + ".json",
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function doImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const n = importKeyringJson(ev.target?.result as string);
        reload();
        toast.success("Imported " + n + " key(s)");
      } catch (err) {
        toast.error("Import failed: " + (err instanceof Error ? err.message : "Unknown error"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const activeCount = keys.filter(k => k.status === "active").length;
  const archivedCount = keys.filter(k => k.status === "archived").length;

  return (
    <div style={{ fontFamily: fonts.sans }}>
      <WalletLinkCard />
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <Button style={{ background: colors.green, fontSize: 14 }} onClick={() => setModal({ type: "quick" })}>
          + Quick key
        </Button>
        <Button
          variant="ghost"
          style={{ borderColor: colors.goldDim, color: colors.gold }}
          onClick={() => setModal({ type: "secure" })}
        >
          + Secure key
        </Button>
        <Button variant="ghost" onClick={() => setModal({ type: "import" })}>
          Import xpub
        </Button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={doExport}>
            Export JSON
          </Button>
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            Import JSON
          </Button>
          <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }} onChange={doImport} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          placeholder="Search by name or fingerprint..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: "8px 12px" }}
        />
        <div style={{ display: "flex", gap: 4 }}>
          {(["active", "archived", "all"] as const).map(f => (
            <Button
              key={f}
              variant="ghost"
              size="sm"
              onClick={() => setFilter(f)}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                borderColor: filter === f ? colors.gold : colors.border,
                color: filter === f ? colors.gold : colors.sub,
              }}
            >
              {f === "active" ? "Active (" + activeCount + ")" : f === "archived" ? "Archived (" + archivedCount + ")" : "All"}
            </Button>
          ))}
        </div>
      </div>

      {personas.length > 2 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {personas.map(p => {
            const accent = p === "all" ? colors.gold : (personaColors[p] ?? colors.gold);
            const active = personaFilter === p;
            return (
              <Button
                key={p}
                variant="ghost"
                size="sm"
                onClick={() => setPersonaFilter(p)}
                style={{
                  padding: "4px 11px",
                  fontSize: 12,
                  borderColor: active ? accent : colors.border,
                  color: active ? accent : colors.sub,
                }}
              >
                {p === "all" ? "All personas" : p}
              </Button>
            );
          })}
        </div>
      )}

      {visible.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "56px 24px",
            background: colors.surface,
            borderRadius: 14,
            border: `1px solid ${colors.border}`,
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            {search ? "No keys match your search" : "Start with a key"}
          </p>
          <p
            style={{
              color: colors.muted,
              fontSize: 14,
              maxWidth: 380,
              margin: "0 auto 24px",
              lineHeight: 1.55,
            }}
          >
            {search
              ? "Try a different search term."
              : "A key is one signer in a vault. Each person (founder, heir, protector) holds their own. Keys never leave this browser. Start with a test key to explore, or a secure (password-encrypted) key for real funds -- then compile a vault in the Policy Builder."}
          </p>
          {!search && (
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <Button style={{ background: colors.green }} onClick={() => setModal({ type: "quick" })}>
                Generate test key
              </Button>
              <Button variant="ghost" onClick={() => setModal({ type: "secure" })}>
                Generate secure key
              </Button>
            </div>
          )}
        </div>
      )}

      {Array.from(new Set(visible.map(k => k.persona))).map(persona => (
        <div key={persona} style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: personaColors[persona] ?? colors.gold }}>
              {persona}
            </span>
            <span style={{ fontSize: 11, color: colors.muted }}>
              {visible.filter(k => k.persona === persona).length} key(s)
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {visible
              .filter(k => k.persona === persona)
              .map(key => (
                <div
                  key={key.keyId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    background: colors.surface,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 12,
                    padding: "13px 16px",
                    cursor: "pointer",
                  }}
                  onClick={() => setModal({ type: "detail", key })}
                >
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 9,
                      flexShrink: 0,
                      background: key.origin === "tapit" ? colors.gold + "14" : key.testMnemonic ? colors.green + "14" : colors.blue + "14",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                    }}
                  >
                    {key.origin === "tapit" ? "🔐" : key.origin === "software" ? (key.testMnemonic ? "T" : "S") : "H"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>{key.label}</span>
                      {key.origin === "tapit" && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: colors.gold + "22", color: colors.gold }}>
                          TAPIT
                        </span>
                      )}
                      {key.testMnemonic && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: colors.green + "22", color: colors.green }}>
                          TEST
                        </span>
                      )}
                      {key.status === "archived" && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: colors.muted + "22", color: colors.muted }}>
                          ARCHIVED
                        </span>
                      )}
                      {!key.backedUp && key.origin === "software" && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: colors.orange + "22", color: colors.orange }}>
                          NOT BACKED UP
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.muted }}>
                        {key.fingerprint}
                      </span>
                      <span style={{ fontSize: 11, color: key.network === "mainnet" ? colors.gold : colors.green }}>
                        {key.network.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 11, color: colors.muted }}>{key.derivationPath}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      style={{ fontSize: 12, padding: "5px 10px" }}
                      onClick={() => setModal({ type: "edit", key })}
                    >
                      Edit
                    </Button>
                    {key.origin === "software" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        style={{ fontSize: 12, padding: "5px 10px" }}
                        onClick={() => setModal({ type: "reveal", key })}
                      >
                        {key.testMnemonic ? "Phrase" : "Backup"}
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      size="sm"
                      style={{ fontSize: 12, padding: "5px 10px" }}
                      onClick={() => handleDelete(key.keyId)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}

      {modal?.type === "quick" && (
        <QuickModal
          onClose={() => setModal(null)}
          onDone={(key, mnemonic) => {
            reload();
            setModal({ type: "test-created", key, mnemonic });
          }}
        />
      )}
      {modal?.type === "secure" && (
        <SecureModal
          onClose={() => setModal(null)}
          onDone={(key, mnemonic) => {
            reload();
            setModal({ type: "backup", key, mnemonic });
          }}
        />
      )}
      {modal?.type === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onDone={() => {
            reload();
            setModal(null);
          }}
        />
      )}
      {modal?.type === "test-created" && (
        <TestKeyCreated keyData={modal.key} mnemonic={modal.mnemonic} onClose={() => setModal(null)} />
      )}
      {modal?.type === "backup" && (
        <BackupFlow
          keyData={modal.key}
          mnemonic={modal.mnemonic}
          onDone={() => {
            reload();
            setModal(null);
          }}
        />
      )}
      {modal?.type === "reveal" && (
        <RevealModal
          keyData={modal.key}
          onClose={() => {
            reload();
            setModal(null);
          }}
          onBackedUp={() => reload()}
        />
      )}
      {modal?.type === "edit" && (
        <EditModal
          keyData={modal.key}
          onClose={() => setModal(null)}
          onDone={() => {
            reload();
            setModal(null);
          }}
        />
      )}
      {modal?.type === "detail" && (
        <DetailModal
          k={modal.key}
          onClose={() => setModal(null)}
          onReveal={() => setModal({ type: "reveal", key: modal.key })}
          onSecure={() => setModal({ type: "upgrade", key: modal.key })}
          onArchive={() => handleArchive(modal.key.keyId)}
          onDelete={() => handleDelete(modal.key.keyId)}
          onEdit={() => setModal({ type: "edit", key: modal.key })}
        />
      )}
      {modal?.type === "upgrade" && (
        <SecureUpgradeModal
          keyData={modal.key}
          onClose={() => setModal(null)}
          onDone={() => {
            reload();
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
