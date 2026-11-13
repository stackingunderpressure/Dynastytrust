// The download build's records -- vaults, spends (proposals) and the
// activity list -- kept on this computer. One small interface, so the
// encrypted file the operator chose (docs/download-and-run-build-note.md,
// decision 3) replaces the storage underneath without touching the
// handlers. Today: the app's own storage, as JSON.

export type Row = Record<string, unknown> & { id: string };
export type Table = 'vaults' | 'proposals' | 'events';

interface Backend {
  read(): Record<Table, Row[]> | null;
  write(all: Record<Table, Row[]>): void;
}

const KEY = 'dt:download:records:v1';
const storageBackend: Backend = {
  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  },
  write(all) {
    localStorage.setItem(KEY, JSON.stringify(all));
  },
};

let backend: Backend = storageBackend;
/** Tests hand in a memory backend; the encrypted file will plug in here. */
export function useStoreBackend(b: Backend | null): void { backend = b ?? storageBackend; cache = null; }

let cache: Record<Table, Row[]> | null = null;
function all(): Record<Table, Row[]> {
  if (!cache) cache = backend.read() ?? { vaults: [], proposals: [], events: [] };
  return cache;
}
function save(): void { backend.write(all()); }

export function list(t: Table): Row[] { return all()[t].map(r => ({ ...r })); }
export function get(t: Table, id: string): Row | null {
  const r = all()[t].find(x => x.id === id);
  return r ? { ...r } : null;
}
export function insert(t: Table, row: Omit<Row, 'id' | 'created_at'>): Row {
  const now = new Date().toISOString();
  const full = { ...row, id: crypto.randomUUID(), created_at: now, updated_at: now } as Row;
  all()[t].push(full);
  save();
  return { ...full };
}
export function update(t: Table, id: string, patch: Record<string, unknown>): Row | null {
  const rows = all()[t];
  const i = rows.findIndex(x => x.id === id);
  if (i < 0) return null;
  rows[i] = { ...rows[i], ...patch, updated_at: new Date().toISOString() };
  save();
  return { ...rows[i] };
}
export function remove(t: Table, id: string): boolean {
  const rows = all()[t];
  const i = rows.findIndex(x => x.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  save();
  return true;
}

/** The one person using this copy of the app. */
export const LOCAL_USER = 'local';

export function recordEvent(vault_id: string, event_type: string, metadata: Record<string, unknown> = {}): void {
  insert('events', { vault_id, user_id: LOCAL_USER, event_type, metadata });
}
