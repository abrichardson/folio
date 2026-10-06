import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  entryPoints: ['lib/finance.ts'],
  outfile: '.test-build/finance-test.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { sampleState, stateSchema, monthly, netWorth, parseCSV, emptyState } =
  await import('../.test-build/finance-test.mjs');
const s = sampleState();
assert.equal(stateSchema.safeParse(s).success, true);
assert.equal(netWorth(s), 16202700);
const month = s.transactions[0].date.slice(0, 7);
assert.equal(monthly(s, month).income, 850000);
assert.equal(monthly(s, month).spent, 379649);
const transfer = {
  ...s.transactions[0],
  id: 'transfer-test',
  category: 'Transfer',
  amount: -999999,
};
assert.equal(monthly({ ...s, transactions: [...s.transactions, transfer] }, month).spent, 379649);
const bad = structuredClone(s);
bad.transactions[0].date = '2026-02-31';
assert.equal(stateSchema.safeParse(bad).success, false);
const missing = structuredClone(s);
missing.transactions[0].accountId = 'unknown';
assert.equal(stateSchema.safeParse(missing).success, false);
const duplicate = structuredClone(s);
duplicate.budgets.push({ ...duplicate.budgets[0], id: 'other' });
assert.equal(stateSchema.safeParse(duplicate).success, false);
assert.deepEqual(
  parseCSV(
    'date,merchant,amount\r\n2026-09-01,"Shop, Inc.",-5.50\r\n2026-09-02,"A ""quoted"" name",10',
  ),
  [
    ['date', 'merchant', 'amount'],
    ['2026-09-01', 'Shop, Inc.', '-5.50'],
    ['2026-09-02', 'A "quoted" name', '10'],
  ],
);
assert.throws(() => parseCSV('a,"unterminated'));
assert.equal(netWorth(emptyState()), 0);
console.log(
  'Passed: net worth, cash flow, transfer exclusion, date validation, account references, budget uniqueness, quoted CSV, empty state.',
);
