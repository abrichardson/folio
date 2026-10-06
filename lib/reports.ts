import { isIncome, liability, parts, totals, type Finance } from './finance';
import { addMonths } from './budgets';
import { payeeKey } from './rules';

// Reports over a date range. Amounts follow the rest of Folio: spending is net of refunds,
// transfers and pending entries are left out.

export type Range = { from: string; to: string };

const counted = (data: Finance, r: Range) =>
  data.transactions.filter((t) => !t.pending && t.date >= r.from && t.date <= r.to);

const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Named ranges ending at `now`, and the same-length range just before. */
export function rangeFor(
  kind: 'month' | 'last-month' | '3-months' | 'year' | '12-months',
  now: string,
): Range {
  const month = now.slice(0, 7);
  if (kind === 'month') return { from: month + '-01', to: lastDay(month) };
  if (kind === 'last-month') {
    const m = addMonths(month, -1);
    return { from: m + '-01', to: lastDay(m) };
  }
  if (kind === 'year') return { from: now.slice(0, 4) + '-01-01', to: lastDay(month) };
  const back = kind === '3-months' ? 2 : 11;
  return { from: addMonths(month, -back) + '-01', to: lastDay(month) };
}

/** The range of the same number of months just before `r` (ranges here are whole months). */
export function previousRange(r: Range): Range {
  const start = r.from.slice(0, 7),
    end = r.to.slice(0, 7);
  const [y1, m1] = start.split('-').map(Number);
  const [y2, m2] = end.split('-').map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1) + 1;
  return { from: addMonths(start, -months) + '-01', to: lastDay(addMonths(start, -1)) };
}

/** Months covered by a range, oldest first. */
export function monthsIn(r: Range) {
  const out: string[] = [];
  for (let m = r.from.slice(0, 7); m <= r.to.slice(0, 7) && out.length < 120; m = addMonths(m, 1))
    out.push(m);
  return out;
}

/** Net spending by category, largest first, with the previous period for comparison. */
export function spendingByCategory(data: Finance, r: Range) {
  const sum = (range: Range) => {
    const by = new Map<string, number>();
    for (const t of counted(data, range))
      for (const p of parts(t)) {
        if (p.category === 'Transfer' || isIncome(data, p.category)) continue;
        by.set(p.category, (by.get(p.category) ?? 0) - p.amount);
      }
    return by;
  };
  const now = sum(r),
    before = sum(previousRange(r));
  return [...new Set([...now.keys(), ...before.keys()])]
    .map((category) => ({
      category,
      amount: now.get(category) ?? 0,
      previous: before.get(category) ?? 0,
    }))
    .filter((c) => c.amount || c.previous)
    .sort((a, b) => b.amount - a.amount || b.previous - a.previous);
}

