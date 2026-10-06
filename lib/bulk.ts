import type { Finance, Transaction } from './finance';

// Changes to many transactions at once, from the Transactions page selection.

const touched = (t: Transaction): Transaction =>
  t.plaidItemId ? { ...t, categoryEdited: true } : t.importBatch ? { ...t, edited: true } : t;

/** Files the selected transactions under one category. */
export function setCategory(data: Finance, ids: ReadonlySet<string>, category: string): Finance {
  return {
    ...data,
    transactions: data.transactions.map((t) => {
      if (!ids.has(t.id) || (t.category === category && !t.splits)) return t;
      // One category for the whole amount replaces any split.
      const whole = { ...t, category };
      delete whole.splits;
      return touched(whole);
    }),
  };
}

/** Marks the selected transactions cleared; pending and reconciled ones are left alone. */
export function markCleared(data: Finance, ids: ReadonlySet<string>): Finance {
  return {
    ...data,
    transactions: data.transactions.map((t) =>
      ids.has(t.id) && !t.pending && !t.status ? { ...t, status: 'cleared' as const } : t,
    ),
  };
}

/** Transactions that can be deleted by hand: bank-synced ones cannot. */
export const deletable = (data: Finance, ids: ReadonlySet<string>) =>
  data.transactions.filter((t) => ids.has(t.id) && !t.plaidItemId);

export function deleteTransactions(data: Finance, ids: ReadonlySet<string>): Finance {
  const remove = new Set(deletable(data, ids).map((t) => t.id));
  return { ...data, transactions: data.transactions.filter((t) => !remove.has(t.id)) };
}
