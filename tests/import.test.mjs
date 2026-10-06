import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/import/common.ts'; export * from './lib/import/ofx.ts'; export * from './lib/import/csv.ts'; export * from './lib/import/statement.ts'; export * from './lib/import/pdf-lines.ts'; export { parseCSV } from './lib/finance.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/import.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/import.mjs');

// --- Exact cents ---
assert.equal(m.decimalToCents('12.34'), 1234);
assert.equal(m.decimalToCents('-0.5'), -50);
assert.equal(m.decimalToCents('+7'), 700);
assert.equal(m.decimalToCents('19,99'), 1999);
assert.equal(m.decimalToCents('0.105'), 11);
assert.equal(m.decimalToCents('-0.105'), -11);
assert.equal(m.decimalToCents('1234567.89'), 123456789);
assert.equal(m.decimalToCents('.07'), 7);
assert.throws(() => m.decimalToCents('12a'));
assert.throws(() => m.decimalToCents(''));

// --- OFX 1.x SGML with a checking account and a credit card in one file (fictional) ---
const sgml = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261002120000<LANGUAGE>ENG<FI><ORG>Example Credit Union<FID>9999</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>000000000<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903120000[-5:EST]<TRNAMT>-42.10<FITID>CHK-1001<NAME>CORNER GROCERY &amp; DELI<MEMO>POS PURCHASE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260915<TRNAMT>2500.00<FITID>CHK-1002<NAME>EXAMPLE EMPLOYER PAYROLL</STMTTRN>
<STMTTRN><TRNTYPE>XFER<DTPOSTED>20260916<TRNAMT>-300.00<FITID>CHK-1003<NAME>ONLINE TRANSFER TO SAVINGS</STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT<DTPOSTED>20260920<TRNAMT>-612.45<FITID>CHK-1004<NAME>EXAMPLE BANK CRD AUTOPAY</STMTTRN>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260921<TRNAMT>-80.00<FITID>CHK-1005<CHECKNUM>1042<PAYEE><NAME>FICTIONAL LANDSCAPING</PAYEE></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>bad-date<TRNAMT>-1.00<FITID>CHK-1006<NAME>BROKEN ROW</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3,210.55<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>2<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>4000000000004321</CCACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260905<TRNAMT>-19.99<FITID>CC-1<NAME>STREAMING SERVICE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260920<TRNAMT>612.45<FITID>CC-2<NAME>PAYMENT THANK YOU</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260922<TRNAMT>25.00<FITID>CC-3<NAME>RETURN - SHOE STORE</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-1234.56<DTASOF>20260930120000</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;
const ofx = m.parseOFX(sgml);
assert.equal(ofx.institution, 'Example Credit Union');
assert.equal(ofx.statements.length, 2);
const [checking, card] = ofx.statements;
assert.equal(checking.kind, 'bank');
assert.equal(checking.accountType, 'CHECKING');
assert.equal(checking.accountNumber, '000123456789');
assert.equal(checking.balance, 321055);
assert.equal(checking.balanceDate, '2026-09-30');
assert.equal(checking.transactions.length, 5);
assert.deepEqual(checking.transactions[0], {
  fitId: 'CHK-1001',
  type: 'DEBIT',
  date: '2026-09-03',
  amount: -4210,
  name: 'CORNER GROCERY & DELI',
  memo: 'POS PURCHASE',
  checkNumber: '',
});
assert.equal(checking.transactions[4].name, 'FICTIONAL LANDSCAPING');
assert.equal(checking.transactions[4].checkNumber, '1042');
assert.ok(ofx.warnings.some((w) => /1 transaction\(s\) had an unreadable/.test(w)));
assert.equal(card.kind, 'creditcard');
assert.equal(card.accountType, 'CREDITCARD');
assert.equal(card.balance, -123456);
assert.equal(card.balanceDate, '2026-09-30');
assert.deepEqual(
  card.transactions.map((t) => [t.fitId, t.amount]),
  [
    ['CC-1', -1999],
    ['CC-2', 61245],
    ['CC-3', 2500],
  ],
);

