import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/promotions.ts'; export * from './lib/finance.ts'; export { parsePromotions, parseStatementText, applyStatement } from './lib/import/statement.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/promotions.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/promotions.mjs');

// All values are fictional.
const promo = (extra = {}) => ({
  id: 'p1',
  description: 'Fictional sofa',
  kind: 'deferred',
  originalAmount: 120000,
  balance: 90000,
  startDate: '2026-01-15',
  endDate: '2026-12-15',
  payoffBy: null,
  aprAfter: 29.99,
  accruedInterest: null,
  asOf: '2026-09-15',
  source: 'manual',
  ...extra,
});

// --- Payments needed and status ---
assert.equal(
  m.paymentsLeft('2026-12-15', '2026-09-20'),
  2,
  'Oct 15 and Nov 15 payments, then Dec 15 is the deadline day',
);
assert.equal(m.paymentsLeft('2026-12-15', '2026-09-15'), 3);
assert.equal(m.paymentsLeft('2026-09-30', '2026-09-20'), 1, 'at least one');
assert.equal(m.paymentsLeft('2026-08-01', '2026-09-20'), 1, 'past deadlines need payment now');
assert.equal(m.monthlyNeeded(promo(), '2026-09-15'), 30000);
assert.equal(
  m.monthlyNeeded(promo({ balance: 90001 }), '2026-09-15'),
  30001,
  'rounds up to the cent',
);
assert.equal(
  m.monthlyNeeded(promo({ payoffBy: '2026-11-15' }), '2026-09-15'),
  45000,
  'an earlier target needs more',
);
assert.equal(m.monthlyNeeded(promo({ balance: 0 }), '2026-09-15'), 0);
assert.equal(m.promotionStatus(promo(), '2026-09-15'), 'on track');
assert.equal(m.promotionStatus(promo(), '2026-10-01'), 'soon');
assert.equal(m.promotionStatus(promo(), '2026-11-20'), 'urgent');
assert.equal(m.promotionStatus(promo(), '2026-12-16'), 'expired');
assert.equal(m.promotionStatus(promo({ balance: 0 }), '2026-12-16'), 'paid');
assert.equal(m.progress(promo()), 0.25);
assert.equal(m.progress(promo({ originalAmount: null })), null);

// --- Deferred interest at risk ---
assert.equal(
  m.deferredInterestAtRisk(promo({ accruedInterest: 18000 }), 25),
  18000,
  'issuer figure wins',
);
assert.equal(
  m.deferredInterestAtRisk(promo(), null),
  Math.round((120000 * 0.2999 * 334) / 365),
  'estimate: original amount at the later rate from purchase to deadline',
);
assert.equal(
  m.deferredInterestAtRisk(promo({ kind: 'zero' }), 25),
  0,
  'true 0% charges nothing back',
);
assert.equal(m.deferredInterestAtRisk(promo({ startDate: null, aprAfter: null }), null), null);

// --- Promotions are part of the card balance ---
const card = {
  id: 'c',
  name: 'Fictional Store Card',
  institution: 'Example',
  type: 'Credit card',
  balance: 100000,
  promotions: [promo(), promo({ id: 'p2', balance: 0 })],
};
assert.deepEqual(
  m.activePromotions(card).map((p) => p.id),
  ['p1'],
);
assert.equal(m.promotionsExceedBalance(card), false);
assert.equal(m.promotionsExceedBalance({ ...card, balance: 50000 }), true);
assert.equal(m.stateSchema.safeParse({ ...m.emptyState(), accounts: [card] }).success, true);

// --- Reading promotions from statement text ---
const calc = m.parsePromotions(
  [
    'Deferred Interest Calculation',
    'No Interest If Paid In 03/02/26 29.99% (v) 09/02/26* $6.40 | $38.15 | $310.00',
    'Full',
    'No Interest If Paid In 05/10/26 29.99% (v) 11/10/26* $3.10 | $12.45 | $150.00',
  ],
  null,
);
assert.deepEqual(calc[0], {
  description: 'No interest if paid in full',
  kind: 'deferred',
  originalAmount: null,
  balance: 31000,
  startDate: '2026-03-02',
  endDate: '2026-09-02',
  aprAfter: 29.99,
  accruedInterest: 3815,
});
assert.equal(calc.length, 2);
const summary = m.parsePromotions(
  [
    'Promotional Purchase Summary',
    'Promotional Promotional Deferred Tran Date Description | Initial',
    'Deferred Interest/No Interest If Paid In',
    '12/20/2026 | $640.00 | $71.30 06/20/2026 | $1,280.00',
    'Full',
    'Transaction Summary',
    '01/01/2027 | $1.00 | $1.00 01/01/2026 | $1.00',
  ],
  26.99,
);
assert.deepEqual(summary, [
  {
    description: 'No interest if paid in full',
    kind: 'deferred',
    originalAmount: 128000,
    balance: 64000,
    startDate: '2026-06-20',
    endDate: '2026-12-20',
    aprAfter: 26.99,
    accruedInterest: 7130,
  },
]);

// --- Merging from statements ---
const ids = (() => {
  let n = 0;
  return () => `new-${++n}`;
})();
const existing = [
  promo({
    id: 'mine',
    startDate: '2026-03-02',
    endDate: '2026-09-02',
    balance: 40000,
    asOf: '2026-08-02',
    payoffBy: '2026-08-15',
  }),
];
const merged = m.mergePromotions(existing, calc, '2026-09-11', ids);
assert.deepEqual(
  merged.map((p) => [p.id, p.balance, p.payoffBy ?? null, p.asOf]),
  [
    ['mine', 31000, '2026-08-15', '2026-09-11'],
    ['new-1', 15000, null, '2026-09-11'],
  ],
  'the matching promotion is updated and keeps your target; a new one is added',
);
assert.deepEqual(
  m
    .mergePromotions(
      merged,
      calc.map((p) => ({ ...p, balance: 1 })),
      '2026-08-01',
      ids,
    )
    .map((p) => p.balance),
  [31000, 15000],
  'an older statement does not overwrite newer balances',
);
const applied = m.applyStatement(
  { ...card, promotions: [] },
  {
    issuer: null,
    last4: null,
    closingDate: '2026-09-11',
    newBalance: 46000,
    minimumPayment: 4000,
    dueDate: '2026-10-06',
    creditLimit: 200000,
    purchaseApr: 29.99,
    promotions: calc,
  },
);
assert.equal(applied.promotions.length, 2);
assert.equal(applied.promotions[0].source, 'pdf');

console.log(
  'Passed: payments needed per promotion, statuses, deferred interest at risk, card balance check, statement promotion tables (two layouts), merging without overwriting newer figures.',
);
