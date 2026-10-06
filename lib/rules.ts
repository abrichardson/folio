import type { Finance, Rule, Transaction } from './finance';

// Cleaning up imported transactions: rules rename payees and set categories, and categories
// the user picked by hand are remembered for the same payee next time.

/** The bank's own description, before any renaming. */
export const bankDescription = (t: { merchant: string; originalMerchant?: string }) =>
  t.originalMerchant ?? t.merchant;

/**
 * The text a new rule should look for: the description's leading words, up to the first
 * word with a digit (a store number or code). "WHOLEFDS ASH #10351 ASHEVILLE NC" gives
 * "WHOLEFDS ASH".
 */
export function ruleTextFor(description: string) {
  const lead: string[] = [];
  let words = 0;
  for (const w of description.trim().split(/\s+/)) {
    if (/[\d#]/.test(w) || words === 4) break;
    lead.push(w);
    if (/[a-z]/i.test(w)) words++;
  }
  // Drop trailing punctuation such as a lone "-".
  while (lead.length && !/[a-z]/i.test(lead[lead.length - 1])) lead.pop();
  return (lead.length ? lead.join(' ') : description.trim()).slice(0, 100);
}

/** The first rule whose text appears in the description (ignoring case). */
export function matchRule(rules: Rule[], description: string): Rule | undefined {
  const text = description.toLowerCase();
  return rules.find((r) => text.includes(r.contains.toLowerCase()));
}

/**
 * Groups descriptions of the same payee: "BISCUITVILLE 222 BOILING SPRINSC" and
 * "BISCUITVILLE 222 BOILING SPRINSC #4" both become "biscuitville boiling sprinsc".
 * Words containing digits (store numbers, dates, reference codes) are dropped.
 */
export function payeeKey(description: string) {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w))
    .slice(0, 4)
    .join(' ');
}

/**
 * Categories chosen by hand, by payee: entries typed in, and imported entries edited since.
 * The most recent choice wins; "Other" teaches nothing.
 */
export function learnedCategories(transactions: Transaction[]) {
  const learned = new Map<string, string>();
  const chosen = transactions
    .filter(
      (t) =>
        (t.edited || t.categoryEdited || !t.importBatch) && t.category !== 'Other' && !t.splits,
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const t of chosen) {
    const key = payeeKey(bankDescription(t));
    if (key) learned.set(key, t.category);
  }
  return learned;
}

type Row = { merchant: string; category: string; amount: number; originalMerchant?: string };

/**
 * Applies rules, then learned categories, to new rows. Transfers and card payments the
 * importer recognized stay transfers unless a rule says otherwise.
 */
export function categorize<T extends Row>(
  rows: T[],
  rules: Rule[],
  learned: Map<string, string>,
): T[] {
  return rows.map((row) => {
    const description = bankDescription(row);
    const rule = matchRule(rules, description);
    if (rule) {
      const renamed = rule.rename && rule.rename !== row.merchant;
      return {
        ...row,
        ...(renamed ? { merchant: rule.rename, originalMerchant: description } : {}),
        // A split keeps its parts' categories; the rule only renames it.
        ...(rule.category && !('splits' in row && row.splits) ? { category: rule.category } : {}),
      };
    }
    const category = learned.get(payeeKey(description));
    if (!category || row.category === 'Transfer') return row;
    // A learned spending category never turns money in into spending, or the reverse.
    if ((category === 'Income') !== row.amount > 0) return row;
    return { ...row, category };
  });
}

/** Existing transactions a rule would change. */
export const ruleMatches = (data: Finance, rule: Rule) =>
  data.transactions.filter((t) => {
    if (!matchRule([rule], bankDescription(t))) return false;
    return (
      (rule.rename !== undefined && t.merchant !== rule.rename) ||
      (rule.category !== undefined && t.category !== rule.category && !t.splits)
    );
  });

/** Applies a rule to existing transactions; imported ones are marked as edited. */
export function applyRule(data: Finance, rule: Rule): { next: Finance; changed: number } {
  const ids = new Set(ruleMatches(data, rule).map((t) => t.id));
  const transactions = data.transactions.map((t) => {
    if (!ids.has(t.id)) return t;
    const [updated] = categorize([t], [rule], new Map());
    return t.importBatch ? { ...updated, edited: true } : updated;
  });
  return { next: { ...data, transactions }, changed: ids.size };
}

/** Moves a transaction, and any split parts, from one category to another. */
function recategorize(t: Transaction, from: string, to: string): Transaction {
  if (t.category !== from && !t.splits?.some((p) => p.category === from)) return t;
  return {
    ...t,
    category: t.category === from ? to : t.category,
    splits: t.splits?.map((p) => (p.category === from ? { ...p, category: to } : p)),
  };
}

/** Renames a custom category everywhere it is used. */
export function renameCategory(data: Finance, from: string, to: string): Finance {
  const swap = (c: string) => (c === from ? to : c);
  return {
    ...data,
    customCategories: data.customCategories.map(swap),
    incomeCategories: data.incomeCategories.map(swap),
    transactions: data.transactions.map((t) => recategorize(t, from, to)),
    budgets: data.budgets.map((b) => (b.category === from ? { ...b, category: to } : b)),
    bills: data.bills.map((b) => (b.category === from ? { ...b, category: to } : b)),
    rules: data.rules.map((r) => (r.category === from ? { ...r, category: to } : r)),
  };
}

/**
 * Removes a custom category: its transactions (and split parts) move to Other, bills lose it,
 * and its budget and the
 * category part of its rules are removed (rules that only set it are removed).
 */
export function removeCategory(data: Finance, name: string): Finance {
  return {
    ...data,
    customCategories: data.customCategories.filter((c) => c !== name),
    incomeCategories: data.incomeCategories.filter((c) => c !== name),
    transactions: data.transactions.map((t) => recategorize(t, name, 'Other')),
    budgets: data.budgets.filter((b) => b.category !== name),
    bills: data.bills.map((b) => (b.category === name ? { ...b, category: undefined } : b)),
    rules: data.rules.flatMap((r) => {
      if (r.category !== name) return [r];
      if (!r.rename) return [];
      const kept = { ...r };
      delete kept.category;
      return [kept];
    }),
  };
}
