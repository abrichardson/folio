import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/rules.ts'; export * from './lib/bulk.ts'; export * from './lib/finance.ts'; export { withoutDuplicates } from './lib/import/common.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/rules.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/rules.mjs');

// All records are fictional.
const tx = (id, merchant, amount, extra = {}) => ({
  id,
  date: '2026-09-01',
  merchant,
  category: amount > 0 ? 'Income' : 'Other',
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

// --- Rule text and payee grouping ---
assert.equal(m.ruleTextFor('WHOLEFDS ASH #10351 ASHEVILLE NC'), 'WHOLEFDS ASH');
assert.equal(m.ruleTextFor('SAMPLE DINER 0042 ANYTOWN'), 'SAMPLE DINER');
assert.equal(m.ruleTextFor('INTERNET PAYMENT - THANK YOU'), 'INTERNET PAYMENT - THANK YOU');
assert.equal(m.ruleTextFor('7-ELEVEN 41590'), '7-ELEVEN 41590', 'falls back to the whole text');
assert.equal(m.payeeKey('EXAMPLE GRILL 222 ANYTOWN ST'), m.payeeKey('Example Grill #9 Anytown ST'));
assert.notEqual(m.payeeKey('EXAMPLE GRILL'), m.payeeKey('OTHER GRILL'));

// --- First matching rule wins, ignoring case ---
const rules = [
  { id: 'r1', contains: 'wholefds', rename: 'Whole Foods', category: 'Groceries' },
  { id: 'r2', contains: 'WHOLE', category: 'Shopping' },
];
assert.equal(m.matchRule(rules, 'WHOLEFDS ASH #1')?.id, 'r1');
assert.equal(m.matchRule(rules, 'Wholesale Club')?.id, 'r2');
assert.equal(m.matchRule(rules, 'Corner Cafe'), undefined);

// --- Learned categories come only from hand choices; the latest wins ---
const history = [
  tx('h1', 'EXAMPLE GRILL 12', -900, {
    category: 'Dining',
    importBatch: 'i',
    edited: true,
    date: '2026-08-01',
  }),
  tx('h2', 'EXAMPLE GRILL 34', -900, {
    category: 'Entertainment',
    importBatch: 'i',
    edited: true,
    date: '2026-08-20',
  }),
  tx('h3', 'AUTO SUGGESTED SHOP', -900, { category: 'Shopping', importBatch: 'i' }),
  tx('h4', 'Typed Bakery', -500, { category: 'Dining' }),
  tx('h5', 'Vague Store', -500, { category: 'Other' }),
];
const learned = m.learnedCategories(history);
assert.equal(learned.get(m.payeeKey('EXAMPLE GRILL 99')), 'Entertainment');
assert.equal(
  learned.has(m.payeeKey('AUTO SUGGESTED SHOP')),
  false,
  'untouched imports teach nothing',
);
assert.equal(learned.get(m.payeeKey('Typed Bakery')), 'Dining');
assert.equal(learned.has(m.payeeKey('Vague Store')), false);

// --- Categorizing new rows: rule, then learned, never against direction or transfers ---
const rows = m.categorize(
  [
    { merchant: 'WHOLEFDS ASH #77', category: 'Groceries', amount: -3000 },
    { merchant: 'EXAMPLE GRILL 55', category: 'Other', amount: -1200 },
    { merchant: 'EXAMPLE GRILL REFUND', category: 'Income', amount: 1200 },
    { merchant: 'TYPED BAKERY', category: 'Transfer', amount: -500 },
  ],
  rules,
  learned,
);
assert.deepEqual(rows[0], {
  merchant: 'Whole Foods',
  originalMerchant: 'WHOLEFDS ASH #77',
  category: 'Groceries',
  amount: -3000,
});
assert.equal(rows[1].category, 'Entertainment');
assert.equal(rows[2].category, 'Income', 'a refund is not turned into spending');
assert.equal(rows[3].category, 'Transfer', 'recognized transfers stay transfers');

// --- A renamed entry is still found when the same file is imported again ---
const renamed = tx('x', 'Whole Foods', -3000, {
  originalMerchant: 'WHOLEFDS ASH #77',
  importBatch: 'i',
});
const again = m.withoutDuplicates(
  [renamed],
  [
    {
      date: '2026-09-01',
      merchant: 'WHOLEFDS ASH #77',
      amount: -3000,
      notes: '',
      category: 'Other',
    },
  ],
  'chk',
);
assert.deepEqual([again.fresh.length, again.duplicates], [0, 1]);

// --- Applying a rule to existing entries ---
{
  const data = base({
    rules,
    transactions: [
      tx('a', 'WHOLEFDS ASH #1', -100, { importBatch: 'i' }),
      tx('b', 'Wholefds market', -200),
      tx('c', 'Whole Foods', -300, { category: 'Groceries', originalMerchant: 'WHOLEFDS X' }),
      tx('d', 'Elsewhere', -400),
    ],
  });
  assert.deepEqual(
    m.ruleMatches(data, rules[0]).map((t) => t.id),
    ['a', 'b'],
    'entries already renamed and filed are not counted',
  );
  const { next, changed } = m.applyRule(data, rules[0]);
  assert.equal(changed, 2);
  assert.deepEqual(
    next.transactions.map((t) => [t.merchant, t.category, t.edited ?? false]),
    [
      ['Whole Foods', 'Groceries', true],
      ['Whole Foods', 'Groceries', false],
      ['Whole Foods', 'Groceries', false],
      ['Elsewhere', 'Other', false],
    ],
  );
  assert.equal(next.transactions[0].originalMerchant, 'WHOLEFDS ASH #1');
}

// --- Custom categories: validation, rename everywhere, removal ---
{
  const data = base({
    customCategories: ['Pets'],
    budgets: [{ id: 'b', category: 'Pets', limit: 5000 }],
    rules: [
      { id: 'p1', contains: 'VET', category: 'Pets' },
      { id: 'p2', contains: 'PETCO', rename: 'Petco', category: 'Pets' },
    ],
    transactions: [tx('p', 'Example Vet', -8000, { category: 'Pets' })],
  });
  assert.equal(m.allCategories(data).includes('Pets'), true);
  assert.equal(m.spendingCategories(data).includes('Income'), false);
  assert.equal(
    m.stateSchema.safeParse({ ...data, transactions: [tx('q', 'X', -1, { category: 'Nope' })] })
      .success,
    false,
    'unknown categories are refused',
  );
  assert.equal(
    m.stateSchema.safeParse({ ...data, customCategories: ['Pets', 'pets'] }).success,
    false,
  );
  assert.equal(
    m.stateSchema.safeParse({ ...data, customCategories: ['groceries'] }).success,
    false,
  );
  assert.equal(
    m.stateSchema.safeParse({ ...data, rules: [{ id: 'r', contains: 'X' }] }).success,
    false,
    'a rule must do something',
  );
  const renamedData = m.renameCategory(data, 'Pets', 'Animals');
  assert.equal(m.stateSchema.safeParse(renamedData).success, true);
  assert.deepEqual(
    [
      renamedData.transactions[0].category,
      renamedData.budgets[0].category,
      renamedData.rules[0].category,
    ],
    ['Animals', 'Animals', 'Animals'],
  );
  const removed = m.removeCategory(data, 'Pets');
  assert.equal(m.stateSchema.safeParse(removed).success, true);
  assert.equal(removed.transactions[0].category, 'Other');
  assert.deepEqual(removed.budgets, []);
  assert.deepEqual(removed.rules, [{ id: 'p2', contains: 'PETCO', rename: 'Petco' }]);
  // Split parts and bills follow renames and removals.
  const withParts = m.stateSchema.parse({
    ...data,
    transactions: [
      ...data.transactions,
      tx('sp', 'SPLIT', -300, {
        category: 'Groceries',
        splits: [
          { category: 'Groceries', amount: -200, note: '' },
          { category: 'Pets', amount: -100, note: '' },
        ],
      }),
    ],
    bills: [
      {
        id: 'vet',
        name: 'Vet plan',
        amount: 2000,
        dueDate: '2026-01-01',
        frequency: 'Monthly',
        category: 'Pets',
      },
    ],
  });
  const renamedParts = m.renameCategory(withParts, 'Pets', 'Animals');
  assert.equal(m.stateSchema.safeParse(renamedParts).success, true);
  assert.equal(renamedParts.transactions.at(-1).splits[1].category, 'Animals');
  assert.equal(renamedParts.bills[0].category, 'Animals');
  const removedParts = m.removeCategory(withParts, 'Pets');
  assert.equal(m.stateSchema.safeParse(removedParts).success, true);
  assert.equal(removedParts.transactions.at(-1).splits[1].category, 'Other');
  assert.equal(removedParts.bills[0].category, undefined);
}

// --- Bulk changes ---
{
  const data = base({
    transactions: [
      tx('i', 'Imported', -100, { importBatch: 'b', status: 'cleared' }),
      tx('h', 'Typed', -200),
      tx('p', 'Pending', -300, { pending: true }),
      tx('r', 'Reconciled', -400, { status: 'reconciled' }),
      tx('s', 'Synced', -500, { plaidItemId: 'item', plaidTransactionId: 'pt' }),
    ],
  });
  const all = new Set(['i', 'h', 'p', 'r', 's']);
  const filed = m.setCategory(data, all, 'Dining');
  assert.deepEqual(
    filed.transactions.map((t) => [t.category, t.edited ?? false, t.categoryEdited ?? false]),
    [
      ['Dining', true, false],
      ['Dining', false, false],
      ['Dining', false, false],
      ['Dining', false, false],
      ['Dining', false, true],
    ],
  );
  assert.deepEqual(
    m.markCleared(data, all).transactions.map((t) => t.status ?? '-'),
    ['cleared', 'cleared', '-', 'reconciled', 'cleared'],
  );
  assert.deepEqual(
    m.deleteTransactions(data, all).transactions.map((t) => t.id),
    ['s'],
    'bank-synced entries are not deleted',
  );
}

console.log(
  'Passed: rule text, payee grouping, first-match rules, learned categories, categorizing new rows, duplicates after renaming, applying rules, custom category validation/rename/removal (split parts and bills too), bulk category/cleared/delete.',
);
