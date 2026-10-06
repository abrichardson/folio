import { z } from 'zod';
export const categories = [
  'Housing',
  'Groceries',
  'Dining',
  'Shopping',
  'Transport',
  'Entertainment',
  'Health',
  'Utilities',
  'Travel',
  'Interest & fees',
  'Other',
  'Income',
  'Transfer',
] as const;
export const moneySchema = z.number().int().min(-100000000000).max(100000000000);
/** Transactions are stored one per row in the data file, so years of history fit. */
export const MAX_TRANSACTIONS = 250_000;
/** Import history entries kept (oldest are dropped); each one can be undone. */
export const MAX_IMPORTS = 500;
const title = z.string().trim().min(1).max(100);
/** A built-in category or one the user added (see `customCategories`). */
export const categoryName = z.string().trim().min(1).max(40);
export type Category = string;
const id = z.string().min(1).max(100);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
export const creditSchema = z.object({
  limit: moneySchema
    .refine((v) => v >= 0)
    .nullable()
    .optional(),
  statementBalance: moneySchema.nullable().optional(),
  minimumPayment: moneySchema
    .refine((v) => v >= 0)
    .nullable()
    .optional(),
  dueDate: dateSchema.nullable().optional(),
  apr: z.number().min(0).max(1000).nullable().optional(),
  lastPaymentAmount: moneySchema.nullable().optional(),
  lastPaymentDate: dateSchema.nullable().optional(),
  isOverdue: z.boolean().nullable().optional(),
  paidDueDates: z.array(dateSchema).max(1000).optional(),
  autopay: z.boolean().optional(),
  /** Closing date of the statement the details came from, when imported from a PDF. */
  statementDate: dateSchema.nullable().optional(),
  /** What you plan to pay each month, for the cash-flow forecast. */
  paymentPlan: z.enum(['minimum', 'statement', 'custom']).optional(),
  plannedPayment: moneySchema
    .refine((v) => v >= 0)
    .nullable()
    .optional(),
  /** The account card payments come from. */
  payFromId: id.optional(),
});
export const billSchema = z.object({
  id,
  name: title,
  amount: moneySchema.refine((v) => v >= 0),
  dueDate: dateSchema.refine((v) => v >= '2000-01-01'),
  frequency: z.enum(['Once', 'Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Yearly']),
  accountId: id.optional(),
  autopay: z.boolean().default(false),
  paidDates: z.array(dateSchema).max(1000).default([]),
  /** Money going out (a bill) or coming in (a paycheck or other income). */
  kind: z.enum(['expense', 'income']).default('expense'),
  /** No occurrences after this date (a finite schedule). */
  endDate: dateSchema.optional(),
  category: categoryName.optional(),
  /** Text that identifies this bill's transactions (defaults to words from its name). */
  match: z.string().trim().max(100).optional(),
});
export type Bill = z.infer<typeof billSchema>;
const column = z.number().int().min(-1).max(1000);
/** Column choices remembered from the last CSV import into an account. */
export const csvSettingsSchema = z.object({
  /** Normalized header row; settings are reused only for files with the same columns. */
  headers: z.string().max(4000),
  mapping: z.object({
    date: column,
    dateFallback: column,
    description: column,
    amount: column,
    debit: column,
    credit: column,
    category: column,
    notes: column,
    type: column,
  }),
  dateFormat: z.enum(['ymd', 'mdy', 'dmy']),
  purchasesPositive: z.boolean(),
});
export const balanceSources = ['manual', 'ofx', 'csv', 'pdf', 'bank'] as const;
export type BalanceSource = (typeof balanceSources)[number];
/**
 * A promotional balance on a credit card: part of the card's balance with its own deadline.
 * Deferred interest: interest accrues from the purchase date and is charged in full if any
 * of the balance is left at the deadline. Zero: a true 0% APR; only interest from the
 * deadline on is charged.
 */
