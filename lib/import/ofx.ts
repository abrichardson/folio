import { dateSchema } from '../finance';
import { cleanText, decimalToCents } from './common';

// Reads OFX files, including Quicken QFX and QuickBooks QBO downloads (both are OFX).
// OFX 1.x is SGML, where value elements have no closing tags; OFX 2.x is XML. Both are
// handled by one small tolerant parser that knows which elements contain other elements.

export type OfxTransaction = {
  fitId: string;
  type: string;
  date: string;
  amount: number;
  name: string;
  memo: string;
  checkNumber: string;
};

export type OfxStatement = {
  kind: 'bank' | 'creditcard';
  bankId: string;
  accountNumber: string;
  /** OFX ACCTTYPE: CHECKING, SAVINGS, MONEYMRKT, CREDITLINE, CD; CREDITCARD for cards. */
  accountType: string;
  currency: string;
  /** Statement (ledger) balance in cents, as the bank reports it. */
  balance: number | null;
  balanceDate: string | null;
  transactions: OfxTransaction[];
};

export type OfxFile = {
  institution: string;
  statements: OfxStatement[];
  /** Problems that skipped part of the file, in plain language. */
  warnings: string[];
};

type OfxNode = { name: string; value?: string; children: OfxNode[] };

const AGGREGATES = new Set([
  'OFX',
  'SIGNONMSGSRSV1',
  'SONRS',
  'STATUS',
  'FI',
  'BANKMSGSRSV1',
  'STMTTRNRS',
  'STMTRS',
  'BANKACCTFROM',
  'BANKACCTTO',
  'BANKTRANLIST',
  'STMTTRN',
  'PAYEE',
  'LEDGERBAL',
  'AVAILBAL',
  'BALLIST',
  'BAL',
  'CURRENCY',
  'ORIGCURRENCY',
  'CREDITCARDMSGSRSV1',
  'CCSTMTTRNRS',
  'CCSTMTRS',
  'CCACCTFROM',
  'CCACCTTO',
  'INVSTMTMSGSRSV1',
  'INVSTMTTRNRS',
  'INVSTMTRS',
  'INVACCTFROM',
  'INVTRANLIST',
  'INVPOSLIST',
  'INVBAL',
  'INVBANKTRAN',
  'SECLISTMSGSRSV1',
  'SECLIST',
]);

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

function parseTree(text: string): OfxNode {
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new Error('This is not an OFX, QFX, or QBO file.');
  const root: OfxNode = { name: '#root', children: [] };
  const stack: OfxNode[] = [root];
  const tag = /<(\/?)([A-Za-z0-9.]+)[^>]*>([^<]*)/g;
  tag.lastIndex = start;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const [, closing, rawName, rawText] = m;
    const name = rawName.toUpperCase();
    if (closing) {
      // Close the nearest open element with this name; SGML value elements were never opened.
      const index = stack.map((n) => n.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
      continue;
    }
    const value = decodeEntities(rawText).trim();
    const parent = stack[stack.length - 1];
    if (AGGREGATES.has(name)) {
      const node: OfxNode = { name, children: [] };
      parent.children.push(node);
      stack.push(node);
    } else {
      parent.children.push({ name, value, children: [] });
    }
  }
  return root;
}

const child = (node: OfxNode | undefined, name: string) =>
  node?.children.find((c) => c.name === name);
const value = (node: OfxNode | undefined, name: string) => child(node, name)?.value ?? '';
function findAll(node: OfxNode, name: string, out: OfxNode[] = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

/** OFX dates are YYYYMMDD with an optional time and zone; Folio keeps the calendar date. */
export function ofxDate(raw: string) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return dateSchema.safeParse(date).success ? date : null;
}

/** OFX amounts; tolerates the thousands separators some banks add despite the spec. */
const ofxAmount = (raw: string) => decimalToCents(raw.replace(/,(?=\d{3}(\D|$))/g, ''));

