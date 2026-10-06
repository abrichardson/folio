import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/cashflow.ts'; export * from './lib/bills.ts'; export * from './lib/finance.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/cashflow.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/cashflow.mjs');

// All values are fictional.
const NOW = '2026-03-10';
const account = (id, type, balance, extra = {}) => ({
  id,
  name: id,
  institution: 'Example Bank',
  type,
  balance,
  ...extra,
});
const bill = (id, extra = {}) => ({
  id,
  name: id,
  amount: 10000,
  dueDate: '2026-01-15',
  frequency: 'Monthly',
  autopay: false,
  paidDates: [],
  kind: 'expense',
  ...extra,
});
const tx = (id, date, merchant, amount, accountId = 'chk', extra = {}) => ({
  id,
  date,
  merchant,
  category: amount > 0 ? 'Income' : 'Other',
  accountId,
  amount,
  notes: '',
  ...extra,
});
const base = (extra = {}) =>
  m.stateSchema.parse({
    ...m.emptyState(),
    accounts: [
      account('chk', 'Checking', 200000),
      account('sav', 'Savings', 900000),
      account('card', 'Credit card', 50000, {
        credit: { dueDate: '2026-03-20', minimumPayment: 3500, statementBalance: 48000 },
      }),
    ],
    ...extra,
  });

// Schedules: every two weeks, quarterly, and finite schedules.
assert.deepEqual(
  m.occurrenceDates({ dueDate: '2026-01-02', frequency: 'Biweekly' }, '2026-01-20', '2026-02-28'),
  ['2026-01-30', '2026-02-13', '2026-02-27'],
);
assert.deepEqual(
  m.occurrenceDates({ dueDate: '2025-11-30', frequency: 'Quarterly' }, '2026-01-01', '2026-12-31'),
  ['2026-02-28', '2026-05-30', '2026-08-30', '2026-11-30'],
);
assert.deepEqual(
  m.occurrenceDates(
    { dueDate: '2026-01-05', frequency: 'Monthly', endDate: '2026-03-05' },
    '2026-01-01',
    '2026-12-31',
  ),
  ['2026-01-05', '2026-02-05', '2026-03-05'],
);
assert.equal(m.frequencyLabel('Biweekly'), 'Every 2 weeks');
// Older bills gain the new fields' defaults.
const legacy = m.stateSchema.parse({
  ...m.emptyState(),
  bills: [{ ...bill('old'), kind: undefined }],
  planner: undefined,
});
assert.equal(legacy.bills[0].kind, 'expense');
assert.deepEqual(legacy.planner, { accountIds: [], cushion: 0, reminderDays: 3, dismissed: [] });
assert.throws(() =>
  m.stateSchema.parse({ ...m.emptyState(), bills: [bill('b', { endDate: '2025-01-01' })] }),
);

// Forecast: income, bills, card payments, plan installments.
const data = base({
  bills: [
    bill('Rent', {
      amount: 150000,
      dueDate: '2026-01-01',
      accountId: 'chk',
      paidDates: ['2026-02-01', '2026-03-01'],
    }),
    bill('Pay', {
      kind: 'income',
      amount: 120000,
      dueDate: '2026-03-13',
      frequency: 'Biweekly',
    }),
    // Charged to the card: left out of the cash forecast.
    bill('Streaming', { amount: 1500, dueDate: '2026-01-25', accountId: 'card' }),
    // Overdue and unpaid: counted today.
    bill('Water', { amount: 4000, dueDate: '2026-03-02', frequency: 'Once' }),
  ],
  plans: [
    {
      id: 'p',
      provider: 'Example Pay',
      description: '',
      kind: 'bnpl',
      originalAmount: 20000,
      principal: 10000,
      apr: 0,
      installment: 5000,
      frequency: 'biweekly',
      nextDate: '2026-03-12',
      paymentsLeft: 2,
      accountId: 'chk',
      autopay: true,
      status: 'active',
      history: [],
    },
  ],
});
const f = m.forecast(data, 30, NOW);
assert.equal(f.start, 200000, 'starts from checking only by default');
assert.deepEqual(
  f.events.map((e) => [e.date, e.name, e.amount, e.overdue, e.estimate]),
  [
    ['2026-03-10', 'Water', -4000, true, false],
    ['2026-03-12', 'Example Pay', -5000, false, false],
    ['2026-03-13', 'Pay', 120000, false, false],
    ['2026-03-20', 'card', -3500, false, false],
    ['2026-03-26', 'Example Pay', -5000, false, false],
    ['2026-03-27', 'Pay', 120000, false, false],
    ['2026-04-01', 'Rent', -150000, false, false],
  ],
);
assert.equal(f.end, 200000 - 4000 - 5000 + 120000 - 3500 - 5000 + 120000 - 150000);
assert.deepEqual(f.lowest, { date: '2026-03-12', balance: 191000 });
assert.equal(f.belowZero, null);
assert.equal(f.moneyIn, 240000);
assert.equal(f.moneyOut, 167500);