export const promotionSchema = z.object({
  id,
  description: z.string().trim().max(100).default(''),
  kind: z.enum(['deferred', 'zero']),
  originalAmount: moneySchema.refine((v) => v >= 0).nullable(),
  /** Promotional balance still owed (positive). */
  balance: moneySchema.refine((v) => v >= 0),
  startDate: dateSchema.nullable(),
  endDate: dateSchema,
  /** Your own earlier target, if any (for example a month before the deadline). */
  payoffBy: dateSchema.nullable().optional(),
  aprAfter: z.number().min(0).max(100).nullable(),
  /** Deferred interest the issuer reports as accrued so far. */
  accruedInterest: moneySchema.refine((v) => v >= 0).nullable(),
  /** Date the balance was true as of. */
  asOf: dateSchema,
  source: z.enum(['manual', 'pdf']),
});
export type Promotion = z.infer<typeof promotionSchema>;
export const accountSchema = z.object({
  id,
  name: title,
  institution: title,
  type: z.enum(['Checking', 'Savings', 'Investment', 'Credit card', 'Loan', 'Property']),
  balance: moneySchema,
  credit: creditSchema.optional(),
  plaidItemId: id.optional(),
  plaidAccountId: id.optional(),
  mask: z.string().max(8).optional(),
  syncedAt: z.string().optional(),
  balanceUnavailable: z.boolean().optional(),
  /** Hashed bank and account number from OFX imports, used to match later imports. */
  importKey: z.string().max(100).optional(),
  /** The date the balance was true (a statement date, or the day it was entered). */
  balanceDate: dateSchema.optional(),
  /** Where the balance came from. */
  balanceSource: z.enum(balanceSources).optional(),
  importSettings: z.object({ csv: csvSettingsSchema.optional() }).optional(),
  /** Where the register starts: the balance at the start of `date`, before that day's entries. */
  openingBalance: z.object({ date: dateSchema, amount: moneySchema }).optional(),
  /** Promotional balances on a credit card. */
  promotions: z.array(promotionSchema).max(50).optional(),
  /** The most recent finished reconciliation. */
  lastReconciled: z
    .object({ date: dateSchema, balance: moneySchema, at: z.string().max(40) })
    .optional(),
});
export const transactionSchema = z.object({
  id,
  date: dateSchema,
  merchant: title,
  category: categoryName,
  accountId: id,
  amount: moneySchema,
  notes: z.string().max(500).default(''),
  plaidTransactionId: id.optional(),
  plaidItemId: id.optional(),
  pending: z.boolean().optional(),
  categoryEdited: z.boolean().optional(),
  /** Bank transaction ID from an OFX/QFX import, used to skip duplicates. */
  importId: z.string().max(260).optional(),
  /** The import (see `imports`) that added this transaction. */
  importBatch: id.optional(),
  /** Changed by hand after it was imported; undoing the import keeps it. */
  edited: z.boolean().optional(),
  /** The bank's description when the merchant shown was renamed (by a rule or by hand). */
  originalMerchant: z.string().max(100).optional(),
  /**
   * A transaction divided across categories. The parts add up to `amount`; `category` holds
   * the largest part's category.
   */
  splits: z
    .array(
      z.object({
        category: categoryName,
        amount: moneySchema.refine((v) => v !== 0),
        note: z.string().max(100).default(''),
      }),
    )
    .min(2)
    .max(30)
    .optional(),
  /** An expense you expect to be paid back for. */
  reimbursable: z.boolean().optional(),
  /** On money received: the reimbursable expense it pays back. */
  reimburses: id.optional(),
  /** Receipts; the files are stored encrypted in the data file under these IDs. */
  receipts: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        name: z.string().max(200),
        type: z.string().max(100),
        bytes: z.number().int().min(1).max(15_000_000),
      }),
    )
    .max(10)
    .optional(),
  /** Shared by the two sides of a transfer between your own accounts. */
  transferId: id.optional(),
  /** Cleared: confirmed by the bank. Reconciled: matched to a statement and locked in. */
  status: z.enum(['cleared', 'reconciled']).optional(),
});
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const budgetSchema = z.object({
  id,
  category: categoryName,
  /** The usual monthly amount. */
  limit: moneySchema.refine((v) => v > 0),
  /** A heading budgets are grouped under (Essentials, Fun, …). */
  group: z.string().trim().max(40).optional(),
  /**
   * Unspent money carries into the next month, and overspending comes out of it, starting in
   * `rolloverFrom`. A fund for irregular costs (car repairs, gifts) is a budget with rollover.
   */
  rollover: z.boolean().default(false),
  rolloverFrom: monthSchema.optional(),
  /** A different amount for particular months. */
  adjustments: z
    .array(z.object({ month: monthSchema, limit: moneySchema.refine((v) => v >= 0) }))
    .max(120)
    .default([]),
});
export const goalSchema = z.object({
  id,
  name: title,
  target: moneySchema.refine((v) => v > 0),
  saved: moneySchema.refine((v) => v >= 0),
  date: dateSchema,
  /** Savings (the default), an emergency fund, a purchase, or paying down a debt. */
  kind: z.enum(['savings', 'emergency', 'purchase', 'debt']).default('savings'),
  /**
   * For savings: the account the money is kept in (earmarked there). For a debt goal: the card
   * or loan being paid down; progress is the target less what is still owed.
   */
  accountId: id.optional(),
});
const count = z.number().int().min(0).max(10_000_000);
export const importRecordSchema = z.object({
  id,
  /** When the import happened (ISO date and time). */
  at: z.string().max(40),
  fileName: z.string().max(260),
  format: z.enum(['OFX', 'CSV', 'PDF']),
  /** SHA-256 of the file, to recognize the same file imported again. */
  fileHash: z.string().max(64).optional(),
  accounts: z
    .array(
      z.object({
        accountId: id,
        created: z.boolean(),
        added: count,
        duplicates: count,
        skipped: count,
        /** Date range of the file's transactions for this account. */
        from: dateSchema.nullable(),
        to: dateSchema.nullable(),
        /** The file's balance and whether it was applied (a newer balance is kept). */
        balance: z
          .object({ amount: moneySchema, date: dateSchema.nullable(), applied: z.boolean() })
          .nullable(),
        /** The account before and after the import, so Undo can restore it. */
        before: accountSchema.nullable(),
        after: accountSchema,
      }),
    )
    .max(100),
  undoneAt: z.string().max(40).optional(),
});
export type ImportRecord = z.infer<typeof importRecordSchema>;
/** "When the description contains …, show it as … and file it under …". */
export const ruleSchema = z
  .object({
    id,
    contains: z.string().trim().min(1).max(100),
    rename: title.optional(),
    category: categoryName.optional(),
  })
  .refine((r) => r.rename || r.category, 'A rule needs a new name or a category.');
