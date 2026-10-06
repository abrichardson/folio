import { invoke } from '@tauri-apps/api/core';

// Where the finance workspace is stored. In the desktop app this is an encrypted
// SQLite file managed by the Rust side (src-tauri); `npm run dev` in a plain browser
// uses an in-browser fallback with fictional data only.

export type VaultStatus = 'missing' | 'locked' | 'unlocked';
export type Stored = { payload: string | null; version: number };
export type Backup = {
  name: string;
  /** Local calendar date it was made (YYYY-MM-DD). */
  date: string;
  kind: 'daily' | 'manual' | 'upgrade' | 'restore';
  /** Seconds since 1970. */
  created: number;
  bytes: number;
};

/** Receipts and other files, stored encrypted inside the data file. */
export interface Attachments {
  add(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array>;
  remove(ids: string[]): Promise<void>;
  /** Saves a copy where the user chooses; false if they cancel. */
  saveCopy(id: string, name: string): Promise<boolean>;
}

/** Encrypted copies of the data file, kept beside it. Desktop app only. */
export interface Backups {
  list(): Promise<Backup[]>;
  /** Makes today's backup unless one exists; resolves to it, or null. */
  daily(date: string): Promise<Backup | null>;
  now(date: string): Promise<Backup>;
  /** Replaces the file with a backup; afterwards it opens with the backup's password. */
  restore(name: string, password: string, date: string): Promise<void>;
  /** Saves a copy where the user chooses; false if they cancel. */
  saveCopy(name: string): Promise<boolean>;
}

export interface Storage {
  status(): Promise<VaultStatus>;
  create(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  load(): Promise<Stored>;
  /**
   * Saves if the file is still at `version`; resolves to the new version. `payload` is the
   * workspace document; when it has a `transactions` array, those replace all stored
   * transactions, otherwise `upsert` (JSON rows) and `remove` (IDs) are applied.
   */
  save(payload: string, upsert: string[], remove: string[], version: number): Promise<number>;
  changePassword(current: string, next: string): Promise<void>;
  /** Null where backups are not available (the in-browser development preview). */
  backups: Backups | null;
  attachments: Attachments;
}

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Errors from Rust commands arrive as plain strings; surface them as Errors.
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : 'Folio could not complete that action.');
  }
}

const desktopStorage: Storage = {
  status: () => call<VaultStatus>('vault_status'),
  create: (password) => call('vault_create', { password }),
  unlock: (password) => call('vault_unlock', { password }),
  lock: () => call('vault_lock'),
  load: () => call<Stored>('state_load'),
  save: (payload, upsert, remove, version) =>
    call<number>('state_save', { payload, upsert, remove, version }),
  changePassword: (current, next) => call('vault_change_password', { current, next }),
  attachments: {
    add: async (id, bytes) => {
      try {
        await invoke('attachment_add', bytes, { headers: { 'x-id': id } });
      } catch (e) {
        throw new Error(typeof e === 'string' ? e : 'The file could not be attached.');
      }
    },
    get: async (id) => new Uint8Array(await call<ArrayBuffer>('attachment_get', { id })),
    remove: (ids) => call('attachment_delete', { ids }),
    saveCopy: (id, name) => call<boolean>('attachment_save_copy', { id, name }),
  },
  backups: {
    list: () => call<Backup[]>('backup_list'),
    daily: (date) => call<Backup | null>('backup_daily', { date }),
    now: (date) => call<Backup>('backup_now', { date }),
    restore: (name, password, date) => call('backup_restore', { name, password, date }),
    saveCopy: (name) => call<boolean>('backup_save_copy', { name }),
  },
};

const DEV_KEY = 'folio-dev-workspace';
function browserDevStorage(): Storage {
  const read = (): Stored => {
    try {
      const raw = localStorage.getItem(DEV_KEY);
      if (raw) return JSON.parse(raw) as Stored;
    } catch {
      // Unreadable development data starts over with the demo workspace.
    }
    return { payload: null, version: 0 };
  };
  return {
    status: async () => 'unlocked',
    create: async () => {},
    unlock: async () => {},
    lock: async () => {},
    changePassword: async () => {
      throw new Error('Passwords apply to the desktop app’s encrypted file.');
    },
    backups: null,
    // The browser preview keeps attachments in memory only.
    attachments: (() => {
      const files = new Map<string, Uint8Array>();
      return {
        add: async (id: string, bytes: Uint8Array) => void files.set(id, bytes),
        get: async (id: string) => {
          const bytes = files.get(id);
          if (!bytes) throw new Error('That attachment was not found.');
          return bytes;
        },
        remove: async (ids: string[]) => ids.forEach((id) => files.delete(id)),
        saveCopy: async () => false,
      };
    })(),
    load: async () => read(),
    save: async (payload, upsert, remove, version) => {
      const current = read();
      if (current.version !== version)
        throw new Error('Your finances changed in another window. Reload before saving again.');
      // Mirrors the desktop file: apply the changed rows to the stored transactions.
      type Row = { id: string };
      const doc = JSON.parse(payload) as { transactions?: Row[] };
      if (!doc.transactions) {
        const rows = new Map<string, Row>(
          (
            (current.payload && (JSON.parse(current.payload) as { transactions?: Row[] })) ||
            {}
          ).transactions?.map((t) => [t.id, t]) ?? [],
        );
        for (const row of upsert.map((r) => JSON.parse(r) as Row)) rows.set(row.id, row);
        for (const id of remove) rows.delete(id);
        doc.transactions = [...rows.values()];
      }
      localStorage.setItem(
        DEV_KEY,
        JSON.stringify({ payload: JSON.stringify(doc), version: version + 1 }),
      );
      return version + 1;
    },
  };
}

export function getStorage(): Storage | null {
  if (isTauri()) return desktopStorage;
  if (import.meta.env.DEV) return browserDevStorage();
  return null;
}
