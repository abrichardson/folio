import { useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCheck, Lock, Scale } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { balanceNote, cash, liability, today, type Account, type Finance } from '@/lib/finance';
import { parseAmount } from '@/lib/import/csv';
import { CategoryPill } from './category-pill';
import {
  applyReconciliation,
  bankDifference,
  clearedBalance,
  reconcilable,
  registerRows,
  suggestedOpening,
} from '@/lib/register';

const PAGE = 50;
const longDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
/** Balances shown the way the Accounts page shows them: amounts owed are negative. */
const shown = (account: Account, balance: number) =>
  cash(liability(account) ? -balance : balance, 2);
const dollars = (cents: number) => (cents / 100).toFixed(2);

type Save = (next: Finance, message?: string) => Promise<boolean>;

/** One account's transactions with running balances, cleared marks, and reconciliation. */
export function RegisterView({
  data,
  accountId,
  saving,
  save,
  onBack,
  onEditTransaction,
}: {
  data: Finance;
  accountId: string;
  saving: boolean;
  save: Save;
  onBack: () => void;
  onEditTransaction: (id: string) => void;
}) {
  const account = data.accounts.find((a) => a.id === accountId);
  const rows = useMemo(
    () => (account ? registerRows(account, data.transactions) : []),
    [account, data.transactions],
  );
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<'opening' | 'reconcile' | null>(null);
  if (!account)
    return (
      <section className="panel">
        <p>This account no longer exists.</p>
        <button className="secondary" onClick={onBack}>
          <ArrowLeft size={16} /> All accounts
        </button>
      </section>
    );
  const newestFirst = [...rows].reverse();
  const pages = Math.max(1, Math.ceil(newestFirst.length / PAGE));
  const current = Math.min(page, pages);
  const latest = [...rows].reverse().find((r) => r.balance !== null)?.balance;
  const registerBalance = account.openingBalance ? (latest ?? account.openingBalance.amount) : null;
  const difference = bankDifference(account, data.transactions);
  // Opening balance plus everything cleared or reconciled.
  const clearedNow = clearedBalance(
    account,
    data.transactions,
    '9999-12-31',
    new Set(data.transactions.filter((t) => t.status === 'cleared').map((t) => t.id)),
  );

  async function toggle(id: string) {
    const t = data.transactions.find((x) => x.id === id);
    if (!t || t.status === 'reconciled') return;
    const marked = t.status !== 'cleared';
    const next = {
      ...data,
      transactions: data.transactions.map((x) => {
        if (x.id !== id) return x;
        if (marked) return { ...x, status: 'cleared' as const };
        const unmarked = { ...x };
        delete unmarked.status;
        return unmarked;
      }),
    };
    await save(next, marked ? 'Marked cleared' : 'Marked not cleared');
  }

  return (
    <>
      <div className="register-head">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={16} /> All accounts
        </button>
        <div className="register-actions">
          <button className="secondary" disabled={saving} onClick={() => setDialog('opening')}>
            Opening balance
          </button>
          <button
            className="primary"
            disabled={saving || !account.openingBalance}
            title={account.openingBalance ? undefined : 'Set an opening balance first'}
            onClick={() => setDialog('reconcile')}
          >
            <Scale size={16} /> Reconcile
          </button>
        </div>
      </div>
      <section className="panel register-summary">
        <div>
          <span>{account.institution}</span>
          <h2>{account.name}</h2>
        </div>
        <dl>
          <div>
            <dt>Register balance</dt>
            <dd>{registerBalance === null ? '—' : shown(account, registerBalance)}</dd>
          </div>
          <div>
            <dt>Cleared balance</dt>
            <dd>{clearedNow === null ? '—' : shown(account, clearedNow)}</dd>
          </div>
          <div>
            <dt>Bank balance</dt>
            <dd>{shown(account, account.balance)}</dd>
            <small>{balanceNote(account)}</small>
          </div>
          <div>
            <dt>Difference</dt>
            <dd className={difference ? 'negative' : difference === 0 ? 'positive' : ''}>
              {difference === null
                ? '—'
                : difference === 0
                  ? 'Matches the bank'
                  : shown(account, difference)}
            </dd>
            {difference !== null && difference !== 0 && (
              <small>Register minus bank on {longDate(account.balanceDate!)}</small>
            )}
          </div>
        </dl>
        {!account.openingBalance && (
          <p className="form-hint">
            Set an opening balance to see running balances and compare them with the bank.
            {account.balanceDate
              ? ' Folio can suggest one that makes the register agree with the bank balance.'
              : ''}
          </p>
        )}
        {difference !== null && difference !== 0 && (
          <p className="form-hint">
            The register and the bank disagree. Look for a missing or duplicated entry, a mistyped
            amount, or an opening balance that needs correcting.
          </p>
        )}
        {account.lastReconciled && (
          <p className="form-hint">
            Last reconciled to the statement of {longDate(account.lastReconciled.date)} (
            {shown(account, account.lastReconciled.balance)}).
          </p>
        )}
      </section>
      <section className="panel table-panel">
        {!rows.length ? (
          <p className="form-hint">No transactions in this account yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Payee</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="status-cell">
                  <span title="Cleared">Clr</span>
                </TableHead>
                <TableHead className="amount-cell">Amount</TableHead>
                <TableHead className="amount-cell">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newestFirst
                .slice((current - 1) * PAGE, current * PAGE)
                .map(({ transaction: t, balance }) => (
                  <TableRow key={t.id} className={t.pending ? 'pending-row' : undefined}>
                    <TableCell className="date-cell">{longDate(t.date)}</TableCell>
                    <TableCell>
                      <button className="merchant-link" onClick={() => onEditTransaction(t.id)}>
                        {t.merchant}
                      </button>
                      {t.pending && <span className="soft"> · pending</span>}
                    </TableCell>
                    <TableCell>
                      <CategoryPill transaction={t} />
                    </TableCell>
                    <TableCell className="status-cell">
                      {t.status === 'reconciled' ? (
                        <span className="status-mark reconciled" title="Reconciled">
                          <Lock size={13} />
                        </span>
                      ) : (
                        <button
                          className={'status-mark' + (t.status === 'cleared' ? ' cleared' : '')}
                          disabled={saving || t.pending}
                          aria-pressed={t.status === 'cleared'}
                          aria-label={`${t.status === 'cleared' ? 'Unmark' : 'Mark'} ${t.merchant} as cleared`}
                          onClick={() => void toggle(t.id)}
                        >
                          {t.status === 'cleared' ? 'C' : ''}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className={'amount-cell' + (t.amount > 0 ? ' positive' : '')}>
                      {t.amount > 0 ? '+' : ''}
                      {cash(t.amount, 2)}
                    </TableCell>
                    <TableCell className="amount-cell">
                      {balance === null ? '' : shown(account, balance)}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="pager">
            <button
              className="text-button"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              Newer
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              className="text-button"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              Older
            </button>
          </div>
        )}
      </section>
      <Dialog
        open={dialog === 'opening'}
        onOpenChange={(open) => !open && !saving && setDialog(null)}
      >
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>Opening balance</DialogTitle>
            <DialogDescription>
              Where the register starts: the balance at the start of a day, before that day&apos;s
              transactions.
            </DialogDescription>
          </DialogHeader>
          {dialog === 'opening' && (
            <OpeningForm
              account={account}
              data={data}
              saving={saving}
              onSave={async (opening) => {
                const next = {
                  ...data,
                  accounts: data.accounts.map((a) => {
                    if (a.id !== account.id) return a;
                    if (opening) return { ...a, openingBalance: opening };
                    const rest = { ...a };
                    delete rest.openingBalance;
                    return rest;
                  }),
                };
                if (await save(next, opening ? 'Opening balance saved' : 'Opening balance removed'))
                  setDialog(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialog === 'reconcile'}
        onOpenChange={(open) => !open && !saving && setDialog(null)}
      >
        <DialogContent className="finance-dialog reconcile-dialog">
          <DialogHeader>
            <DialogTitle>Reconcile {account.name}</DialogTitle>
            <DialogDescription>
              Check off each transaction that appears on the statement. When the difference is zero,
              finish to lock them in.
            </DialogDescription>
          </DialogHeader>
          {dialog === 'reconcile' && (
            <ReconcileForm
              account={account}
              data={data}
              saving={saving}
              onSave={async (statement, selected, finish) => {
                const next = applyReconciliation(
                  data,
                  account.id,
                  statement,
                  selected,
                  finish,
                  new Date().toISOString(),
                );
                if (
                  await save(
                    next,
                    finish ? `${account.name} reconciled` : 'Reconciliation saved for later',
                  )
                )
                  setDialog(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OpeningForm({
  account,
  data,
  saving,
  onSave,
}: {
  account: Account;
  data: Finance;
  saving: boolean;
  onSave: (opening: { date: string; amount: number } | null) => Promise<void>;
}) {
  const suggestion = suggestedOpening(account, data.transactions);
  const start = account.openingBalance ?? suggestion;
  const [date, setDate] = useState(start?.date ?? today());
  const [amount, setAmount] = useState(start ? dollars(start.amount) : '');
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmount(amount);
    if (cents === null) return setError('Enter the balance as a number.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Choose a date.');
    void onSave({ date, amount: cents });
  }
  return (
    <form className="record-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="form-field">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="form-field">
          {liability(account) ? 'Amount owed (USD)' : 'Balance (USD)'}
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
      </div>
      {suggestion && (
        <p className="form-hint">
          Suggested: {shown(account, suggestion.amount)} on {longDate(suggestion.date)}, which makes
          the register match the bank balance of {longDate(account.balanceDate!)}.{' '}
          <button
            type="button"
            className="text-button inline"
            onClick={() => {
              setDate(suggestion.date);
              setAmount(dollars(suggestion.amount));
            }}
          >
            Use it
          </button>
        </p>
      )}
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {account.openingBalance ? (
          <button
            type="button"
            className="text-button"
            disabled={saving}
            onClick={() => void onSave(null)}
          >
            Remove opening balance
          </button>
        ) : (
          <span />
        )}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save opening balance'}
        </button>
      </div>
    </form>
  );
}

function ReconcileForm({
  account,
  data,
  saving,
  onSave,
}: {
  account: Account;
  data: Finance;
  saving: boolean;
  onSave: (
    statement: { date: string; balance: number },
    selected: Set<string>,
    finish: boolean,
  ) => Promise<void>;
}) {
  const [date, setDate] = useState(account.balanceDate ?? today());
  const [ending, setEnding] = useState(account.balanceDate ? dollars(account.balance) : '');
  const candidates = reconcilable(account, data.transactions, date);
  const [selected, setSelected] = useState(
    () =>
      new Set(
        data.transactions
          .filter((t) => t.accountId === account.id && t.status === 'cleared')
          .map((t) => t.id),
      ),
  );
  const picked = new Set(candidates.filter((t) => selected.has(t.id)).map((t) => t.id));
  const cleared = clearedBalance(account, data.transactions, date, picked);
  const statement = parseAmount(ending);
  const difference = cleared === null || statement === null ? null : statement - cleared;
  const flip = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const all = candidates.length > 0 && candidates.every((t) => selected.has(t.id));
  return (
    <div className="record-form">
      <div className="form-grid">
        <label className="form-field">
          Statement ending date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="form-field">
          {liability(account) ? 'Statement balance owed (USD)' : 'Statement ending balance (USD)'}
          <input inputMode="decimal" value={ending} onChange={(e) => setEnding(e.target.value)} />
        </label>
      </div>
      <div className="reconcile-list">
        <label className="reconcile-row reconcile-all">
          <input
            type="checkbox"
            checked={all}
            onChange={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                for (const t of candidates) {
                  if (all) next.delete(t.id);
                  else next.add(t.id);
                }
                return next;
              })
            }
          />
          <span>Select all ({candidates.length})</span>
        </label>
        {candidates.map((t) => (
          <label className="reconcile-row" key={t.id}>
            <input type="checkbox" checked={selected.has(t.id)} onChange={() => flip(t.id)} />
            <span className="soft">{longDate(t.date)}</span>
            <span className="reconcile-payee">{t.merchant}</span>
            <b className={t.amount > 0 ? 'positive' : ''}>{cash(t.amount, 2)}</b>
          </label>
        ))}
        {!candidates.length && (
          <p className="form-hint">No unreconciled transactions on or before this date.</p>
        )}
      </div>
      <dl className="statement-facts reconcile-totals">
        <div>
          <dt>Statement balance</dt>
          <dd>{statement === null ? '—' : shown(account, statement)}</dd>
        </div>
        <div>
          <dt>Cleared balance</dt>
          <dd>{cleared === null ? '—' : shown(account, cleared)}</dd>
        </div>
        <div>
          <dt>Difference</dt>
          <dd className={difference === 0 ? 'positive' : difference === null ? '' : 'negative'}>
            {difference === null ? '—' : shown(account, difference)}
          </dd>
        </div>
      </dl>
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={saving || statement === null}
          onClick={() =>
            statement !== null && void onSave({ date, balance: statement }, picked, false)
          }
        >
          Save for later
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving || difference !== 0 || statement === null}
          onClick={() =>
            statement !== null && void onSave({ date, balance: statement }, picked, true)
          }
        >
          <CheckCheck size={16} /> Finish
        </button>
      </div>
    </div>
  );
}
