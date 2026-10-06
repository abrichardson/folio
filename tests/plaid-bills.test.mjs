import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  entryPoints: ['lib/finance.ts', 'lib/bills.ts', 'lib/plaid-data.ts'],
  outdir: '.test-build/tests',
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
});
const { emptyState, stateSchema, monthly, netWorth, sampleState } =
  await import('../.test-build/tests/finance.mjs');
const { occurrenceDates, dueItems, togglePaid } = await import('../.test-build/tests/bills.mjs');
const { mergePlaid, collectPages, plaidCategory } =
  await import('../.test-build/tests/plaid-data.mjs');
const bill = {
  id: 'rent',
  name: 'Rent',
  dueDate: '2024-01-31',
  frequency: 'Monthly',
  amount: 10000,
  paidDates: [],
  autopay: false,
};
assert.deepEqual(occurrenceDates(bill, '2024-01-01', '2024-04-30'), [
  '2024-01-31',
  '2024-02-29',
  '2024-03-31',
  '2024-04-30',
]);
assert.deepEqual(occurrenceDates({ ...bill, dueDate: '2023-01-31' }, '2023-02-01', '2023-03-31'), [
  '2023-02-28',
  '2023-03-31',
]);
assert.deepEqual(
  occurrenceDates(
    { ...bill, dueDate: '2024-02-29', frequency: 'Yearly' },
    '2024-01-01',
    '2028-12-31',
  ),
  ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'],
);
assert.deepEqual(occurrenceDates({ ...bill, frequency: 'Weekly' }, '2024-02-01', '2024-02-20'), [
  '2024-02-07',
  '2024-02-14',
]);
const data = { ...emptyState(), bills: [bill] };
const due = dueItems(data, '2024-02-01', '2024-02-29')[0];
assert.equal(due.amount, 10000);
const paid = togglePaid(data, due);
assert.equal(dueItems(paid, '2024-02-01', '2024-02-29')[0].paid, true);
assert.equal(dueItems(paid, '2024-03-01', '2024-03-31')[0].paid, false);
assert.equal(paid.transactions.length, 0);
assert.deepEqual(togglePaid(paid, { ...due, paid: true }), data);
const legacy = sampleState();
delete legacy.bills;
assert.deepEqual(stateSchema.parse(legacy).bills, []);
const account = {
  account_id: 'card',
  name: 'Test card',
  type: 'credit',
  balances: { current: 120, limit: 1000, iso_currency_code: 'USD' },
};
const pending = {
  transaction_id: 'pending',
  account_id: 'card',
  date: '2026-09-20',
  name: 'Coffee',
  amount: 5,
  pending: true,
  iso_currency_code: 'USD',
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
};
const page = (added = [], modified = [], removed = []) => ({
  added,
  modified,
  removed,
  next_cursor: 'one',
  has_more: false,
});
const item = { id: 'item-a', institution: 'Sandbox bank' };
let merged = mergePlaid(
  emptyState(),
  item,
  [account],
  [page([pending])],
  [
    {
      account_id: 'card',
      last_statement_balance: 100,
      minimum_payment_amount: 20,
      next_payment_due_date: '2026-10-15',
      aprs: [{ apr_type: 'purchase_apr', apr_percentage: 19.99 }],
    },
  ],
);
assert.equal(merged.accounts[0].balance, 12000);
assert.equal(netWorth(merged), -12000);
assert.equal(merged.accounts[0].credit.minimumPayment, 2000);
assert.equal(merged.accounts[0].credit.apr, 19.99);
assert.equal(monthly(merged, '2026-09').spent, 0);
merged.transactions[0].notes = 'Pending note';
merged = mergePlaid(
  merged,
  item,
  [account],
  [
    page([], [], [{ transaction_id: 'pending' }]),
    page([
      {
        ...pending,
        transaction_id: 'posted',
        pending: false,
        pending_transaction_id: 'pending',
        amount: 5.5,
      },
    ]),
  ],
  null,
);
assert.equal(merged.transactions[0].notes, 'Pending note');
assert.equal(merged.transactions.length, 1);
assert.equal(monthly(merged, '2026-09').spent, 550);
merged.transactions[0].notes = 'Personal note';
merged.transactions[0].category = 'Travel';
merged.transactions[0].categoryEdited = true;
merged = mergePlaid(
  merged,
  item,
  [account],
  [page([], [{ ...pending, transaction_id: 'posted', pending: false, amount: 6 }])],
  null,
);
assert.equal(merged.transactions[0].notes, 'Personal note');
assert.equal(merged.transactions[0].category, 'Travel');
assert.equal(monthly(merged, '2026-09').spent, 600);
const replay = mergePlaid(
  merged,
  item,
  [account],
  [page([], [{ ...pending, transaction_id: 'posted', pending: false, amount: 6 }])],
  null,
);
assert.equal(replay.transactions.length, 1);
merged = mergePlaid(merged, item, [account], [page([], [], [{ transaction_id: 'posted' }])], null);
assert.equal(merged.transactions.length, 0);
assert.equal(
  plaidCategory({
    ...pending,
    personal_finance_category: {
      primary: 'LOAN_PAYMENTS',
      detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    },
  }),
  'Transfer',
);
const credit = mergePlaid(
  emptyState(),
  item,
  [{ ...account, balances: { ...account.balances, current: -25 } }],
  [],
  null,
);
assert.equal(netWorth(credit), 2500);
const currencies = mergePlaid(
  emptyState(),
  item,
  [{ ...account, balances: { ...account.balances, iso_currency_code: 'EUR' } }],
  [],
  null,
);
assert.equal(currencies.accounts.length, 0);
const missing = mergePlaid(
  merged,
  item,
  [{ ...account, balances: { ...account.balances, current: null } }],
  [],
  null,
);
assert.equal(missing.accounts[0].balance, 12000);
assert.equal(missing.accounts[0].balanceUnavailable, true);
let calls = [];
const result = await collectPages(async (cursor) => {
  calls.push(cursor);
  if (calls.length === 1) return { ...page(), has_more: true, next_cursor: 'page2' };
  if (calls.length === 2) {
    const e = new Error('mutation');
    e.code = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
    throw e;
  }
  return { ...page(), next_cursor: 'done' };
}, 'initial');
assert.deepEqual(calls, ['initial', 'page2', 'initial']);
assert.equal(result.cursor, 'done');
assert.equal(result.pages.length, 1);
console.log(
  'Passed: bill recurrence/leap years, per-occurrence payment status, legacy migration, liabilities, pending-to-posted replacement, idempotent replay, edited categories, removed transactions, transfer classification, credit balances, unsupported currencies, unavailable balances, sync pagination restart.',
);
