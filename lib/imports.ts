import {
  MAX_IMPORTS,
  type Account,
  type Finance,
  type ImportRecord,
  type Transaction,
} from './finance';

// Import history and Undo. Each import is recorded with what it added and how it changed
// each account, so it can be reversed later without losing edits made since.

export type ImportedAccount = {
  /** The account as the import leaves it. */
  account: Account;
  created: boolean;
  /** New transactions for this account (duplicates already removed). */
  transactions: Transaction[];
  duplicates: number;
  skipped: number;
  from: string | null;
  to: string | null;
  balance: ImportRecord['accounts'][number]['balance'];
};

export type ImportResult = {
  fileName: string;
  format: ImportRecord['format'];
  fileHash?: string;
  accounts: ImportedAccount[];
  /** Replaces the default "N transactions imported" message. */
  message?: string;
};

/** Date range of a set of rows, as [earliest, latest]. */
export function dateRange(rows: { date: string }[]): [string | null, string | null] {
  let from: string | null = null;
  let to: string | null = null;
  for (const { date } of rows) {
    if (!from || date < from) from = date;
    if (!to || date > to) to = date;
  }
  return [from, to];
}

/** Adds an import's accounts and transactions to the workspace and records it in history. */
export function applyImport(data: Finance, result: ImportResult, id: string, at: string): Finance {
  const next = structuredClone(data);
  const record: ImportRecord = {
    id,
    at,
    fileName: result.fileName.slice(0, 260),
    format: result.format,
    ...(result.fileHash ? { fileHash: result.fileHash } : {}),
    accounts: [],
  };
  for (const r of result.accounts) {
    const index = next.accounts.findIndex((a) => a.id === r.account.id);
    const before = index >= 0 ? next.accounts[index] : null;
    if (index >= 0) next.accounts[index] = r.account;
    else next.accounts.push(r.account);
    // Rows from a bank file are cleared: the bank has recorded them.
    next.transactions.push(
      ...r.transactions.map((t) => ({ ...t, importBatch: id, status: 'cleared' as const })),
    );
    record.accounts.push({
      accountId: r.account.id,
      created: !before,
      added: r.transactions.length,
      duplicates: r.duplicates,
      skipped: r.skipped,
      from: r.from,
      to: r.to,
      balance: r.balance,
      // Copies, so later edits to the account never change the record.
      before: before && structuredClone(before),
      after: structuredClone(r.account),
    });
  }
  next.imports = [...next.imports, record].slice(-MAX_IMPORTS);
  return next;
}

/** Compares values with object keys in any order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  return [...keys].every((k) => sameValue(ao[k], bo[k]));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reverts the fields an import changed (`before` → `after`) in `current`, leaving any field
 * that was changed again since then. Nested objects (card details) are compared field by
 * field. Returns the reverted value and whether any later change was kept.
 */
function revert(
  current: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { value: Record<string, unknown>; kept: boolean } {
  const value = { ...current };
  let kept = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key];
    const set = after[key];
    if (sameValue(was, set)) continue;
    const now = current[key];
    if (isPlainObject(now) && isPlainObject(set) && (was === undefined || isPlainObject(was))) {
      const inner = revert(now, (was as Record<string, unknown>) ?? {}, set);
      // Details the import added to an account that had none are removed entirely.
      if (was === undefined && !Object.keys(inner.value).length) delete value[key];
      else value[key] = inner.value;
      kept ||= inner.kept;
    } else if (sameValue(now, set)) {
      if (was === undefined) delete value[key];
      else value[key] = was;
    } else kept = true;
  }
  return { value, kept };
}

export type UndoSummary = {
  removed: number;
  /** Transactions edited or reconciled after the import; they stay. */
  keptEdited: number;
  restored: string[];
  /** Accounts with changes made after the import, which were kept. */
  keptChanges: string[];
  removedAccounts: string[];
  /** Accounts the import created that now hold other records, so they stay. */
  keptAccounts: string[];
};

/**
 * Reverses an import: removes its transactions (except ones edited since), restores the
 * account details it changed (except fields changed again since), and removes accounts it
 * created when nothing else uses them.
 */
export function undoImport(
  data: Finance,
  importId: string,
  at: string,
): { next: Finance; summary: UndoSummary } {
  const record = data.imports.find((r) => r.id === importId);
  if (!record) throw new Error('That import is no longer in the history.');
  if (record.undoneAt) throw new Error('That import was already undone.');
  const next = structuredClone(data);
  const summary: UndoSummary = {
    removed: 0,
    keptEdited: 0,
    restored: [],
    keptChanges: [],
    removedAccounts: [],
    keptAccounts: [],
  };
  next.transactions = next.transactions.filter((t) => {
    if (t.importBatch !== importId) return true;
    if (t.edited || t.status === 'reconciled') {
      summary.keptEdited++;
      return true;
    }
    summary.removed++;
    return false;
  });
  for (const entry of record.accounts) {
    const index = next.accounts.findIndex((a) => a.id === entry.accountId);
    if (index < 0) continue;
    const current = next.accounts[index];
    if (entry.created || !entry.before) {
      const inUse =
        next.transactions.some((t) => t.accountId === current.id) ||
        next.bills.some((b) => b.accountId === current.id);
      if (!inUse && sameValue(current, entry.after)) {
        next.accounts.splice(index, 1);
        summary.removedAccounts.push(current.name);
      } else summary.keptAccounts.push(current.name);
      continue;
    }
    const { value, kept } = revert(current, entry.before, entry.after);
    next.accounts[index] = value as Account;
    if (!sameValue(value, current)) summary.restored.push(current.name);
    if (kept) summary.keptChanges.push(current.name);
  }
  next.imports = next.imports.map((r) => (r.id === importId ? { ...r, undoneAt: at } : r));
  return { next, summary };
}

export function describeUndo(s: UndoSummary): string {
  const parts = [`Removes ${s.removed} imported transaction${s.removed === 1 ? '' : 's'}`];
  if (s.keptEdited)
    parts.push(
      `keeps ${s.keptEdited} you edited or reconciled since (delete those by hand if unwanted)`,
    );
  if (s.restored.length) parts.push(`restores the earlier details of ${s.restored.join(', ')}`);
  if (s.keptChanges.length)
    parts.push(`keeps the later changes to ${s.keptChanges.join(', ')}, such as a newer balance`);
  if (s.removedAccounts.length)
    parts.push(`removes the new account ${s.removedAccounts.join(', ')}`);
  if (s.keptAccounts.length)
    parts.push(`keeps ${s.keptAccounts.join(', ')}, which now holds other records`);
  return parts.join('; ') + '.';
}

/** The import of the same file that is still in effect, if any. */
export const previousImportOf = (data: Finance, fileHash: string) =>
  [...data.imports].reverse().find((r) => r.fileHash === fileHash && !r.undoneAt);
