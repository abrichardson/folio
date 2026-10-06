import { categories, type Account, type Transaction } from '../finance';

export type Category = (typeof categories)[number];

/** A transaction read from a bank file, before it is assigned to a Folio account. */
export type ImportedTransaction = {
  date: string;
  merchant: string;
  amount: number;
  notes: string;
  category: Category;
  /** Stable ID from the bank file (OFX FITID), used to skip re-imports. */
  importId?: string;
};

/**
 * Converts a decimal string to integer cents without floating-point error.
 * Accepts an optional sign and either `.` or `,` as the decimal separator; more than two
 * decimal places round half away from zero. Throws on anything else.
 */
export function decimalToCents(raw: string): number {
  const text = raw.trim();
  const match = /^([+-])?(\d*)(?:[.,](\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new Error(`“${raw}” is not an amount.`);
  const [, sign, whole = '', fraction = ''] = match;
  const padded = (fraction + '000').slice(0, 3);
  let cents = Number(whole || '0') * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw new Error(`“${raw}” is too large.`);
  return sign === '-' ? -cents : cents;
}

/** Collapses whitespace and limits a description to Folio's 100-character merchant field. */
export function cleanText(value: string, max = 100) {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

const synonyms: [RegExp, Category][] = [
  [/transfer|payment|xfer/, 'Transfer'],
  [/income|paycheck|payroll|salary|deposit|interest|dividend/, 'Income'],
  [/grocer|supermarket/, 'Groceries'],
  [/food|dining|restaurant|coffee|bar\b/, 'Dining'],
  [/gas|fuel|auto|transport|parking|transit|ride/, 'Transport'],
  [/travel|airline|hotel|lodging/, 'Travel'],
  [/entertain|movie|music|stream/, 'Entertainment'],
  [/health|medical|pharmac|doctor|fitness|wellness|personal care/, 'Health'],
  [/utilit|bill|phone|internet|electric|water/, 'Utilities'],
  [/rent|mortgage|home|housing/, 'Housing'],
  [/shop|merchandise|retail|warehouse|department/, 'Shopping'],
];

const cardPayment =
  /(credit\s*c(ar)?d|crd|card|amex|visa|mastercard|discover).*(payment|pmt|autopay|auto pay|epay)|(payment|pmt|autopay|auto pay|epay).*(credit\s*c(ar)?d|crd|card)/i;
const transferWords = /\b(transfer|xfer|trnsfr)\b/i;
const charges =
  /\b(interest charge|finance charge|late (payment )?fee|annual fee|overdraft|service (charge|fee)|monthly (maintenance )?fee|foreign transaction fee|returned payment fee)\b/i;
const cardPaymentReceived = /payment|thank you|autopay|auto pay/i;

/**
 * Suggests a Folio category. Transfers between the user's own accounts, especially credit
 * card payments, must be `Transfer` so they are not counted as both spending and income.
 */
export function suggestCategory(input: {
  merchant: string;
  amount: number;
  accountType?: Account['type'];
  ofxType?: string;
  bankCategory?: string;
}): Category {
  const { merchant, amount, accountType, ofxType, bankCategory } = input;
  if (ofxType === 'XFER') return 'Transfer';
  if (accountType === 'Credit card' && amount > 0)
    return cardPaymentReceived.test(merchant) ? 'Transfer' : 'Other';
  if (cardPayment.test(merchant) || transferWords.test(merchant)) return 'Transfer';
  const raw = bankCategory?.trim().toLowerCase();
  if (amount < 0 && (charges.test(merchant) || /interest|fee/.test(raw ?? '')))
    return 'Interest & fees';
  if (raw) {
    const exact = categories.find((c) => c.toLowerCase() === raw);
    if (exact) return exact;
    const found = synonyms.find(([pattern]) => pattern.test(raw));
    if (found && !(found[1] === 'Income' && amount < 0)) return found[1];
  }
  return amount > 0 ? 'Income' : 'Other';
}

const duplicateKey = (t: { date: string; merchant: string; amount: number }, accountId: string) =>
  [t.date, t.merchant.toLowerCase(), t.amount, accountId].join('|');

/**
 * Removes transactions already in Folio for one account. Bank IDs match exactly. Entries
 * without a bank ID match on date, description, and amount, and matches are counted: two
 * identical purchases on the same day both import, and importing the same file again adds
 * nothing.
 */
export function withoutDuplicates(
  existing: Transaction[],
  incoming: ImportedTransaction[],
  accountId: string,
) {
  const ids = new Set<string>();
  // Detail matches available to rows without a bank ID (any existing entry) and to rows
  // with one (only entries that have no bank ID, such as hand-entered or CSV rows).
  const anyEntry = new Map<string, number>();
  const unidentified = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const t of existing) {
    if (t.accountId !== accountId) continue;
    // Match on the bank's own description, even if the payee was renamed since.
    const key = duplicateKey({ ...t, merchant: t.originalMerchant ?? t.merchant }, accountId);
    add(anyEntry, key);
    if (t.importId) ids.add(t.importId);
    else add(unidentified, key);
  }
  const take = (map: Map<string, number>, key: string) => {
    const remaining = map.get(key) ?? 0;
    if (remaining > 0) map.set(key, remaining - 1);
    return remaining > 0;
  };
  const fresh: ImportedTransaction[] = [];
  let duplicates = 0;
  for (const t of incoming) {
    const key = duplicateKey(t, accountId);
    const duplicate = t.importId
      ? ids.has(t.importId) || take(unidentified, key)
      : take(anyEntry, key);
    if (duplicate) {
      duplicates++;
      continue;
    }
    if (t.importId) ids.add(t.importId);
    fresh.push(t);
  }
  return { fresh, duplicates };
}

/**
 * A stable, non-reversible key for a bank account so later imports find the same Folio
 * account without storing the full account number.
 */
export async function accountImportKey(bankId: string, accountNumber: string) {
  const bytes = new TextEncoder().encode(`${bankId.trim()}|${accountNumber.trim()}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'ofx:' + Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decodes a bank file, honoring the Windows-1252 charset that older OFX files declare. */
export function decodeBankFile(bytes: Uint8Array) {
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 1024));
  const legacy =
    /CHARSET:\s*(1252|WINDOWS-1252)/i.test(head) || /ENCODING="?windows-1252/i.test(head);
  return new TextDecoder(legacy ? 'windows-1252' : 'utf-8').decode(bytes).replace(/^\uFEFF/, '');
}
