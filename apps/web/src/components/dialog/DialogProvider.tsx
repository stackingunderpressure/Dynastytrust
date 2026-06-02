import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { colors } from '../../theme';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

// Promise-based replacements for the browser's blocking window.confirm /
// window.prompt. Both render styled modals that match the design system and
// resolve when the user acts. Use via useConfirm() / usePrompt().

interface ConfirmOpts {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOpts {
  title?: string;
  message: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  password?: boolean;
  confirmLabel?: string;
  // When set, the confirm button stays disabled until the typed value matches
  // this string exactly (used for "type the name to delete" guards).
  matchValue?: string;
}

interface DialogApi {
  confirm: (opts: ConfirmOpts | string) => Promise<boolean>;
  prompt: (opts: PromptOpts | string) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

type ActiveConfirm = { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void };
type ActivePrompt = { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };
type Active = ActiveConfirm | ActivePrompt;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;

  const settle = useCallback((value: boolean | string | null) => {
    const cur = activeRef.current;
    if (!cur) return;
    setActive(null);
    if (cur.kind === 'confirm') cur.resolve(value as boolean);
    else cur.resolve(value as string | null);
  }, []);

  const confirm = useCallback((opts: ConfirmOpts | string) => {
    const normalized = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise<boolean>(resolve => {
      setActive({ kind: 'confirm', opts: normalized, resolve });
    });
  }, []);

  const prompt = useCallback((opts: PromptOpts | string) => {
    const normalized = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise<string | null>(resolve => {
      setActive({ kind: 'prompt', opts: normalized, resolve });
    });
  }, []);

  const api = useMemo<DialogApi>(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active?.kind === 'confirm' && (
        <ConfirmDialog
          opts={active.opts}
          onCancel={() => settle(false)}
          onConfirm={() => settle(true)}
        />
      )}
      {active?.kind === 'prompt' && (
        <PromptDialog
          opts={active.opts}
          onCancel={() => settle(null)}
          onSubmit={v => settle(v)}
        />
      )}
    </DialogContext.Provider>
  );
}

function ConfirmDialog({
  opts,
  onCancel,
  onConfirm,
}: {
  opts: ConfirmOpts;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={opts.title ?? 'Please confirm'} onClose={onCancel}>
      <div style={{ fontSize: 14, color: colors.sub, lineHeight: 1.55, marginBottom: 22 }}>
        {opts.message}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel}>
          {opts.cancelLabel ?? 'Cancel'}
        </Button>
        <Button variant={opts.danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {opts.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </Modal>
  );
}

function PromptDialog({
  opts,
  onCancel,
  onSubmit,
}: {
  opts: PromptOpts;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(opts.defaultValue ?? '');
  const matchOk = opts.matchValue == null || value === opts.matchValue;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matchOk) return;
    onSubmit(value);
  }

  return (
    <Modal title={opts.title ?? 'Enter value'} onClose={onCancel}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 14, color: colors.sub, lineHeight: 1.55 }}>{opts.message}</div>
        <Input
          autoFocus
          type={opts.password ? 'password' : 'text'}
          value={value}
          placeholder={opts.placeholder}
          onChange={e => setValue(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!matchOk}>
            {opts.confirmLabel ?? 'OK'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>');
  return ctx;
}

export function useConfirm() {
  return useDialog().confirm;
}

export function usePrompt() {
  return useDialog().prompt;
}
