import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/register.ts'; export * from './lib/imports.ts'; export * from './lib/finance.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/register.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/register.mjs');

// All records are fictional.
const tx = (id, date, amount, extra = {}) => ({
  id,
  date,
  merchant: `Fictional ${id}`,
  category: 'Other',
  accountId: 'chk',
  amount,
  notes: '',
  ...extra,
});
const checking = {
  id: 'chk',
  name: 'Fictional Checking',
  institution: 'Example Bank',
  type: 'Checking',
  balance: 113000,
  balanceDate: '2026-09-05',
  openingBalance: { date: '2026-09-01', amount: 100000 },
};
const txs = [
  tx('before', '2026-08-30', -1000),
  tx('rent', '2026-09-02', -5000),
  tx('pay', '2026-09-05', 20000),
  tx('pending', '2026-09-06', -100, { pending: true }),
  tx('grocer', '2026-09-03', -2000),
  tx('other-account', '2026-09-03', -999, { accountId: 'card' }),
];

// --- Running balances, oldest first, from the opening balance ---
assert.deepEqual(
  m.registerRows(checking, txs).map((r) => [r.transaction.id, r.balance]),
  [
    ['before', null],
    ['rent', 95000],
    ['grocer', 93000],
    ['pay', 113000],
    ['pending', 113000],
  ],
  'entries before the opening date have no balance; pending entries do not count',
);
assert.equal(m.balanceOn(checking, txs, '2026-09-03'), 93000);
assert.equal(m.balanceOn(checking, txs, '2026-08-31'), null);
assert.equal(m.bankDifference(checking, txs), 0);
assert.equal(m.bankDifference({ ...checking, balance: 112000 }, txs), 1000);
assert.equal(m.bankDifference({ ...checking, openingBalance: undefined }, txs), null);
assert.equal(m.bankDifference({ ...checking, balanceDate: undefined }, txs), null);

// --- Cards: purchases raise what is owed, payments lower it ---
const card = {
  id: 'card',
  name: 'Fictional Card',
  institution: 'Example',
  type: 'Credit card',
  balance: 0,
  openingBalance: { date: '2026-09-01', amount: 30000 },
};
const cardTx = [
  tx('buy', '2026-09-02', -4210, { accountId: 'card' }),
  tx('payment', '2026-09-04', 10000, { accountId: 'card', category: 'Transfer' }),
];
assert.deepEqual(
  m.registerRows(card, cardTx).map((r) => r.balance),
  [34210, 24210],
);

// --- A suggested opening balance makes the register agree with the bank ---
const suggested = m.suggestedOpening({ ...checking, openingBalance: undefined }, txs);
assert.deepEqual(suggested, { date: '2026-08-30', amount: 101000 });
assert.equal(m.bankDifference({ ...checking, openingBalance: suggested }, txs), 0);
assert.equal(m.suggestedOpening({ ...checking, balanceDate: undefined }, txs), null);
assert.deepEqual(
  m.suggestedOpening({ ...checking, id: 'empty' }, txs),
  { date: '2026-09-05', amount: 113000 },
  'an account without entries opens at its bank balance',
);

// --- Reconciling against a statement ---
const data = { accounts: [checking], transactions: txs.map((t) => ({ ...t })) };
data.transactions[1].status = 'cleared'; // rent
data.transactions[4].status = 'cleared'; // grocer
assert.deepEqual(
  m.reconcilable(checking, data.transactions, '2026-09-05').map((t) => t.id),
  ['rent', 'grocer', 'pay'],
  'excludes entries before the opening date, pending ones, and later ones',
);
const picked = new Set(['rent', 'pay']);
assert.equal(m.clearedBalance(checking, data.transactions, '2026-09-05', picked), 115000);
// Save for later: picked entries are cleared, the unpicked cleared one is unmarked.
const later = m.applyReconciliation(
  data,
  'chk',
  { date: '2026-09-05', balance: 115000 },
  picked,
  false,
  'now',
);
assert.deepEqual(
  later.transactions.map((t) => t.status ?? '-'),
  ['-', 'cleared', 'cleared', '-', '-', '-'],
);
assert.equal(later.accounts[0].lastReconciled, undefined);
assert.equal(data.transactions[4].status, 'cleared', 'the input is not changed');
// Finish: picked entries are reconciled and the statement is recorded.
const done = m.applyReconciliation(
  later,
  'chk',
  { date: '2026-09-05', balance: 115000 },
  picked,
  true,
  '2026-09-07T10:00:00Z',
);
assert.deepEqual(
  done.transactions.map((t) => t.status ?? '-'),
  ['-', 'reconciled', 'reconciled', '-', '-', '-'],
);
assert.deepEqual(done.accounts[0].lastReconciled, {
  date: '2026-09-05',
  balance: 115000,
  at: '2026-09-07T10:00:00Z',
});
assert.deepEqual(
  m.reconcilable(done.accounts[0], done.transactions, '2026-09-30').map((t) => t.id),
  ['grocer'],
);
assert.equal(
  m.clearedBalance(done.accounts[0], done.transactions, '2026-09-30', new Set()),
  115000,
  'reconciled entries always count toward the cleared balance',
);
assert.throws(() =>
  m.applyReconciliation(data, 'missing', { date: '2026-09-05', balance: 0 }, picked, true, 'x'),
);
assert.equal(
  m.stateSchema.safeParse({
    ...m.emptyState(),
    accounts: done.accounts,
    transactions: done.transactions.filter((t) => t.accountId === 'chk'),
  }).success,
  true,
);

// --- Imported rows arrive cleared; Undo keeps rows reconciled since ---
const imported = m.applyImport(
  { ...m.emptyState(), accounts: [checking] },
  {
    fileName: 'fictional.csv',
    format: 'CSV',
    accounts: [
      {
        account: checking,
        created: false,
        transactions: [tx('i1', '2026-09-10', -300), tx('i2', '2026-09-11', -400)],
        duplicates: 0,
        skipped: 0,
        from: '2026-09-10',
        to: '2026-09-11',
        balance: null,
      },
    ],
  },
  'imp',
  'now',
);
assert.deepEqual(
  imported.transactions.map((t) => t.status),
  ['cleared', 'cleared'],
);
imported.transactions[0].status = 'reconciled';
const undone = m.undoImport(imported, 'imp', 'later');
assert.deepEqual(
  undone.next.transactions.map((t) => t.id),
  ['i1'],
);
assert.equal(undone.summary.keptEdited, 1);

console.log(
  'Passed: running balances, pending and pre-opening entries, card balances, bank differences, suggested opening balances, reconciliation (save for later and finish), imported rows cleared, undo keeps reconciled rows.',
);
