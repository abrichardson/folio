import { spentIn, liability, type Finance } from './finance';

// Monthly budgets with per-month adjustments and rollover, and goals with earmarked accounts
// and debt payoff.

type Budget = Finance['budgets'][number];
type Goal = Finance['goals'][number];

/** "2026-03" → "2026-04" (or back with a negative step). */
export function addMonths(month: string, step: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + step, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The budget's amount for a month: its adjustment for that month, or the usual amount. */
export const limitFor = (b: Budget, month: string) =>
  b.adjustments.find((a) => a.month === month)?.limit ?? b.limit;

const MAX_ROLLOVER_MONTHS = 120;

/**
 * A budget for one month. With rollover, `carried` is what was left (or overspent) in the
 * months since rollover started; `available` is this month's amount plus that.
 */
export function budgetMonth(data: Finance, b: Budget, month: string) {
  const spentInMonth = (m: string) =>
    spentIn(
      data.transactions.filter((t) => t.date.startsWith(m)),
      b.category,
    );
  const limit = limitFor(b, month);
  let carried = 0;
  if (b.rollover && b.rolloverFrom && b.rolloverFrom < month) {
    let m = b.rolloverFrom;
    for (let i = 0; m < month && i < MAX_ROLLOVER_MONTHS; i++, m = addMonths(m, 1))
      carried += limitFor(b, m) - spentInMonth(m);
  }
  const spent = spentInMonth(month);
  const available = limit + carried;
  return { limit, carried, available, spent, left: available - spent };
}

/** Budgets grouped under their headings, in first-seen order; ungrouped last. */
export function budgetGroups(budgets: Budget[]) {
  const groups = new Map<string, Budget[]>();
  for (const b of budgets) {
    const name = b.group?.trim() || '';
    groups.set(name, [...(groups.get(name) ?? []), b]);
  }
  const named = [...groups].filter(([n]) => n);
  const rest = groups.get('');
  return [...named, ...(rest ? [['', rest] as [string, Budget[]]] : [])].map(([name, list]) => ({
    name,
    budgets: list,
  }));
}

/** Sets or clears (with `limit` null) one month's adjustment. */
export function adjustMonth(b: Budget, month: string, limit: number | null): Budget {
  const rest = b.adjustments.filter((a) => a.month !== month);
  return {
    ...b,
    adjustments:
      limit === null || limit === b.limit
        ? rest
        : [...rest, { month, limit }].sort((x, y) => x.month.localeCompare(y.month)).slice(-120),
  };
}

/**
 * How far along a goal is. Debt goals linked to a card or loan count what has been paid down
 * from the target (the starting balance); other goals use the amount saved.
 */
export function goalProgress(data: Finance, g: Goal) {
  const account = data.accounts.find((a) => a.id === g.accountId);
  const saved =
    g.kind === 'debt' && account && liability(account)
      ? Math.max(0, Math.min(g.target, g.target - account.balance))
      : g.saved;
  return { saved, left: Math.max(0, g.target - saved), done: saved >= g.target };
}

/** Months from `now` until the goal date (at least one while the date is ahead). */
export function monthsUntil(date: string, now: string) {
  const [y1, m1] = now.split('-').map(Number);
  const [y2, m2] = date.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1));
}

/** The monthly amount that reaches the goal by its date. */
export function monthlyForGoal(data: Finance, g: Goal, now: string) {
  const { left } = goalProgress(data, g);
  if (!left) return 0;
  const months = monthsUntil(g.date, now);
  return months ? Math.ceil(left / months) : left;
}

/**
 * Savings earmarked in each account by goals, and what is left unassigned. `over` is true when
 * the goals claim more than the account holds.
 */
export function earmarks(data: Finance) {
  return data.accounts
    .filter((a) => !liability(a))
    .map((a) => {
      const goals = data.goals.filter((g) => g.accountId === a.id && g.kind !== 'debt');
      const earmarked = goals.reduce((s, g) => s + g.saved, 0);
      return {
        account: a,
        goals,
        earmarked,
        free: a.balance - earmarked,
        over: earmarked > a.balance,
      };
    })
    .filter((e) => e.goals.length);
}
