'use client';
import { useState, type FormEvent } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Check,
  Pencil,
  Trash2,
  FileText,
  RotateCcw,
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Empty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PromotionsSection } from './promotions';
import {
  cash,
  today,
  withTodaySnapshot,
  olderThanBalance,
  billSchema,
  allCategories,
  type Finance,
  type Account,
  type Bill,
} from '@/lib/finance';
import {
  dueItems,
  monthEnd,
  dueStatus,
  togglePaid,
  frequencyLabel,
  type DueItem,
} from '@/lib/bills';
import { PaymentMatches, SuggestedBills } from './cashflow';
import {
  looksLikeStatement,
  parseStatementText,
  type StatementSummary,
} from '@/lib/import/statement';
import { pdfTextLines } from './pdf-text';
type Props = {
  data: Finance;
  saving: boolean;
  save: (data: Finance, message?: string) => Promise<boolean>;
};
const dayLabel = (date: string) =>
  new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const money = (value: number | null | undefined) =>
  value == null ? 'Not provided' : cash(value, 2);
function Pick({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem value={o.value} key={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function CardsView({ data, saving, save, onAdd }: Props & { onAdd: () => void }) {
  const cards = data.accounts.filter((a) => a.type === 'Credit card');
  const [editing, setEditing] = useState<Account | null>(null);
  const known = cards.filter((a) => (a.credit?.limit ?? 0) > 0);
  const totalLimit = known.reduce((s, a) => s + a.credit!.limit!, 0),
    used = known.reduce((s, a) => s + Math.max(0, a.balance), 0);
  return (
    <>
      <div className="account-summary">
        <div>
          <span>Total card balance</span>
          <strong>
            {cash(
              cards.reduce((s, a) => s + a.balance, 0),
              2,
            )}
          </strong>
        </div>
        <div>
          <span>Known credit limits</span>
          <strong>{cash(totalLimit)}</strong>
        </div>
        <div>
          <span>Utilization · cards with limits</span>
          <strong>
            {totalLimit ? Math.round((used / totalLimit) * 100) + '%' : 'Not available'}
          </strong>
        </div>
      </div>
      <p className="helper-note">
        Payment checkmarks are your own records. Confirm amounts and payment status with your card
        issuer. Folio does not schedule or send payments.
      </p>
      <div className="credit-grid">
        {cards.map((a, i) => {
          const c = a.credit,
            percent = c?.limit ? (Math.max(0, a.balance) / c.limit) * 100 : null,
            paid = !!c?.dueDate && !!c.paidDueDates?.includes(c.dueDate);
          return (
            <section className="panel credit-panel" key={a.id}>
              <div className={'credit-face face-' + (i % 3)}>
                <div>
                  <span>{a.institution}</span>
                  <CreditCard size={24} />
                </div>
                <h2>{a.name}</h2>
                <div>
                  <strong>{cash(a.balance, 2)}</strong>
                  <span>{a.mask ? '•••• ' + a.mask : 'Manual card'}</span>
                </div>
              </div>
              <div className="utilization">
                <span>Credit used</span>
                <b>{percent == null ? 'Limit not provided' : Math.round(percent) + '%'}</b>
              </div>
              <Progress value={Math.min(100, percent ?? 0)} aria-label={`${a.name} utilization`} />
              <div className="card-details">
                <div>
                  <span>Credit limit</span>
                  <b>{money(c?.limit)}</b>
                </div>
                <div>
                  <span>Last statement balance</span>
                  <b>
                    {money(c?.statementBalance)}
                    {c?.statementDate && <small>{dayLabel(c.statementDate)}</small>}
                  </b>
                </div>
                <div>
                  <span>Minimum payment</span>
                  <b>{money(c?.minimumPayment)}</b>
                </div>
                <div>
                  <span>Next due date</span>
                  <b className={!paid && c?.dueDate && c.dueDate < today() ? 'negative' : ''}>
                    {c?.dueDate ? dayLabel(c.dueDate) : 'Not provided'}
                  </b>
                </div>
                <div>
                  <span>Purchase APR</span>
                  <b>{c?.apr == null ? 'Not provided' : c.apr + '%'}</b>
                </div>
                <div>
                  <span>Last reported payment</span>
                  <b>
                    {money(c?.lastPaymentAmount)}
                    {c?.lastPaymentDate && <small>{dayLabel(c.lastPaymentDate)}</small>}
                  </b>
                </div>
              </div>
              <PromotionsSection account={a} data={data} saving={saving} save={save} />
              <div className="card-state">
                <span className="pill">{a.plaidItemId ? 'Plaid Sandbox' : 'Manual tracking'}</span>
                {c?.autopay && <span className="pill">Autopay reminder</span>}
                {c?.isOverdue && <span className="negative">Issuer reports overdue</span>}
              </div>
              {a.balanceUnavailable && (
                <p className="negative form-hint">
                  Current balance unavailable; showing the last saved balance, or zero if none.
                </p>
              )}
              <div className="card-actions">
                <button className="secondary" disabled={saving} onClick={() => setEditing(a)}>
                  <Pencil size={14} />
                  {a.plaidItemId ? 'Payment reminders' : 'Edit card details'}
                </button>
                {c?.dueDate && (
                  <button
                    className={paid ? 'secondary' : 'primary'}
                    disabled={saving}
                    onClick={() => {
                      const item: DueItem = {
                        key: '',
                        id: a.id,
                        name: a.name,
                        date: c.dueDate!,
                        amount: c.minimumPayment ?? null,
                        paid,
                        autopay: false,
                        kind: 'card',
                      };
                      void save(
                        togglePaid(data, item),
                        paid ? 'Payment mark removed' : 'Payment marked paid',
                      );
                    }}
                  >
                    {paid ? <RotateCcw size={15} /> : <Check size={15} />}{' '}
                    {paid ? 'Undo paid' : 'Mark paid'}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {!cards.length && (
        <section className="panel">
          <Empty>
            <CreditCard size={30} />
            <EmptyTitle>A clearer view of your credit</EmptyTitle>
            <EmptyDescription>
              Add a card manually or connect a Sandbox bank from Accounts.
            </EmptyDescription>
            <button className="primary" onClick={onAdd}>
              Add a credit card
            </button>
          </Empty>
        </section>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o && !saving) setEditing(null);
        }}
      >
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>{editing?.name}</DialogTitle>
            <DialogDescription>
              {editing?.plaidItemId
                ? 'Bank-reported amounts update when you sync. Manage your personal payment reminders here.'
                : 'Track your latest statement and upcoming payment.'}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <CardForm
              key={editing.id}
              account={editing}
              saving={saving}
              onSave={async (a) => {
                if (await save(withSnapshot(data, a), 'Card details saved')) setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
/** Replaces a card and records today's net worth, as editing any account balance does. */
function withSnapshot(data: Finance, account: Account): Finance {
  const next = {
    ...data,
    accounts: data.accounts.map((old) => (old.id === account.id ? account : old)),
  };
  return { ...next, snapshots: withTodaySnapshot(next) };
}
function CardForm({
  account,
  saving,
  onSave,
}: {
  account: Account;
  saving: boolean;
  onSave: (a: Account) => Promise<void>;
}) {
  const c = account.credit;
  const dollars = (cents: number | null | undefined) => (cents == null ? '' : String(cents / 100));
  const [form, setForm] = useState({
    limit: dollars(c?.limit),
    balance: dollars(account.balance),
    minimumPayment: dollars(c?.minimumPayment),
    dueDate: c?.dueDate || '',
    apr: c?.apr == null ? '' : String(c.apr),
    autopay: c?.autopay || false,
  });
  // Set when the user fills the form from a statement PDF.
  const [statement, setStatement] = useState<StatementSummary | null>(null);
  const older = !!statement && olderThanBalance(account, statement.closingDate);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState('');
  const field = (
    key: 'limit' | 'balance' | 'minimumPayment' | 'apr' | 'dueDate',
    label: string,
    type = 'number',
  ) => (
    <label className="form-field">
      {label}
      <input
        disabled={!!account.plaidItemId}
        type={type}
        step={type === 'date' ? undefined : '.01'}
        min={type === 'date' ? '2000-01-01' : key === 'balance' ? undefined : '0'}
        max={type === 'date' ? undefined : key === 'apr' ? 1000 : 1000000000}
        value={form[key]}
        onInput={(e) => {
          const value = e.currentTarget.value;
          setForm((prev) => ({ ...prev, [key]: value }));
        }}
      />
    </label>
  );
  async function readStatement(file: File) {
    setReading(true);
    setNotice('');
    try {
      const summary = parseStatementText(
        await pdfTextLines(new Uint8Array(await file.arrayBuffer())),
      );
      if (!looksLikeStatement(summary))
        throw new Error(
          'Folio could not find statement details in this PDF. Scanned statements are not supported yet; enter the details below.',
        );
      setStatement(summary);
      // An older statement fills in missing details but keeps the newer balance.
      const stale = olderThanBalance(account, summary.closingDate);
      setForm((prev) => ({
        ...prev,
        limit: summary.creditLimit == null ? prev.limit : dollars(summary.creditLimit),
        balance: summary.newBalance == null || stale ? prev.balance : dollars(summary.newBalance),
        minimumPayment:
          summary.minimumPayment == null ? prev.minimumPayment : dollars(summary.minimumPayment),
        dueDate: summary.dueDate ?? prev.dueDate,
        apr: summary.purchaseApr == null ? prev.apr : String(summary.purchaseApr),
      }));
      const missing = [
        summary.newBalance == null && 'balance',
        summary.creditLimit == null && 'credit limit',
        summary.minimumPayment == null && 'minimum payment',
        summary.dueDate == null && 'due date',
        summary.purchaseApr == null && 'APR',
      ].filter(Boolean);
      const mismatch =
        account.mask && summary.last4 && account.mask !== summary.last4
          ? ` This statement is for a card ending ${summary.last4}, not ${account.mask}.`
          : '';
      setNotice(
        `Filled from ${summary.issuer ?? 'the'} statement${
          summary.closingDate ? ` closing ${summary.closingDate}` : ''
        }. Check the values, then save.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}${mismatch}${
          stale
            ? ` This statement is older than the balance from ${account.balanceDate}, so the balance was not changed.`
            : ''
        }`,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'The PDF could not be read.');
    } finally {
      setReading(false);
    }
  }
  return (
    <form
      className="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = (key: 'limit' | 'balance' | 'minimumPayment') =>
          form[key] === '' ? null : Math.round(Number(form[key]) * 100);
        const balance = cents('balance');
        const changed = balance !== null && balance !== account.balance;
        // A balance read from a statement is dated by it; one typed in is dated today.
        const fromStatement = !!statement && balance === statement.newBalance && !older;
        void onSave({
          ...account,
          // One balance: what the card form shows is the account's balance everywhere.
          balance: balance ?? account.balance,
          ...(changed
            ? fromStatement
              ? { balanceDate: statement.closingDate ?? today(), balanceSource: 'pdf' as const }
              : { balanceDate: today(), balanceSource: 'manual' as const }
            : {}),
          mask: account.mask ?? statement?.last4 ?? undefined,
          credit: {
            ...c,
            limit: cents('limit'),
            minimumPayment: cents('minimumPayment'),
            dueDate: form.dueDate || null,
            apr: form.apr === '' ? null : Number(form.apr),
            autopay: form.autopay,
            ...(statement
              ? {
                  statementBalance: statement.newBalance ?? c?.statementBalance ?? null,
                  statementDate: statement.closingDate ?? c?.statementDate ?? null,
                }
              : {}),
          },
        });
      }}
    >
      {!account.plaidItemId && (
        <label className="upload-zone statement-zone">
          <FileText size={20} />
          <b>{reading ? 'Reading statement…' : 'Fill from a statement PDF'}</b>
          <span>
            Reads the balance, limit, APR, minimum payment, and due date on this computer.
          </span>
          <input
            type="file"
            title="Choose a statement PDF"
            accept=".pdf,application/pdf"
            disabled={reading || saving}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readStatement(f);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {notice && (
        <p className={statement ? 'form-hint' : 'negative'} role="status">
          {notice}
        </p>
      )}
      <div className="form-grid">
        {field('balance', 'Balance owed (USD)')}
        {field('limit', 'Credit limit (USD)')}
        {field('minimumPayment', 'Minimum payment (USD)')}
        {field('dueDate', 'Payment due date', 'date')}
      </div>
      {field('apr', 'Purchase APR (%)')}
      <label className="switch-row">
        <Switch
          checked={form.autopay}
          onCheckedChange={(autopay) => setForm({ ...form, autopay })}
        />
        Show an autopay reminder
      </label>
      <p className="form-hint">
        The balance is the same one shown on Accounts. This reminder does not enroll your card in
        autopay. Leave unknown amounts blank.
      </p>
      <button className="primary" disabled={saving || reading}>
        {saving ? 'Saving…' : 'Save card details'}
      </button>
    </form>
  );
}
export function BillsView({
  data,
  saving,
  save,
  requestAdd,
  onAddHandled,
}: Props & { requestAdd: boolean; onAddHandled: () => void }) {
  const [month, setMonth] = useState(today().slice(0, 7)),
    [edit, setEdit] = useState<Bill | null>(null),
    [open, setOpen] = useState(false),
    [remove, setRemove] = useState<Bill | null>(null);
  const isOpen = open || requestAdd;
  const from = month + '-01',
    to = monthEnd(month);
  const items = dueItems(data, from, to),
    unpaid = items.filter((i) => !i.paid && !i.income);
  const overdue = dueItems(data, '2000-01-01', today()).filter(
    (i) => !i.paid && !i.income && i.date < today() && !items.some((x) => x.key === i.key),
  );
  function step(delta: number) {
    const d = new Date(from + 'T12:00:00');
    d.setMonth(d.getMonth() + delta);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  function close() {
    setOpen(false);
    setEdit(null);
    onAddHandled();
  }
  const rows = (list: DueItem[]) =>
    list.map((item) => (
      <div className="bill-row" key={item.key}>
        <div className={'due-day ' + (item.kind === 'card' ? 'card-day' : '')}>
          <span>
            {new Date(item.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })}
          </span>
          <b>{Number(item.date.slice(-2))}</b>
        </div>
        <div className="bill-name">
          <h3>{item.name}</h3>
          <p>
            {item.kind === 'card'
              ? 'Credit card · minimum payment'
              : (item.income ? 'Income · ' : '') +
                frequencyLabel(data.bills.find((b) => b.id === item.id)?.frequency ?? 'Once')}
            {item.autopay ? ' · Autopay reminder' : ''}
          </p>
          <span
            className={
              'bill-status ' +
              (dueStatus(item) === 'Overdue' ? 'negative' : item.paid ? 'positive' : '')
            }
          >
            {dueStatus(item)}
          </span>
        </div>
        <strong className={item.income ? 'positive' : ''}>
          {item.income ? '+' : ''}
          {money(item.amount)}
        </strong>
        <div className="bill-row-actions">
          {item.kind === 'bill' && (
            <button
              className="icon-button"
              aria-label={`Edit bill ${item.name}`}
              disabled={saving}
              onClick={() => {
                setEdit(data.bills.find((b) => b.id === item.id)!);
                setOpen(true);
              }}
            >
              <Pencil size={15} />
            </button>
          )}
          <button
            className={item.paid ? 'secondary' : 'primary'}
            disabled={saving}
            onClick={() =>
              save(
                togglePaid(data, item),
                item.paid ? 'Payment mark removed' : 'Payment marked paid',
              )
            }
          >
            {item.paid ? <RotateCcw size={14} /> : <Check size={14} />}{' '}
            {item.paid ? 'Undo' : item.income ? 'Mark received' : 'Mark paid'}
          </button>
        </div>
      </div>
    ));
  const days = new Date(to + 'T12:00:00').getDate(),
    offset = new Date(from + 'T12:00:00').getDay();
  return (
    <>
      <div className="period-bar">
        <div className="month-picker">
          <button onClick={() => step(-1)} aria-label="Previous bill month">
            <ChevronLeft size={17} />
          </button>
          <CalendarDays size={17} />
          {new Date(from + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'long',
            year: 'numeric',
          })}
          <button onClick={() => step(1)} aria-label="Next bill month">
            <ChevronRight size={17} />
          </button>
        </div>
        <button className="text-button" onClick={() => setMonth(today().slice(0, 7))}>
          This month
        </button>
      </div>
      <div className="budget-overview panel">
        <div>
          <span className="muted">Unpaid this month</span>
          <h2>{cash(unpaid.reduce((n, i) => n + (i.amount ?? 0), 0))}</h2>
        </div>
        <div>
          <span className="muted">Marked paid</span>
          <h2>
            {items.filter((i) => i.paid).length} <span className="muted">of {items.length}</span>
          </h2>
        </div>
        <div>
          <span className="muted">Overdue across months</span>
          <h2 className="negative">
            {[...overdue, ...unpaid.filter((i) => i.date < today())].length}
          </h2>
        </div>
      </div>
      <p className="helper-note">
        Card bills use the latest minimum payment supplied by the issuer. Unknown amounts are
        excluded from totals. Marking paid does not move money or create a transaction.
      </p>
      <PaymentMatches data={data} saving={saving} save={save} />
      <SuggestedBills data={data} saving={saving} save={save} />
      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Due dates</TabsTrigger>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
          <TabsTrigger value="manage">Manage bills</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <section className="panel bills-list">
            {items.length ? (
              rows(items)
            ) : (
              <Empty>
                <EmptyTitle>Nothing due this month</EmptyTitle>
                <EmptyDescription>
                  Add a bill or enter a card’s next payment due date.
                </EmptyDescription>
              </Empty>
            )}
          </section>
          {overdue.length > 0 && (
            <section className="panel bills-list older-bills">
              <h2>Overdue outside this month</h2>
              {rows(overdue)}
            </section>
          )}
        </TabsContent>
        <TabsContent value="calendar">
          <section className="panel calendar-panel">
            <div className="calendar-grid">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div className="calendar-weekday" key={d}>
                  {d}
                </div>
              ))}
              {Array.from({ length: offset }, (_, i) => (
                <div className="calendar-blank" key={'blank' + i} />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const date = month + '-' + String(i + 1).padStart(2, '0'),
                  entries = items.filter((b) => b.date === date);
                return (
                  <div
                    className={'calendar-day ' + (date === today() ? 'calendar-today' : '')}
                    key={date}
                  >
                    <span>{i + 1}</span>
                    {entries.map((b) => (
                      <div
                        title={`${b.name}: ${money(b.amount)} · ${dueStatus(b)}`}
                        className={'calendar-bill ' + (b.paid ? 'paid' : '')}
                        key={b.key}
                      >
                        {b.paid ? '✓ ' : ''}
                        {b.name}
                        <small>{money(b.amount)}</small>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        </TabsContent>
        <TabsContent value="manage">
          <section className="panel">
            {data.bills.map((b) => (
              <div className="managed-bill" key={b.id}>
                <div>
                  <h3>{b.name}</h3>
                  <p>
                    {b.kind === 'income' ? 'Income · ' : ''}
                    {frequencyLabel(b.frequency)} · starts {dayLabel(b.dueDate)}
                    {b.endDate ? ` · ends ${dayLabel(b.endDate)}` : ''} · {cash(b.amount, 2)}
                  </p>
                </div>
                <button
                  className="icon-button"
                  aria-label={`Edit recurring bill ${b.name}`}
                  disabled={saving}
                  onClick={() => {
                    setEdit(b);
                    setOpen(true);
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`Delete bill ${b.name}`}
                  disabled={saving}
                  onClick={() => setRemove(b)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {!data.bills.length && (
              <Empty>
                <EmptyTitle>Your recurring essentials</EmptyTitle>
                <EmptyDescription>
                  Add rent, utilities, subscriptions, and other bills here.
                </EmptyDescription>
              </Empty>
            )}
          </section>
        </TabsContent>
      </Tabs>
      <Dialog
        open={isOpen}
        onOpenChange={(v) => {
          if (!v && !saving) close();
        }}
      >
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>{edit ? 'Edit bill' : 'Add bill'}</DialogTitle>
            <DialogDescription>Keep upcoming payments on your radar.</DialogDescription>
          </DialogHeader>
          {isOpen && (
            <BillForm
              key={edit?.id || 'new'}
              bill={edit}
              data={data}
              saving={saving}
              onSave={async (b) => {
                const bills = edit
                  ? data.bills.map((old) => (old.id === b.id ? b : old))
                  : [...data.bills, b];
                if (await save({ ...data, bills }, 'Bill saved')) close();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!remove}
        onOpenChange={(v) => {
          if (!v && !saving) setRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete {remove?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes this bill’s schedule and payment checkmarks. It does not cancel the bill
            with your provider.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <button
              className="primary"
              disabled={saving}
              onClick={async () => {
                if (
                  await save(
                    { ...data, bills: data.bills.filter((b) => b.id !== remove?.id) },
                    'Bill deleted',
                  )
                )
                  setRemove(null);
              }}
            >
              Delete bill
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function BillForm({
  bill,
  data,
  saving,
  onSave,
}: {
  bill: Bill | null;
  data: Finance;
  saving: boolean;
  onSave: (b: Bill) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: bill?.name || '',
    amount: bill ? String(bill.amount / 100) : '',
    dueDate: bill?.dueDate || today(),
    frequency: bill?.frequency || 'Monthly',
    accountId: bill?.accountId || 'none',
    autopay: bill?.autopay || false,
    kind: bill?.kind || 'expense',
    endDate: bill?.endDate || '',
    category: bill?.category || 'none',
    match: bill?.match || '',
  });
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = billSchema.safeParse({
      ...form,
      id: bill?.id || crypto.randomUUID(),
      amount: Math.round(Number(form.amount) * 100),
      accountId: form.accountId === 'none' ? undefined : form.accountId,
      paidDates: bill?.paidDates || [],
      endDate: form.endDate || undefined,
      category: form.category === 'none' ? undefined : form.category,
      match: form.match.trim() || undefined,
    });
    if (form.endDate && form.endDate < form.dueDate) {
      setError('The last date must be on or after the first one.');
      return;
    }
    if (!parsed.success) {
      setError('Check the bill’s name, amount, and due date.');
      return;
    }
    await onSave(parsed.data);
  }
  return (
    <form className="record-form" onSubmit={submit}>
      <div className="segmented" role="radiogroup" aria-label="Money in or out">
        {(
          [
            ['expense', 'Bill or payment'],
            ['income', 'Income'],
          ] as const
        ).map(([kind, label]) => (
          <button
            type="button"
            role="radio"
            aria-checked={form.kind === kind}
            className={form.kind === kind ? 'active' : ''}
            key={kind}
            onClick={() => setForm({ ...form, kind })}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="form-field">
        {form.kind === 'income' ? 'Name (a paycheck, for example)' : 'Bill name'}
        <input
          required
          maxLength={100}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <div className="form-grid">
        <label className="form-field">
          Amount (USD)
          <input
            type="number"
            required
            min="0"
            max="1000000000"
            step=".01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
        </label>
        <label className="form-field">
          First due date
          <input
            type="date"
            required
            min="2000-01-01"
            value={form.dueDate}
            onInput={(e) => {
              const dueDate = e.currentTarget.value;
              setForm((prev) => ({ ...prev, dueDate }));
            }}
          />
        </label>
      </div>
      <label className="form-field">
        Repeats
        <Pick
          label="Bill frequency"
          value={form.frequency}
          onChange={(frequency) => setForm({ ...form, frequency: frequency as Bill['frequency'] })}
          options={(['Once', 'Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Yearly'] as const).map(
            (value) => ({ value, label: frequencyLabel(value) }),
          )}
        />
      </label>
      {form.frequency !== 'Once' && (
        <label className="form-field">
          Last date (optional, for a schedule that ends)
          <input
            type="date"
            min={form.dueDate}
            value={form.endDate}
            onInput={(e) => {
              const endDate = e.currentTarget.value;
              setForm((prev) => ({ ...prev, endDate }));
            }}
          />
        </label>
      )}
      <div className="form-grid">
        <label className="form-field">
          Category (optional)
          <Pick
            label="Bill category"
            value={form.category}
            onChange={(category) => setForm({ ...form, category })}
            options={[
              { value: 'none', label: 'No category' },
              ...allCategories(data).map((c) => ({ value: c, label: c })),
            ]}
          />
        </label>
        <label className="form-field">
          Matches transactions containing
          <input
            maxLength={100}
            placeholder="Words from the bill’s name"
            value={form.match}
            onChange={(e) => setForm({ ...form, match: e.target.value })}
          />
        </label>
      </div>
      <label className="form-field">
        Payment account (optional)
        <Pick
          label="Bill payment account"
          value={form.accountId}
          onChange={(accountId) => setForm({ ...form, accountId })}
          options={[
            { value: 'none', label: 'No account selected' },
            ...data.accounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
      </label>
      <label className="switch-row">
        <Switch
          checked={form.autopay}
          onCheckedChange={(autopay) => setForm({ ...form, autopay })}
        />
        Show an autopay reminder
      </label>
      <p className="form-hint">
        Monthly dates fall on the last day when a month is shorter. Editing a schedule affects
        earlier months too. Autopay reminders do not set up payments. Folio suggests marking a date
        paid when an imported transaction matches it.
      </p>
      {error && <p className="negative">{error}</p>}
      <button className="primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save bill'}
      </button>
    </form>
  );
}
