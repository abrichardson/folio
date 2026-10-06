import {
  type Finance,
  type Account,
  type Transaction,
  categories,
  stateSchema,
  withTodaySnapshot,
} from './finance';
export type PlaidAccount = {
  account_id: string;
  name: string;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: {
    current: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
  };
};
export type PlaidTransaction = {
  transaction_id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name?: string | null;
  amount: number;
  pending: boolean;
  pending_transaction_id?: string | null;
  iso_currency_code?: string | null;
  personal_finance_category?: { primary: string; detailed: string } | null;
};
export type CreditLiability = {
  account_id: string;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount?: number | null;
  last_payment_date?: string | null;
  is_overdue?: boolean | null;
  aprs?: { apr_type: string; apr_percentage: number }[];
};
export type SyncPage = {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: string;
};
export function toCents(n: number | null | undefined) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;
}
export function plaidCategory(t: PlaidTransaction): (typeof categories)[number] {
  const primary = t.personal_finance_category?.primary || '',
    detail = t.personal_finance_category?.detailed || '';
  if (
    primary === 'TRANSFER_IN' ||
    primary === 'TRANSFER_OUT' ||
    detail.includes('CREDIT_CARD_PAYMENT') ||
    detail.includes('ACCOUNT_TRANSFER')
  )
    return 'Transfer';
  if (primary === 'INCOME') return 'Income';
  if (detail.includes('GROCERIES')) return 'Groceries';
  if (primary === 'FOOD_AND_DRINK') return 'Dining';
  if (primary === 'TRANSPORTATION') return 'Transport';
  if (primary === 'ENTERTAINMENT') return 'Entertainment';
  if (primary === 'MEDICAL' || primary === 'PERSONAL_CARE') return 'Health';
  if (primary === 'TRAVEL') return 'Travel';
  if (detail.includes('RENT') || detail.includes('MORTGAGE')) return 'Housing';
  if (primary === 'RENT_AND_UTILITIES') return 'Utilities';
  if (primary === 'GENERAL_MERCHANDISE' || primary === 'HOME_IMPROVEMENT') return 'Shopping';
  return 'Other';
}
export function mergePlaid(
  data: Finance,
  item: { id: string; institution: string },
  accounts: PlaidAccount[],
  pages: SyncPage[],
  credit: CreditLiability[] | null,
  now = new Date().toISOString(),
): Finance {
  const next = structuredClone(data);
  const accountMap = new Map(next.accounts.map((a) => [a.id, a]));
  for (const raw of accounts) {
    if (
      raw.balances.iso_currency_code !== 'USD' ||
      !['depository', 'credit', 'loan', 'investment'].includes(raw.type)
    )
      continue;
    const id = `plaid:${raw.account_id}`,
      old = accountMap.get(id);
    const balance = toCents(raw.balances.current);
    const info = credit?.find((c) => c.account_id === raw.account_id);
    const account: Account = {
      ...old,
      id,
      name: old?.name || raw.name.slice(0, 100),
      institution: item.institution,
      type:
        raw.type === 'credit'
          ? 'Credit card'
          : raw.type === 'loan'
            ? 'Loan'
            : raw.type === 'investment'
              ? 'Investment'
              : raw.subtype === 'savings'
                ? 'Savings'
                : 'Checking',
      balance: balance ?? old?.balance ?? 0,
      balanceUnavailable: balance === null,
      plaidItemId: item.id,
      plaidAccountId: raw.account_id,
      mask: raw.mask || undefined,
      syncedAt: now,
    };
    if (raw.type === 'credit')
      account.credit = {
        ...old?.credit,
        limit: toCents(raw.balances.limit),
        ...(info
          ? {
              statementBalance: toCents(info.last_statement_balance),
              minimumPayment: toCents(info.minimum_payment_amount),
              dueDate: info.next_payment_due_date,
              apr: info.aprs?.find((a) => a.apr_type === 'purchase_apr')?.apr_percentage ?? null,
              lastPaymentAmount: toCents(info.last_payment_amount),
              lastPaymentDate: info.last_payment_date ?? null,
              isOverdue: info.is_overdue ?? null,
            }
          : {}),
      };
    accountMap.set(id, account);
  }
  next.accounts = [...accountMap.values()];
  const originalTx = new Map(next.transactions.map((t) => [t.id, t]));
  const txMap = new Map(originalTx);
  for (const page of pages) {
    for (const removed of page.removed) txMap.delete(`plaid:${removed.transaction_id}`);
    for (const raw of [...page.added, ...page.modified]) {
      if (raw.iso_currency_code !== 'USD' || !accountMap.has(`plaid:${raw.account_id}`)) continue;
      const id = `plaid:${raw.transaction_id}`;
      const priorPending = raw.pending_transaction_id
        ? txMap.get(`plaid:${raw.pending_transaction_id}`)
        : undefined;
      const old =
        txMap.get(id) ||
        priorPending ||
        originalTx.get(id) ||
        (raw.pending_transaction_id
          ? originalTx.get(`plaid:${raw.pending_transaction_id}`)
          : undefined);
      if (raw.pending_transaction_id) txMap.delete(`plaid:${raw.pending_transaction_id}`);
      const tx: Transaction = {
        id,
        date: raw.date,
        merchant: (raw.merchant_name || raw.name || 'Transaction').slice(0, 100),
        amount: -(toCents(raw.amount) ?? 0),
        accountId: `plaid:${raw.account_id}`,
        category: old?.categoryEdited ? old.category : plaidCategory(raw),
        categoryEdited: old?.categoryEdited,
        notes: old?.notes || '',
        pending: raw.pending,
        plaidTransactionId: raw.transaction_id,
        plaidItemId: item.id,
      };
      txMap.set(id, tx);
    }
  }
  next.transactions = [...txMap.values()];
  next.snapshots = withTodaySnapshot(next);
  return stateSchema.parse(next);
}
export async function collectPages(
  call: (cursor: string) => Promise<SyncPage>,
  initialCursor: string,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = initialCursor;
    const pages: SyncPage[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        const page = await call(cursor);
        pages.push(page);
        cursor = page.next_cursor;
        if (!page.has_more) return { pages, cursor };
      }
      throw new Error('Too many transaction updates. Please contact support before retrying.');
    } catch (e) {
      if (
        (e as { code?: string }).code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' &&
        attempt < 2
      )
        continue;
      throw e;
    }
  }
  throw new Error('Transaction data kept changing. Try again shortly.');
}
