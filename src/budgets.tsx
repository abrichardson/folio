import { useState } from 'react';
import {
  CalendarClock,
  Pencil,
  PiggyBank,
  ShieldCheck,
  ShoppingBag,
  Target,
  TrendingDown,
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { allCategories, cash, spentIn, today, type Finance } from '@/lib/finance';
import { parseAmount } from '@/lib/import/csv';
import {
  adjustMonth,
  budgetGroups,
  budgetMonth,
  earmarks,
  goalProgress,
  monthlyForGoal,
} from '@/lib/budgets';

type Save = (next: Finance, message?: string) => Promise<boolean>;
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const monthName = (month: string) =>
  new Date(month + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long' });

/** Monthly budgets, grouped, with rollover and one-month adjustments. */
export function BudgetsView({
  data,
  month,
  saving,
  save,
  onEdit,
  empty,
}: {
  data: Finance;
  month: string;
  saving: boolean;
  save: Save;
  onEdit: (id: string) => void;
  empty: React.ReactNode;
}) {
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const rows = data.budgets.map((b) => ({ b, ...budgetMonth(data, b, month) }));
  const planned = rows.reduce((s, r) => s + r.available, 0);
  const spent = rows.reduce((s, r) => s + r.spent, 0);
  const tx = data.transactions.filter((t) => t.date.startsWith(month));
  const outside = allCategories(data).filter(
    (c) => c !== 'Transfer' && !data.budgets.some((b) => b.category === c) && spentIn(tx, c) > 0,
  );
  const totalSpent = outside.reduce((s, c) => s + spentIn(tx, c), spent);
  async function saveAdjustment(id: string, limit: number | null) {
    const budgets = data.budgets.map((b) => (b.id === id ? adjustMonth(b, month, limit) : b));
    if (
      await save(
        { ...data, budgets },
        limit === null ? 'Back to the usual amount' : `${monthName(month)} adjusted`,
      )
    )
      setAdjusting(null);
  }
  return (
    <>
      <div className="budget-overview panel">
        <div>
          <span className="muted">Planned for {monthName(month)}</span>
          <h2>{cash(planned)}</h2>
        </div>
        <div>
          <span className="muted">Spent in budgets</span>
          <h2>{cash(spent, 2)}</h2>
        </div>
        <div>
          <span className="muted">{planned >= spent ? 'Remaining' : 'Over budget'}</span>
          <h2 className={planned >= spent ? 'positive' : 'negative'}>
            {cash(Math.abs(planned - spent), 2)}
          </h2>
        </div>
      </div>
      {budgetGroups(data.budgets).map((g) => {
        const list = rows.filter((r) => g.budgets.includes(r.b));
        return (
          <section className="budget-group" key={g.name || 'other'}>
            {(g.name || budgetGroups(data.budgets).length > 1) && (
              <div className="budget-group-head">
                <h2>{g.name || 'Other budgets'}</h2>
                <span className="soft">
                  {cash(list.reduce((s, r) => s + r.spent, 0))} of{' '}
                  {cash(list.reduce((s, r) => s + r.available, 0))}
                </span>
              </div>
            )}
            <div className="budget-grid">
              {list.map(({ b, limit, carried, available, spent, left }) => (
                <section className="panel budget-card" key={b.id}>
                  <div className="panel-title">
                    <h2>{b.category}</h2>
                    <button
                      className="icon-button"
                      aria-label={`Edit ${b.category} budget`}
                      onClick={() => onEdit(b.id)}
                    >
                      <Pencil size={16} />
                    </button>
                  </div>
                  <div className="budget-number">
                    {cash(spent)} <span>/ {cash(available)}</span>
                  </div>
                  <Progress
                    value={clamp(available > 0 ? (spent / available) * 100 : spent > 0 ? 100 : 0)}
                    className={left < 0 ? 'over-budget' : ''}
                    aria-label={`${b.category} budget used`}
                  />
                  <p className={left < 0 ? 'negative' : 'muted'}>
                    {cash(Math.abs(left))} {left < 0 ? 'over budget' : 'left to spend'}
                    <span>{available > 0 ? Math.round((spent / available) * 100) : 0}%</span>
                  </p>
                  {(b.rollover || limit !== b.limit) && (
                    <p className="budget-detail">
                      {limit !== b.limit && `${cash(limit)} this month (usually ${cash(b.limit)})`}
                      {limit !== b.limit && b.rollover && ' · '}
                      {b.rollover &&
                        (carried >= 0
                          ? `${cash(carried)} carried in`
                          : `${cash(-carried)} overspent earlier`)}
                    </p>
                  )}
                  {adjusting === b.id ? (
                    <form
                      className="cushion-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = parseAmount(amount);
                        if (v !== null && v >= 0) void saveAdjustment(b.id, v);
                      }}
                    >
                      <label className="form-field">
                        Amount for {monthName(month)}
                        <input
                          inputMode="decimal"
                          autoFocus
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                        />
                      </label>
                      <button className="secondary" disabled={saving}>
                        Save
                      </button>
                    </form>
                  ) : (
                    <div className="budget-actions">
                      <button
                        className="text-button"
                        disabled={saving}
                        onClick={() => {
                          setAmount(String(limit / 100));
                          setAdjusting(b.id);
                        }}
                      >
                        Adjust {monthName(month)}
                      </button>
                      {limit !== b.limit && (
                        <button
                          className="text-button"
                          disabled={saving}
                          onClick={() => void saveAdjustment(b.id, null)}
                        >
                          Use usual amount
                        </button>
                      )}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </section>
        );
      })}
      {!data.budgets.length && empty}
      <div className="panel unbudgeted">
        <h2>Outside your plan</h2>
        <p className="muted">
          {cash(totalSpent, 2)} spent in all this month. Spending in categories without a budget:
        </p>
        {outside.map((c) => (
          <div key={c}>
            <span>{c}</span>
            <strong>{cash(spentIn(tx, c), 2)}</strong>
          </div>
        ))}
      </div>
    </>
  );
}

const goalIcon = {
  savings: PiggyBank,
  emergency: ShieldCheck,
  purchase: ShoppingBag,
  debt: TrendingDown,
};
const goalKind = {
  savings: 'Savings',
  emergency: 'Emergency fund',
  purchase: 'Purchase',
  debt: 'Debt payoff',
};

/** Goals with progress, the monthly amount that reaches each, and earmarked accounts. */
export function GoalsView({
  data,
  onEdit,
  empty,
}: {
  data: Finance;
  onEdit: (id: string) => void;
  empty: React.ReactNode;
}) {
  const now = today();
  const marks = earmarks(data);
  const savedTotal = data.goals
    .filter((g) => g.kind !== 'debt')
    .reduce((s, g) => s + goalProgress(data, g).saved, 0);
  const account = (id?: string) => data.accounts.find((a) => a.id === id);
  return (
    <>
      <div className="goals-intro">
        <Target size={23} />
        <p>
          <strong>{cash(savedTotal)}</strong> set aside for what comes next.
        </p>
      </div>
      <p className="helper-note">
        Goals don’t add to net worth; the money stays in your accounts. Update the amount saved as
        you set money aside. A debt goal linked to a card or loan updates from its balance.
      </p>
      {marks.length > 0 && (
        <section className="panel earmarks">
          <h2>Earmarked savings</h2>
          {marks.map((m) => (
            <div className="earmark-row" key={m.account.id}>
              <div>
                <b>{m.account.name}</b>
                <small>{m.goals.map((g) => g.name).join(' · ')}</small>
              </div>
              <div>
                <span>
                  {cash(m.earmarked)} of {cash(m.account.balance)} earmarked
                </span>
                <small className={m.over ? 'negative' : ''}>
                  {m.over
                    ? `Goals claim ${cash(-m.free)} more than the account holds`
                    : `${cash(m.free)} unassigned`}
                </small>
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="goal-grid">
        {data.goals.map((g) => {
          const p = goalProgress(data, g);
          const Icon = goalIcon[g.kind];
          const monthly = monthlyForGoal(data, g, now);
          const linked = account(g.accountId);
          return (
            <section className="panel full-goal" key={g.id}>
              <div className="panel-title">
                <span className="goal-art">
                  <Icon size={25} />
                </span>
                <button
                  className="icon-button"
                  aria-label={`Edit ${g.name}`}
                  onClick={() => onEdit(g.id)}
                >
                  <Pencil size={16} />
                </button>
              </div>
              <h2>{g.name}</h2>
              <p className="goal-date">
                {goalKind[g.kind]} · by{' '}
                {new Date(g.date + 'T12:00:00').toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
                {linked ? ` · ${g.kind === 'debt' ? '' : 'in '}${linked.name}` : ''}
              </p>
              <div className="goal-saved">
                {cash(p.saved)}{' '}
                <span>
                  {g.kind === 'debt' ? 'paid down of' : 'of'} {cash(g.target)}
                </span>
              </div>
              <Progress
                value={clamp((p.saved / g.target) * 100)}
                aria-label={`${g.name} progress`}
              />
              <div className="goal-status">
                <span>{p.done ? 'Goal reached' : `${cash(p.left)} to go`}</span>
                <b>{Math.round((p.saved / g.target) * 100)}%</b>
              </div>
              {!p.done && (
                <p className="goal-pace">
                  <CalendarClock size={14} />
                  {g.date <= now
                    ? 'The target date has passed'
                    : `${cash(monthly)} a month reaches it on time`}
                </p>
              )}
              <button className="secondary" onClick={() => onEdit(g.id)}>
                Update progress
              </button>
            </section>
          );
        })}
      </div>
      {!data.goals.length && empty}
    </>
  );
}
