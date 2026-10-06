import { useState, type FormEvent } from 'react';
import { Check, HandCoins, Pencil, Trash2, Undo2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { cash, today, type Finance, type Plan } from '@/lib/finance';
import { parseAmount } from '@/lib/import/csv';
import {
  applyRefund,
  byProvider,
  payOff,
  paymentsDue,
  recordPayment,
  remaining,
} from '@/lib/plans';

type Save = (next: Finance, message?: string) => Promise<boolean>;
const PROVIDERS = ['Affirm', 'Klarna', 'Afterpay', 'PayPal Pay in 4', 'Amazon', 'Apple Pay Later'];
const kindLabel: Record<Plan['kind'], string> = {
  bnpl: 'Buy now, pay later',
  auto: 'Auto loan',
  personal: 'Personal loan',
  other: 'Other loan',
};
const freqLabel: Record<Plan['frequency'], string> = {
  weekly: 'weekly',
  biweekly: 'every 2 weeks',
  monthly: 'monthly',
};
const longDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const plus = (date: string, days: number) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Installment plans and loans, grouped by provider, each with its own schedule. */
export function PlansView({
  data,
  saving,
  save,
  requestAdd,
  onAddHandled,
}: {
  data: Finance;
  saving: boolean;
  save: Save;
  requestAdd: boolean;
  onAddHandled: () => void;
}) {
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [refunding, setRefunding] = useState<Plan | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  // The heading's "Add plan" button opens the form without a separate state update.
  const shown = editing ?? (requestAdd ? 'new' : null);
  const close = () => {
    setEditing(null);
    onAddHandled();
  };
  const now = today();
  const active = data.plans.filter((p) => p.status === 'active');
  const owed = active.reduce((s, p) => s + p.principal, 0);
  const future = active.map(remaining);
  const totalFuture = future.reduce((s, r) => s + r.total, 0);
  const interest = future.reduce((s, r) => s + r.interest, 0);
  const due30 = paymentsDue(active, plus(now, 30)).reduce((s, p) => s + p.amount, 0);
  const listed = showClosed ? data.plans : active;
  const update = (plan: Plan, message: string) =>
    save({ ...data, plans: data.plans.map((p) => (p.id === plan.id ? plan : p)) }, message);
  const account = (id?: string) => data.accounts.find((a) => a.id === id)?.name;
  return (
    <>
      <div className="account-summary">
        <div>
          <span>Principal owed</span>
          <strong>{cash(owed, 2)}</strong>
        </div>
        <div>
          <span>Payments still scheduled</span>
          <strong>{cash(totalFuture, 2)}</strong>
        </div>
        <div>
          <span>Due in the next 30 days</span>
          <strong>{cash(due30, 2)}</strong>
        </div>
      </div>
      <p className="helper-note">
        Principal is what you owe today; scheduled payments add the interest still to come (
        {cash(interest, 2)}). Plan principal counts as a debt in your net worth. Recording a payment
        here is your own record; it does not move money.
      </p>
      {byProvider(listed).map(({ provider, plans }) => (
        <section className="panel plan-group" key={provider}>
          <div className="panel-title">
            <h2>{provider}</h2>
            <span className="soft">
              {cash(
                plans.filter((p) => p.status === 'active').reduce((s, p) => s + p.principal, 0),
                2,
              )}{' '}
              owed
            </span>
          </div>
          {plans.map((p) => {
            const r = remaining(p);
            const share = p.originalAmount ? 1 - p.principal / p.originalAmount : 0;
            return (
              <div className={'plan-row' + (p.status !== 'active' ? ' closed' : '')} key={p.id}>
                <div className="plan-main">
                  <div>
                    <b>{p.description || kindLabel[p.kind]}</b>
                    <small>
                      {kindLabel[p.kind]} · {p.apr ? `${p.apr}% APR` : '0% APR'}
                      {account(p.accountId) ? ` · from ${account(p.accountId)}` : ''}
                      {p.autopay ? ' · autopay' : ''}
                    </small>
                  </div>
                  <div className="plan-figures">
                    <b>{cash(p.principal, 2)}</b>
                    <small>of {cash(p.originalAmount, 2)}</small>
                  </div>
                </div>
                <Progress
                  value={Math.max(0, Math.min(100, share * 100))}
                  aria-label={`${p.description} paid`}
                />
                {p.status === 'active' ? (
                  <p className="plan-next">
                    Next: <b>{cash(Math.min(p.installment, r.total), 2)}</b> on{' '}
                    {longDate(p.nextDate)} · {r.payments} payment{r.payments === 1 ? '' : 's'} left,{' '}
                    {freqLabel[p.frequency]} · {cash(r.total, 2)} to pay
                    {r.interest ? ` (${cash(r.interest, 2)} interest)` : ''}
                  </p>
                ) : (
                  <p className="plan-next">{p.status === 'paid' ? 'Paid off' : 'Cancelled'}</p>
                )}
                <div className="row-actions">
                  {p.status === 'active' && (
                    <>
                      <button
                        className="secondary"
                        disabled={saving}
                        onClick={() => void update(recordPayment(p), 'Payment recorded')}
                      >
                        <Check size={14} /> Record payment
                      </button>
                      <button
                        className="text-button"
                        disabled={saving}
                        onClick={() => setRefunding(p)}
                      >
                        Refund
                      </button>
                      <button
                        className="text-button"
                        disabled={saving}
                        onClick={() => void update(payOff(p, now), 'Marked paid off')}
                      >
                        Paid off early
                      </button>
                    </>
                  )}
                  {p.status !== 'active' && (
                    <button className="text-button" disabled={saving} onClick={() => setEditing(p)}>
                      <Undo2 size={14} /> Reopen or edit
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`Edit ${p.description || provider}`}
                    disabled={saving}
                    onClick={() => setEditing(p)}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {!data.plans.length && (
        <section className="panel empty-note">
          <HandCoins size={28} />
          <h2>Installment plans in one place</h2>
          <p className="form-hint">
            Add buy-now-pay-later plans (Affirm, Klarna, Afterpay…) and auto or personal loans. Each
            keeps its own schedule, grouped by provider.
          </p>
          <button className="primary" onClick={() => setEditing('new')}>
            Add a plan
          </button>
        </section>
      )}
      {data.plans.length > active.length && (
        <button className="text-button" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? 'Hide' : 'Show'} {data.plans.length - active.length} paid off or cancelled
        </button>
      )}
      <Dialog open={!!shown} onOpenChange={(o) => !o && !saving && close()}>
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>{shown === 'new' ? 'Add a plan' : 'Edit plan'}</DialogTitle>
            <DialogDescription>
              Enter the plan as the provider shows it. Edit it later if the schedule changes.
            </DialogDescription>
          </DialogHeader>
          {shown && (
            <PlanForm
              plan={shown === 'new' ? null : shown}
              data={data}
              saving={saving}
              onDelete={async (id) => {
                if (
                  await save(
                    { ...data, plans: data.plans.filter((p) => p.id !== id) },
                    'Plan deleted',
                  )
                )
                  close();
              }}
              onSave={async (plan) => {
                const exists = data.plans.some((p) => p.id === plan.id);
                const plans = exists
                  ? data.plans.map((p) => (p.id === plan.id ? plan : p))
                  : [...data.plans, plan];
                if (await save({ ...data, plans }, 'Plan saved')) close();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={!!refunding} onOpenChange={(o) => !o && !saving && setRefunding(null)}>
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>Apply a refund</DialogTitle>
            <DialogDescription>
              A refund lowers what you owe; the remaining payments are recounted at the same
              installment.
            </DialogDescription>
          </DialogHeader>
          {refunding && (
            <RefundForm
              plan={refunding}
              saving={saving}
              onSave={async (amount) => {
                if (await update(applyRefund(refunding, amount, now), 'Refund applied'))
                  setRefunding(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RefundForm({
  plan,
  saving,
  onSave,
}: {
  plan: Plan;
  saving: boolean;
  onSave: (amount: number) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = parseAmount(amount);
        if (cents === null || cents <= 0) return setError('Enter the refund amount.');
        void onSave(cents);
      }}
    >
      <label className="form-field">
        Refund (USD)
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <p className="form-hint">Principal owed now: {cash(plan.principal, 2)}.</p>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span />
        <button className="primary" type="submit" disabled={saving}>
          Apply refund
        </button>
      </div>
    </form>
  );
}

const ACCOUNT_NONE = '__none__';

function PlanForm({
  plan,
  data,
  saving,
  onSave,
  onDelete,
}: {
  plan: Plan | null;
  data: Finance;
  saving: boolean;
  onSave: (p: Plan) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const dollars = (c: number | undefined) => (c == null ? '' : String(c / 100));
  const [form, setForm] = useState({
    provider: plan?.provider ?? 'Affirm',
    description: plan?.description ?? '',
    kind: plan?.kind ?? 'bnpl',
    originalAmount: dollars(plan?.originalAmount),
    principal: dollars(plan?.principal),
    apr: plan ? String(plan.apr) : '0',
    installment: dollars(plan?.installment),
    frequency: plan?.frequency ?? 'monthly',
    nextDate: plan?.nextDate ?? today(),
    paymentsLeft: plan ? String(plan.paymentsLeft) : '4',
    accountId: plan?.accountId ?? ACCOUNT_NONE,
    autopay: plan?.autopay ?? true,
    status: plan?.status ?? 'active',
  });
  const [error, setError] = useState('');
  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const original = parseAmount(form.originalAmount);
    const principal = form.principal.trim() ? parseAmount(form.principal) : original;
    const installment = parseAmount(form.installment);
    const apr = Number(form.apr || 0);
    const left = Number(form.paymentsLeft);
    if (!form.provider.trim()) return setError('Enter the provider or lender.');
    if (original === null || original < 0) return setError('Enter the original amount.');
    if (principal === null || principal < 0) return setError('Enter what is still owed.');
    if (installment === null || installment <= 0) return setError('Enter the payment amount.');
    if (!Number.isFinite(apr) || apr < 0 || apr > 100)
      return setError('Enter the APR, for example 0 or 9.99.');
    if (!Number.isInteger(left) || left < 0 || left > 1000)
      return setError('Enter how many payments are left.');
    void onSave({
      id: plan?.id ?? crypto.randomUUID(),
      provider: form.provider.trim().slice(0, 100),
      description: form.description.trim().slice(0, 100),
      kind: form.kind as Plan['kind'],
      originalAmount: original,
      principal,
      apr,
      installment,
      frequency: form.frequency as Plan['frequency'],
      nextDate: form.nextDate,
      paymentsLeft: left,
      ...(form.accountId !== ACCOUNT_NONE ? { accountId: form.accountId } : {}),
      autopay: form.autopay,
      status: principal === 0 ? 'paid' : (form.status as Plan['status']),
      history: plan?.history ?? [],
    });
  }

  const input = (
    key: keyof typeof form,
    label: string,
    type = 'text',
    mode?: 'decimal' | 'numeric',
  ) => (
    <label className="form-field">
      {label}
      <input
        type={type}
        inputMode={mode}
        value={String(form[key])}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const pick = (key: keyof typeof form, label: string, options: [string, string][]) => (
    <label className="form-field">
      {label}
      <Select value={String(form[key])} onValueChange={(v) => set(key, v)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([value, text]) => (
            <SelectItem key={value} value={value}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
  return (
    <form className="record-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="form-field">
          Provider or lender
          <input
            list="plan-providers"
            value={form.provider}
            onChange={(e) => set('provider', e.target.value)}
          />
          <datalist id="plan-providers">
            {PROVIDERS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        {pick('kind', 'Kind', Object.entries(kindLabel))}
      </div>
      {input('description', 'What it was for')}
      <div className="form-grid">
        {input('originalAmount', 'Original amount (USD)', 'text', 'decimal')}
        {input('principal', 'Still owed (USD)', 'text', 'decimal')}
        {input('installment', 'Payment amount (USD)', 'text', 'decimal')}
        {pick('frequency', 'How often', Object.entries(freqLabel))}
        {input('nextDate', 'Next payment', 'date')}
        {input('paymentsLeft', 'Payments left', 'number', 'numeric')}
        {input('apr', 'APR (%)', 'text', 'decimal')}
        {pick('accountId', 'Paid from', [
          [ACCOUNT_NONE, 'Not set'],
          ...data.accounts.map((a): [string, string] => [a.id, a.name]),
        ])}
        {plan &&
          pick('status', 'Status', [
            ['active', 'Active'],
            ['paid', 'Paid off'],
            ['cancelled', 'Cancelled'],
          ])}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={form.autopay}
          onChange={(e) => set('autopay', e.target.checked)}
        />
        <span>Paid automatically by the provider</span>
      </label>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {plan ? (
          <button
            type="button"
            className="icon-button danger"
            aria-label="Delete plan"
            disabled={saving}
            onClick={() => void onDelete(plan.id)}
          >
            <Trash2 size={16} />
          </button>
        ) : (
          <span />
        )}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save plan'}
        </button>
      </div>
    </form>
  );
}
