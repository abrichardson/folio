import { useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Plus, Repeat, Waves, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cash, today, type Account, type Finance } from '@/lib/finance';
import { frequencyLabel } from '@/lib/bills';
import { parseAmount } from '@/lib/import/csv';
import {
  billFromSuggestion,
  cardPayment,
  confirmMatches,
  dailyBalances,
  forecast,
  matchPayments,
  suggestBills,
  type Forecast,
} from '@/lib/cashflow';

type Save = (next: Finance, message?: string) => Promise<boolean>;
const shortDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const NONE = '__none__';

/** Imported transactions that look like a scheduled payment, to confirm as paid. */
export function PaymentMatches({
  data,
  saving,
  save,
}: {
  data: Finance;
  saving: boolean;
  save: Save;
}) {
  const matches = matchPayments(data, today());
  if (!matches.length) return null;
  return (
    <section className="panel planner-panel">
      <div className="panel-title">
        <h2>Payments found in your transactions</h2>
        <button
          className="secondary"
          disabled={saving}
          onClick={() =>
            void save(
              confirmMatches(data, matches),
              `${matches.length} payment${matches.length === 1 ? '' : 's'} marked`,
            )
          }
        >
          <Check size={14} /> Confirm all
        </button>
      </div>
      {matches.map((m) => (
        <div className="planner-row" key={m.item.key}>
          <div>
            <b>{m.item.name}</b>
            <small>
              Due {shortDate(m.item.date)} · {m.tx.merchant} on {shortDate(m.tx.date)}
            </small>
          </div>
          <strong className={m.tx.amount > 0 ? 'positive' : ''}>
            {cash(Math.abs(m.tx.amount), 2)}
          </strong>
          <button
            className="text-button"
            disabled={saving}
            onClick={() =>
              void save(
                confirmMatches(data, [m]),
                m.item.income ? 'Marked received' : 'Marked paid',
              )
            }
          >
            {m.item.income ? 'Mark received' : 'Mark paid'}
          </button>
        </div>
      ))}
    </section>
  );
}

/** Payees that look recurring in imported transactions, to add as bills or income. */
export function SuggestedBills({
  data,
  saving,
  save,
}: {
  data: Finance;
  saving: boolean;
  save: Save;
}) {
  const [open, setOpen] = useState(false);
  const list = suggestBills(data, today());
  if (!list.length) return null;
  const account = (id: string) => data.accounts.find((a) => a.id === id)?.name ?? '';
  return (
    <section className="panel planner-panel">
      <button className="planner-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Repeat size={17} />
        <span>
          <b>
            {list.length} recurring payment{list.length === 1 ? '' : 's'} found in your transactions
          </b>
          <small>Add them as bills or income to see them in the forecast.</small>
        </span>
        <ChevronRight size={17} className={open ? 'rotate' : ''} />
      </button>
      {open &&
        list.map((s) => (
          <div className="planner-row" key={s.key}>
            <div>
              <b>{s.name}</b>
              <small>
                {s.kind === 'income' ? 'Income · ' : ''}
                {frequencyLabel(s.frequency)} · {s.count} times · next {shortDate(s.nextDate)}
                {account(s.accountId) ? ` · ${account(s.accountId)}` : ''}
              </small>
            </div>
            <strong className={s.kind === 'income' ? 'positive' : ''}>{cash(s.amount, 2)}</strong>
            <div className="planner-actions">
              <button
                className="secondary"
                disabled={saving}
                onClick={() =>
                  void save(
                    { ...data, bills: [...data.bills, billFromSuggestion(s, crypto.randomUUID())] },
                    `${s.name} added`,
                  )
                }
              >
                <Plus size={14} /> Add
              </button>
              <button
                className="icon-button"
                aria-label={`Not a recurring payment: ${s.name}`}
                disabled={saving}
                onClick={() =>
                  void save(
                    {
                      ...data,
                      planner: {
                        ...data.planner,
                        dismissed: [...data.planner.dismissed, s.key].slice(-500),
                      },
                    },
                    'Suggestion hidden',
                  )
                }
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ))}
    </section>
  );
}

