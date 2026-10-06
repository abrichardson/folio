import { useState, type FormEvent } from 'react';
import { AlarmClock, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { cash, today, type Account, type Finance, type Promotion } from '@/lib/finance';
import { parseAmount } from '@/lib/import/csv';
import {
  activePromotions,
  daysUntil,
  deferredInterestAtRisk,
  monthlyNeeded,
  progress,
  promotionStatus,
  promotionsExceedBalance,
  targetDate,
} from '@/lib/promotions';

type Save = (next: Finance, message?: string) => Promise<boolean>;
const longDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const statusText: Record<ReturnType<typeof promotionStatus>, string> = {
  paid: 'Paid off',
  expired: 'Deadline passed',
  urgent: 'Due very soon',
  soon: 'Ending soon',
  'on track': 'On track',
};

function withPromotions(data: Finance, accountId: string, promotions: Promotion[]): Finance {
  return {
    ...data,
    accounts: data.accounts.map((a) => (a.id === accountId ? { ...a, promotions } : a)),
  };
}

/** A card's promotional balances, with the payment each needs to be cleared in time. */
export function PromotionsSection({
  account,
  data,
  saving,
  save,
}: {
  account: Account;
  data: Finance;
  saving: boolean;
  save: Save;
}) {
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const all = [...(account.promotions ?? [])].sort((a, b) => a.endDate.localeCompare(b.endDate));
  const shown = showPaid ? all : all.filter((p) => p.balance > 0);
  const now = today();
  return (
    <div className="promotions">
      <div className="promotions-head">
        <b>Promotions</b>
        <button className="text-button" disabled={saving} onClick={() => setEditing('new')}>
          <Plus size={14} /> Add
        </button>
      </div>
      {!all.length && (
        <p className="form-hint">
          Track deferred-interest and 0% offers here, or import a statement PDF that lists them.
        </p>
      )}
      {promotionsExceedBalance(account) && (
        <p className="form-hint negative">
          Promotional balances add up to more than the card balance. Update them from your latest
          statement.
        </p>
      )}
      {shown.map((p) => {
        const status = promotionStatus(p, now);
        const risk = deferredInterestAtRisk(p, account.credit?.apr);
        const share = progress(p);
        const days = daysUntil(p.endDate, now);
        return (
          <div className={'promotion status-' + status.replace(' ', '-')} key={p.id}>
            <div className="promotion-top">
              <div>
                <b>{p.description || 'Promotional balance'}</b>
                <span className="pill">
                  {p.kind === 'deferred' ? 'Deferred interest' : '0% APR'}
                </span>
              </div>
              <button
                className="icon-button"
                aria-label={`Edit ${p.description || 'promotion'}`}
                disabled={saving}
                onClick={() => setEditing(p)}
              >
                <Pencil size={14} />
              </button>
            </div>
            <div className="promotion-facts">
              <span>
                {cash(p.balance, 2)} left
                {p.originalAmount ? ` of ${cash(p.originalAmount, 2)}` : ''}
              </span>
              <span>
                {status === 'expired'
                  ? `Ended ${longDate(p.endDate)}`
                  : `Ends ${longDate(p.endDate)} · ${days} day${days === 1 ? '' : 's'}`}
              </span>
            </div>
            {share !== null && (
              <Progress value={share * 100} aria-label={`${p.description} paid down`} />
            )}
            {p.balance > 0 && status !== 'expired' && (
              <p className="promotion-plan">
                <AlarmClock size={14} /> Pay <b>{cash(monthlyNeeded(p, now), 2)}</b> a month to
                clear it by {longDate(targetDate(p))}
                {p.payoffBy ? ' (your target)' : ''}. <em>{statusText[status]}.</em>
              </p>
            )}
            {p.kind === 'deferred' && p.balance > 0 && (
              <p className={'form-hint' + (status === 'on track' ? '' : ' negative')}>
                {status === 'expired'
                  ? 'The deadline has passed with a balance left; deferred interest may have been charged. Check your next statement.'
                  : risk
                    ? `If any balance is left on ${longDate(p.endDate)}, about ${cash(risk, 2)} of interest is charged back${p.startDate ? ` to ${longDate(p.startDate)}` : ''}${p.accruedInterest != null ? ' (as reported by the issuer)' : ' (estimate)'}.`
                    : 'If any balance is left at the deadline, interest is charged back to the purchase date.'}
              </p>
            )}
            <small className="soft">
              As of {longDate(p.asOf)}
              {p.source === 'pdf' ? ' · from a statement' : ''}
            </small>
          </div>
        );
      })}
      {all.length > shown.length && (
        <button className="text-button" onClick={() => setShowPaid(true)}>
          Show {all.length - shown.length} paid off
        </button>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && !saving && setEditing(null)}>
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'Add a promotion' : 'Edit promotion'}</DialogTitle>
            <DialogDescription>
              A promotional balance is part of this card&apos;s balance with its own deadline.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <PromotionForm
              promotion={editing === 'new' ? null : editing}
              cardApr={account.credit?.apr ?? null}
              saving={saving}
              onDelete={async (id) => {
                const next = all.filter((p) => p.id !== id);
                if (await save(withPromotions(data, account.id, next), 'Promotion removed'))
                  setEditing(null);
              }}
              onSave={async (p) => {
                const next = all.some((x) => x.id === p.id)
                  ? all.map((x) => (x.id === p.id ? p : x))
                  : [...all, p];
                if (await save(withPromotions(data, account.id, next), 'Promotion saved'))
                  setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PromotionForm({
  promotion,
  cardApr,
  saving,
  onSave,
  onDelete,
}: {
  promotion: Promotion | null;
  cardApr: number | null;
  saving: boolean;
  onSave: (p: Promotion) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const dollars = (c: number | null | undefined) => (c == null ? '' : String(c / 100));
  const [form, setForm] = useState({
    description: promotion?.description ?? '',
    kind: promotion?.kind ?? 'deferred',
    originalAmount: dollars(promotion?.originalAmount),
    balance: dollars(promotion?.balance),
    startDate: promotion?.startDate ?? '',
    endDate: promotion?.endDate ?? '',
    payoffBy: promotion?.payoffBy ?? '',
    aprAfter:
      promotion?.aprAfter == null
        ? cardApr == null
          ? ''
          : String(cardApr)
        : String(promotion.aprAfter),
  });
  const [error, setError] = useState('');
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const balance = parseAmount(form.balance);
    const original = form.originalAmount.trim() ? parseAmount(form.originalAmount) : null;
    const apr = form.aprAfter.trim() ? Number(form.aprAfter) : null;
    if (balance === null || balance < 0) return setError('Enter the promotional balance owed.');
    if (form.originalAmount.trim() && (original === null || original < 0))
      return setError('Enter the original amount as a number, or leave it blank.');
    if (!form.endDate) return setError('Enter the date the promotion ends.');
    if (apr !== null && (!Number.isFinite(apr) || apr < 0 || apr > 100))
      return setError('Enter the APR as a percentage, for example 29.99.');
    if (form.payoffBy && form.payoffBy > form.endDate)
      return setError('Your target should be on or before the promotion ends.');
    void onSave({
      id: promotion?.id ?? crypto.randomUUID(),
      description: form.description.trim().slice(0, 100),
      kind: form.kind as Promotion['kind'],
      originalAmount: original,
      balance,
      startDate: form.startDate || null,
      endDate: form.endDate,
      payoffBy: form.payoffBy || null,
      aprAfter: apr,
      accruedInterest:
        promotion && promotion.balance === balance ? promotion.accruedInterest : null,
      asOf: promotion && promotion.balance === balance ? promotion.asOf : today(),
      source: promotion && promotion.balance === balance ? promotion.source : 'manual',
    });
  }

  const text = (key: keyof typeof form, label: string, type = 'text', placeholder = '') => (
    <label className="form-field">
      {label}
      <input
        type={type}
        value={form[key]}
        placeholder={placeholder}
        inputMode={type === 'text' && key !== 'description' ? 'decimal' : undefined}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  return (
    <form className="record-form" onSubmit={submit}>
      {text('description', 'What it was for', 'text', 'e.g. Living room sofa')}
      <label className="form-field">
        Kind of offer
        <Select value={form.kind} onValueChange={(v) => set('kind', v)}>
          <SelectTrigger aria-label="Kind of offer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deferred">
              Deferred interest (“no interest if paid in full”)
            </SelectItem>
            <SelectItem value="zero">True 0% APR (interest only after it ends)</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <p className="form-hint">
        {form.kind === 'deferred'
          ? 'With deferred interest, interest builds from the purchase date. If any of the balance is left when the promotion ends, all of it is charged at once.'
          : 'With a true 0% APR, nothing is charged back; interest starts on what is left once the promotion ends.'}
      </p>
      <div className="form-grid">
        {text('balance', 'Promotional balance left (USD)')}
        {text('originalAmount', 'Original amount (optional)')}
        {text('startDate', 'Purchase date (optional)', 'date')}
        {text('endDate', 'Promotion ends', 'date')}
        {text('aprAfter', 'APR afterward (%)')}
        {text('payoffBy', 'Pay off by (optional target)', 'date')}
      </div>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {promotion ? (
          <button
            type="button"
            className="icon-button danger"
            aria-label="Delete promotion"
            disabled={saving}
            onClick={() => void onDelete(promotion.id)}
          >
            <Trash2 size={16} />
          </button>
        ) : (
          <span />
        )}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save promotion'}
        </button>
      </div>
    </form>
  );
}

/** Promotions across all cards ending within 120 days, for the overview. */
export function PromotionDeadlines({ data, onOpen }: { data: Finance; onOpen: () => void }) {
  const now = today();
  const items = data.accounts
    .filter((a) => a.type === 'Credit card')
    .flatMap((a) => activePromotions(a).map((p) => ({ a, p })))
    .filter(({ p }) => daysUntil(p.endDate, now) <= 120)
    .sort((x, y) => x.p.endDate.localeCompare(y.p.endDate))
    .slice(0, 5);
  if (!items.length) return null;
  return (
    <section className="panel promo-deadlines">
      <div className="panel-title">
        <h2>Promotions ending soon</h2>
        <button className="text-button" onClick={onOpen}>
          Credit cards
        </button>
      </div>
      {items.map(({ a, p }) => {
        const status = promotionStatus(p, now);
        return (
          <div className="deadline-row" key={p.id}>
            <div>
              <b>{p.description || 'Promotional balance'}</b>
              <small>
                {a.name} · {p.kind === 'deferred' ? 'deferred interest' : '0% APR'}
              </small>
            </div>
            <div className={status === 'on track' ? '' : 'negative'}>
              <b>{cash(p.balance, 2)}</b>
              <small>
                {status === 'expired' ? 'ended ' : 'by '}
                {longDate(p.endDate)}
                {status !== 'expired' && ` · ${cash(monthlyNeeded(p, now), 2)}/mo`}
              </small>
            </div>
          </div>
        );
      })}
    </section>
  );
}
