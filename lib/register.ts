import { liability, type Account, type Transaction } from './finance';

// The account register: an account's transactions in date order with a running balance,
// starting from an opening balance. Balances use the account's own sign: what you have for
// assets, what you owe for cards and loans. Pending transactions are listed but not counted.

/** How a transaction changes the account's balance (a card purchase raises what is owed). */
export const effect = (account: Account, amount: number) => (liability(account) ? -amount : amount);

const counts = (t: Transaction) => !t.pending;

/** The account's transactions, oldest first; same-day entries keep their saved order. */
export function accountTransactions(account: Account, transactions: Transaction[]) {
  return transactions
    .map((t, i) => [t, i] as const)
    .filter(([t]) => t.accountId === account.id)
    .sort(([a, i], [b, j]) => a.date.localeCompare(b.date) || i - j)
    .map(([t]) => t);
}

export type RegisterRow = {
  transaction: Transaction;
  /** Balance after this entry, or null before the opening date or without one. */
  balance: number | null;
};

export function registerRows(account: Account, transactions: Transaction[]): RegisterRow[] {
  const opening = account.openingBalance;
  let balance = opening?.amount ?? 0;
  return accountTransactions(account, transactions).map((transaction) => {
    if (!opening || transaction.date < opening.date) return { transaction, balance: null };
    if (counts(transaction)) balance += effect(account, transaction.amount);
    return { transaction, balance };
  });
}

/** The register balance at the end of `date`, or null without an opening balance. */
export function balanceOn(account: Account, transactions: Transaction[], date: string) {
  const opening = account.openingBalance;
  if (!opening || date < opening.date) return null;
  return transactions
    .filter(
      (t) => t.accountId === account.id && counts(t) && t.date >= opening.date && t.date <= date,
    )
    .reduce((sum, t) => sum + effect(account, t.amount), opening.amount);
}

/**
 * The register balance minus the bank's balance on the bank balance's date. Zero means they
 * agree; anything else is a missing, duplicated, or mistyped entry, or a wrong opening balance.
 */
export function bankDifference(account: Account, transactions: Transaction[]) {
  if (!account.balanceDate) return null;
  const register = balanceOn(account, transactions, account.balanceDate);
  return register === null ? null : register - account.balance;
}

/**
 * An opening balance that makes the register agree with the bank: on the earliest
 * transaction's date, the bank balance less every entry up to the bank balance's date.
 */
export function suggestedOpening(account: Account, transactions: Transaction[]) {
  if (!account.balanceDate) return null;
  const own = accountTransactions(account, transactions);
  const date = own.length && own[0].date < account.balanceDate ? own[0].date : account.balanceDate;
  const amount = own
    .filter((t) => counts(t) && t.date >= date && t.date <= account.balanceDate!)
    .reduce((sum, t) => sum - effect(account, t.amount), account.balance);
  return { date, amount };
}

/** Opening balance plus reconciled entries and those in `selected`, up to `date`. */
export function clearedBalance(
  account: Account,
  transactions: Transaction[],
  date: string,
  selected: ReadonlySet<string>,
) {
  const opening = account.openingBalance;
  if (!opening) return null;
  return transactions
    .filter(
      (t) =>
        t.accountId === account.id &&
        counts(t) &&
        t.date >= opening.date &&
        t.date <= date &&
        (t.status === 'reconciled' || selected.has(t.id)),
    )
    .reduce((sum, t) => sum + effect(account, t.amount), opening.amount);
}

/** Entries a reconciliation can include: counted, after the opening date, not yet reconciled. */
export const reconcilable = (account: Account, transactions: Transaction[], date: string) =>
  accountTransactions(account, transactions).filter(
    (t) =>
      counts(t) &&
      t.status !== 'reconciled' &&
      t.date <= date &&
      (!account.openingBalance || t.date >= account.openingBalance.date),
  );

/**
 * Applies a reconciliation. Finishing marks the selected entries reconciled and records the
 * statement; saving for later only marks them cleared (and clears the mark on the others).
 */
export function applyReconciliation<T extends { accounts: Account[]; transactions: Transaction[] }>(
  data: T,
  accountId: string,
  statement: { date: string; balance: number },
  selected: ReadonlySet<string>,
  finish: boolean,
  at: string,
): T {
  const account = data.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('That account no longer exists.');
  const open = new Set(reconcilable(account, data.transactions, statement.date).map((t) => t.id));
  const transactions = data.transactions.map((t) => {
    if (!open.has(t.id)) return t;
    if (selected.has(t.id))
      return { ...t, status: finish ? ('reconciled' as const) : ('cleared' as const) };
    if (t.status !== 'cleared') return t;
    const unmarked = { ...t };
    delete unmarked.status;
    return unmarked;
  });
  const accounts = finish
    ? data.accounts.map((a) =>
        a.id === accountId ? { ...a, lastReconciled: { ...statement, at } } : a,
      )
    : data.accounts;
  return { ...data, accounts, transactions };
}