/** A step chart of the projected balance, with the cushion as a dashed line. */
function BalanceChart({ f, days, cushion }: { f: Forecast; days: number; cushion: number }) {
  const points = dailyBalances(f, today(), days);
  const values = [...points.map((p) => p.balance), cushion, 0];
  const max = Math.max(...values),
    min = Math.min(...values);
  const span = max - min || 1;
  const W = 600,
    H = 160;
  const x = (i: number) => (i / days) * W;
  const y = (v: number) => H - ((v - min) / span) * (H - 10) - 5;
  let path = `M0 ${y(points[0].balance)}`;
  points.forEach((p, i) => {
    if (i) path += ` H${x(i)} V${y(p.balance)}`;
  });
  return (
    <svg
      className="balance-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Projected balance from ${cash(f.start)} to ${cash(f.end)}, lowest ${cash(f.lowest.balance)}`}
    >
      {min < 0 && <line className="zero" x1="0" x2={W} y1={y(0)} y2={y(0)} />}
      {cushion > 0 && <line className="cushion" x1="0" x2={W} y1={y(cushion)} y2={y(cushion)} />}
      <path d={path} />
    </svg>
  );
}

const kindLabel = { income: 'Income', bill: 'Bill', card: 'Card payment', plan: 'Plan payment' };