export type Rule = z.infer<typeof ruleSchema>;
/** An installment plan: buy now, pay later (Affirm, Klarna, …), an auto loan, or a personal loan. */
export const planSchema = z.object({
  id,
  provider: title,
  description: z.string().trim().max(100).default(''),
  kind: z.enum(['bnpl', 'auto', 'personal', 'other']),
  originalAmount: moneySchema.refine((v) => v >= 0),
  /** Principal still owed. */
  principal: moneySchema.refine((v) => v >= 0),
  apr: z.number().min(0).max(100),
  installment: moneySchema.refine((v) => v > 0),
  frequency: z.enum(['weekly', 'biweekly', 'monthly']),
  nextDate: dateSchema,
  paymentsLeft: z.number().int().min(0).max(1000),
  /** The account payments come from. */
  accountId: id.optional(),
  autopay: z.boolean().default(false),
  status: z.enum(['active', 'paid', 'cancelled']).default('active'),
  /** Payments recorded in Folio, split into principal and interest. */
  history: z
    .array(
      z.object({
        date: dateSchema,
        amount: moneySchema,
        principal: moneySchema,
        interest: moneySchema,
        note: z.string().max(100).default(''),
      }),
    )
    .max(1000)
    .default([]),
});
export type Plan = z.infer<typeof planSchema>;
export const stateSchema = z
  .object({
    demo: z.boolean(),
    bills: z.array(billSchema).max(200).default([]),
    accounts: z.array(accountSchema).max(100),
    transactions: z.array(transactionSchema).max(MAX_TRANSACTIONS),
    budgets: z.array(budgetSchema).max(50),
    goals: z.array(goalSchema).max(50),
    snapshots: z
      .array(
        z.object({
          date: dateSchema,
          value: moneySchema,
          /** Total owed on cards, loans, and plans that day (kept from this version on). */
          debt: moneySchema.optional(),
        }),
      )
      .max(1000),
    imports: z.array(importRecordSchema).max(MAX_IMPORTS).default([]),
    // Older files may hold a custom category that has since become built in; drop those.
    customCategories: z
      .array(categoryName)
      .max(100)
      .default([])
      .transform((list) =>
        list.filter((c) => !categories.some((b) => b.toLowerCase() === c.toLowerCase())),
      ),
    /** Custom categories that hold money coming in (like Income) rather than spending. */
    incomeCategories: z.array(categoryName).max(100).default([]),
    rules: z.array(ruleSchema).max(500).default([]),
    plans: z.array(planSchema).max(300).default([]),
    /** Cash-flow planner choices. */
    planner: z
      .object({
        /** Accounts the forecast starts from; empty means every checking account. */
        accountIds: z.array(id).max(100).default([]),
        /** Warn when the forecast drops below this balance. */
        cushion: moneySchema.refine((v) => v >= 0).default(0),
        /** Days ahead that unpaid bills show as reminders. */
        reminderDays: z.number().int().min(0).max(30).default(3),
        /** Suggested recurring bills the user turned down (payee keys). */
        dismissed: z.array(z.string().max(200)).max(500).default([]),
      })
      .default({}),
    settings: z
      .object({
        /** Lock after this many minutes without activity; 0 never locks. */
        autoLockMinutes: z.number().int().min(0).max(240).default(15),
      })
      .default({ autoLockMinutes: 15 }),
  })
  .superRefine((s, ctx) => {
    for (const key of [
      'accounts',
      'transactions',
      'budgets',
      'goals',
      'bills',
      'imports',
    ] as const) {
      if (new Set(s[key].map((x) => x.id)).size !== s[key].length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate record IDs' });
    }
    if (s.goals.some((g) => g.accountId && !s.accounts.some((a) => a.id === g.accountId)))
      ctx.addIssue({ code: 'custom', message: 'Goal account does not exist' });
    if (
      s.budgets.some(
        (b) => new Set(b.adjustments.map((a) => a.month)).size !== b.adjustments.length,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Each month can have one budget adjustment' });
    if (s.plans.some((p) => p.accountId && !s.accounts.some((a) => a.id === p.accountId)))
      ctx.addIssue({ code: 'custom', message: 'Plan account does not exist' });
    if (s.bills.some((b) => b.accountId && !s.accounts.some((a) => a.id === b.accountId)))
      ctx.addIssue({ code: 'custom', message: 'Bill account does not exist' });
    if (s.bills.some((b) => b.endDate && b.endDate < b.dueDate))
      ctx.addIssue({ code: 'custom', message: 'A bill cannot end before it starts' });
    if (
      s.accounts.some(
        (a) => a.credit?.payFromId && !s.accounts.some((x) => x.id === a.credit!.payFromId),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Card payment account does not exist' });
    const accountIds = new Set(s.accounts.map((a) => a.id));
    if (s.transactions.some((t) => !accountIds.has(t.accountId)))
      ctx.addIssue({ code: 'custom', message: 'Transaction account does not exist' });
    const known = new Set(allCategories(s));
    // Names must differ ignoring case ("groceries" would duplicate "Groceries").
    if (
      new Set([...known].map((c) => c.toLowerCase())).size !==
      categories.length + s.customCategories.length
    )
      ctx.addIssue({ code: 'custom', message: 'Category names must be different' });
    if (
      s.transactions.some(
        (t) => t.splits && t.splits.reduce((sum, part) => sum + part.amount, 0) !== t.amount,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Split amounts must add up to the total' });
    if (
      s.transactions.some((t) => !known.has(t.category)) ||
      s.transactions.some((t) => t.splits?.some((part) => !known.has(part.category))) ||
      s.budgets.some((b) => !known.has(b.category)) ||
      s.rules.some((r) => r.category && !known.has(r.category)) ||
      s.bills.some((b) => b.category && !known.has(b.category))
    )
      ctx.addIssue({ code: 'custom', message: 'Category does not exist' });
    if (s.incomeCategories.some((c) => !s.customCategories.includes(c)))
      ctx.addIssue({ code: 'custom', message: 'Income category does not exist' });
    if (new Set(s.budgets.map((b) => b.category)).size !== s.budgets.length)
      ctx.addIssue({ code: 'custom', message: 'Each category can have one budget' });
  });
export type Finance = z.infer<typeof stateSchema>;
export type Receipt = NonNullable<Transaction['receipts']>[number];
/** IDs of every stored receipt the workspace refers to. */
export const receiptIds = (s: { transactions: Transaction[] }) =>
  new Set(s.transactions.flatMap((t) => t.receipts?.map((r) => r.id) ?? []));
/** Every category in display order: spending categories, the user's own, then Other, Income, Transfer. */
export function allCategories(s: { customCategories: string[] }): string[] {
  const fixed = ['Other', 'Income', 'Transfer'];
  return [
    ...categories.filter((c) => !fixed.includes(c)),
    ...[...s.customCategories].sort((a, b) => a.localeCompare(b)),
    ...fixed,
  ];
}
/** True for Income and custom categories marked as income. */
export const isIncome = (s: { incomeCategories?: string[] }, category: string) =>
  category === 'Income' || !!s.incomeCategories?.includes(category);
/** Categories that hold spending (for budgets). */
export const spendingCategories = (s: {
  customCategories: string[];
  incomeCategories?: string[];
}) => allCategories(s).filter((c) => !isIncome(s, c) && c !== 'Transfer');
export type Account = z.infer<typeof accountSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export const cash = (c: number, decimals = 0) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format((c || 0) / 100);
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const liability = (a: Account) => a.type === 'Credit card' || a.type === 'Loan';
/** True when a statement dated `date` is older than the account's current balance. */
export const olderThanBalance = (a: Account, date: string | null | undefined) =>
  !!(date && a.balanceDate && date < a.balanceDate);
const sourceNames: Record<BalanceSource, string> = {
  manual: 'Entered by hand',
  ofx: 'Bank download',
  csv: 'CSV import',
  pdf: 'Statement PDF',
  bank: 'Bank sync',
};
/** "Statement PDF · Sep 10, 2026", or "Manual balance" for balances saved before dates were kept. */
export function balanceNote(a: Account) {
  if (!a.balanceDate) return 'Manual balance';
  const date = new Date(a.balanceDate + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${sourceNames[a.balanceSource ?? 'manual']} · ${date}`;
}
/** Accounts, less the principal owed on active installment plans. */
export const netWorth = (s: Pick<Finance, 'accounts'> & { plans?: Finance['plans'] }) =>
  s.accounts.reduce((sum, a) => sum + (liability(a) ? -a.balance : a.balance), 0) -
  (s.plans ?? []).filter((p) => p.status === 'active').reduce((sum, p) => sum + p.principal, 0);
/** Owed on cards and loans, plus active plan principal. */
export const totalDebt = (s: Pick<Finance, 'accounts'> & { plans?: Finance['plans'] }) =>
  s.accounts.filter(liability).reduce((sum, a) => sum + a.balance, 0) +
  (s.plans ?? []).filter((p) => p.status === 'active').reduce((sum, p) => sum + p.principal, 0);
/** Snapshots with today's net worth and debt recorded (one per day). */
export const withTodaySnapshot = (s: Finance): Finance['snapshots'] =>
  [
    ...s.snapshots.filter((x) => x.date !== today()),
    { date: today(), value: netWorth(s), debt: totalDebt(s) },
  ].slice(-1000);
export function emptyState(): Finance {
  return {
    demo: false,
    bills: [],
    accounts: [],
    transactions: [],
    budgets: [],
    goals: [],
    snapshots: [],
    imports: [],
    customCategories: [],
    incomeCategories: [],
    rules: [],
    plans: [],
    planner: { accountIds: [], cushion: 0, reminderDays: 3, dismissed: [] },
    settings: { autoLockMinutes: 15 },
  };
}
export function sampleState(): Finance {
  const now = new Date(),
    month = today().slice(0, 7);
  const accounts: Account[] = [
    {
      id: 'checking',
      name: 'Everyday Checking',
      institution: 'Chase',
      type: 'Checking',
      balance: 824532,
    },
    {
      id: 'savings',
      name: 'High-Yield Savings',
      institution: 'Ally',
      type: 'Savings',
      balance: 2450000,
    },
    {
      id: 'invest',
      name: 'Investment Portfolio',
      institution: 'Fidelity',
      type: 'Investment',
      balance: 9248050,
    },
    {
      id: 'retire',
      name: 'Retirement · 401(k)',
      institution: 'Vanguard',
      type: 'Investment',
      balance: 3865020,
    },
    {
      id: 'card',
      name: 'Sapphire Preferred',
      institution: 'Chase',
      type: 'Credit card',
      balance: 184902,
      credit: {
        limit: 1500000,
        statementBalance: 164500,
        minimumPayment: 4000,
        dueDate: month + '-28',
        apr: 24.99,
        paidDueDates: [],
      },
    },
  ];
  const entries: [number, string, (typeof categories)[number], number, string][] = [
    [28, 'Whole Foods Market', 'Groceries', -8647, 'card'],
    [27, 'Blue Bottle Coffee', 'Dining', -650, 'card'],
    [26, 'September paycheck', 'Income', 425000, 'checking'],
    [25, 'Spotify Premium', 'Entertainment', -1199, 'card'],
    [24, 'Aesop', 'Shopping', -6800, 'card'],
    [23, 'Sweetgreen', 'Dining', -1845, 'card'],
    [22, 'Shell', 'Transport', -5240, 'card'],
    [20, 'Trader Joe’s', 'Groceries', -11238, 'card'],
    [18, 'Electric company', 'Utilities', -12400, 'checking'],
    [17, 'Neighborhood restaurant', 'Dining', -9850, 'card'],
    [16, 'Uniqlo', 'Shopping', -14250, 'card'],
    [15, 'September paycheck', 'Income', 425000, 'checking'],
    [14, 'Internet', 'Utilities', -7500, 'checking'],
    [12, 'Weekly groceries', 'Groceries', -15430, 'card'],
    [10, 'Weekend dinner', 'Dining', -12600, 'card'],
    [8, 'Gym membership', 'Health', -6500, 'checking'],
    [7, 'Train pass', 'Transport', -13200, 'checking'],
    [5, 'Home supplies', 'Shopping', -8200, 'card'],
    [4, 'Farmers market', 'Groceries', -6300, 'card'],
    [3, 'Movie night', 'Entertainment', -4200, 'card'],
    [2, 'Lunches & coffee', 'Dining', -8600, 'card'],
    [1, 'Monthly rent', 'Housing', -225000, 'checking'],
  ];
  const transactions: Transaction[] = entries.map((e, i) => ({
    id: `sample-${i}`,
    date: `${month}-${String(Math.min(e[0], now.getDate())).padStart(2, '0')}`,
    merchant: e[1],
    category: e[2],
    amount: e[3],
    accountId: e[4],
    notes: '',
  }));
  const snapshots = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
      value: [13940000, 14325000, 14290000, 15018000, 15462000, 16203000][i],
    };
  });
  snapshots.push({ date: today(), value: netWorth({ accounts } as Finance) });
  return {
    demo: true,
    bills: [
      {
        id: 'bill-rent',
        name: 'Monthly rent',
        amount: 225000,
        dueDate: month + '-01',
        frequency: 'Monthly',
        autopay: true,
        paidDates: [month + '-01'],
        accountId: 'checking',
        kind: 'expense',
      },
      {
        id: 'bill-internet',
        name: 'Internet',
        amount: 7500,
        dueDate: month + '-' + String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()),
        frequency: 'Monthly',
        autopay: false,
        paidDates: [],
        accountId: 'checking',
        kind: 'expense',
      },
      {
        id: 'bill-paycheck',
        name: 'Paycheck',
        amount: 310000,
        dueDate: month + '-05',
        frequency: 'Biweekly',
        autopay: false,
        paidDates: [],
        accountId: 'checking',
        kind: 'income',
        category: 'Income',
      },
    ],
    accounts,
    transactions,
    budgets: [
      ['Housing', 250000],
      ['Groceries', 65000],
      ['Dining', 50000],
      ['Shopping', 40000],
      ['Transport', 30000],
      ['Entertainment', 15000],
      ['Utilities', 25000],
      ['Health', 15000],
    ].map(([category, limit], i) => ({
      id: `b${i}`,
      category: String(category),
      limit: Number(limit),
      group: ['Housing', 'Groceries', 'Utilities', 'Health', 'Transport'].includes(String(category))
        ? 'Essentials'
        : 'Lifestyle',
      rollover: false,
      adjustments: [],
    })),
    goals: [
      {
        id: 'g1',
        name: 'Emergency fund',
        target: 3000000,
        saved: 2450000,
        date: `${now.getFullYear() + 1}-03-01`,
        kind: 'emergency',
      },
      {
        id: 'g2',
        name: 'Japan adventure',
        target: 800000,
        saved: 325000,
        date: `${now.getFullYear() + 1}-06-01`,
        kind: 'purchase',
      },
    ],
    snapshots,
    imports: [],
    customCategories: [],
    incomeCategories: [],
    rules: [],
    plans: [],
    planner: { accountIds: [], cushion: 0, reminderDays: 3, dismissed: [] },
    settings: { autoLockMinutes: 15 },
  };
}
/** A transaction's amounts by category: its split parts, or the whole amount. */
export const parts = (t: Pick<Transaction, 'category' | 'amount' | 'splits'>) =>
  t.splits?.length
    ? t.splits.map((p) => ({ category: p.category, amount: p.amount }))
    : [{ category: t.category, amount: t.amount }];

/**
 * Net spending in one category (positive cents), counting split parts: refunds and
 * reimbursements filed under the category reduce it. Pending entries are excluded.
 */
export const spentIn = (tx: Transaction[], category: string) =>
  0 -
  tx
    .filter((t) => !t.pending)
    .flatMap(parts)
    .filter((p) => p.category === category)
    .reduce((sum, p) => sum + p.amount, 0);

/** The category a split's largest part belongs to. */
export const mainCategory = (splits: { category: string; amount: number }[]) =>
  [...splits].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0].category;

/**
 * Income and spending for a month. Income is money in income categories; spending is the net
 * of everything in spending categories, so a refund lowers spending instead of counting as
 * income. Transfers and pending entries are left out.
 */
export function monthly(s: Finance, month: string) {
  const tx = s.transactions.filter((t) => t.date.startsWith(month));
  return { tx, ...totals(s, tx) };
}

export function totals(s: { incomeCategories?: string[] }, tx: Transaction[]) {
  const counted = tx
    .filter((t) => !t.pending)
    .flatMap(parts)
    .filter((p) => p.category !== 'Transfer');
  const income = counted.filter((p) => isIncome(s, p.category));
  const spending = counted.filter((p) => !isIncome(s, p.category));
  return {
    income: income.reduce((a, p) => a + p.amount, 0),
    spent: 0 - spending.reduce((a, p) => a + p.amount, 0),
  };
}

/** Reimbursable expenses not yet linked to a repayment. */
export const awaitingReimbursement = (s: { transactions: Transaction[] }) => {
  const repaid = new Set(s.transactions.map((t) => t.reimburses).filter(Boolean));
  return s.transactions.filter((t) => t.reimbursable && t.amount < 0 && !repaid.has(t.id));
};
export function parseCSV(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(value);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  if (quoted) throw new Error('Unclosed quotation mark in CSV.');
  row.push(value);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
