import assert from 'node:assert/strict';
import { build } from 'esbuild';
await build({
  stdin: {
    contents: `export * from './lib/persist.ts'; export * from './lib/imports.ts'; export * from './lib/finance.ts'; export { applyStatement } from './lib/import/statement.ts'; export { csvHeaderSignature } from './lib/import/csv.ts';`,
    resolveDir: '.',
    loader: 'ts',
  },
  outfile: '.test-build/history.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const m = await import('../.test-build/history.mjs');

// All records below are fictional.
const tx = (id, amount, extra = {}) => ({
  id,
  date: '2026-09-01',
  merchant: `Fictional ${id}`,
  category: 'Other',
  accountId: 'chk',
  amount,
  notes: '',
  ...extra,
});
const base = () =>
  m.stateSchema.parse({
    ...m.emptyState(),
    accounts: [
      {
        id: 'chk',
        name: 'Fictional Checking',
        institution: 'Example Bank',
        type: 'Checking',
        balance: 100000,
        balanceDate: '2026-08-31',
        balanceSource: 'manual',
      },
    ],
    transactions: [tx('t1', -500), tx('t2', -700)],
  });

// --- Saves send only changed transactions ---
{
  const s = base();
  const first = m.workspaceChanges(s, null);
  assert.equal(JSON.parse(first.payload).transactions.length, 2, 'unknown file: send everything');
  assert.deepEqual([first.upsert, first.remove], [[], []]);

  const same = m.workspaceChanges(s, first.saved);
  assert.equal('transactions' in JSON.parse(same.payload), false);
  assert.deepEqual([same.upsert, same.remove], [[], []], 'nothing changed');

  const next = structuredClone(s);
  next.transactions[0].notes = 'edited';
  next.transactions.splice(1, 1);
  next.transactions.push(tx('t3', 900));
  const diff = m.workspaceChanges(next, same.saved);
  assert.deepEqual(
    diff.upsert.map((r) => JSON.parse(r).id),
    ['t1', 't3'],
  );
  assert.deepEqual(diff.remove, ['t2']);
  assert.deepEqual(m.workspaceChanges(next, diff.saved).upsert, []);
}

// --- Older workspaces load; the transaction limit is far above 10,000 ---
{
  const old = { ...m.emptyState() };
  delete old.imports;
  assert.deepEqual(m.stateSchema.parse(old).imports, []);
  assert.deepEqual(m.stateSchema.parse(old).settings, { autoLockMinutes: 15 });
  assert.equal(
    m.stateSchema.safeParse({ ...old, settings: { autoLockMinutes: 500 } }).success,
    false,
  );
  const many = base();
  many.transactions = Array.from({ length: 12000 }, (_, i) => tx(`bulk-${i}`, -i - 1));
  assert.equal(m.stateSchema.safeParse(many).success, true);
  assert.ok(m.MAX_TRANSACTIONS >= 250000);
}

// --- Importing records history; Undo removes it and restores the account ---
const imported = (data, id, extra = {}) => {
  const account = {
    ...data.accounts[0],
    balance: 123456,
    balanceDate: '2026-09-15',
    balanceSource: 'ofx',
    importKey: 'key-1',
  };
  return m.applyImport(
    data,
    {
      fileName: 'fictional.qfx',
      format: 'OFX',
      fileHash: 'a'.repeat(64),
      accounts: [
        {
          account,
          created: false,
          transactions: [tx('n1', -100), tx('n2', -200)],
          duplicates: 2,
          skipped: 0,
          from: '2026-09-01',
          to: '2026-09-15',
          balance: { amount: 123456, date: '2026-09-15', applied: true },
          ...extra,
        },
      ],
    },
    id,
    '2026-09-16T10:00:00.000Z',
  );
};
{
  const before = base();
  const after = m.stateSchema.parse(imported(before, 'imp1'));
  assert.equal(after.imports.length, 1);
  assert.equal(after.imports[0].accounts[0].added, 2);
  assert.equal(after.transactions.filter((t) => t.importBatch === 'imp1').length, 2);
  assert.equal(m.previousImportOf(after, 'a'.repeat(64))?.id, 'imp1');

  const { next, summary } = m.undoImport(after, 'imp1', '2026-09-17T10:00:00.000Z');
  assert.equal(summary.removed, 2);
  assert.deepEqual(summary.restored, ['Fictional Checking']);
  assert.deepEqual(next.accounts, before.accounts, 'balance, date, source, and key restored');
  assert.deepEqual(next.transactions, before.transactions);
  assert.equal(next.imports[0].undoneAt, '2026-09-17T10:00:00.000Z');
  assert.equal(m.previousImportOf(next, 'a'.repeat(64)), undefined);
  assert.throws(() => m.undoImport(next, 'imp1', 'x'), /already undone/);
  assert.throws(() => m.undoImport(next, 'missing', 'x'), /no longer/);
  assert.match(m.describeUndo(summary), /Removes 2 imported transactions; restores/);
}

// --- Undo keeps edits made after the import ---
{
  const after = structuredClone(imported(base(), 'imp1'));
  const n1 = after.transactions.find((t) => t.id === 'n1');
  n1.category = 'Dining';
  n1.edited = true;
  // A newer balance entered by hand after the import.
  Object.assign(after.accounts[0], {
    balance: 99000,
    balanceDate: '2026-09-20',
    balanceSource: 'manual',
  });
  const { next, summary } = m.undoImport(after, 'imp1', 'now');
  assert.equal(summary.removed, 1);
  assert.equal(summary.keptEdited, 1);
  assert.deepEqual(
    next.transactions.map((t) => t.id),
    ['t1', 't2', 'n1'],
  );
  const account = next.accounts[0];
  assert.deepEqual(
    [account.balance, account.balanceDate, account.balanceSource],
    [99000, '2026-09-20', 'manual'],
    'the newer balance stays',
  );
  assert.equal(account.importKey, undefined, 'unchanged fields the import set are reverted');
  assert.deepEqual(summary.keptChanges, ['Fictional Checking']);
  assert.match(m.describeUndo(summary), /keeps 1 you edited/);
}

// --- Accounts an import created are removed only when nothing else uses them ---
{
  const created = {
    id: 'new-card',
    name: 'Fictional Card',
    institution: 'Example',
    type: 'Credit card',
    balance: 5000,
    balanceDate: '2026-09-10',
    balanceSource: 'pdf',
  };
  const result = {
    fileName: 'statement.pdf',
    format: 'PDF',
    accounts: [
      {
        account: created,
        created: true,
        transactions: [],
        duplicates: 0,
        skipped: 0,
        from: null,
        to: null,
        balance: { amount: 5000, date: '2026-09-10', applied: true },
      },
    ],
  };
  const after = m.applyImport(base(), result, 'imp2', 'now');
  const undone = m.undoImport(after, 'imp2', 'later');
  assert.deepEqual(undone.summary.removedAccounts, ['Fictional Card']);
  assert.equal(undone.next.accounts.length, 1);

  const used = structuredClone(after);
  used.transactions.push(tx('manual', -100, { accountId: 'new-card' }));
  const kept = m.undoImport(used, 'imp2', 'later');
  assert.deepEqual(kept.summary.keptAccounts, ['Fictional Card']);
  assert.equal(kept.next.accounts.length, 2);
}

// --- Card details are restored field by field; a payment mark made since is kept ---
{
  const card = {
    id: 'card',
    name: 'Fictional Card',
    institution: 'Example',
    type: 'Credit card',
    balance: 40000,
    credit: { limit: 300000, apr: 19.99, paidDueDates: [] },
  };
  const start = { ...base(), accounts: [card], transactions: [] };
  const statement = {
    issuer: 'Example',
    last4: '9876',
    closingDate: '2026-09-10',
    newBalance: 52000,
    minimumPayment: 3500,
    dueDate: '2026-10-05',
    creditLimit: 350000,
    purchaseApr: 21.5,
  };
  const updated = m.applyStatement(card, statement);
  const after = m.applyImport(
    start,
    {
      fileName: 'statement.pdf',
      format: 'PDF',
      accounts: [
        {
          account: updated,
          created: false,
          transactions: [],
          duplicates: 0,
          skipped: 0,
          from: null,
          to: null,
          balance: { amount: 52000, date: '2026-09-10', applied: true },
        },
      ],
    },
    'imp3',
    'now',
  );
  after.accounts[0].credit.paidDueDates = ['2026-10-05'];
  const { next } = m.undoImport(after, 'imp3', 'later');
  assert.deepEqual(next.accounts[0], {
    ...card,
    credit: { limit: 300000, apr: 19.99, paidDueDates: ['2026-10-05'] },
  });
}

// --- History keeps the most recent imports ---
{
  let data = base();
  data.imports = Array.from({ length: m.MAX_IMPORTS }, (_, i) => ({
    id: `old-${i}`,
    at: 'then',
    fileName: 'old.csv',
    format: 'CSV',
    accounts: [],
  }));
  data = imported(data, 'newest');
  assert.equal(data.imports.length, m.MAX_IMPORTS);
  assert.equal(data.imports[0].id, 'old-1');
  assert.equal(data.imports.at(-1).id, 'newest');
}

// --- Balances carry a date and source; older statements do not replace newer balances ---
{
  const card = {
    id: 'card',
    name: 'Fictional Card',
    institution: 'Example',
    type: 'Credit card',
    balance: 61000,
    balanceDate: '2026-09-10',
    balanceSource: 'pdf',
    credit: { limit: 300000, apr: null, dueDate: '2026-10-05' },
  };
  const older = {
    issuer: 'Example',
    last4: '9876',
    closingDate: '2026-08-10',
    newBalance: 45000,
    minimumPayment: 2500,
    dueDate: '2026-09-05',
    creditLimit: 250000,
    purchaseApr: 22.24,
  };
  assert.equal(m.olderThanBalance(card, older.closingDate), true);
  assert.equal(m.olderThanBalance(card, '2026-09-10'), false);
  assert.equal(m.olderThanBalance({ ...card, balanceDate: undefined }, '2020-01-01'), false);
  const kept = m.applyStatement(card, older);
  assert.deepEqual(
    [kept.balance, kept.balanceDate, kept.balanceSource],
    [61000, '2026-09-10', 'pdf'],
  );
  assert.equal(kept.credit.limit, 300000, 'known details are not replaced by older ones');
  assert.equal(kept.credit.dueDate, '2026-10-05');
  assert.equal(kept.credit.apr, 22.24, 'missing details are filled in');
  assert.equal(kept.credit.minimumPayment, 2500);

  const newer = m.applyStatement(card, { ...older, closingDate: '2026-10-10', newBalance: 70000 });
  assert.deepEqual(
    [newer.balance, newer.balanceDate, newer.balanceSource, newer.credit.limit],
    [70000, '2026-10-10', 'pdf', 250000],
  );
  assert.equal(m.balanceNote(newer), 'Statement PDF · Oct 10, 2026');
  assert.equal(m.balanceNote({ ...card, balanceDate: undefined }), 'Manual balance');
}

// --- Small helpers ---
assert.deepEqual(
  m.dateRange([{ date: '2026-09-03' }, { date: '2026-08-30' }, { date: '2026-09-01' }]),
  ['2026-08-30', '2026-09-03'],
);
assert.deepEqual(m.dateRange([]), [null, null]);
assert.equal(
  m.csvHeaderSignature(['﻿Trans. Date', 'Post Date', 'Description']),
  m.csvHeaderSignature(['trans date', 'POST DATE', 'description']),
);
assert.equal(m.sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
assert.equal(m.sameValue({ a: 1 }, { a: 1, b: 2 }), false);

console.log(
  'Passed: change-only saves, older workspaces and lock settings, 12,000+ transactions, import history, undo with later edits kept, created accounts, card details field by field, history limit, dated balances and older statements, helpers.',
);
