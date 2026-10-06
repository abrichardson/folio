import type { Finance, Transaction } from './finance';

// Money moving between your own accounts appears twice: once leaving one account and once
// arriving in the other (a checking payment and the card's payment received). Matching the
// two sides files both as Transfer so neither counts as spending or income.

/** How many days apart the two sides of a transfer may post. */
export const TRANSFER_DAYS = 5;

export type TransferPair = { out: Transaction; in: Transaction; days: number };

const dayNumber = (date: string) => Date.parse(date + 'T00:00:00Z') / 86_400_000;

/**
 * Likely transfers: an amount leaving one account and the same amount arriving in another
 * within a few days. Each transaction is used once; the closest dates are paired first.
 */
export function findTransfers(data: Finance): TransferPair[] {
  const open = data.transactions.filter(
    (t) => !t.transferId && !t.pending && t.amount !== 0 && !t.splits,
  );
  const outgoing = open.filter((t) => t.amount < 0);
  const incoming = new Map<number, Transaction[]>();
  for (const t of open)
    if (t.amount > 0) incoming.set(t.amount, [...(incoming.get(t.amount) ?? []), t]);
  const candidates: TransferPair[] = [];
  for (const out of outgoing) {
    for (const arrival of incoming.get(-out.amount) ?? []) {
      if (arrival.accountId === out.accountId) continue;
      const days = Math.abs(dayNumber(arrival.date) - dayNumber(out.date));
      if (days <= TRANSFER_DAYS) candidates.push({ out, in: arrival, days });
    }
  }
  candidates.sort((a, b) => a.days - b.days || a.out.date.localeCompare(b.out.date));
  const used = new Set<string>();
  const pairs: TransferPair[] = [];
  for (const pair of candidates) {
    if (used.has(pair.out.id) || used.has(pair.in.id)) continue;
    used.add(pair.out.id);
    used.add(pair.in.id);
    pairs.push(pair);
  }
  return pairs.sort((a, b) => b.out.date.localeCompare(a.out.date));
}

/** A pair is suggested ticked when either side already looks like a transfer. */
export const looksLikeTransfer = (pair: TransferPair) =>
  pair.out.category === 'Transfer' || pair.in.category === 'Transfer';

/** Links each pair with a shared ID and files both sides as Transfer. */
export function linkTransfers(data: Finance, pairs: TransferPair[], newId: () => string): Finance {
  const links = new Map<string, string>();
  for (const pair of pairs) {
    const id = newId();
    links.set(pair.out.id, id);
    links.set(pair.in.id, id);
  }
  return {
    ...data,
    transactions: data.transactions.map((t) => {
      const transferId = links.get(t.id);
      if (!transferId) return t;
      const linked = { ...t, transferId, category: 'Transfer' };
      return t.importBatch ? { ...linked, edited: true } : linked;
    }),
  };
}

/** The other side of a linked transfer, if it still exists. */
export const transferPartner = (data: Finance, t: Transaction) =>
  t.transferId
    ? data.transactions.find((x) => x.transferId === t.transferId && x.id !== t.id)
    : undefined;

/** Removes the link from both sides; their categories stay as they are. */
export function unlinkTransfer(data: Finance, transferId: string): Finance {
  return {
    ...data,
    transactions: data.transactions.map((t) => {
      if (t.transferId !== transferId) return t;
      const unlinked = { ...t };
      delete unlinked.transferId;
      return unlinked;
    }),
  };
}