const typeLabels: Record<string, string> = {
  CHECKING: 'Checking',
  SAVINGS: 'Savings',
  MONEYMRKT: 'Money market',
  CREDITLINE: 'Line of credit',
  CD: 'CD',
  CREDITCARD: 'Credit card',
};
export const ofxTypeLabel = (type: string) => typeLabels[type] ?? 'Account';

function readStatement(node: OfxNode, kind: OfxStatement['kind'], warnings: string[]) {
  const from = child(node, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM');
  const accountNumber = value(from, 'ACCTID');
  const accountType = kind === 'bank' ? value(from, 'ACCTTYPE').toUpperCase() : 'CREDITCARD';
  const label = `${ofxTypeLabel(accountType)} ending ${accountNumber.slice(-4) || '????'}`;
  const currency = (value(node, 'CURDEF') || 'USD').toUpperCase();
  if (currency !== 'USD') {
    warnings.push(`${label} is in ${currency}; Folio only supports US dollars, so it was skipped.`);
    return null;
  }
  const ledger = child(node, 'LEDGERBAL');
  let balance: number | null = null;
  try {
    balance = ledger && value(ledger, 'BALAMT') ? ofxAmount(value(ledger, 'BALAMT')) : null;
  } catch {
    warnings.push(`${label}: the statement balance could not be read.`);
  }
  const transactions: OfxTransaction[] = [];
  let unreadable = 0;
  for (const t of findAll(child(node, 'BANKTRANLIST') ?? node, 'STMTTRN')) {
    const date = ofxDate(value(t, 'DTPOSTED')) ?? ofxDate(value(t, 'DTUSER'));
    let amount: number | null = null;
    try {
      amount = ofxAmount(value(t, 'TRNAMT'));
    } catch {
      amount = null;
    }
    if (!date || amount === null) {
      unreadable++;
      continue;
    }
    const type = value(t, 'TRNTYPE').toUpperCase();
    const name = cleanText(value(t, 'NAME') || value(child(t, 'PAYEE'), 'NAME'));
    transactions.push({
      fitId: value(t, 'FITID'),
      type,
      date,
      amount,
      name,
      memo: cleanText(value(t, 'MEMO'), 500),
      checkNumber: value(t, 'CHECKNUM'),
    });
  }
  if (unreadable)
    warnings.push(`${label}: ${unreadable} transaction(s) had an unreadable date or amount.`);
  const statement: OfxStatement = {
    kind,
    bankId: value(from, 'BANKID'),
    accountNumber,
    accountType,
    currency,
    balance,
    balanceDate: ledger ? ofxDate(value(ledger, 'DTASOF')) : null,
    transactions,
  };
  return statement;
}

export function parseOFX(text: string): OfxFile {
  const root = parseTree(text);
  const warnings: string[] = [];
  const statements: OfxStatement[] = [];
  for (const s of findAll(root, 'STMTRS')) {
    const statement = readStatement(s, 'bank', warnings);
    if (statement) statements.push(statement);
  }
  for (const s of findAll(root, 'CCSTMTRS')) {
    const statement = readStatement(s, 'creditcard', warnings);
    if (statement) statements.push(statement);
  }
  const investments = findAll(root, 'INVSTMTRS').length;
  if (investments)
    warnings.push(
      `${investments} investment account statement(s) were skipped; investment imports are not supported yet.`,
    );
  const fi = findAll(root, 'FI')[0];
  const signonError = findAll(root, 'SONRS')
    .map((s) => value(child(s, 'STATUS'), 'CODE'))
    .find((code) => code && code !== '0');
  if (!statements.length && signonError)
    throw new Error('The bank reported an error in this file instead of a statement.');
  if (!statements.length && !investments)
    throw new Error('No bank or credit card statements were found in this file.');
  return { institution: cleanText(value(fi, 'ORG')), statements, warnings };
}