/** The cash-flow planner: a 30, 60, or 90 day forecast of the cash accounts. */
export function CashFlowView({
  data,
  saving,
  save,
}: {
  data: Finance;
  saving: boolean;
  save: Save;
}) {
  const [days, setDays] = useState(30);
  const [cushion, setCushion] = useState(String(data.planner.cushion / 100));
  const f = forecast(data, days, today());
  const cards = data.accounts.filter((a) => a.type === 'Credit card');
  const funds = data.accounts.filter((a) => a.type === 'Checking' || a.type === 'Savings');
  const chosen = new Set(f.accounts.map((a) => a.id));
  const setPlanner = (planner: Partial<Finance['planner']>, message: string) =>
    save({ ...data, planner: { ...data.planner, ...planner } }, message);
  const setCredit = (a: Account, credit: Partial<NonNullable<Account['credit']>>) =>
    save(
      {
        ...data,
        accounts: data.accounts.map((x) =>
          x.id === a.id ? { ...x, credit: { ...x.credit, ...credit } } : x,
        ),
      },
      'Card payment plan saved',
    );
  const warning = f.belowZero ?? f.belowCushion;
  return (
    <>
      <div className="period-bar">
        <div className="segmented" role="radiogroup" aria-label="Forecast length">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              role="radio"
              aria-checked={days === d}
              className={days === d ? 'active' : ''}
              onClick={() => setDays(d)}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      <div className="account-summary">
        <div>
          <span>Starting balance</span>
          <strong>{cash(f.start, 2)}</strong>
        </div>
        <div>
          <span>Lowest balance</span>
          <strong className={f.lowest.balance < 0 ? 'negative' : ''}>
            {cash(f.lowest.balance, 2)}
          </strong>
          <small>{shortDate(f.lowest.date)}</small>
        </div>
        <div>
          <span>In {days} days</span>
          <strong>{cash(f.end, 2)}</strong>
          <small>
            +{cash(f.moneyIn)} in · −{cash(f.moneyOut)} out
          </small>
        </div>
      </div>
      {!f.accounts.length ? (
        <p className="helper-note">
          Add a checking account, or choose the accounts to plan from below, to see a forecast.
        </p>
      ) : warning ? (
        <div className="planner-warning" role="alert">
          <AlertTriangle size={18} />
          <span>
            {f.belowZero ? (
              <>
                Your balance would go below zero on <b>{shortDate(f.belowZero.date)}</b> when{' '}
                {f.belowZero.name} ({cash(-f.belowZero.amount, 2)}) is due.
              </>
            ) : (
              <>
                Your balance would drop below your {cash(data.planner.cushion)} cushion on{' '}
                <b>{shortDate(warning.date)}</b> ({warning.name}).
              </>
            )}{' '}
            Consider moving a payment date or money between accounts.
          </span>
        </div>
      ) : (
        <p className="helper-note">
          No shortfalls in the next {days} days
          {data.planner.cushion
            ? `; you stay above your ${cash(data.planner.cushion)} cushion`
            : ''}
          .
        </p>
      )}
      {f.accounts.length > 0 && (
        <section className="panel">
          <div className="panel-title">
            <h2>Projected balance</h2>
            <span className="soft">{f.accounts.map((a) => a.name).join(', ')}</span>
          </div>
          <BalanceChart f={f} days={days} cushion={data.planner.cushion} />
          <div className="flow-table" role="table" aria-label="Scheduled money in and out">
            <div className="flow-row flow-head" role="row">
              <span role="columnheader">Date</span>
              <span role="columnheader">What</span>
              <span role="columnheader">Amount</span>
              <span role="columnheader">Balance</span>
            </div>
            <div className="flow-row" role="row">
              <span role="cell">Today</span>
              <span role="cell">Starting balance</span>
              <span role="cell" />
              <span role="cell">{cash(f.start, 2)}</span>
            </div>
            {f.events.map((e) => (
              <div className={'flow-row' + (e.balance < 0 ? ' short' : '')} role="row" key={e.key}>
                <span role="cell">{shortDate(e.date)}</span>
                <span role="cell">
                  {e.name}
                  <small>
                    {kindLabel[e.kind]}
                    {e.overdue ? ' · overdue, not marked paid' : ''}
                    {e.estimate ? ' · estimate' : ''}
                  </small>
                </span>
                <span role="cell" className={e.amount > 0 ? 'positive' : ''}>
                  {e.amount > 0 ? '+' : '−'}
                  {cash(Math.abs(e.amount), 2)}
                </span>
                <span role="cell" className={e.balance < 0 ? 'negative' : ''}>
                  {cash(e.balance, 2)}
                </span>
              </div>
            ))}
            {!f.events.length && (
              <p className="form-hint">
                Nothing scheduled. Add bills and income on the Bills page, card due dates on Credit
                cards, and plans on Loans.
              </p>
            )}
          </div>
          {f.unknownCards.length > 0 && (
            <p className="form-hint">
              Left out because the payment amount is unknown: {f.unknownCards.join(', ')}. Enter a
              minimum payment or choose a payment plan below.
            </p>
          )}
        </section>
      )}
      <div className="planner-settings">
        <section className="panel">
          <h2>Plan from</h2>
          <p className="form-hint">
            The forecast starts from these accounts’ balances. With none chosen, every checking
            account is used. Bills and plans paid from other accounts are left out.
          </p>
          {funds.map((a) => (
            <label className="check-row" key={a.id}>
              <input
                type="checkbox"
                checked={chosen.has(a.id)}
                disabled={saving}
                onChange={() => {
                  const next = new Set(chosen);
                  if (next.has(a.id)) next.delete(a.id);
                  else next.add(a.id);
                  void setPlanner({ accountIds: [...next] }, 'Forecast accounts saved');
                }}
              />
              {a.name} <span className="soft">{cash(a.balance, 2)}</span>
            </label>
          ))}
          {!funds.length && <p className="form-hint">No checking or savings accounts yet.</p>}
          <form
            className="cushion-form"
            onSubmit={(e) => {
              e.preventDefault();
              const value = parseAmount(cushion);
              if (value === null || value < 0) return;
              void setPlanner({ cushion: value }, 'Cushion saved');
            }}
          >
            <label className="form-field">
              Warn below (cushion)
              <input
                inputMode="decimal"
                value={cushion}
                onChange={(e) => setCushion(e.target.value)}
              />
            </label>
            <button className="secondary" disabled={saving}>
              Save
            </button>
          </form>
        </section>
        <section className="panel">
          <h2>Card payments</h2>
          <p className="form-hint">
            What you plan to pay on each card. Later months repeat the same amount as an estimate,
            unless you set your own amount.
          </p>
          {cards.map((a) => (
            <CardPlan key={a.id} card={a} funds={funds} saving={saving} onChange={setCredit} />
          ))}
          {!cards.length && <p className="form-hint">No credit cards yet.</p>}
        </section>
      </div>
      <p className="helper-note">
        The forecast is built from your schedules and today’s account balances. It doesn’t move
        money, and it doesn’t include spending that isn’t scheduled.
      </p>
    </>
  );
}

