import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/plans.ts'; export * from './lib/finance.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/plans.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/plans.mjs');

// All values are fictional.
const plan = (extra = {}) => ({
  id: 'p',
  provider: 'Example Pay',
  description: 'Fictional desk',
  kind: 'bnpl',
  originalAmount: 40000,
  principal: 40000,
  apr: 0,
  installment: 10000,
  frequency: 'monthly',
  nextDate: '2026-01-31',
  paymentsLeft: 4,
  autopay: true,
  status: 'active',
  history: [],
  ...extra,
});

// --- Dates ---
assert.equal(m.nextPaymentDate('2026-01-31', 'monthly'), '2026-02-28', 'month end is kept');
assert.equal(m.nextPaymentDate('2026-02-28', 'monthly'), '2026-03-28');
assert.equal(m.nextPaymentDate('2026-12-15', 'monthly'), '2027-01-15');
assert.equal(m.nextPaymentDate('2026-01-01', 'biweekly'), '2026-01-15');
assert.equal(m.nextPaymentDate('2026-01-01', 'weekly'), '2026-01-08');

// --- 0% pay-in-4 ---
assert.deepEqual(
  m.schedule(plan()).map((s) => [s.date, s.amount, s.interest]),
  [
    ['2026-01-31', 10000, 0],
    ['2026-02-28', 10000, 0],
    ['2026-03-28', 10000, 0],
    ['2026-04-28', 10000, 0],
  ],
);
assert.deepEqual(m.remaining(plan()), { total: 40000, interest: 0, payments: 4 });

// --- An interest-bearing loan: payments exceed principal ---
const loan = plan({
  kind: 'personal',
  apr: 12,
  originalAmount: 120000,
  principal: 120000,
  installment: 10662,
  paymentsLeft: 12,
});
const r = m.remaining(loan);
assert.equal(r.payments, 12);
assert.ok(
  r.total > loan.principal && r.interest === r.total - loan.principal,
  'interest is the difference',
);
assert.ok(
  Math.abs(r.interest - 7940) < 60,
  `about $79 interest on $1,200 at 12% over a year, got ${r.interest}`,
);
const s = m.schedule(loan);
assert.equal(
  s.at(-1).principal + s.slice(0, -1).reduce((a, x) => a + x.principal, 0),
  120000,
  'the schedule pays off exactly',
);

// --- Recording payments ---
const after = m.recordPayment(loan);
assert.equal(after.history[0].interest, 1200, '1% of $1,200 in the first month');
assert.equal(after.principal, 120000 - (10662 - 1200));
assert.deepEqual([after.paymentsLeft, after.nextDate], [11, '2026-02-28']);
let paid = plan();
for (let i = 0; i < 4; i++) paid = m.recordPayment(paid);
assert.deepEqual([paid.principal, paid.status, paid.paymentsLeft], [0, 'paid', 0]);
assert.deepEqual(m.schedule(paid), []);

// --- Refunds and early payoff update the plan instead of adding one ---
const refunded = m.applyRefund(plan(), 15000, '2026-01-10');
assert.deepEqual(
  [refunded.principal, refunded.paymentsLeft, refunded.status],
  [25000, 3, 'active'],
);
assert.equal(m.schedule(refunded).at(-1).amount, 5000, 'the last payment is only what is left');
assert.equal(m.applyRefund(plan(), 50000, '2026-01-10').status, 'paid');
const early = m.payOff(after, '2026-03-01');
assert.deepEqual(
  [early.principal, early.status, early.history.at(-1).note],
  [0, 'paid', 'Paid off early'],
);
assert.equal(
  m.paymentsNeeded(plan({ apr: 400, installment: 100 }), 40000),
  1000,
  'an installment below the interest never pays off',
);

// --- Groups, due soon, net worth ---
const plans = [
  plan({ id: 'a', provider: 'Zeta' }),
  plan({ id: 'b', provider: 'Alpha', nextDate: '2026-02-10' }),
  plan({ id: 'c', provider: 'Alpha', nextDate: '2026-01-05' }),
];
assert.deepEqual(
  m.byProvider(plans).map((g) => [g.provider, g.plans.map((p) => p.id)]),
  [
    ['Alpha', ['c', 'b']],
    ['Zeta', ['a']],
  ],
);
assert.equal(m.paymentsDue(plans, '2026-01-31').length, 2);
const data = m.stateSchema.parse({
  ...m.emptyState(),
  accounts: [
    {
      id: 'chk',
      name: 'Fictional Checking',
      institution: 'Example',
      type: 'Checking',
      balance: 100000,
    },
  ],
  plans: [plan({ accountId: 'chk' }), plan({ id: 'done', status: 'paid', principal: 0 })],
});
assert.equal(m.netWorth(data), 60000, 'plan principal is a debt');
assert.equal(
  m.stateSchema.safeParse({ ...data, plans: [plan({ accountId: 'missing' })] }).success,
  false,
);

console.log(
  'Passed: payment dates, 0% pay-in-4, amortized loans (principal vs. total payments), recording payments, refunds and early payoff, grouping, due soon, net worth.',
);
