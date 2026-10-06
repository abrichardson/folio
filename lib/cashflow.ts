import { type Account, type Bill, type Finance, type Transaction } from './finance';
import { dueItems, occurrenceDates, togglePaid, type DueItem } from './bills';
import { schedule } from './plans';
import { payeeKey } from './rules';

// The cash-flow planner: what the checking balance does over the next weeks as bills, income,
// card payments, and installment-plan payments land. Everything here is a projection from
// schedules the user entered; nothing moves money.

const DAY = 86400000;
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

/** The accounts the forecast starts from: the user's choice, or every checking account. */
export function cashAccounts(data: Pick<Finance, 'accounts' | 'planner'>): Account[] {
  const chosen = data.planner.accountIds;
  return data.accounts.filter((a) =>
    chosen.length ? chosen.includes(a.id) : a.type === 'Checking',
  );
}

/** The amount a card's payment plan calls for, or null when it is not known. */
export function cardPayment(a: Account): number | null {
  const c = a.credit;
  if (!c) return null;
  if (c.paymentPlan === 'custom') return c.plannedPayment ?? null;
  if (c.paymentPlan === 'statement') return c.statementBalance ?? null;
  return c.minimumPayment ?? null;
}

export type FlowEvent = {
  key: string;
  date: string;
  name: string;
  /** Signed: money in is positive. */
  amount: number;
  kind: 'income' | 'bill' | 'card' | 'plan';
  /** A guess: a later card payment, assumed to repeat the current one. */
  estimate: boolean;
  /** Past due and not marked paid; counted today. */
  overdue: boolean;
  /** Balance after this event. */
  balance: number;
};

export type Forecast = {
  start: number;
  accounts: Account[];
  events: FlowEvent[];
  end: number;
  moneyIn: number;
  moneyOut: number;
  lowest: { date: string; balance: number };
  /** The first event that takes the balance below the cushion, and below zero. */
  belowCushion: FlowEvent | null;
  belowZero: FlowEvent | null;
  /** Cards whose payment amount is unknown, so they are left out. */
  unknownCards: string[];
};

const OVERDUE_DAYS = 30;

/** Projects the balance of the cash accounts from `now` through `days` days ahead. */
export function forecast(data: Finance, days: number, now: string): Forecast {
  const accounts = cashAccounts(data);
  const ids = new Set(accounts.map((a) => a.id));
  // Bills paid from no account in particular are assumed to come from cash.
  const fromCash = (id?: string) => !id || ids.has(id);
  const to = addDays(now, days);
  const raw: Omit<FlowEvent, 'balance'>[] = [];

  for (const b of data.bills) {
    if (!fromCash(b.accountId)) continue;
    for (const date of occurrenceDates(b, addDays(now, -OVERDUE_DAYS), to)) {
      if (b.paidDates.includes(date)) continue;
      const overdue = date < now;
      raw.push({
        key: `bill:${b.id}:${date}`,
        date: overdue ? now : date,
        name: b.name,
        amount: b.kind === 'income' ? b.amount : -b.amount,
        kind: b.kind === 'income' ? 'income' : 'bill',
        estimate: false,
        overdue,
      });
    }
  }

  const unknownCards: string[] = [];
  for (const a of data.accounts) {
    const c = a.credit;
    if (a.type !== 'Credit card' || !c?.dueDate || !fromCash(c.payFromId)) continue;
    const amount = cardPayment(a);
    if (amount === null) {
      if (c.dueDate >= addDays(now, -OVERDUE_DAYS) && c.dueDate <= to) unknownCards.push(a.name);
      continue;
    }
    if (!amount) continue;
    const monthly = { dueDate: c.dueDate, frequency: 'Monthly' as const };
    for (const date of occurrenceDates(monthly, addDays(now, -OVERDUE_DAYS), to)) {
      const current = date === c.dueDate;
      if (current && c.paidDueDates?.includes(date)) continue;
      // Only the current statement's due date can be overdue; later ones are projections.
      if (date < now && !current) continue;
      raw.push({
        key: `card:${a.id}:${date}`,
        date: date < now ? now : date,
        name: a.name,
        amount: -amount,
        kind: 'card',
        estimate: !current && c.paymentPlan !== 'custom',
        overdue: date < now,
      });
    }
  }

  for (const p of data.plans) {
    if (p.status !== 'active' || !fromCash(p.accountId)) continue;
    for (const pay of schedule(p, 200)) {
      if (pay.date > to) break;
      const overdue = pay.date < now;
      raw.push({
        key: `plan:${p.id}:${pay.date}`,
        date: overdue ? now : pay.date,
        name: p.description ? `${p.provider} · ${p.description}` : p.provider,
        amount: -pay.amount,
        kind: 'plan',
        estimate: false,
        overdue,
      });
    }
  }

  // Money in before money out on the same day.
  raw.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const start = accounts.reduce((s, a) => s + a.balance, 0);
  let balance = start;
  let lowest = { date: now, balance: start };
  let belowCushion: FlowEvent | null = null,
    belowZero: FlowEvent | null = null;
  const events = raw.map((e) => {
    balance += e.amount;
    const event = { ...e, balance };
    if (balance < lowest.balance) lowest = { date: e.date, balance };
    if (!belowCushion && balance < data.planner.cushion) belowCushion = event;
    if (!belowZero && balance < 0) belowZero = event;
    return event;
  });
  return {
    start,
    accounts,
    events,
    end: balance,
    moneyIn: events.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0),
    moneyOut: events.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0),
    lowest,
    belowCushion,
    belowZero,
    unknownCards,
  };
}