/** Net spending by payee, largest first. */
export function spendingByMerchant(data: Finance, r: Range, limit = 25) {
  const by = new Map<string, { name: string; amount: number; count: number }>();
  for (const t of counted(data, r)) {
    const spent = parts(t)
      .filter((p) => p.category !== 'Transfer' && !isIncome(data, p.category))
      .reduce((s, p) => s - p.amount, 0);
    if (!spent) continue;
    const key = payeeKey(t.merchant) || t.merchant.toLowerCase();
    const entry = by.get(key) ?? { name: t.merchant, amount: 0, count: 0 };
    entry.amount += spent;
    entry.count++;
    by.set(key, entry);
  }
  return [...by.values()]
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

/** Income, spending, and what was left, month by month. */
export function incomeVsExpenses(data: Finance, r: Range) {
  return monthsIn(r).map((month) => {
    const { income, spent } = totals(
      data,
      counted(data, r).filter((t) => t.date.startsWith(month)),
    );
    return { month, income, spent, net: income - spent };
  });
}

const PER_MONTH = {
  Once: 0,
  Weekly: 52 / 12,
  Biweekly: 26 / 12,
  Monthly: 1,
  Quarterly: 1 / 3,
  Yearly: 1 / 12,
};

/** Scheduled bills and plan payments as a monthly cost, largest first. */
export function recurringCosts(data: Finance) {
  const bills = data.bills
    .filter((b) => b.kind !== 'income' && b.frequency !== 'Once')
    .map((b) => ({
      name: b.name,
      kind: 'Bill',
      frequency: b.frequency,
      amount: b.amount,
      monthly: Math.round(b.amount * PER_MONTH[b.frequency]),
    }));
  const plans = data.plans
    .filter((p) => p.status === 'active')
    .map((p) => ({
      name: p.description ? `${p.provider} · ${p.description}` : p.provider,
      kind: 'Plan',
      frequency: (p.frequency === 'biweekly'
        ? 'Biweekly'
        : p.frequency === 'weekly'
          ? 'Weekly'
          : 'Monthly') as Finance['bills'][number]['frequency'],
      amount: p.installment,
      monthly: Math.round(
        p.installment *
          (p.frequency === 'weekly' ? 52 / 12 : p.frequency === 'biweekly' ? 26 / 12 : 1),
      ),
    }));
  const income = data.bills
    .filter((b) => b.kind === 'income')
    .reduce((s, b) => s + Math.round(b.amount * PER_MONTH[b.frequency]), 0);
  const list = [...bills, ...plans].sort((a, b) => b.monthly - a.monthly);
  return { list, monthly: list.reduce((s, x) => s + x.monthly, 0), income };
}

/** Interest and fees charged, by account, plus interest paid on installment plans. */
export function interestAndFees(data: Finance, r: Range) {
  const by = new Map<string, number>();
  for (const t of counted(data, r))
    for (const p of parts(t))
      if (p.category === 'Interest & fees')
        by.set(t.accountId, (by.get(t.accountId) ?? 0) - p.amount);
  const accounts = [...by]
    .map(([id, amount]) => ({
      name: data.accounts.find((a) => a.id === id)?.name ?? 'Account',
      amount,
    }))
    .filter((a) => a.amount)
    .sort((a, b) => b.amount - a.amount);
  const plans = data.plans
    .map((p) => ({
      name: p.description ? `${p.provider} · ${p.description}` : p.provider,
      amount: p.history
        .filter((h) => h.date >= r.from && h.date <= r.to)
        .reduce((s, h) => s + h.interest, 0),
    }))
    .filter((p) => p.amount)
    .sort((a, b) => b.amount - a.amount);
  const all = [...accounts, ...plans];
  return { accounts, plans, total: all.reduce((s, x) => s + x.amount, 0) };
}

/** What is owed now on each debt, and the recorded history of total debt. */
export function debtReport(data: Finance, r: Range) {
  const debts = [
    ...data.accounts.filter(liability).map((a) => ({
      name: a.name,
      kind: a.type as string,
      owed: a.balance,
      apr: a.credit?.apr ?? null,
    })),
    ...data.plans
      .filter((p) => p.status === 'active')
      .map((p) => ({
        name: p.description ? `${p.provider} · ${p.description}` : p.provider,
        kind: 'Plan',
        owed: p.principal,
        apr: p.apr,
      })),
  ]
    .filter((d) => d.owed)
    .sort((a, b) => b.owed - a.owed);
  const history = data.snapshots
    .filter((s) => s.debt !== undefined && s.date >= r.from && s.date <= r.to)
    .map((s) => ({ date: s.date, debt: s.debt! }));
  const paidOnPlans = data.plans
    .flatMap((p) => p.history)
    .filter((h) => h.date >= r.from && h.date <= r.to)
    .reduce((s, h) => s + h.principal, 0);
  const change = history.length > 1 ? history[history.length - 1].debt - history[0].debt : null;
  return { debts, total: debts.reduce((s, d) => s + d.owed, 0), history, change, paidOnPlans };
}

/** Net worth snapshots within the range. */
export const netWorthHistory = (data: Finance, r: Range) =>
  data.snapshots.filter((s) => s.date >= r.from && s.date <= r.to);

const cell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? "'" + v : v;
  return '"' + safe.replace(/"/g, '""') + '"';
};
/** A CSV file from rows of text (formula-like cells are prefixed so spreadsheets don't run them). */
export const toCSV = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((c) => cell(String(c))).join(',')).join('\r\n');
export const dollars = (cents: number) => (cents / 100).toFixed(2);