// Card payment plans, later months as estimates, and a shortfall.
const statement = structuredClone(data);
statement.accounts[2].credit.paymentPlan = 'statement';
statement.planner.cushion = 195000;
const g = m.forecast(statement, 60, NOW);
const cards = g.events.filter((e) => e.kind === 'card');
assert.deepEqual(
  cards.map((e) => [e.date, e.amount, e.estimate]),
  [
    ['2026-03-20', -48000, false],
    ['2026-04-20', -48000, true],
  ],
);
assert.equal(g.belowCushion?.name, 'Example Pay');
const custom = structuredClone(data);
custom.accounts[2].credit = {
  ...custom.accounts[2].credit,
  paymentPlan: 'custom',
  plannedPayment: 20000,
};
assert.ok(
  m
    .forecast(custom, 60, NOW)
    .events.filter((e) => e.kind === 'card')
    .every((e) => e.amount === -20000 && !e.estimate),
);
const paidCard = structuredClone(data);
paidCard.accounts[2].credit.paidDueDates = ['2026-03-20'];
assert.ok(!m.forecast(paidCard, 30, NOW).events.some((e) => e.kind === 'card'));
const unknown = structuredClone(data);
unknown.accounts[2].credit.minimumPayment = null;
assert.deepEqual(m.forecast(unknown, 30, NOW).unknownCards, ['card']);
// Choosing accounts, and running below zero.
const chosen = structuredClone(data);
chosen.planner.accountIds = ['sav'];
const h = m.forecast(chosen, 30, NOW);
assert.equal(h.start, 900000);
assert.ok(!h.events.some((e) => e.name === 'Rent'), 'rent is paid from checking');
const broke = structuredClone(data);
broke.accounts[0].balance = 5000;
assert.equal(m.forecast(broke, 30, NOW).belowZero?.name, 'Example Pay');
const days = m.dailyBalances(f, NOW, 30);
assert.equal(days.length, 31);
assert.equal(days[0].balance, 196000);
assert.equal(days[30].balance, f.end);

// Matching imported transactions to scheduled payments.
const matching = base({
  bills: [
    bill('City Power', { amount: 9000, dueDate: '2026-02-12' }),
    bill('Paycheck', {
      kind: 'income',
      amount: 120000,
      dueDate: '2026-02-27',
      frequency: 'Once',
      match: 'EXAMPLE CORP',
    }),
    bill('Gym', { amount: 3000, dueDate: '2026-03-01' }),
  ],
  transactions: [
    tx('t1', '2026-02-11', 'CITY POWER AUTOPAY', -9420),
    tx('t2', '2026-02-27', 'EXAMPLE CORP PAYROLL', 120000),
    // Wrong amount for the gym; wrong name for anything.
    tx('t3', '2026-03-01', 'GYM CLUB', -9900),
    tx('t4', '2026-03-01', 'CORNER STORE', -3000),
    // A payment on the card before its due date.
    tx('t5', '2026-03-15', 'PAYMENT THANK YOU', 10000, 'card', { category: 'Transfer' }),
    // Too small to cover the minimum.
    tx('t6', '2026-03-14', 'PAYMENT THANK YOU', 1000, 'card', { category: 'Transfer' }),
  ],
});
const found = m.matchPayments(matching, '2026-03-16');
assert.deepEqual(
  found.map((x) => [x.item.name, x.item.date, x.tx.id]).sort(),
  [
    ['City Power', '2026-02-12', 't1'],
    ['Paycheck', '2026-02-27', 't2'],
    ['card', '2026-03-20', 't5'],
  ].sort(),
);
const confirmed = m.confirmMatches(matching, found);
assert.deepEqual(confirmed.bills[0].paidDates, ['2026-02-12']);
assert.deepEqual(confirmed.accounts[2].credit.paidDueDates, ['2026-03-20']);
assert.equal(m.matchPayments(confirmed, '2026-03-16').length, 0, 'matched once');

