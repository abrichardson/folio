import type { Plan } from './finance';

// Installment plans (buy now, pay later, auto and personal loans): schedules, how each payment
// splits into principal and interest, and what is left to pay. Principal owed and the total of
// future payments are kept apart: with interest, the payments add up to more.

const PERIODS = { weekly: 52, biweekly: 26, monthly: 12 } as const;

/** Interest rate per payment period. */
export const periodRate = (p: Pick<Plan, 'apr' | 'frequency'>) =>
  p.apr / 100 / PERIODS[p.frequency];

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The payment date after `date` for the plan's frequency (months keep the day, or month end). */
export function nextPaymentDate(date: string, frequency: Plan['frequency']) {
  const d = new Date(date + 'T00:00:00Z');
  if (frequency !== 'monthly') {
    d.setUTCDate(d.getUTCDate() + (frequency === 'weekly' ? 7 : 14));
    return iso(d);
  }
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return iso(target);
}

export type ScheduledPayment = {
  date: string;
  amount: number;
  principal: number;
  interest: number;
};

/** The remaining payments, amortized: the last one is only what is left. */
export function schedule(plan: Plan, limit = 1000): ScheduledPayment[] {
  if (plan.status !== 'active') return [];
  const rate = periodRate(plan);
  const out: ScheduledPayment[] = [];
  let principal = plan.principal;
  let date = plan.nextDate;
  for (let i = 0; i < plan.paymentsLeft && principal > 0 && i < limit; i++) {
    const interest = Math.round(principal * rate);
    const last = i === plan.paymentsLeft - 1;
    const amount = last ? principal + interest : Math.min(plan.installment, principal + interest);
    const toPrincipal = Math.min(principal, Math.max(0, amount - interest));
    out.push({ date, amount, principal: toPrincipal, interest });
    principal -= toPrincipal;
    date = nextPaymentDate(date, plan.frequency);
  }
  return out;
}

/** Total of the remaining scheduled payments, and the interest within them. */
export function remaining(plan: Plan) {
  const s = schedule(plan);
  const total = s.reduce((sum, p) => sum + p.amount, 0);
  const interest = s.reduce((sum, p) => sum + p.interest, 0);
  return { total, interest, payments: s.length };
}

/** Records the next scheduled payment (or a different amount) and moves the plan forward. */
export function recordPayment(plan: Plan, amount = plan.installment, date = plan.nextDate): Plan {
  const interest = Math.round(plan.principal * periodRate(plan));
  const toPrincipal = Math.min(plan.principal, Math.max(0, amount - interest));
  const principal = plan.principal - toPrincipal;
  const paymentsLeft = Math.max(0, plan.paymentsLeft - 1);
  return {
    ...plan,
    principal,
    paymentsLeft: principal === 0 ? 0 : paymentsLeft,
    nextDate: nextPaymentDate(plan.nextDate, plan.frequency),
    status: principal === 0 ? 'paid' : plan.status,
    history: [...plan.history, { date, amount, principal: toPrincipal, interest, note: '' }].slice(
      -1000,
    ),
  };
}

/** Payments needed to clear `principal` at the plan's installment and rate. */
export function paymentsNeeded(plan: Plan, principal: number) {
  const rate = periodRate(plan);
  let left = principal;
  let n = 0;
  while (left > 0 && n < 1000) {
    const interest = Math.round(left * rate);
    if (plan.installment <= interest) return 1000; // never paid off at this installment
    left -= Math.min(left, plan.installment - interest);
    n++;
  }
  return n;
}

/**
 * A refund lowers the principal; the remaining payments are recounted at the same
 * installment, as Affirm and Klarna do. A full refund closes the plan.
 */
export function applyRefund(plan: Plan, refund: number, date: string): Plan {
  const principal = Math.max(0, plan.principal - refund);
  return {
    ...plan,
    principal,
    paymentsLeft: principal === 0 ? 0 : paymentsNeeded(plan, principal),
    status: principal === 0 ? 'paid' : plan.status,
    history: [
      ...plan.history,
      { date, amount: 0, principal: plan.principal - principal, interest: 0, note: 'Refund' },
    ].slice(-1000),
  };
}

/** Paying the whole principal early closes the plan. */
export function payOff(plan: Plan, date: string): Plan {
  return {
    ...plan,
    principal: 0,
    paymentsLeft: 0,
    status: 'paid',
    history: [
      ...plan.history,
      {
        date,
        amount: plan.principal,
        principal: plan.principal,
        interest: 0,
        note: 'Paid off early',
      },
    ].slice(-1000),
  };
}

/** Active plans grouped by provider, providers sorted by name. */
export function byProvider(plans: Plan[]) {
  const groups = new Map<string, Plan[]>();
  for (const p of plans) groups.set(p.provider, [...(groups.get(p.provider) ?? []), p]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({
      provider,
      plans: list.sort((a, b) => a.nextDate.localeCompare(b.nextDate)),
    }));
}

/** Scheduled payments on or before `until`, across active plans. */
export const paymentsDue = (plans: Plan[], until: string) =>
  plans.flatMap((p) =>
    schedule(p, 60)
      .filter((s) => s.date <= until)
      .map((s) => ({ plan: p, ...s })),
  );
