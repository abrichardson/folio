import { dateSchema, olderThanBalance, today, type Account } from '../finance';
import { mergePromotions, type FoundPromotion } from '../promotions';
import { decimalToCents } from './common';

// Reads the summary fields US credit card statements print in a standard layout (the
// "Account Summary" / "Payment Information" boxes and the "Interest Charge Calculation"
// table). Works on text lines extracted from the statement PDF; anything not found is null
// so the user can fill it in before saving.

export type StatementSummary = {
  issuer: string | null;
  last4: string | null;
  closingDate: string | null;
  /** Amount owed at the statement date, in cents (positive = owed). */
  newBalance: number | null;
  minimumPayment: number | null;
  dueDate: string | null;
  creditLimit: number | null;
  /** Purchase APR in percent, e.g. 21.74. */
  purchaseApr: number | null;
  /** Promotional balances listed on the statement. */
  promotions?: FoundPromotion[];
};

// Between a label and its value: spaces, colons, column marks, or "=".
const SEP = String.raw`[\s:|=]*`;
const MONEY = String.raw`([+-]?)\s*\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)`;
const MONTHS = String.raw`Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?`;
/** 9/10/2026, 9/10/26, Sep 10, 2026, or September 10, 2026 (one capture group). */
const DATE = String.raw`(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b|(?:${MONTHS})\.?\s+\d{1,2},?\s+\d{4})`;
const monthNumber = (name: string) =>
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
    name.slice(0, 3).toLowerCase(),
  ) + 1;

function toCents(sign: string, digits: string) {
  const cents = decimalToCents(digits.replace(/,/g, ''));
  return sign === '-' ? -cents : cents;
}

