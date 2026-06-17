import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type VaultProposal, type AssistantEyes } from '../lib/api';
import { listKeys } from '../lib/keystore';
import { colors, fonts, radii, space } from '../theme';
import { Button, Textarea } from '../components/ui';
import { useToast } from '../components/toast';
// Single source of truth: template titles + the opening common-path
// chips both derive from the same canonical module PolicyBuilder and
// Sage's brain read, so the chat surface can never drift from the real
// templates the app supports.
import { TEMPLATE_TITLES, openingChips } from '../data/vault-templates';

/**
 * ChatWizard.tsx -- the education bot ("Sage"), slice 1.
 *
 * A warm, guided conversation that teaches a newcomer and walks them
 * toward building ONE vault. Sage PROPOSES values; the person DECIDES
 * with a tap. When a reply carries a structured proposal, we render a
 * CONFIRM CARD in plain English. Confirming hands off to the EXISTING
 * PolicyBuilder (route /policy) with the proposal as prefill -- we do
 * NOT compile or save a vault here. No key material ever flows through
 * this page.
 */

interface ChatMessage {
  sender: 'user' | 'wizard';
  content: string;
  // Attached to the wizard turn that carried it, so the confirm card
  // renders inline beneath that reply.
  proposal?: VaultProposal | null;
  // Model-emitted contextual next-step chips, attached to the wizard
  // turn that carried them. Tapping one sends it as the next message.
  chips?: string[] | null;
}

type Mode = 'guided' | 'express';

// Human-readable titles for the template ids the bot may propose come
// from the SSOT (TEMPLATE_TITLES is derived from VAULT_TEMPLATES there),
// so there is no hand-synced map to drift.
function templateTitle(id: string): string {
  return TEMPLATE_TITLES[id] ?? id;
}

// Assemble the readiness "eyes" from data the client already holds.
// SAFE FIELDS ONLY -- we read COUNTS and public labels, never key
// material. From each LocalKey we touch ONLY: status (to count active
// keys), the PRESENCE of encryptedMnemonic vs testMnemonic (to classify
// secure vs test -- we never read their values), and backedUp (a flag).
// We never read xpub, pubkey, fingerprint, or any mnemonic value. From
// each vault we take ONLY name + network labels (the Vault type carries
// no template, so template is null). The server re-sanitizes all of this.
function buildEyes(vaults: { name: string; network: 'testnet' | 'signet' | 'bitcoin' }[]): AssistantEyes {
  const keys = listKeys().filter(k => k.status === 'active');
  let secure = 0;
  let test = 0;
  let backedUp = 0;
  for (const k of keys) {
    // Presence checks only -- the blob/mnemonic VALUES are never read.
    if (k.encryptedMnemonic) secure += 1;
    else if (k.testMnemonic) test += 1;
    if (k.backedUp) backedUp += 1;
  }
  return {
    keys: {
      key_count: keys.length,
      secure_key_count: secure,
      test_key_count: test,
      backed_up_key_count: backedUp,
    },
    vault_count: vaults.length,
    vaults: vaults.map(v => ({ name: v.name, template: null, network: v.network })),
  };
}

const INTRO =
  "Hi, I'm Sage. I'll help you understand Bitcoin vaults and build one that fits your life -- one step at a time, in plain language. I have no control over your money: I only suggest, you decide with a tap. I never see or ask for your seed words, private keys, or passwords -- those live only in your browser. To start, tell me in your own words: who is this Bitcoin for, and who should be able to reach it if something happens to you?";

