import { type Finance, type Bill, today } from './finance';
export type DueItem = {
  key: string;
  id: string;
  name: string;
  date: string;
  amount: number | null;
  paid: boolean;
  autopay: boolean;
  kind: 'bill' | 'card';
  /** Money expected in (a paycheck) rather than a payment. */
  income?: boolean;
  accountId?: string;
};
export function monthEnd(month: string) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
}
const DAY = 86400000;
const STEP_DAYS: Partial<Record<Bill['frequency'], number>> = { Weekly: 7, Biweekly: 14 };
const STEP_MONTHS: Partial<Record<Bill['frequency'], number>> = {
  Monthly: 1,
  Quarterly: 3,
  Yearly: 12,
};
export function occurrenceDates(
  bill: Pick<Bill, 'dueDate' | 'frequency' | 'endDate'>,
  from: string,
  to: string,
): string[] {
  if (bill.endDate && bill.endDate < to) to = bill.endDate;
  const anchor = new Date(bill.dueDate + 'T00:00:00Z'),
    result: string[] = [];
  const start = new Date(from + 'T00:00:00Z'),
    end = new Date(to + 'T00:00:00Z');
  if (end < anchor) return result;
  if (bill.frequency === 'Once')
    return bill.dueDate >= from && bill.dueDate <= to ? [bill.dueDate] : [];
  const days = STEP_DAYS[bill.frequency],
    months = STEP_MONTHS[bill.frequency] ?? 1;
  let n = days
    ? Math.max(0, Math.floor((start.getTime() - anchor.getTime()) / (days * DAY)))
    : Math.max(
        0,
        Math.floor(
          ((start.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
            start.getUTCMonth() -
            anchor.getUTCMonth()) /
            months,
        ),
      );
  for (let count = 0; count < 5000; count++, n++) {
    let d: Date;
    if (days) d = new Date(anchor.getTime() + n * days * DAY);
    else {
      const first = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + n * months, 1),
      );
      const last = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
      ).getUTCDate();
      d = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor.getUTCDate(), last)),
      );
    }
    if (d > end) break;
    const value = d.toISOString().slice(0, 10);
    if (value >= from) result.push(value);
  }
  return result;
}
/** "Every 2 weeks", "Monthly", … */
export const frequencyLabel = (f: Bill['frequency']) => (f === 'Biweekly' ? 'Every 2 weeks' : f);
export function dueItems(data: Finance, from: string, to: string): DueItem[] {
  const bills = data.bills.flatMap((b) =>
    occurrenceDates(b, from, to).map((date) => ({
      key: `bill:${b.id}:${date}`,
      id: b.id,
      name: b.name,
      date,
      amount: b.amount,
      paid: b.paidDates.includes(date),
      autopay: b.autopay,
      kind: 'bill' as const,
      income: b.kind === 'income',
      accountId: b.accountId,
    })),
  );
  const cards = data.accounts
    .filter(
      (a) =>
        a.type === 'Credit card' &&
        a.credit?.dueDate &&
        a.credit.dueDate >= from &&
        a.credit.dueDate <= to,
    )
    .map((a) => ({
      key: `card:${a.id}:${a.credit!.dueDate}`,
      id: a.id,
      name: a.name,
      date: a.credit!.dueDate!,
      amount: a.credit!.minimumPayment ?? null,
      paid: a.credit!.paidDueDates?.includes(a.credit!.dueDate!) ?? false,
      autopay: a.credit!.autopay ?? false,
      kind: 'card' as const,
      accountId: a.id,
    }));
  return [...bills, ...cards].sort(
    (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
  );
}
export function dueStatus(item: DueItem, now = today()) {
  return item.paid
    ? 'Marked paid'
    : item.date < now
      ? 'Overdue'
      : item.date === now
        ? 'Due today'
        : 'Upcoming';
}
export function togglePaid(data: Finance, item: DueItem): Finance {
  const next = structuredClone(data);
  const dates =
    item.kind === 'bill'
      ? next.bills.find((b) => b.id === item.id)?.paidDates
      : next.accounts.find((a) => a.id === item.id)?.credit?.paidDueDates;
  const updated = dates?.includes(item.date)
    ? dates.filter((d) => d !== item.date)
    : [...(dates || []), item.date];
  if (item.kind === 'bill') {
    const b = next.bills.find((b) => b.id === item.id);
    if (b) b.paidDates = updated;
  } else {
    const a = next.accounts.find((a) => a.id === item.id);
    if (a?.credit) a.credit.paidDueDates = updated;
  }
  return next;
}
