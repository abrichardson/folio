import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/reports.ts'; export * from './lib/budgets.ts'; export * from './lib/finance.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/reports.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/reports.mjs');

// All values are fictional.
const tx = (id, date, merchant, category, amount, accountId = 'chk', extra = {}) => ({
  id,
  date,
  merchant,
  category,
  accountId,
  amount,
  notes: '',
  ...extra,
});
const budget = (extra = {}) => ({
  id: 'b',
  category: 'Groceries',
  limit: 40000,
  rollover: false,
  adjustments: [],
  ...extra,
});
const data = m.stateSchema.parse({
  ...m.emptyState(),
  accounts: [
    { id: 'chk', name: 'Checking', institution: 'Example', type: 'Checking', balance: 300000 },
    { id: 'sav', name: 'Savings', institution: 'Example', type: 'Savings', balance: 200000 },
    {
      id: 'card',
      name: 'Card',
      institution: 'Example',
      type: 'Credit card',
      balance: 120000,
      credit: { apr: 24.99 },
    },
  ],
  transactions: [
    tx('a', '2026-01-05', 'FRESH MARKET 12', 'Groceries', -30000),
    tx('b', '2026-02-05', 'FRESH MARKET 12', 'Groceries', -50000),
    tx('c', '2026-03-05', 'FRESH MARKET 99', 'Groceries', -25000),
    tx('c2', '2026-03-06', 'FRESH MARKET 99', 'Groceries', 5000), // refund
    tx('d', '2026-03-07', 'BISTRO', 'Dining', -6000, 'card'),
    tx('e', '2026-02-07', 'BISTRO', 'Dining', -9000, 'card'),
    tx('f', '2026-03-15', 'EXAMPLE CORP', 'Income', 250000),
    tx('g', '2026-03-16', 'TO SAVINGS', 'Transfer', -50000),
    tx('h', '2026-03-20', 'INTEREST CHARGE', 'Interest & fees', -2100, 'card'),
    tx('i', '2026-03-21', 'PENDING SHOP', 'Shopping', -9900, 'chk', { pending: true }),
    tx('j', '2026-02-27', 'SPLIT STORE', 'Shopping', -10000, 'chk', {
      splits: [
        { category: 'Shopping', amount: -6000, note: '' },
        { category: 'Groceries', amount: -4000, note: '' },
      ],
    }),
  ],
  goals: [
    { id: 'g1', name: 'Trip', target: 150000, saved: 120000, date: '2026-09-01', accountId: 'sav' },
    {
      id: 'g2',
      name: 'Cushion',
      target: 100000,
      saved: 100000,
      date: '2026-12-01',
      accountId: 'sav',
    },
    {
      id: 'g3',
      name: 'Card free',
      target: 200000,
      saved: 0,
      date: '2026-07-01',
      kind: 'debt',
      accountId: 'card',
    },
  ],
  plans: [
    {
      id: 'p',
      provider: 'Example Pay',
      description: '',
      kind: 'personal',
      originalAmount: 100000,
      principal: 80000,
      apr: 12,
      installment: 10000,
      frequency: 'monthly',
      nextDate: '2026-04-01',
      paymentsLeft: 9,
      autopay: true,
      status: 'active',
      history: [{ date: '2026-03-01', amount: 10000, principal: 9100, interest: 900, note: '' }],
    },
  ],
  bills: [
    {
      id: 'r',
      name: 'Rent',
      amount: 150000,
      dueDate: '2026-01-01',
      frequency: 'Monthly',
      autopay: false,
      paidDates: [],
    },
    {
      id: 'w',
      name: 'Water',
      amount: 9000,
      dueDate: '2026-01-01',
      frequency: 'Quarterly',
      autopay: false,
      paidDates: [],
    },
    {
      id: 'y',
      name: 'Pay',
      amount: 120000,
      dueDate: '2026-01-02',
      frequency: 'Biweekly',
      autopay: false,
      paidDates: [],
      kind: 'income',
    },
  ],
  snapshots: [
    { date: '2026-01-31', value: 100000 },
    { date: '2026-02-28', value: 150000, debt: 230000 },
    { date: '2026-03-31', value: 260000, debt: 200000 },
  ],
});

// Budgets: monthly adjustments and rollover.
assert.equal(m.addMonths('2026-01', -1), '2025-12');
assert.equal(m.addMonths('2026-11', 3), '2027-02');
const adjusted = m.adjustMonth(budget(), '2026-03', 60000);
assert.equal(m.limitFor(adjusted, '2026-03'), 60000);
assert.equal(m.limitFor(adjusted, '2026-04'), 40000);
assert.deepEqual(m.adjustMonth(adjusted, '2026-03', null).adjustments, []);
assert.deepEqual(
  m.adjustMonth(budget(), '2026-03', 40000).adjustments,
  [],
  'same as usual: no adjustment',
);
assert.deepEqual(m.budgetMonth(data, budget(), '2026-03'), {
  limit: 40000,
  carried: 0,
  available: 40000,
  spent: 20000,
  left: 20000,
});
// Rollover from January: Jan 40,000 − 30,000 = +10,000; Feb 40,000 − 54,000 (incl. split) = −14,000.
const rolling = budget({ rollover: true, rolloverFrom: '2026-01' });
assert.deepEqual(m.budgetMonth(data, rolling, '2026-03'), {
  limit: 40000,
  carried: -4000,
  available: 36000,
  spent: 20000,
  left: 16000,
});
assert.equal(m.budgetMonth(data, { ...rolling, rolloverFrom: '2026-03' }, '2026-03').carried, 0);
assert.equal(
  m.budgetMonth(data, m.adjustMonth(rolling, '2026-02', 60000), '2026-03').carried,
  16000,
  'adjusted months roll over their own amount',
);
assert.deepEqual(
  m
    .budgetGroups([
      budget({ id: '1' }),
      budget({ id: '2', group: 'Fun' }),
      budget({ id: '3', group: 'Fun' }),
    ])
    .map((g) => [g.name, g.budgets.length]),
  [
    ['Fun', 2],
    ['', 1],
  ],
);
assert.throws(() =>
  m.stateSchema.parse({
    ...data,
    budgets: [
      budget({
        adjustments: [
          { month: '2026-01', limit: 1 },
          { month: '2026-01', limit: 2 },
        ],
      }),
    ],
  }),
);

