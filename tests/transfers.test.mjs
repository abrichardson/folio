import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/transfers.ts'; export * from './lib/finance.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/transfers.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/transfers.mjs');

// All records are fictional.
const tx = (id, accountId, date, amount, extra = {}) => ({
  id,
  date,
  merchant: `Fictional ${id}`,
  category: amount > 0 ? 'Income' : 'Other',
  accountId,
  amount,
  notes: '',
  ...extra,
});
const data = m.stateSchema.parse({
  ...m.emptyState(),
  accounts: ['chk', 'sav', 'card'].map((id) => ({
    id,
    name: id,
    institution: 'Example',
    type: id === 'card' ? 'Credit card' : id === 'sav' ? 'Savings' : 'Checking',
    balance: 0,
  })),
  transactions: [
    tx('pay-out', 'chk', '2026-09-10', -50000, { category: 'Transfer', importBatch: 'i' }),
    tx('pay-in', 'card', '2026-09-12', 50000, { category: 'Transfer' }),
    tx('save-out', 'chk', '2026-09-15', -20000),
    tx('save-in-far', 'sav', '2026-09-25', 20000),
    tx('save-in', 'sav', '2026-09-15', 20000),
    tx('same-account', 'chk', '2026-09-16', 20000),
    tx('pending', 'card', '2026-09-15', 20000, { pending: true }),
    tx('lonely', 'chk', '2026-09-20', -1234),
  ],
});

const pairs = m.findTransfers(data);
assert.deepEqual(
  pairs.map((p) => [p.out.id, p.in.id, p.days]),
  [
    ['save-out', 'save-in', 0],
    ['pay-out', 'pay-in', 2],
  ],
  'closest dates win; same account, pending, and far-apart entries are not paired',
);
assert.deepEqual(pairs.map(m.looksLikeTransfer), [false, true]);

const linked = m.linkTransfers(
  data,
  pairs,
  (() => {
    let n = 0;
    return () => `t${++n}`;
  })(),
);
assert.equal(m.stateSchema.safeParse(linked).success, true);
const byId = Object.fromEntries(linked.transactions.map((t) => [t.id, t]));
assert.deepEqual(
  [byId['save-out'].transferId, byId['save-in'].transferId, byId['save-in'].category],
  ['t1', 't1', 'Transfer'],
);
assert.equal(byId['pay-out'].edited, true, 'imported sides are marked edited');
assert.equal(byId['pay-in'].edited, undefined);
assert.equal(m.transferPartner(linked, byId['save-out']).id, 'save-in');
assert.equal(m.transferPartner(linked, byId['lonely']), undefined);
assert.equal(m.monthly(linked, '2026-09').spent, 1234, 'only the unmatched purchase is spending');
assert.deepEqual(m.findTransfers(linked).length, 0, 'linked entries are not offered again');

const unlinked = m.unlinkTransfer(linked, 't1');
assert.equal(unlinked.transactions.filter((t) => t.transferId === 't1').length, 0);
assert.equal(
  unlinked.transactions.find((t) => t.id === 'save-in').category,
  'Transfer',
  'categories are left as they are',
);

console.log(
  'Passed: transfer pairing (closest dates, other accounts only, pending and far entries skipped), linking, partners, spending excludes linked transfers, unlinking.',
);