function CardPlan({
  card,
  funds,
  saving,
  onChange,
}: {
  card: Account;
  funds: Account[];
  saving: boolean;
  onChange: (a: Account, credit: Partial<NonNullable<Account['credit']>>) => Promise<boolean>;
}) {
  const c = card.credit ?? {};
  const [amount, setAmount] = useState(
    c.plannedPayment != null ? String(c.plannedPayment / 100) : '',
  );
  const plan = c.paymentPlan ?? 'minimum';
  const amountNow = cardPayment(card);
  return (
    <div className="card-plan">
      <div className="card-plan-head">
        <b>{card.name}</b>
        <span className="soft">
          {c.dueDate ? `Due ${shortDate(c.dueDate)}` : 'No due date'} ·{' '}
          {amountNow == null ? 'amount unknown' : cash(amountNow, 2)}
        </span>
      </div>
      <div className="form-grid">
        <Select
          value={plan}
          disabled={saving}
          onValueChange={(v) =>
            void onChange(card, { paymentPlan: v as 'minimum' | 'statement' | 'custom' })
          }
        >
          <SelectTrigger aria-label={`${card.name} payment plan`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minimum">Minimum payment</SelectItem>
            <SelectItem value="statement">Statement balance</SelectItem>
            <SelectItem value="custom">My own amount</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={c.payFromId ?? NONE}
          disabled={saving}
          onValueChange={(v) => void onChange(card, { payFromId: v === NONE ? undefined : v })}
        >
          <SelectTrigger aria-label={`${card.name} paid from`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Paid from: any account</SelectItem>
            {funds.map((f) => (
              <SelectItem value={f.id} key={f.id}>
                Paid from {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {plan === 'custom' && (
        <form
          className="cushion-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = parseAmount(amount);
            if (value === null || value < 0) return;
            void onChange(card, { plannedPayment: value });
          }}
        >
          <label className="form-field">
            Monthly amount
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button className="secondary" disabled={saving}>
            Save
          </button>
        </form>
      )}
    </div>
  );
}

/** Overview: a one-line forecast for the next 30 days. */
export function ForecastStrip({ data, onOpen }: { data: Finance; onOpen: () => void }) {
  const f = forecast(data, 30, today());
  if (!f.accounts.length || !f.events.length) return null;
  const warning = f.belowZero ?? f.belowCushion;
  return (
    <button className={'upcoming-strip' + (warning ? ' warning' : '')} onClick={onOpen}>
      {warning ? <AlertTriangle size={20} /> : <Waves size={20} />}
      <span>
        <b>
          {f.belowZero
            ? `Checking may go below zero on ${shortDate(f.belowZero.date)}`
            : warning
              ? `Checking may drop below your cushion on ${shortDate(warning.date)}`
              : 'Checking stays covered for the next 30 days'}
        </b>
        <small>
          Lowest {cash(f.lowest.balance)} on {shortDate(f.lowest.date)} · {f.events.length}{' '}
          scheduled
        </small>
      </span>
      <strong>{cash(f.end)}</strong>
      <ChevronRight size={18} />
    </button>
  );
}