// Goals: debt payoff, monthly amount, earmarks.
assert.deepEqual(m.goalProgress(data, data.goals[2]), { saved: 80000, left: 120000, done: false });
assert.equal(m.monthlyForGoal(data, data.goals[0], '2026-03-15'), 5000);
assert.equal(m.monthlyForGoal(data, data.goals[1], '2026-03-15'), 0);
const marks = m.earmarks(data);
assert.equal(marks.length, 1);
assert.deepEqual([marks[0].earmarked, marks[0].free, marks[0].over], [220000, -20000, true]);
assert.throws(() =>
  m.stateSchema.parse({ ...data, goals: [{ ...data.goals[0], accountId: 'gone' }] }),
);

// Reports.
const march = m.rangeFor('month', '2026-03-18');
assert.deepEqual(march, { from: '2026-03-01', to: '2026-03-31' });
assert.deepEqual(m.previousRange(march), { from: '2026-02-01', to: '2026-02-28' });
assert.deepEqual(m.rangeFor('3-months', '2026-03-18'), { from: '2026-01-01', to: '2026-03-31' });
assert.deepEqual(m.previousRange(m.rangeFor('3-months', '2026-03-18')), {
  from: '2025-10-01',
  to: '2025-12-31',
});
assert.deepEqual(m.rangeFor('year', '2026-03-18'), { from: '2026-01-01', to: '2026-03-31' });
assert.deepEqual(m.rangeFor('last-month', '2026-01-18'), { from: '2025-12-01', to: '2025-12-31' });
assert.deepEqual(m.spendingByCategory(data, march), [
  { category: 'Groceries', amount: 20000, previous: 54000 },
  { category: 'Dining', amount: 6000, previous: 9000 },
  { category: 'Interest & fees', amount: 2100, previous: 0 },
  { category: 'Shopping', amount: 0, previous: 6000 },
]);
assert.deepEqual(
  m
    .spendingByMerchant(data, m.rangeFor('3-months', '2026-03-18'))
    .map((x) => [x.name, x.amount, x.count]),
  [
    ['FRESH MARKET 12', 100000, 4],
    ['BISTRO', 15000, 2],
    ['SPLIT STORE', 10000, 1],
    ['INTEREST CHARGE', 2100, 1],
  ],
);
assert.deepEqual(m.incomeVsExpenses(data, m.rangeFor('3-months', '2026-03-18')), [
  { month: '2026-01', income: 0, spent: 30000, net: -30000 },
  { month: '2026-02', income: 0, spent: 69000, net: -69000 },
  { month: '2026-03', income: 250000, spent: 28100, net: 221900 },
]);
const recurring = m.recurringCosts(data);
assert.deepEqual(
  recurring.list.map((x) => [x.name, x.monthly]),
  [
    ['Rent', 150000],
    ['Example Pay', 10000],
    ['Water', 3000],
  ],
);
assert.equal(recurring.monthly, 163000);
assert.equal(recurring.income, 260000);
const fees = m.interestAndFees(data, march);
assert.deepEqual(fees.accounts, [{ name: 'Card', amount: 2100 }]);
assert.deepEqual(fees.plans, [{ name: 'Example Pay', amount: 900 }]);
assert.equal(fees.total, 3000);
const debt = m.debtReport(data, m.rangeFor('3-months', '2026-03-18'));
assert.deepEqual(
  debt.debts.map((d) => [d.name, d.owed]),
  [
    ['Card', 120000],
    ['Example Pay', 80000],
  ],
);
assert.equal(debt.total, 200000);
assert.equal(debt.change, -30000);
assert.equal(debt.paidOnPlans, 9100);
assert.equal(m.netWorthHistory(data, march).length, 1);
assert.equal(m.totalDebt(data), 200000);
assert.equal(
  m.toCSV([
    ['name', 'amount'],
    ['=SUM(A1)', '-12.50'],
    ['Say "hi"', 3],
  ]),
  '"name","amount"\r\n"\'=SUM(A1)","-12.50"\r\n"Say ""hi""","3"',
);

console.log(
  'Passed: budget adjustments, rollover (overspending, adjusted months), groups, debt and savings goals, earmarks, report ranges and comparisons, spending by category and payee, income vs. expenses, recurring costs, interest and fees, debt, net worth, CSV export.',
);