export default function ChatWizard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('guided');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { sender: 'wizard', content: INTRO },
  ]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // Readiness eyes -- COUNTS + labels only, no key material. Seeded
  // from the keystore (sync) on mount, then enriched with vault
  // name/network labels once the vault list loads.
  const [eyes, setEyes] = useState<AssistantEyes>(() => buildEyes([]));
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Load the safe vault labels (name + network only) and fold them
  // into the eyes. Failures are non-fatal -- Sage just sees the key
  // counts and zero vaults.
  useEffect(() => {
    let alive = true;
    api.vaults
      .list(false)
      .then(res => {
        if (!alive) return;
        const safeVaults = res.vaults.map(v => ({ name: v.name, network: v.network }));
        setEyes(buildEyes(safeVaults));
      })
      .catch(() => {
        /* keep the keystore-only eyes */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Send a message. With no argument it sends the textarea draft; with
  // an explicit string it sends that (used by the tap-able chips, which
  // reuse this exact same path so a chip tap behaves like typing).
  async function send(explicit?: string) {
    const text = (explicit ?? draft).trim();
    if (!text || sending) return;
    setDraft('');
    setMessages(prev => [...prev, { sender: 'user', content: text }]);
    setSending(true);
    try {
      const res = await api.assistant.chat({
        thread_id: threadId,
        message: text,
        mode,
        eyes,
      });
      setThreadId(res.thread.id);
      setMessages(prev => [
        ...prev,
        {
          sender: 'wizard',
          content: res.reply,
          proposal: res.proposed_values,
          chips: res.chips,
        },
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sage could not reply');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Hand the proposal to the existing PolicyBuilder. We do NOT compile
  // or save here -- the proven form is the only vault-creation path.
  function buildThis(proposal: VaultProposal) {
    navigate('/policy', { state: { prefill: proposal } });
  }

  // True once the person has sent at least one message. Drives the
  // opening common-path chips, which only show on the fresh screen.
  const hasUserSpoken = messages.some(m => m.sender === 'user');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space[2],
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 12, color: colors.muted }}>Conversation style:</span>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <div
        ref={listRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: space[3],
          maxHeight: '58vh',
          overflowY: 'auto',
          padding: space[1],
        }}
      >
        {messages.map((m, i) => (
          <div key={i}>
            <Bubble sender={m.sender} text={m.content} />
            {m.proposal && (
              <ConfirmCard
                proposal={m.proposal}
                onBuild={() => buildThis(m.proposal!)}
              />
            )}
            {m.sender === 'wizard' && m.chips && m.chips.length > 0 && !sending && (
              <ChipRow chips={m.chips} disabled={sending} onPick={c => void send(c)} />
            )}
          </div>
        ))}
        {/* Opening common-path chips -- shown only before the first user
            message, derived from the SSOT's most common templates plus
            two evergreen helpers. Free-text input always stays available. */}
        {!hasUserSpoken && !sending && (
          <ChipRow chips={openingChips()} disabled={sending} onPick={c => void send(c)} />
        )}
        {sending && (
          <Bubble sender="wizard" text="Sage is thinking..." muted />
        )}
      </div>

      <div style={{ display: 'flex', gap: space[2], alignItems: 'flex-end' }}>
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Tell Sage about your situation..."
          rows={2}
          style={{ flex: 1 }}
          disabled={sending}
        />
        <Button onClick={() => void send()} disabled={sending || !draft.trim()}>
          Send
        </Button>
      </div>

      <div
        style={{
          fontSize: 11,
          color: colors.muted,
          fontFamily: fonts.sans,
          textAlign: 'center',
        }}
      >
        What Sage can see: {eyes.keys.key_count}{' '}
        {eyes.keys.key_count === 1 ? 'key' : 'keys'}, {eyes.vault_count}{' '}
        {eyes.vault_count === 1 ? 'vault' : 'vaults'} -- never your seed words or keys.
      </div>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: { id: Mode; label: string }[] = [
    { id: 'guided', label: 'Guided' },
    { id: 'express', label: 'Express' },
  ];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {opts.map(o => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              padding: '6px 14px',
              borderRadius: radii.md,
              border: '1px solid',
              borderColor: active ? colors.gold : colors.border,
              background: active ? colors.gold + '22' : 'transparent',
              color: active ? colors.gold : colors.muted,
              fontWeight: active ? 700 : 400,
              fontSize: 13,
              fontFamily: fonts.sans,
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Tap-able chips. Used for both the opening common-path set (derived
// from the SSOT) and the model-emitted contextual next-step chips. A
// tap sends the chip text down the normal send() path -- exactly as if
// the person had typed it -- so there is no second, divergent flow.
// Styled to match the gold ModeToggle / ConfirmCard look using theme
// tokens, never raw hex.
function ChipRow({
  chips,
  onPick,
  disabled,
}: {
  chips: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: space[2],
        marginTop: space[2],
      }}
    >
      {chips.map((c, i) => (
        <button
          key={i}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c)}
          style={{
            padding: '7px 14px',
            borderRadius: radii.lg,
            border: `1px solid ${colors.goldDim}`,
            background: colors.gold + '14',
            color: colors.gold,
            fontSize: 13,
            fontFamily: fonts.sans,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            lineHeight: 1.3,
            textAlign: 'left',
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function Bubble({
  sender,
  text,
  muted,
}: {
  sender: 'user' | 'wizard';
  text: string;
  muted?: boolean;
}) {
  const isUser = sender === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '85%',
          background: isUser ? colors.gold + '1A' : colors.surface,
          border: `1px solid ${isUser ? colors.goldDim : colors.border}`,
          borderRadius: radii.lg,
          padding: '10px 14px',
          color: muted ? colors.muted : colors.text,
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          fontFamily: fonts.sans,
          fontStyle: muted ? 'italic' : 'normal',
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: isUser ? colors.gold : colors.muted,
            marginBottom: 4,
          }}
        >
          {isUser ? 'You' : 'Sage'}
        </div>
        {text}
      </div>
    </div>
  );
}

// Tap-to-confirm card: shows the proposed vault in plain English so the
// person confirms MEANING, never raw config. "Build this vault" hands
// off to the PolicyBuilder; "Keep talking" just dismisses (the card
// stays in the transcript but the person can continue the conversation).
function ConfirmCard({
  proposal,
  onBuild,
}: {
  proposal: VaultProposal;
  onBuild: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const hasHeirs = proposal.heir_count > 0;
  const hasRecovery = proposal.recovery_after_months > 0;

  return (
    <div
      style={{
        marginTop: space[2],
        marginLeft: 'auto',
        marginRight: 'auto',
        maxWidth: '85%',
        background: colors.goldBg,
        border: `1px solid ${colors.gold}`,
        borderRadius: radii.lg,
        padding: space[4],
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: colors.gold,
          fontWeight: 700,
          marginBottom: space[2],
        }}
      >
        Proposed vault -- you decide
      </div>

      <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: space[2] }}>
        {templateTitle(proposal.template)}
      </div>

      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 13,
          color: colors.sub,
          lineHeight: 1.6,
        }}
      >
        <li>
          {proposal.founder_quorum} of {proposal.founder_count}{' '}
          {proposal.founder_count === 1 ? 'signer' : 'signers'} can spend now
        </li>
        {hasRecovery && (
          <li>recovery path opens after about {proposal.recovery_after_months} months</li>
        )}
        {hasHeirs && (
          <li>
            heirs: {proposal.heir_quorum} of {proposal.heir_count} can inherit after about{' '}
            {proposal.inheritance_after_months} months
          </li>
        )}
        {!hasHeirs && !hasRecovery && <li>no timelocks -- founders only</li>}
      </ul>

      {proposal.summary && (
        <div
          style={{
            marginTop: space[3],
            fontSize: 13,
            color: colors.text,
            lineHeight: 1.5,
            fontStyle: 'italic',
          }}
        >
          {proposal.summary}
        </div>
      )}

      {!dismissed && (
        <div style={{ display: 'flex', gap: space[2], marginTop: space[4], flexWrap: 'wrap' }}>
          <Button onClick={onBuild}>Looks right -- build this vault</Button>
          <Button variant="ghost" onClick={() => setDismissed(true)}>
            Keep talking
          </Button>
        </div>
      )}
      {dismissed && (
        <div style={{ marginTop: space[3], fontSize: 12, color: colors.muted }}>
          No problem -- ask Sage anything else, or refine what you want.
        </div>
      )}
    </div>
  );
}
