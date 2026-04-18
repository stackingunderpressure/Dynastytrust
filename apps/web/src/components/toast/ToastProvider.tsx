import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { colors, fonts, radii, space } from '../../theme';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setToasts(t => [...t, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: m => show(m, 'success'),
      error: m => show(m, 'error'),
      info: m => show(m, 'info'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'fixed',
          bottom: space[6],
          right: space[6],
          display: 'flex',
          flexDirection: 'column',
          gap: space[2],
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const accent =
    toast.kind === 'success'
      ? colors.green
      : toast.kind === 'error'
        ? colors.red
        : colors.blue;

  return (
    <div
      role="status"
      onClick={onDismiss}
      style={{
        pointerEvents: 'auto',
        cursor: 'pointer',
        background: colors.raised,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: radii.md,
        color: colors.text,
        fontFamily: fonts.sans,
        fontSize: 14,
        padding: `${space[3]}px ${space[4]}px`,
        minWidth: 240,
        maxWidth: 360,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      {toast.message}
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
