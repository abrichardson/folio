import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/finance.ts'; export * from './lib/bulk.ts'; export * from './lib/rules.ts'; export { findTransfers } from './lib/transfers.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/splits.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/splits.mjs');

// All records are fictional.
const split = {
  id: 'big-store',
  date: '2026-09-05',
  merchant: 'Fictional Superstore',
  category: 'Groceries',
  accountId: 'chk',
  amount: -10000,
  notes: '',
  splits: [
    { category: 'Groceries', amount: -6000, note: 'food' },
    { category: 'Shopping', amount: -3000, note: '' },
    { category: 'Transfer', amount: -1000, note: 'cash back' },
  ],
};
const plain = { ...split, id: 'cafe', merchant: 'Corner Cafe', category: 'Dining', amount: -500 };
delete plain.splits;
const data = m.stateSchema.parse({
  ...m.emptyState(),
  accounts: [
    { id: 'chk', name: 'Fictional Checking', institution: 'Example', type: 'Checking', balance: 0 },
    { id: 'sav', name: 'Fictional Savings', institution: 'Example', type: 'Savings', balance: 0 },
  ],
  transactions: [
    split,
    plain,
    { ...plain, id: 'in', accountId: 'sav', amount: 10000, category: 'Income' },
  ],
});

// --- Totals count the parts ---
assert.deepEqual(m.parts(data.transactions[1]), [{ category: 'Dining', amount: -500 }]);
const month = m.monthly(data, '2026-09');
assert.equal(month.spent, 9500, 'the transfer part is not spending');
assert.equal(month.income, 10000);
assert.equal(m.spentIn(data.transactions, 'Shopping'), 3000);
assert.equal(m.spentIn(data.transactions, 'Groceries'), 6000);
assert.equal(m.mainCategory(split.splits), 'Groceries');

// --- Validation ---
const bad = (splits) =>
  m.stateSchema.safeParse({ ...data, transactions: [{ ...split, splits }] }).success;
assert.equal(bad(split.splits), true);
assert.equal(
  bad([
    { category: 'Groceries', amount: -6000, note: '' },
    { category: 'Shopping', amount: -3000, note: '' },
  ]),
  false,
  'parts must add up to the total',
);
assert.equal(
  bad([
    { category: 'Nope', amount: -6000, note: '' },
    { category: 'Shopping', amount: -4000, note: '' },
  ]),
  false,
  'parts must use known categories',
);
assert.equal(
  bad([{ category: 'Groceries', amount: -10000, note: '' }]),
  false,
  'at least two parts',
);

// --- Other features respect splits ---
const filed = m.setCategory(data, new Set(['big-store']), 'Shopping');
assert.equal(filed.transactions[0].splits, undefined, 'one category replaces the split');
assert.equal(filed.transactions[0].category, 'Shopping');
const rule = { id: 'r', contains: 'SUPERSTORE', rename: 'Superstore', category: 'Health' };
const ruled = m.applyRule(data, rule).next.transactions[0];
assert.deepEqual(
  [ruled.merchant, ruled.category, ruled.splits.length],
  ['Superstore', 'Groceries', 3],
);
assert.equal(
  m.learnedCategories(data.transactions).has(m.payeeKey('Fictional Superstore')),
  false,
  'splits teach nothing',
);
const withTwin = {
  ...data,
  transactions: [...data.transactions, { ...plain, id: 'twin', accountId: 'sav', amount: 10000 }],
};
assert.equal(
  m.findTransfers(withTwin).some((p) => p.out.id === 'big-store'),
  false,
  'split entries are not offered as transfers',
);

console.log(
  'Passed: split parts in monthly totals and budgets, transfer parts excluded, validation, bulk/rules/learning/transfers respect splits.',
);