// --- OFX 2.x XML (QFX style with Intuit tags), entities, and investment statements ---
const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><FI><ORG>Fictional Savings Bank</ORG></FI><INTU.BID>00000</INTU.BID></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>
<BANKACCTFROM><BANKID>111111111</BANKID><ACCTID>555500001111</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>INT</TRNTYPE><DTPOSTED>20260930000000.000[0:GMT]</DTPOSTED><TRNAMT>3.21</TRNAMT><FITID>SAV-1</FITID><NAME>INTEREST PAID</NAME><MEMO></MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260916</DTPOSTED><TRNAMT>300.00</TRNAMT><FITID>SAV-2</FITID><NAME>TRANSFER FROM CHECKING &#38; MORE</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>10303.21</BALAMT><DTASOF>20260930</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1>
<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD</CURDEF></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>
</OFX>`;
const xmlFile = m.parseOFX(xml);
assert.equal(xmlFile.institution, 'Fictional Savings Bank');
assert.equal(xmlFile.statements.length, 1);
assert.equal(xmlFile.statements[0].accountType, 'SAVINGS');
assert.equal(xmlFile.statements[0].transactions[0].date, '2026-09-30');
assert.equal(xmlFile.statements[0].transactions[0].memo, '');
assert.equal(xmlFile.statements[0].transactions[1].name, 'TRANSFER FROM CHECKING & MORE');
assert.ok(xmlFile.warnings.some((w) => /investment/.test(w)));

// Non-USD statements are skipped with a warning; non-OFX files and empty files are refused.
const cad = sgml.replace('<CURDEF>USD\n<BANKACCTFROM>', '<CURDEF>CAD\n<BANKACCTFROM>');
const cadFile = m.parseOFX(cad);
assert.equal(cadFile.statements.length, 1);
assert.ok(cadFile.warnings.some((w) => /CAD/.test(w)));
assert.throws(() => m.parseOFX('date,merchant,amount\n'), /not an OFX/);
assert.throws(() => m.parseOFX('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>'), /No bank/);

// Windows-1252 files decode accented names correctly.
const bytes = new Uint8Array([
  ...Buffer.from('CHARSET:1252\n<OFX><NAME>CAF'),
  0xc9,
  ...Buffer.from('</OFX>'),
]);
assert.ok(m.decodeBankFile(bytes).includes('CAFÉ'));
assert.equal(m.decodeBankFile(new TextEncoder().encode('﻿date')), 'date');

// --- Categories: transfers and card payments must not count as spending or income ---
const cat = (merchant, amount, extra = {}) => m.suggestCategory({ merchant, amount, ...extra });
assert.equal(cat('EXAMPLE BANK CRD AUTOPAY', -61245), 'Transfer');
assert.equal(cat('PAYMENT TO CREDIT CARD 4321', -100), 'Transfer');
assert.equal(cat('ONLINE TRANSFER TO SAVINGS', -30000), 'Transfer');
assert.equal(cat('ANYTHING', -1, { ofxType: 'XFER' }), 'Transfer');
assert.equal(cat('PAYMENT THANK YOU', 61245, { accountType: 'Credit card' }), 'Transfer');
assert.equal(cat('RETURN - SHOE STORE', 2500, { accountType: 'Credit card' }), 'Other');
assert.equal(cat('EXAMPLE EMPLOYER PAYROLL', 250000), 'Income');
assert.equal(cat('STREAMING SERVICE', -1999), 'Other');
assert.equal(cat('BURGER PLACE', -1200, { bankCategory: 'Food & Drink' }), 'Dining');
assert.equal(cat('MARKET', -1200, { bankCategory: 'groceries' }), 'Groceries');
assert.equal(cat('GAS STATION', -4000, { bankCategory: 'Gas' }), 'Transport');
assert.equal(cat('REFUND', 500, { bankCategory: 'Shopping' }), 'Shopping');
assert.equal(cat('ODD', -500, { bankCategory: 'Unknown thing' }), 'Other');

// --- Duplicates ---
const existing = [
  {
    id: 'a',
    date: '2026-09-03',
    merchant: 'Coffee',
    amount: -500,
    accountId: 'acct',
    category: 'Dining',
    notes: '',
  },
  {
    id: 'b',
    date: '2026-09-04',
    merchant: 'Imported',
    amount: -100,
    accountId: 'acct',
    category: 'Other',
    notes: '',
    importId: 'ofx:X1',
  },
  {
    id: 'c',
    date: '2026-09-03',
    merchant: 'Coffee',
    amount: -500,
    accountId: 'other',
    category: 'Dining',
    notes: '',
  },
];
const row = (merchant, amount, importId, date = '2026-09-03') => ({
  date,
  merchant,
  amount,
  notes: '',
  category: 'Other',
  importId,
});
let r = m.withoutDuplicates(
  existing,
  [row('coffee', -500), row('Coffee', -500), row('Tea', -300)],
  'acct',
);
assert.equal(r.duplicates, 1, 'one existing coffee matches one incoming coffee');
assert.deepEqual(
  r.fresh.map((t) => t.merchant),
  ['Coffee', 'Tea'],
  'a second identical purchase still imports',
);
r = m.withoutDuplicates(
  existing,
  [
    row('Renamed', -100, 'ofx:X1', '2026-09-04'),
    row('New', -1, 'ofx:X2'),
    row('New', -1, 'ofx:X2'),
  ],
  'acct',
);
assert.equal(r.duplicates, 2);
assert.deepEqual(
  r.fresh.map((t) => t.importId),
  ['ofx:X2'],
);
r = m.withoutDuplicates(existing, [row('Coffee', -500, 'ofx:X3')], 'acct');
assert.equal(r.duplicates, 1, 'a bank-file row matching a hand-entered row is a duplicate');
r = m.withoutDuplicates(existing, [row('Imported', -100, undefined, '2026-09-04')], 'acct');
assert.equal(r.duplicates, 1, 'a CSV row matching an OFX-imported row is a duplicate');

const keyA = await m.accountImportKey('000000000', '000123456789');
assert.equal(keyA, await m.accountImportKey(' 000000000', '000123456789 '));
assert.notEqual(keyA, await m.accountImportKey('000000000', '000123456780'));
assert.ok(!keyA.includes('123456789'));

// --- CSV: column detection, dates, amounts ---
assert.deepEqual(
  m.detectMapping([
    'Transaction Date',
    'Post Date',
    'Description',
    'Category',
    'Type',
    'Amount',
    'Memo',
  ]),
  {
    date: 0,
    dateFallback: 1,
    description: 2,
    amount: 5,
    debit: -1,
    credit: -1,
    category: 3,
    notes: 6,
    type: 4,
  },
);
assert.deepEqual(m.detectMapping(['﻿Date', 'Description', 'Withdrawals', 'Deposits', 'Balance']), {
  date: 0,
  description: 1,
  amount: -1,
  debit: 2,
  credit: 3,
  category: -1,
  notes: -1,
  dateFallback: -1,
  type: -1,
});
assert.equal(m.detectDateFormat(['09/03/2026', '12/31/2026']), 'mdy');
assert.equal(m.detectDateFormat(['03/09/2026', '31/12/2026']), 'dmy');
assert.equal(m.detectDateFormat(['2026-09-03']), 'ymd');
assert.equal(m.parseDate('9/3/26', 'mdy'), '2026-09-03');
assert.equal(m.parseDate('03.09.2026', 'dmy'), '2026-09-03');
assert.equal(m.parseDate('2026-09-03 14:22:01', 'ymd'), '2026-09-03');
assert.equal(m.parseDate('2026-02-30', 'ymd'), null);
assert.equal(m.parseDate('13/01/2026', 'mdy'), null);
assert.equal(m.parseAmount('-1,234.56'), -123456);
assert.equal(m.parseAmount('$12.00'), 1200);
assert.equal(m.parseAmount('(45.10)'), -4510);
assert.equal(m.parseAmount('45.10-'), -4510);
assert.equal(m.parseAmount('12.00 CR'), 1200);
assert.equal(m.parseAmount('12.00 DR'), -1200);
assert.equal(m.parseAmount('12,50'), 1250);
assert.equal(m.parseAmount(''), null);
assert.equal(m.parseAmount('abc'), null);

// A card export with negative purchases and bank categories.
const chase = m.parseCSV(
  'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n09/03/2026,09/04/2026,BURGER PLACE,Food & Drink,Sale,-12.40,\n09/20/2026,09/20/2026,Payment Thank You-Mobile,,Payment,612.45,\n',
);
const chaseMap = m.detectMapping(chase.shift());
let csv = m.readCsvRows(chase, {
  mapping: chaseMap,
  dateFormat: 'mdy',
  purchasesPositive: false,
  accountType: 'Credit card',
});
assert.deepEqual(csv.errors, []);
assert.deepEqual(
  csv.transactions.map((t) => [t.date, t.merchant, t.amount, t.category]),
  [
    ['2026-09-03', 'BURGER PLACE', -1240, 'Dining'],
    ['2026-09-20', 'Payment Thank You-Mobile', 61245, 'Transfer'],
  ],
);

// A card export with positive purchases, flipped by the user's choice.
const amex = m.parseCSV(
  'Date,Description,Amount\n09/05/2026,HARDWARE STORE,54.20\n09/20/2026,AUTOPAY PAYMENT - THANK YOU,-200.00\n',
);
csv = m.readCsvRows(amex.slice(1), {
  mapping: m.detectMapping(amex[0]),
  dateFormat: 'mdy',
  purchasesPositive: true,
  accountType: 'Credit card',
});
assert.deepEqual(
  csv.transactions.map((t) => [t.amount, t.category]),
  [
    [-5420, 'Other'],
    [20000, 'Transfer'],
  ],
);

// A bank export with separate withdrawal and deposit columns, and bad rows reported.
const bank = m.parseCSV(
  'Date,Description,Withdrawals,Deposits,Balance\n09/03/2026,CORNER GROCERY,42.10,,958.00\n09/15/2026,PAYROLL,,"2,500.00",3458.00\n09/16/2026,NO AMOUNT,,,0\nnot a date,X,1.00,,0\n09/17/2026,,1.00,,0\n',
);
csv = m.readCsvRows(bank.slice(1), {
  mapping: m.detectMapping(bank[0]),
  dateFormat: 'mdy',
  purchasesPositive: false,
  accountType: 'Checking',
});
assert.deepEqual(
  csv.transactions.map((t) => [t.merchant, t.amount, t.category]),
  [
    ['CORNER GROCERY', -4210, 'Other'],
    ['PAYROLL', 250000, 'Income'],
  ],
);
assert.equal(csv.errors.length, 3);
assert.match(csv.errors[0], /Row 4: the amount/);
assert.match(csv.errors[1], /Row 5: the date/);
assert.match(csv.errors[2], /Row 6: the description/);

// Truist-style export (fictional): "Transaction Date" is "null", so the posted date is used;
// a Debit/Credit column and parenthesized amounts give the direction.
const truist = m.parseCSV(
  'Posted Date,Transaction Date,Transaction Type,Check/Serial #,Description,Amount\n09/02/2026,null,Debit,,MAINTENANCE FEE,($12.00)\n09/05/2026,null,Credit,,DEPOSIT,$250.00\n09/06/2026,null,Debit,1042,CHECK,$80.00\n',
);
const truistMap = m.detectMapping(truist[0]);
assert.equal(truistMap.date, 1, 'Transaction Date is preferred when it has values');
assert.equal(truistMap.dateFallback, 0);
assert.equal(truistMap.type, 2);
csv = m.readCsvRows(truist.slice(1), {
  mapping: truistMap,
  dateFormat: 'mdy',
  purchasesPositive: false,
  accountType: 'Checking',
});
assert.deepEqual(csv.errors, []);
assert.deepEqual(
  csv.transactions.map((t) => [t.date, t.merchant, t.amount]),
  [
    ['2026-09-02', 'MAINTENANCE FEE', -1200],
    ['2026-09-05', 'DEPOSIT', 25000],
    ['2026-09-06', 'CHECK', -8000],
  ],
  'unsigned debit amounts become money out',
);
csv = m.readCsvRows(truist.slice(1), {
  mapping: truistMap,
  dateFormat: 'mdy',
  purchasesPositive: true,
  accountType: 'Checking',
});
assert.deepEqual(
  csv.transactions.map((t) => t.amount),
  [-1200, 25000, -8000],
  'Debit/Credit wins over the purchases switch',
);
// Without a fallback column, a "null" date is reported as empty rather than as "null".
csv = m.readCsvRows(truist.slice(1, 2), {
  mapping: { ...truistMap, dateFallback: -1 },
  dateFormat: 'mdy',
  purchasesPositive: false,
});
assert.deepEqual(csv.errors, ['Row 2: the date is empty.']);

assert.equal(m.accountDigitsFromFileName('acct_7201_08_03_2026_to_10_02_2026.csv'), '7201');
assert.equal(m.accountDigitsFromFileName('Chase1234_Activity_20260930.CSV'), '');
assert.equal(m.accountDigitsFromFileName('Checking...5678.csv'), '5678');
assert.equal(m.accountDigitsFromFileName('statement.csv'), '');

// --- Card exports: detect "purchases are positive" (fictional rows) ---
const discover = m.parseCSV(
  'Trans. Date,Post Date,Description,Amount,Category\n01/12/2026,01/12/2026,"SANDWICH SHOP",15.29,"Restaurants"\n01/13/2026,01/13/2026,"FUEL STOP",7.04,"Gasoline"\n02/08/2026,02/08/2026,"INTERNET PAYMENT - THANK YOU",-100.00,"Payments and Credits"\n02/10/2026,02/10/2026,"INTEREST CHARGE ON PURCHASES",8.22,"Interest"\n',
);
const discoverMap = m.detectMapping(discover[0]);
assert.equal(discoverMap.date, 0, '"Trans. Date" is the date');
assert.equal(m.detectPurchasesPositive(discover.slice(1), discoverMap), true);
csv = m.readCsvRows(discover.slice(1), {
  mapping: discoverMap,
  dateFormat: 'mdy',
  purchasesPositive: true,
  accountType: 'Credit card',
});
assert.deepEqual(
  csv.transactions.map((t) => [t.amount, t.category]),
  [
    [-1529, 'Dining'],
    [-704, 'Transport'],
    [10000, 'Transfer'],
    [-822, 'Interest & fees'],
  ],
);
assert.equal(
  m.detectPurchasesPositive(chase, chaseMap),
  false,
  'Chase lists purchases as negative',
);
assert.equal(
  m.detectPurchasesPositive(truist.slice(1), truistMap),
  false,
  'Debit/Credit columns decide',
);
assert.equal(
  m.detectPurchasesPositive(amex.slice(1, 2), m.detectMapping(amex[0])),
  false,
  'no payment rows means no evidence',
);

// --- PDF text lines: fragments on one baseline join; far-apart columns are marked ---
assert.deepEqual(
  m.linesFromFragments([
    { str: 'New Balance', x: 300, y: 700, width: 50 },
    { str: 'Credit Line', x: 40, y: 700.8, width: 45 },
    { str: '$1,800', x: 90, y: 700, width: 20 },
    { str: '$1,247.35', x: 352, y: 700.4, width: 30 },
    { str: 'DISCOVER CARD ENDING IN 4321', x: 40, y: 760, width: 150 },
    { str: '   ', x: 10, y: 600, width: 5 },
  ]),
  ['DISCOVER CARD ENDING IN 4321', 'Credit Line $1,800 | New Balance $1,247.35'],
);

// --- Statement summaries in three fictional layouts ---
const discoverStatement = m.parseStatementText([
  'DISCOVER IT CHROME CARD ENDING IN 4321',
  'Account Summary 07/14/2026 - 08/13/2026  |  Payment Information',
  'Previous Balance  |  $1,150.00 New Balance Minimum Payment Payment Due Date',
  'Purchases  |  +$62.40',
  'New Balance:  |  $1,247.35',
  'Credit Line  |  $1,800',
  'Credit Line Available  |  $552',
  'Cash Advance Credit Line  |  $400',
  'Payment Coupon  |  ACCOUNT NUMBER ENDING IN 4321',
  'Minimum Payment Due  |  38.00',
  'Payment Due Date  |  09/09/2026',
  'must pay at least the Minimum Payment Due by the Payment Due Date. Send only your',
  'Purchases  |  21.74% V  |  N/A  |  $1,180.00  |  $21.37',
  'Cash Advances  |  28.24% V  |  N/A  |  $0.00  |  $0.00',
]);
assert.deepEqual(discoverStatement, {
  issuer: 'Discover',
  last4: '4321',
  closingDate: '2026-08-13',
  newBalance: 124735,
  minimumPayment: 3800,
  dueDate: '2026-09-09',
  creditLimit: 180000,
  purchaseApr: 21.74,
  promotions: [],
});
const storeCard = m.parseStatementText([
  'Account Number :  |  xxxx xxxx xxxx 2222',
  'Statement Closing Date: 08/24/2026',
  'Previous Balance  |  $612.00  |  New Balance  |  $1,234.56',
  '+  |  New Purchases  |  $9.99  |  Total Minimum Payment Due  |  $45.00',
  '-  |  Payments  |  $120.00  |  Payment Due Date  |  09/20/2026',
  'Credit Limit  |  $2,500.00',
  'Available Credit  |  $1,265.44',
  'may be increased up to the Penalty APR of 29.990%.',
  'Purchases  |  NA  |  31.99%  |  $1,100.00  |  $28.10',
  'Synchrony Bank',
]);
assert.equal(storeCard.issuer, 'Synchrony');
assert.equal(storeCard.last4, '2222');
assert.equal(storeCard.closingDate, '2026-08-24');
assert.equal(storeCard.newBalance, 123456);
assert.equal(storeCard.minimumPayment, 4500);
assert.equal(storeCard.dueDate, '2026-09-20');
assert.equal(storeCard.creditLimit, 250000);
assert.equal(storeCard.purchaseApr, 31.99, 'the penalty APR in the warning text is ignored');
const promoCard = m.parseStatementText([
  'Account Number ending in 3333',
  'New Balance:  |  $480.12',
  'Total Minimum Payment Due:  |  $29.00',
  'Payment Due Date:  |  10/18/2026',
  'Previous Balance as of 08/26/2026  |  $500.00  |  Credit Limit  |  $500',
  'New Balance as of 09/25/2026  |  $480.12',
  'Purchases  |  N/A  |  0.00%  |  $0.00  |  $0.00  |  6M',
]);
assert.equal(promoCard.last4, '3333');
assert.equal(promoCard.closingDate, '2026-09-25');
assert.equal(promoCard.purchaseApr, 0);
assert.equal(promoCard.creditLimit, 50000);
assert.equal(m.looksLikeStatement(promoCard), true);
const notStatement = m.parseStatementText(['Monthly newsletter', 'Purchases are up 5% this year']);
assert.equal(notStatement.purchaseApr, null);
assert.equal(m.looksLikeStatement(notStatement), false);
assert.equal(m.statementDate('2/30/2026'), null);
assert.equal(m.statementDate('9/7/26'), '2026-09-07');

// Applying a statement: its balance becomes the account balance; missing fields are kept.
const statementCard = {
  id: 'card',
  name: 'Fictional Card',
  institution: 'Example',
  type: 'Credit card',
  balance: 100,
  credit: { limit: 99900, apr: 19.99, autopay: true, paidDueDates: ['2026-09-07'] },
};
const updated = m.applyStatement(statementCard, { ...discoverStatement, purchaseApr: null });
assert.equal(updated.balance, 124735);
assert.equal(updated.mask, '4321');
assert.deepEqual(updated.credit, {
  limit: 180000,
  apr: 19.99,
  autopay: true,
  paidDueDates: ['2026-09-07'],
  statementBalance: 124735,
  minimumPayment: 3800,
  dueDate: '2026-09-09',
  statementDate: '2026-08-13',
});
assert.equal(
  m.applyStatement({ ...statementCard, mask: '9999' }, discoverStatement).mask,
  '9999',
  'an existing mask is kept',
);

// --- More layouts (fictional values): dates as words, values under header rows ---
const ventureLike = m.parseStatementText([
  'Example Rewards Card | World Elite Mastercard ending in 5150',
  'Jul 14, 2026 - Aug 13, 2026 | 31 days in Billing Cycle',
  'Payment Information | Account Summary',
  'Payment Due Date | For online and phone payments, the Previous Balance | $812.40',
  'Sep 8, 2026 | on the statement closing date when Payments | - $300.00',
  'Upcoming statement closing date: Sep 13, 2026',
  'New Balance | Minimum Payment Due',
  'Fees Charged | + $0.00',
  '$1,045.18 | $35.00',
  'Credit Limit | $2,750.00',
  'Cash Advance Credit Limit | $800.00',
  'Available Credit (as of Aug 13, 2026) | $1,704.82',
  'New Balance | = $1,045.18',
  'Payment Due Date: Sep 8, 2026 | Account ending in 5150',
  'Type of Balance | Annual Percentage Rate (APR) | Balance Subject to Interest Rate | Interest Charged',
  'Purchases | 27.24% P | $990.12 | $21.80',
  'Cash Advances | 29.99% P | $0.00 | $0.00',
]);
assert.deepEqual(ventureLike, {
  issuer: null,
  last4: '5150',
  closingDate: '2026-08-13',
  newBalance: 104518,
  minimumPayment: 3500,
  dueDate: '2026-09-08',
  creditLimit: 275000,
  purchaseApr: 27.24,
  promotions: [],
});
// Header-row values on the payment coupon only.
assert.equal(
  m.parseStatementText([
    'New Balance | Minimum Payment Due Amount Enclosed | Example Bank',
    '$612.00 | $40.00 | $ ________ | Anytown ST 00000',
  ]).minimumPayment,
  4000,
);
const standardPurchases = m.parseStatementText([
  'New Balance | $401.77',
  'Minimum Payment Due | $27.00',
  'Payment Due Date | 10/06/2026',
  'Purchases & other debits | + 120.50 Cash limit | $300',
  'Credit Limit | $1,500',
  'increased up to the Penalty APR of 29.990%.',
  'Standard Purchases | 30.99% (v) | $0.00 | $8.40 | $380.12',
]);
assert.equal(standardPurchases.purchaseApr, 30.99);
assert.equal(standardPurchases.creditLimit, 150000);
assert.equal(
  m.parseStatementText(['Purchases & Balance Transfers N/A | 24.24% (v) $1,210.00 | $22.01'])
    .purchaseApr,
  24.24,
);
const storeCard2 = m.parseStatementText([
  'New Balance | $233.10',
  'Minimum Payment Due | $35.00',
  'Payment Due Date | October 21, 2026',
  'Credit Limit | $1,200.00',
  'Amount Over Credit Limit | $0.00',
  'Next Statement Closing Date | 10/26/2026',
  'Statement Closing Date | 09/25/2026',
  'Type of Balance | Annual Percentage Rate (APR) Balance Subject to Interest Rate Interest Charge',
  'PURCHASES',
  'REGULAR | 31.24% (M)(V) | $210.00 | $5.39',
]);
assert.deepEqual(
  [storeCard2.dueDate, storeCard2.closingDate, storeCard2.creditLimit, storeCard2.purchaseApr],
  ['2026-10-21', '2026-09-25', 120000, 31.24],
  'the next closing date and the over-limit amount are ignored',
);
assert.equal(
  m.parseStatementText(['PURCHASES', 'Revolving Balance | 26.99% (M) | $55.00 | $1.10'])
    .purchaseApr,
  26.99,
);
assert.equal(m.statementDate('Sept 7, 2026'), '2026-09-07');
assert.equal(m.statementDate('October 21 2026'), '2026-10-21');
assert.equal(m.statementDate('Foo 1, 2026'), null);
assert.equal(m.statementDate('Feb 30, 2026'), null);

console.log(
  'Passed: exact cents, OFX SGML and XML, checking and credit card statements, balances, entities, check payees, unreadable rows, non-USD and investment warnings, Windows-1252, transfer and card-payment categories, counted duplicates, account keys, CSV column detection, date styles, amount styles, debit/credit columns, positive-purchase cards, row errors, Truist null dates with posted-date fallback, Debit/Credit columns, account digits from file names, purchase-sign detection, PDF line grouping, statement summaries in seven layouts (dates as words, header rows, purchase-row variants, Citi headings), applying statements to cards.',
);