// Suggested recurring bills.
const monthly = [
  '2025-10-03',
  '2025-11-03',
  '2025-12-03',
  '2026-01-03',
  '2026-02-03',
  '2026-03-03',
];
const biweekly = ['2026-01-02', '2026-01-16', '2026-01-30', '2026-02-13', '2026-02-27'];
const history = base({
  bills: [bill('Rent', { amount: 150000 })],
  transactions: [
    ...monthly.map((d, i) => tx('s' + i, d, 'STREAMCO 8841', -1599, 'card')),
    ...biweekly.map((d, i) => tx('p' + i, d, 'EXAMPLE CORP PAYROLL', 120000 + i * 100)),
    ...monthly.map((d, i) => tx('r' + i, d, 'RENT PORTAL', -150000)),
    // Irregular: not suggested.
    ...['2026-01-02', '2026-01-09', '2026-02-20', '2026-03-01'].map((d, i) =>
      tx('c' + i, d, 'CORNER CAFE', -800),
    ),
    // Amounts vary too much.
    ...monthly.map((d, i) => tx('v' + i, d, 'VARIES SHOP', -(1000 + i * 2000))),
    // Stopped months ago.
    ...['2025-08-01', '2025-09-01', '2025-10-01'].map((d, i) => tx('o' + i, d, 'OLD GYM', -3000)),
  ],
});
const suggested = m.suggestBills(history, NOW);
assert.deepEqual(
  suggested.map((s) => [s.name, s.frequency, s.nextDate, s.kind, s.amount]),
  [
    ['STREAMCO 8841', 'Monthly', '2026-04-03', 'expense', 1599],
    ['EXAMPLE CORP PAYROLL', 'Biweekly', '2026-03-13', 'income', 120400],
  ],
);
const made = m.billFromSuggestion(suggested[0], 'new');
assert.equal(made.match, 'streamco');
assert.equal(made.accountId, 'card');
assert.ok(m.billSchema.safeParse(made).success);
const scheduled = structuredClone(history);
scheduled.bills.push({
  ...bill('Paycheck', { kind: 'income', amount: 120000, frequency: 'Biweekly' }),
});
assert.deepEqual(
  m.suggestBills(scheduled, NOW).map((s) => s.name),
  ['STREAMCO 8841'],
  'a bill with the same schedule and amount covers the payee',
);
history.planner.dismissed = [suggested[0].key];
assert.equal(m.suggestBills(history, NOW).length, 1, 'dismissed suggestions stay hidden');

// Reminders: unpaid and due soon, including overdue; income is not a reminder.
const remind = base({
  bills: [
    bill('Soon', { dueDate: '2026-03-12', frequency: 'Once' }),
    bill('Later', { dueDate: '2026-03-20', frequency: 'Once' }),
    bill('Late', { dueDate: '2026-03-01', frequency: 'Once' }),
    bill('Paid', { dueDate: '2026-03-11', frequency: 'Once', paidDates: ['2026-03-11'] }),
    bill('Pay', { dueDate: '2026-03-11', frequency: 'Once', kind: 'income' }),
  ],
});
assert.deepEqual(
  m.reminders(remind, NOW).map((i) => i.name),
  ['Late', 'Soon'],
);

console.log(
  'Passed: two-week, quarterly, and finite schedules, older bills, forecast (income, bills, overdue, card plans and estimates, plan installments, chosen accounts, cushion and shortfalls, daily balances), matching payments, suggested recurring bills, reminders.',
);