export function statementDate(raw: string): string | null {
  let month: number, day: string, year: string;
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  const named = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw.trim());
  if (numeric) [month, day, year] = [Number(numeric[1]), numeric[2], numeric[3]];
  else if (named) [month, day, year] = [monthNumber(named[1]), named[2], named[3]];
  else return null;
  if (!month) return null;
  if (year.length === 2) year = '20' + year;
  const iso = `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return dateSchema.safeParse(iso).success ? iso : null;
}

const cells = (line: string) => line.split(' | ').map((c) => c.trim());
const MONEY_CELL = /^([+-]?)\s*\$\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})$/;

/**
 * Values printed in the row under a row of labels (Capital One's "New Balance | Minimum
 * Payment Due" box, for one): the cell under the matching label, within the next 3 lines.
 */
function moneyBelow(lines: string[], label: string) {
  const re = new RegExp(`^${label}`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const header = cells(lines[i]);
    const column = header.findIndex((c) => re.test(c));
    if (column < 0 || header.some((c) => MONEY_CELL.test(c))) continue;
    for (const next of lines.slice(i + 1, i + 4)) {
      const row = cells(next);
      if (!MONEY_CELL.test(row[0])) continue;
      const m = MONEY_CELL.exec(row[column] ?? '');
      if (m) return toCents(m[1], m[2]);
      break;
    }
  }
  return null;
}

/** First money value directly after a label (only spaces, colons, or column marks between). */
function moneyAfter(lines: string[], label: string, skipBefore?: RegExp) {
  const re = new RegExp(`${label}${SEP}${MONEY}(?![\\d/%])`, 'gi');
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      if (skipBefore && skipBefore.test(line.slice(0, m.index))) continue;
      return toCents(m[1], m[2]);
    }
  }
  return null;
}

function dateAfter(lines: string[], label: string) {
  const re = new RegExp(`${label}${SEP}${DATE}`, 'i');
  for (const line of lines) {
    const m = re.exec(line);
    const date = m && statementDate(m[1]);
    if (date) return date;
  }
  return null;
}

const issuers: [RegExp, string][] = [
  [/\bdiscover\b/i, 'Discover'],
  [/\bsynchrony\b/i, 'Synchrony'],
  [/\bchase\b/i, 'Chase'],
  [/\bcapital one\b/i, 'Capital One'],
  [/\bcitibank\b|\bciti\b/i, 'Citi'],
  [/\bamerican express\b|\bamex\b/i, 'American Express'],
  [/\bbank of america\b/i, 'Bank of America'],
  [/\bwells fargo\b/i, 'Wells Fargo'],
  [/\bbarclays\b/i, 'Barclays'],
  [/\btruist\b/i, 'Truist'],
  [/\bu\.?s\.? bank\b/i, 'U.S. Bank'],
  [/\bapple card\b/i, 'Apple Card'],
];

export function parseStatementText(lines: string[]): StatementSummary {
  const text = lines.join('\n');
  const last4 =
    /ending\s+in\s+(\d{4})\b/i.exec(text)?.[1] ??
    /account\s+number\s*:?[\s|]*(?:[x*•]{4}[\s-]*){3}(\d{4})\b/i.exec(text)?.[1] ??
    null;

  const accountSummary = new RegExp(`Account Summary${SEP}${DATE}\\s*-\\s*${DATE}`, 'i').exec(text);
  // "Aug 11, 2026 - Sep 10, 2026 | 31 days in Billing Cycle"
  const cycle = lines
    .filter((l) => /billing\s+(cycle|period)|statement\s+period/i.test(l))
    .map((l) => new RegExp(`${DATE}\\s*(?:-|–|to)\\s*${DATE}`, 'i').exec(l))
    .find(Boolean);
  const closingDate =
    dateAfter(lines, String.raw`(?<!Next\s)(?<!Upcoming\s)Statement\s+Closing\s+Date`) ??
    (accountSummary ? statementDate(accountSummary[2]) : null) ??
    (cycle ? statementDate(cycle[2]) : null) ??
    dateAfter(lines, String.raw`New\s+Balance\s+as\s+of`) ??
    dateAfter(lines, String.raw`Closing\s+Date`);

  // The purchase row of the interest table: "Purchases", "Standard Purchases", or
  // "Purchases & Balance Transfers", then any N/A or date cells, then the rate. Some issuers
  // (Citi) put a "PURCHASES" heading on its own line above rows such as "REGULAR".
  let purchaseApr: number | null = null;
  const rate = String.raw`(\d{1,2}(?:\.\d{1,3})?)\s*%`;
  const aprRow = new RegExp(
    String.raw`(?:^|\|)\s*(?:Standard\s+|Regular\s+)?Purchases(?:\s*(?:&|and)\s*Balance\s+Transfers)?${SEP}(?:(?:N\/?A|${DATE.slice(1, -1)})${SEP})*${rate}`,
    'i',
  );
  for (let i = 0; i < lines.length && purchaseApr === null; i++) {
    const m = aprRow.exec(lines[i]);
    if (m) purchaseApr = Number(m[1]);
    else if (/^purchases$/i.test(lines[i].trim())) {
      const row = lines
        .slice(i + 1, i + 4)
        .map((l) => new RegExp(`^[A-Za-z][A-Za-z ]{0,40}${SEP}${rate}`).exec(l))
        .find(Boolean);
      if (row) purchaseApr = Number(row[1]);
    }
  }

  return {
    issuer: issuers.find(([re]) => re.test(text))?.[1] ?? null,
    last4,
    closingDate,
    newBalance:
      moneyAfter(lines, String.raw`New\s+Balance(?:\s+as\s+of\s+\d{1,2}\/\d{1,2}\/\d{2,4})?`) ??
      moneyBelow(lines, String.raw`New\s+Balance`),
    minimumPayment:
      moneyAfter(lines, String.raw`(?:Total\s+)?Minimum\s+Payment\s+Due`) ??
      moneyBelow(lines, String.raw`(?:Total\s+)?Minimum\s+Payment\s+Due`),
    dueDate: dateAfter(lines, String.raw`Payment\s+Due\s+Date`),
    creditLimit: moneyAfter(
      lines,
      String.raw`(?:Credit\s+Limit|Credit\s+Line)(?!\s+Available)`,
      /(advance|cash|over)\s*$/i,
    ),
    purchaseApr,
    promotions: parsePromotions(lines, purchaseApr),
  };
}

const NUM_DATE = String.raw`(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))`;
const AMOUNT = String.raw`\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})`;
const cents = (raw: string) => decimalToCents(raw.replace(/,/g, ''));

/**
 * Promotions in two layouts: the "Deferred Interest Calculation" table (PayPal and other
 * Synchrony cards: posting date, APR, expiration, monthly and total accrued interest, balance)
 * and Synchrony's "Promotional Purchase Summary" (expiration, balance, deferred interest,
 * purchase date, original amount).
 */
export function parsePromotions(lines: string[], purchaseApr: number | null): FoundPromotion[] {
  const found: FoundPromotion[] = [];
  const calc = new RegExp(
    String.raw`No Interest If Paid In(?: Full)?\s+${NUM_DATE}\s+(\d{1,2}(?:\.\d{1,3})?)\s*%\s*(?:\(v\))?\s*${NUM_DATE}\*?\s*${AMOUNT}\s*\|?\s*${AMOUNT}\s*\|?\s*${AMOUNT}`,
    'i',
  );
  for (const line of lines) {
    const m = calc.exec(line);
    const start = m && statementDate(m[1]);
    const end = m && statementDate(m[3]);
    if (!m || !start || !end) continue;
    found.push({
      description: 'No interest if paid in full',
      kind: 'deferred',
      originalAmount: null,
      balance: cents(m[6]),
      startDate: start,
      endDate: end,
      aprAfter: Number(m[2]),
      accruedInterest: cents(m[5]),
    });
  }
  const summary = lines.findIndex((l) => /^Promotional Purchase Summary/i.test(l.trim()));
  if (summary >= 0) {
    const row = new RegExp(
      String.raw`^${NUM_DATE}\s*\|\s*${AMOUNT}\s*\|\s*${AMOUNT}\s+${NUM_DATE}(?:\s+([^|$]*?))?\s*\|\s*${AMOUNT}`,
    );
    let kind: FoundPromotion['kind'] = 'deferred';
    let label = '';
    for (const line of lines.slice(summary + 1, summary + 40)) {
      if (/^(Transaction Summary|Total Fees)/i.test(line.trim())) break;
      if (/deferred interest|no interest if paid/i.test(line)) {
        kind = 'deferred';
        label = 'No interest if paid in full';
      } else if (/reduced apr|fixed apr|0(\.0+)?% apr|low apr/i.test(line)) {
        kind = 'zero';
        label = line.trim().slice(0, 100);
      }
      const m = row.exec(line.trim());
      const end = m && statementDate(m[1]);
      if (!m || !end) continue;
      found.push({
        description: (m[5]?.trim() || label || 'Promotional purchase').slice(0, 100),
        kind,
        originalAmount: cents(m[6]),
        balance: cents(m[2]),
        startDate: statementDate(m[4]),
        endDate: end,
        aprAfter: purchaseApr,
        accruedInterest: kind === 'deferred' ? cents(m[3]) : null,
      });
    }
  }
  return found;
}

/** True when enough was found to be worth showing; otherwise the PDF is likely unsupported. */
export const looksLikeStatement = (s: StatementSummary) =>
  [s.newBalance, s.minimumPayment, s.dueDate, s.creditLimit, s.purchaseApr].filter(
    (v) => v !== null,
  ).length >= 2;

/**
 * Applies statement details to a card account. The statement's new balance becomes the
 * account balance (the one balance shown everywhere), dated by the statement's closing date,
 * and is also kept as the statement balance; fields the statement did not show are left
 * unchanged. A statement older than the account's current balance changes nothing that is
 * already known: it only fills in missing details.
 */
export function applyStatement(account: Account, s: StatementSummary, asOf = today()): Account {
  const older = olderThanBalance(account, s.closingDate);
  const pick = <T>(value: T | null, previous: T | null | undefined): T | null =>
    older ? (previous ?? value) : (value ?? previous ?? null);
  const c = account.credit;
  const setBalance = !older && s.newBalance !== null;
  return {
    ...account,
    ...(setBalance
      ? {
          balance: s.newBalance!,
          balanceDate: s.closingDate ?? asOf,
          balanceSource: 'pdf' as const,
        }
      : {}),
    mask: account.mask ?? s.last4 ?? undefined,
    ...(s.promotions?.length
      ? {
          promotions: mergePromotions(
            account.promotions ?? [],
            s.promotions,
            s.closingDate ?? asOf,
            () => globalThis.crypto.randomUUID(),
          ),
        }
      : {}),
    credit: {
      ...c,
      limit: pick(s.creditLimit, c?.limit),
      statementBalance: pick(s.newBalance, c?.statementBalance),
      minimumPayment: pick(s.minimumPayment, c?.minimumPayment),
      dueDate: pick(s.dueDate, c?.dueDate),
      apr: pick(s.purchaseApr, c?.apr),
      statementDate: pick(s.closingDate, c?.statementDate),
    },
  };
}