/** The balance at the end of each day, for a chart. */
export function dailyBalances(f: Forecast, now: string, days: number) {
  const out: { date: string; balance: number }[] = [];
  let balance = f.start,
    i = 0;
  for (let d = 0; d <= days; d++) {
    const date = addDays(now, d);
    while (i < f.events.length && f.events[i].date <= date) balance = f.events[i++].balance;
    out.push({ date, balance });
  }
  return out;
}

/** Words that identify a bill's transactions: its match text, or its name's payee words. */
function billWords(b: Pick<Bill, 'name' | 'match'>) {
  if (b.match) return [b.match.toLowerCase()];
  return payeeKey(b.name)
    .split(' ')
    .filter((w) => w.length >= 3);
}
const describe = (t: Transaction) =>
  [t.merchant, t.originalMerchant ?? ''].flatMap((d) => [d.toLowerCase(), payeeKey(d)]).join(' ');

export type PaymentMatch = { item: DueItem; tx: Transaction };

/**
 * Imported transactions that look like a scheduled bill, paycheck, or card payment that is not
 * yet marked paid: the right direction, a similar amount (within 10%, or $1), a date within a
 * week of the due date, and for bills, the bill's name or match text in the description.
 */
export function matchPayments(data: Finance, now: string): PaymentMatch[] {
  const items = dueItems(data, addDays(now, -60), addDays(now, 7)).filter(
    (i) => !i.paid && i.amount,
  );
  const used = new Set<string>();
  const matches: PaymentMatch[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, Math.round(b * 0.1));
  for (const item of items) {
    let best: Transaction | undefined;
    let bestScore = Infinity;
    if (item.kind === 'bill') {
      const bill = data.bills.find((b) => b.id === item.id)!;
      const words = billWords(bill);
      if (!words.length) continue;
      for (const t of data.transactions) {
        if (used.has(t.id) || t.pending) continue;
        if (item.income ? t.amount <= 0 : t.amount >= 0) continue;
        const gap = Math.abs(daysBetween(item.date, t.date));
        if (gap > 7 || !near(Math.abs(t.amount), item.amount!)) continue;
        if (bill.accountId && t.accountId !== bill.accountId) {
          // A bill charged to a card shows up on the card; one paid from checking, on checking.
          const account = data.accounts.find((a) => a.id === bill.accountId);
          if (account?.type === 'Credit card') continue;
        }
        const text = describe(t);
        if (!words.some((w) => text.includes(w))) continue;
        const score = gap * 1000 + Math.abs(Math.abs(t.amount) - item.amount!);
        if (score < bestScore) {
          best = t;
          bestScore = score;
        }
      }
    } else {
      // A payment arriving on the card account itself, at least the minimum, before the due
      // date (or up to 3 days after).
      for (const t of data.transactions) {
        if (used.has(t.id) || t.pending || t.accountId !== item.id || t.amount <= 0) continue;
        const gap = daysBetween(t.date, item.date);
        if (gap < -3 || gap > 25 || t.amount < item.amount!) continue;
        if (!/pay|thank|autopay|transfer/i.test(describe(t)) && t.category !== 'Transfer') continue;
        const score = Math.abs(gap);
        if (score < bestScore) {
          best = t;
          bestScore = score;
        }
      }
    }
    if (best) {
      used.add(best.id);
      matches.push({ item, tx: best });
    }
  }
  return matches;
}

