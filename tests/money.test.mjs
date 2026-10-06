import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/finance.ts'; export * from './lib/rules.ts'; export { suggestCategory } from './lib/import/common.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/money.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/money.mjs');

// All records are fictional.
const tx = (id, amount, category, extra = {}) => ({
  id,
  date: '2026-09-10',
  merchant: `Fictional ${id}`,
  category,
  accountId: 'chk',
  amount,
  notes: '',
  ...extra,
});
const base = (extra = {}) =>
  m.stateSchema.parse({
    ...m.emptyState(),
    accounts: [
      {
        id: 'chk',
        name: 'Fictional Checking',
        institution: 'Example',
        type: 'Checking',
        balance: 0,
      },
    ],
    ...extra,
  });

// --- Refunds lower spending instead of counting as income ---
{
  const data = base({
    transactions: [
      tx('shoes', -8000, 'Shopping'),
      tx('return', 3000, 'Shopping'),
      tx('pay', 200000, 'Income'),
      tx('reversal', -5000, 'Income'),
      tx('move', -10000, 'Transfer'),
    ],
  });
  const month = m.monthly(data, '2026-09');
  assert.equal(month.spent, 5000, 'a $30 return nets against $80 of shopping');
  assert.equal(month.income, 195000, 'a reversed deposit lowers income');
  assert.equal(m.spentIn(data.transactions, 'Shopping'), 5000);
  assert.equal(Object.is(m.spentIn([], 'Shopping'), 0), true, 'no negative zero');
}

// --- Custom income categories ---
{
  const data = base({
    customCategories: ['Side business'],
    incomeCategories: ['Side business'],
    transactions: [tx('gig', 40000, 'Side business'), tx('lunch', -1500, 'Dining')],
  });
  assert.deepEqual(m.totals(data, data.transactions), { income: 40000, spent: 1500 });
  assert.equal(m.spendingCategories(data).includes('Side business'), false);
  assert.equal(
    m.stateSchema.safeParse({ ...data, incomeCategories: ['Nope'] }).success,
    false,
    'income categories must exist',
  );
  const renamed = m.renameCategory(data, 'Side business', 'Consulting');
  assert.deepEqual(renamed.incomeCategories, ['Consulting']);
  assert.deepEqual(m.removeCategory(data, 'Side business').incomeCategories, []);
}

// --- Older files whose custom category is now built in still load ---
assert.deepEqual(base({ customCategories: ['Pets', 'interest & fees'] }).customCategories, [
  'Pets',
]);

// --- Reimbursements ---
{
  const data = base({
    transactions: [
      tx('hotel', -24000, 'Travel', { reimbursable: true }),
      tx('taxi', -3000, 'Travel', { reimbursable: true }),
      tx('repay', 24000, 'Travel', { reimburses: 'hotel' }),
    ],
  });
  assert.deepEqual(
    m.awaitingReimbursement(data).map((t) => t.id),
    ['taxi'],
  );
  assert.equal(m.monthly(data, '2026-09').spent, 3000, 'the repaid hotel nets to zero');
}

// --- Interest and fees ---
assert.equal(
  m.suggestCategory({ merchant: 'INTEREST CHARGE ON PURCHASES', amount: -822 }),
  'Interest & fees',
);
assert.equal(m.suggestCategory({ merchant: 'LATE FEE', amount: -2900 }), 'Interest & fees');
assert.equal(
  m.suggestCategory({ merchant: 'MONTHLY MAINTENANCE FEE', amount: -1200 }),
  'Interest & fees',
);
assert.equal(
  m.suggestCategory({ merchant: 'INTEREST PAID', amount: 321, bankCategory: 'Interest' }),
  'Income',
  'interest earned is income',
);
assert.equal(m.categories.includes('Interest & fees'), true);

// --- Receipts ---
{
  const receipt = { id: 'r-1', name: 'receipt.jpg', type: 'image/jpeg', bytes: 1200 };
  const data = base({
    transactions: [tx('a', -500, 'Dining', { receipts: [receipt] }), tx('b', -1, 'Other')],
  });
  assert.deepEqual([...m.receiptIds(data)], ['r-1']);
  assert.equal(
    m.stateSchema.safeParse({
      ...data,
      transactions: [tx('c', -1, 'Other', { receipts: [{ ...receipt, id: '../x' }] })],
    }).success,
    false,
  );
}

console.log(
  'Passed: refunds net against spending, reversed income, custom income categories, built-in clash cleanup, reimbursements, interest and fee categories, receipt IDs.',
);
