import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type VaultProposal } from '../lib/api';
import { colors, fonts, radii, space } from '../theme';
import { Button, Textarea } from '../components/ui';
import { useToast } from '../components/toast';

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
}

type Mode = 'guided' | 'express';

// Human-readable titles for the template ids the bot may propose.
// Kept in sync by hand with PolicyBuilder VAULT_TEMPLATES.
const TEMPLATE_TITLES: Record<string, string> = {
  'solo-savings': 'Solo Savings',
  couples: 'Couples',
  'family-inheritance': 'Family Inheritance',
  'generational-trust': 'Generational Trust',
  'business-treasury': 'Business Treasury',
  'emergency-backup': 'Lost-Device Insurance',
  'social-recovery': 'Self-Custody + Social Recovery',
};

function templateTitle(id: string): string {
  return TEMPLATE_TITLES[id] ?? id;
}

// Mirrors netlify/functions/assistant.js's looksLikeSecretMaterial --
// same reasoning, kept in sync by hand (same pattern _xpub.js/xpub.ts
// already use). This is a UX nicety, not the security boundary: it
// catches an obvious paste before it ever leaves the browser, saving a
// round trip, but the server-side check is what actually matters --
// this client-side one is never trusted to be the only gate.
const PRIVATE_KEY_PREFIXES = ['xprv', 'tprv', 'uprv', 'vprv'];

function looksLikeSecretMaterial(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (tokens.some(t => PRIVATE_KEY_PREFIXES.includes(t.slice(0, 4).toLowerCase()))) return true;
  if (tokens.some(t => /^(0x)?[0-9a-f]{64}$/i.test(t))) return true;
  const wordlike = tokens.map(t => /^[a-z]{3,8}$/i.test(t));
  let run = 0;
  for (const isWord of wordlike) {
    run = isWord ? run + 1 : 0;
    if (run >= 11) return true;
  }
  return false;
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
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    // Checked before the text is even added to on-screen history or sent
    // anywhere -- see looksLikeSecretMaterial's header comment.
    if (looksLikeSecretMaterial(text)) {
      toast.error(
        "That looks like it might contain a seed phrase or private key -- never type or paste one here. Nothing was sent. Use the Keys step in the vault wizard instead, which keeps it in your browser only.",
      );
      return;
    }
    setDraft('');
    setMessages(prev => [...prev, { sender: 'user', content: text }]);
    setSending(true);
    try {
      const res = await api.assistant.chat({
        thread_id: threadId,
        message: text,
        mode,
      });
      setThreadId(res.thread.id);
      setMessages(prev => [
        ...prev,
        { sender: 'wizard', content: res.reply, proposal: res.proposed_values },
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
        <span style={{ fontSize: 12, color: colors.muted }}>Pace:</span>
        <ModeToggle mode={mode} onChange={setMode} />
        <span style={{ fontSize: 12, color: colors.muted }}>
          {mode === 'express'
            ? 'Fast and concrete -- ask "why?" any time for the deeper lesson.'
            : 'Take all the education you want -- one step at a time, as deep as you like.'}
        </span>
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
          </div>
        ))}
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
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  // 'guided' is the friendly, education-first pace the doc calls the Rabbit
  // Hole. The backend mode contract stays 'guided' | 'express'; only the
  // user-facing label reflects the curriculum's name.
  const opts: { id: Mode; label: string }[] = [
    { id: 'guided', label: 'Rabbit Hole' },
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
  const hasSecondInheritance = (proposal.second_inheritance_after_months ?? 0) > 0;

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
        {hasSecondInheritance && (
          <li>
            deeper backstop: {proposal.second_heir_quorum} of {proposal.second_heir_count}{' '}
            {proposal.second_heir_count === 1 ? 'key' : 'keys'} alone can spend after about{' '}
            {proposal.second_inheritance_after_months} months
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