/** Marks the matched due dates paid. Like any payment mark, this moves no money. */
export function confirmMatches(data: Finance, matches: PaymentMatch[]): Finance {
  return matches.reduce((next, m) => togglePaid(next, m.item), data);
}

export type SuggestedBill = {
  key: string;
  name: string;
  amount: number;
  frequency: Bill['frequency'];
  nextDate: string;
  kind: Bill['kind'];
  accountId: string;
  category: string;
  count: number;
};

const CADENCES: { frequency: Bill['frequency']; days: number; slack: number }[] = [
  { frequency: 'Weekly', days: 7, slack: 1 },
  { frequency: 'Biweekly', days: 14, slack: 2 },
  { frequency: 'Monthly', days: 30.4, slack: 4 },
  { frequency: 'Quarterly', days: 91, slack: 7 },
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Payees charged (or paying in) on a steady schedule for similar amounts, that are not already
 * a bill: three or more times over the last 200 days, most gaps within a few days of weekly,
 * every two weeks, monthly, or quarterly, amounts within 25% of the usual one, and recent.
 */
export function suggestBills(data: Finance, now: string): SuggestedBill[] {
  const since = addDays(now, -200);
  const groups = new Map<string, Transaction[]>();
  for (const t of data.transactions) {
    if (t.date < since || t.date > now || t.pending || !t.amount) continue;
    if (t.category === 'Transfer') continue;
    const key = payeeKey(t.originalMerchant ?? t.merchant);
    if (!key) continue;
    const k = `${t.amount > 0 ? 'in' : 'out'}:${key}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const known = data.bills.flatMap((b) => billWords(b));
  const out: SuggestedBill[] = [];
  for (const [key, list] of groups) {
    if (data.planner.dismissed.includes(key)) continue;
    const name = key.slice(key.indexOf(':') + 1);
    if (known.some((w) => name.includes(w))) continue;
    const dates = [...new Set(list.map((t) => t.date))].sort();
    if (dates.length < 3) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const usual = median(gaps);
    const cadence = CADENCES.find((c) => Math.abs(usual - c.days) <= c.slack);
    if (!cadence) continue;
    const steady = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.slack + 1).length;
    if (steady / gaps.length < 0.75) continue;
    const amounts = list.map((t) => Math.abs(t.amount));
    const typical = median(amounts);
    if (amounts.some((a) => Math.abs(a - typical) > typical * 0.25)) continue;
    const last = dates[dates.length - 1];
    if (daysBetween(last, now) > cadence.days * 1.5 + cadence.slack) continue;
    const latest = list.filter((t) => t.date === last)[0];
    // Already scheduled under another name (a "Paycheck" bill for "EXAMPLE CORP PAYROLL").
    const kind = latest.amount > 0 ? 'income' : 'expense';
    if (
      data.bills.some(
        (b) =>
          b.kind === kind &&
          b.frequency === cadence.frequency &&
          Math.abs(b.amount - typical) <= typical * 0.1,
      )
    )
      continue;
    const nextDate = occurrenceDates(
      { dueDate: last, frequency: cadence.frequency },
      addDays(last, 1),
      addDays(last, 120),
    )[0];
    const accounts = list.map((t) => t.accountId);
    out.push({
      key,
      name: latest.merchant,
      amount: Math.abs(latest.amount),
      frequency: cadence.frequency,
      nextDate,
      kind,
      accountId: accounts.sort(
        (a, b) => accounts.filter((x) => x === b).length - accounts.filter((x) => x === a).length,
      )[0],
      category: latest.category,
      count: dates.length,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Turns a suggestion into a bill with no payments marked. */
export function billFromSuggestion(s: SuggestedBill, id: string): Bill {
  return {
    id,
    name: s.name.slice(0, 100),
    amount: s.amount,
    dueDate: s.nextDate,
    frequency: s.frequency,
    accountId: s.accountId,
    autopay: false,
    paidDates: [],
    kind: s.kind,
    category: s.category,
    match: s.key.slice(s.key.indexOf(':') + 1).slice(0, 100),
  };
}

/** Unpaid bills and card payments due within the reminder window, including overdue ones. */
export function reminders(data: Finance, now: string): DueItem[] {
  return dueItems(data, addDays(now, -OVERDUE_DAYS), addDays(now, data.planner.reminderDays))
    .filter((i) => !i.paid && !i.income)
    .sort((a, b) => a.date.localeCompare(b.date));
}
