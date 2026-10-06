import { dateSchema, type Account } from '../finance';
import { cleanText, decimalToCents, suggestCategory, type ImportedTransaction } from './common';

// Bank CSV downloads vary: column names, date styles, and whether spending is negative or
// split into debit and credit columns. These helpers guess a mapping the user can adjust.

export type CsvMapping = {
  date: number;
  /** Second date column used when the first is blank or "null" (e.g. posted date). */
  dateFallback: number;
  description: number;
  /** Signed amount column, or -1 when the file uses separate debit/credit columns. */
  amount: number;
  debit: number;
  credit: number;
  category: number;
  notes: number;
  /** Column that labels each row Debit or Credit, for files with unsigned amounts. */
  type: number;
};

export type DateFormat = 'ymd' | 'mdy' | 'dmy';

const normalize = (h: string) =>
  h
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Earlier names win, so "Transaction Date" is preferred over "Post Date".
const names: Record<Exclude<keyof CsvMapping, 'dateFallback'>, string[]> = {
  date: [
    'date',
    'transactiondate',
    'transdate',
    'trandate',
    'posteddate',
    'postingdate',
    'postdate',
  ],
  description: [
    'merchant',
    'description',
    'payee',
    'name',
    'transactiondescription',
    'details',
    'originaldescription',
  ],
  amount: ['amount', 'transactionamount', 'amountusd', 'netamount'],
  debit: ['debit', 'debits', 'withdrawal', 'withdrawals', 'debitamount', 'moneyout', 'paidout'],
  credit: ['credit', 'credits', 'deposit', 'deposits', 'creditamount', 'moneyin', 'paidin'],
  category: ['category', 'transactioncategory'],
  notes: ['notes', 'note', 'memo'],
  type: ['transactiontype', 'type', 'debitcredit', 'creditdebit', 'drcr', 'creditdebitindicator'],
};

export function detectMapping(header: string[]): CsvMapping {
  const cols = header.map(normalize);
  const used = new Set<number>();
  const find = (list: string[]) => {
    for (const name of list) {
      const index = cols.findIndex((c, i) => c === name && !used.has(i));
      if (index >= 0) {
        used.add(index);
        return index;
      }
    }
    return -1;
  };
  const date = find(names.date);
  return {
    date,
    dateFallback: date >= 0 ? find(names.date) : -1,
    description: find(names.description),
    amount: find(names.amount),
    debit: find(names.debit),
    credit: find(names.credit),
    category: find(names.category),
    notes: find(names.notes),
    type: find(names.type),
  };
}

/** Picks the date style that fits every non-empty value; US month-first wins ties. */
export function detectDateFormat(values: string[]): DateFormat {
  const parts = values
    .map((v) => v.trim().split(/[/.\-\s]/))
    .filter((p) => p.length >= 3 && p.every((x) => /^\d+$/.test(x)));
  if (parts.length && parts.every((p) => p[0].length === 4)) return 'ymd';
  if (parts.some((p) => Number(p[0]) > 12)) return 'dmy';
  return 'mdy';
}

export function parseDate(raw: string, format: DateFormat): string | null {
  const text = raw.trim().split(/[T\s]/)[0];
  const p = text.split(/[/.-]/);
  if (p.length !== 3 || !p.every((x) => /^\d+$/.test(x))) return null;
  const [year, m, d] =
    format === 'ymd' ? p : format === 'mdy' ? [p[2], p[0], p[1]] : [p[2], p[1], p[0]];
  let y = year;
  if (y.length === 2) y = (Number(y) < 70 ? '20' : '19') + y;
  if (y.length !== 4) return null;
  const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return dateSchema.safeParse(date).success ? date : null;
}

/** Reads amounts like "-1,234.56", "$12.00", "(45.10)", "45.10-", or "12.00 CR". */
export function parseAmount(raw: string): number | null {
  let text = raw
    .trim()
    .replace(/[$\s]/g, '')
    .replace(/,(?=\d{3}(\D|$))/g, '');
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (/dr$/i.test(text)) {
    negative = true;
    text = text.slice(0, -2);
  } else if (/cr$/i.test(text)) text = text.slice(0, -2);
  try {
    const cents = decimalToCents(text);
    return negative ? -Math.abs(cents) : cents;
  } catch {
    return null;
  }
}

export type CsvOptions = {
  mapping: CsvMapping;
  dateFormat: DateFormat;
  /** True when the file shows purchases as positive numbers (common for credit cards). */
  purchasesPositive: boolean;
  accountType?: Account['type'];
};

