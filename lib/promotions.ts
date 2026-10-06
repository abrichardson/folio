import type { Account, Promotion } from './finance';

// Promotional balances on credit cards: what must be paid each month to clear each one before
// its deadline, and what a deferred-interest promotion would cost if it is not cleared.

const day = (date: string) => Date.parse(date + 'T00:00:00Z') / 86_400_000;
export const daysUntil = (date: string, today: string) => Math.round(day(date) - day(today));

/** The date to have the balance paid by: your own target, or the promotion's deadline. */
export const targetDate = (p: Promotion) => p.payoffBy ?? p.endDate;

/**
 * Monthly payments left before `target`: one per month boundary still ahead, at least one
 * (pay it now if the target is this month or already past).
 */
export function paymentsLeft(target: string, today: string) {
  const [ty, tm, td] = target.split('-').map(Number);
  const [y, m, d] = today.split('-').map(Number);
  const months = (ty - y) * 12 + (tm - m) + (td >= d ? 0 : -1);
  return Math.max(1, months);
}

/** The monthly payment that clears the promotion by its target, in whole cents. */
export const monthlyNeeded = (p: Promotion, today: string) =>
  p.balance <= 0 ? 0 : Math.ceil(p.balance / paymentsLeft(targetDate(p), today));

export type PromotionStatus = 'paid' | 'expired' | 'urgent' | 'soon' | 'on track';

export function promotionStatus(p: Promotion, today: string): PromotionStatus {
  if (p.balance <= 0) return 'paid';
  const days = daysUntil(p.endDate, today);
  if (days < 0) return 'expired';
  if (days <= 45) return 'urgent';
  if (days <= 90) return 'soon';
  return 'on track';
}

/**
 * Interest charged back if a deferred-interest promotion is not cleared in time: the amount
 * the issuer reports as accrued, or else an estimate on the original amount at the rate after
 * the promotion, from the purchase date to the deadline. Zero for true 0% offers.
 */
export function deferredInterestAtRisk(p: Promotion, cardApr: number | null | undefined) {
  if (p.kind !== 'deferred' || p.balance <= 0) return 0;
  if (p.accruedInterest != null) return p.accruedInterest;
  const apr = p.aprAfter ?? cardApr;
  if (apr == null || !p.startDate) return null;
  const principal = p.originalAmount ?? p.balance;
  return Math.round(
    (principal * (apr / 100) * Math.max(0, day(p.endDate) - day(p.startDate))) / 365,
  );
}

/** Paid-down share of the original amount, 0 to 1, when the original is known. */
export const progress = (p: Promotion) =>
  p.originalAmount ? Math.min(1, Math.max(0, 1 - p.balance / p.originalAmount)) : null;

/** Promotions still owed on a card, soonest deadline first. */
export const activePromotions = (a: Account) =>
  (a.promotions ?? [])
    .filter((p) => p.balance > 0)
    .sort((x, y) => x.endDate.localeCompare(y.endDate));

/** Promotional balances are part of the card balance; more than it means something is stale. */
export const promotionsExceedBalance = (a: Account) =>
  activePromotions(a).reduce((s, p) => s + p.balance, 0) > Math.max(0, a.balance);

export type FoundPromotion = Omit<Promotion, 'id' | 'asOf' | 'source' | 'payoffBy'>;

/**
 * Merges promotions read from a statement into a card's list: one with the same deadline and
 * start date (or original amount) is updated; new ones are added. Promotions the statement no
 * longer shows are kept as they were, since they may have been paid off.
 */
export function mergePromotions(
  existing: Promotion[],
  found: FoundPromotion[],
  asOf: string,
  newId: () => string,
): Promotion[] {
  const result = existing.map((p) => ({ ...p }));
  for (const f of found) {
    const match = result.find(
      (p) =>
        p.endDate === f.endDate &&
        (p.startDate === f.startDate ||
          (p.originalAmount != null && p.originalAmount === f.originalAmount)),
    );
    if (match) {
      if (match.asOf > asOf) continue; // never replace newer figures with an older statement
      Object.assign(match, {
        balance: f.balance,
        accruedInterest: f.accruedInterest ?? match.accruedInterest,
        aprAfter: f.aprAfter ?? match.aprAfter,
        originalAmount: match.originalAmount ?? f.originalAmount,
        startDate: match.startDate ?? f.startDate,
        asOf,
      });
    } else result.push({ ...f, id: newId(), asOf, source: 'pdf', payoffBy: null });
  }
  return result;
}