/** Converts CSV rows (header removed) into transactions, collecting row-level problems. */
/** Placeholder text some banks write into empty cells. */
const blank = /^(null|undefined|n\/?a|none|-+)$/i;
// Only unambiguous direction words: "Payment" or "Sale" (Chase) say nothing about sign.
const debitWords = /^(debit|dr|d|withdrawal|withdrawl)$/i;
const creditWords = /^(credit|cr|c|deposit)$/i;

/** Converts CSV rows (header removed) into transactions, collecting row-level problems. */
export function readCsvRows(rows: string[][], options: CsvOptions) {
  const { mapping: m, dateFormat, purchasesPositive, accountType } = options;
  const transactions: ImportedTransaction[] = [];
  const errors: string[] = [];
  const cell = (row: string[], index: number) => {
    const value = index >= 0 ? (row[index] ?? '').trim() : '';
    return blank.test(value) ? '' : value;
  };
  rows.forEach((row, i) => {
    const line = i + 2;
    const rawDate = cell(row, m.date) || cell(row, m.dateFallback);
    const date = parseDate(rawDate, dateFormat);
    const merchant = cleanText(cell(row, m.description));
    let amount: number | null;
    let directionKnown = false;
    if (m.amount >= 0) {
      amount = parseAmount(cell(row, m.amount));
      // Unsigned amounts with a Debit/Credit column: the column decides the direction.
      const type = cell(row, m.type);
      if (amount !== null && debitWords.test(type)) {
        amount = -Math.abs(amount);
        directionKnown = true;
      } else if (amount !== null && creditWords.test(type)) {
        amount = Math.abs(amount);
        directionKnown = true;
      }
    } else {
      const debit = cell(row, m.debit) ? parseAmount(cell(row, m.debit)) : 0;
      const credit = cell(row, m.credit) ? parseAmount(cell(row, m.credit)) : 0;
      amount =
        debit === null || credit === null || (!cell(row, m.debit) && !cell(row, m.credit))
          ? null
          : Math.abs(credit) - Math.abs(debit);
    }
    if (!date)
      return errors.push(
        rawDate
          ? `Row ${line}: the date “${rawDate}” could not be read.`
          : `Row ${line}: the date is empty.`,
      );
    if (!merchant) return errors.push(`Row ${line}: the description is empty.`);
    if (amount === null) return errors.push(`Row ${line}: the amount could not be read.`);
    if (purchasesPositive && !directionKnown) amount = -amount;
    transactions.push({
      date,
      merchant,
      amount,
      notes: cleanText(cell(row, m.notes), 500),
      category: suggestCategory({
        merchant,
        amount,
        accountType,
        bankCategory: cell(row, m.category),
      }),
    });
  });
  return { transactions, errors };
}

/** Last four account digits from names like "acct_7201_08_03_2026.csv" or "Checking...1234". */
export function accountDigitsFromFileName(name: string) {
  return /(?:acct|account|acc|ending|x|\.\.\.)[ _#-]*(\d{4})(?!\d)/i.exec(name)?.[1] ?? '';
}

const paymentWords = /payment|thank you|autopay|auto pay/i;

/**
 * Guesses whether a card export lists purchases as positive numbers (Discover and Amex do;
 * Chase does not) from the sign of payment rows versus everything else. Returns false when
 * there is not enough evidence, leaving the switch for the user.
 */
export function detectPurchasesPositive(rows: string[][], mapping: CsvMapping) {
  if (mapping.amount < 0) return false;
  let paymentsNegative = 0,
    paymentsPositive = 0,
    othersPositive = 0,
    othersNegative = 0;
  for (const row of rows) {
    const amount = parseAmount(row[mapping.amount] ?? '');
    if (!amount) continue;
    if (mapping.type >= 0 && /^(debit|credit|dr|cr)$/i.test((row[mapping.type] ?? '').trim()))
      return false;
    const isPayment = paymentWords.test(row[mapping.description] ?? '');
    if (isPayment && amount < 0) paymentsNegative++;
    else if (isPayment) paymentsPositive++;
    else if (amount > 0) othersPositive++;
    else othersNegative++;
  }
  return paymentsNegative > paymentsPositive && othersPositive > othersNegative;
}

/** Identifies a CSV layout by its column names, so saved settings are reused only for it. */
export const csvHeaderSignature = (header: string[]) =>
  header.map(normalize).join('|').slice(0, 4000);
