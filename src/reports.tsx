import { useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cash, today, type Finance } from '@/lib/finance';
import { frequencyLabel } from '@/lib/bills';
import {
  debtReport,
  dollars,
  incomeVsExpenses,
  interestAndFees,
  netWorthHistory,
  previousRange,
  rangeFor,
  recurringCosts,
  spendingByCategory,
  spendingByMerchant,
  toCSV,
  type Range,
} from '@/lib/reports';
import { saveTextFile } from './save-file';

const RANGES = {
  month: 'This month',
  'last-month': 'Last month',
  '3-months': 'Last 3 months',
  year: 'This year',
  '12-months': 'Last 12 months',
} as const;
type RangeKind = keyof typeof RANGES;
type Tab = 'spending' | 'merchants' | 'cashflow' | 'recurring' | 'interest' | 'debt' | 'worth';

const shortDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const monthLabel = (m: string) =>
  new Date(m + '-01T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const pct = (part: number, whole: number) =>
  whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;

function Bar({ value, max, tone }: { value: number; max: number; tone?: 'in' | 'out' | 'prev' }) {
  return (
    <span className="report-bar">
      <span className={tone ?? ''} style={{ width: `${pct(value, max)}%` }} />
    </span>
  );
}

/** A small line chart of dated values. */
function Line({ points, label }: { points: { date: string; value: number }[]; label: string }) {
  if (points.length < 2)
    return (
      <p className="form-hint">
        Not enough history yet; a point is recorded each day you update balances.
      </p>
    );
  const values = points.map((p) => p.value);
  const max = Math.max(...values),
    min = Math.min(...values),
    span = max - min || 1;
  const W = 600,
    H = 140;
  const first = Date.parse(points[0].date),
    last = Date.parse(points[points.length - 1].date) || first + 1;
  const d = points
    .map((p, i) => {
      const x = ((Date.parse(p.date) - first) / (last - first || 1)) * W;
      const y = H - ((p.value - min) / span) * (H - 10) - 5;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className="balance-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={d} />
    </svg>
  );
}

/** Reports over a chosen period, each exportable as CSV. */
export function ReportsView({ data }: { data: Finance }) {
  const [kind, setKind] = useState<RangeKind>('month');
  const [tab, setTab] = useState<Tab>('spending');
  const range: Range = rangeFor(kind, today());
  const prev = previousRange(range);
  const categories = spendingByCategory(data, range);
  const merchants = spendingByMerchant(data, range, 30);
  const flow = incomeVsExpenses(data, range);
  const recurring = recurringCosts(data);
  const fees = interestAndFees(data, range);
  const debt = debtReport(data, range);
  const worth = netWorthHistory(data, range);
  const spentTotal = categories.reduce((s, c) => s + c.amount, 0);
  const prevTotal = categories.reduce((s, c) => s + c.previous, 0);
  const catMax = Math.max(1, ...categories.map((c) => Math.max(c.amount, c.previous)));
  const flowMax = Math.max(1, ...flow.map((f) => Math.max(f.income, f.spent)));
  const period = `${shortDate(range.from)} – ${shortDate(range.to)}`;

  function exportTab() {
    const rows: (string | number)[][] =
      tab === 'spending'
        ? [
            ['category', 'amount', 'previous period'],
            ...categories.map((c) => [c.category, dollars(c.amount), dollars(c.previous)]),
          ]
        : tab === 'merchants'
          ? [
              ['payee', 'amount', 'transactions'],
              ...merchants.map((m) => [m.name, dollars(m.amount), m.count]),
            ]
          : tab === 'cashflow'
            ? [
                ['month', 'income', 'spending', 'net'],
                ...flow.map((f) => [f.month, dollars(f.income), dollars(f.spent), dollars(f.net)]),
              ]
            : tab === 'recurring'
              ? [
                  ['name', 'kind', 'frequency', 'amount', 'per month'],
                  ...recurring.list.map((r) => [
                    r.name,
                    r.kind,
                    r.frequency,
                    dollars(r.amount),
                    dollars(r.monthly),
                  ]),
                ]
              : tab === 'interest'
                ? [
                    ['charged by', 'amount'],
                    ...[...fees.accounts, ...fees.plans].map((f) => [f.name, dollars(f.amount)]),
                  ]
                : tab === 'debt'
                  ? [
                      ['debt', 'kind', 'owed', 'apr'],
                      ...debt.debts.map((d) => [d.name, d.kind, dollars(d.owed), d.apr ?? '']),
                    ]
                  : [
                      ['date', 'net worth', 'debt'],
                      ...worth.map((w) => [
                        w.date,
                        dollars(w.value),
                        w.debt === undefined ? '' : dollars(w.debt),
                      ]),
                    ];
    const name = `folio-${tab}-${range.from}-to-${range.to}.csv`;
    saveTextFile(name, toCSV(rows), 'text/csv').then(
      (saved) => saved && toast.success(`Saved ${name}`),
      (e: Error) => toast.error(e.message),
    );
  }

  return (
    <>
      <div className="period-bar report-bar-top">
        <Select value={kind} onValueChange={(v) => setKind(v as RangeKind)}>
          <SelectTrigger aria-label="Report period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RANGES).map(([k, label]) => (
              <SelectItem value={k} key={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="period-note">{period}</span>
        <button className="secondary" onClick={exportTab}>
          <Download size={15} /> Export CSV
        </button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="report-tabs">
          <TabsTrigger value="spending">Categories</TabsTrigger>
          <TabsTrigger value="merchants">Payees</TabsTrigger>
          <TabsTrigger value="cashflow">Income vs. spending</TabsTrigger>
          <TabsTrigger value="recurring">Recurring</TabsTrigger>
          <TabsTrigger value="interest">Interest & fees</TabsTrigger>
          <TabsTrigger value="debt">Debt</TabsTrigger>
          <TabsTrigger value="worth">Net worth</TabsTrigger>
        </TabsList>
        <TabsContent value="spending">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Spending by category</h2>
              <span className="soft">
                {cash(spentTotal)} ·{' '}
                {prevTotal ? `${cash(prevTotal)} the period before` : 'nothing the period before'}
              </span>
            </div>
            {categories.map((c) => {
              const change = c.amount - c.previous;
              return (
                <div className="report-row" key={c.category}>
                  <span className="report-name">{c.category}</span>
                  <span className="report-bars">
                    <Bar value={c.amount} max={catMax} tone="out" />
                    <Bar value={c.previous} max={catMax} tone="prev" />
                  </span>
                  <span className="report-figure">
                    {cash(c.amount)}
                    <small className={change > 0 ? 'negative' : change < 0 ? 'positive' : ''}>
                      {change === 0
                        ? 'no change'
                        : `${change > 0 ? '+' : '−'}${cash(Math.abs(change))}`}
                    </small>
                  </span>
                </div>
              );
            })}
            {!categories.length && <p className="form-hint">No spending in this period.</p>}
            <p className="form-hint">
              Lighter bars are the previous{' '}
              {prev.from.slice(0, 7) === prev.to.slice(0, 7) ? 'month' : 'period'} (
              {shortDate(prev.from)} – {shortDate(prev.to)}). Refunds reduce spending; transfers and
              pending entries are left out.
            </p>
          </section>
        </TabsContent>
        <TabsContent value="merchants">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Top payees</h2>
              <span className="soft">{period}</span>
            </div>
            {merchants.map((m) => (
              <div className="report-row" key={m.name}>
                <span className="report-name">
                  {m.name}
                  <small>
                    {m.count} transaction{m.count === 1 ? '' : 's'}
                  </small>
                </span>
                <span className="report-bars">
                  <Bar value={m.amount} max={merchants[0]?.amount ?? 1} tone="out" />
                </span>
                <span className="report-figure">{cash(m.amount, 2)}</span>
              </div>
            ))}
            {!merchants.length && <p className="form-hint">No spending in this period.</p>}
          </section>
        </TabsContent>
        <TabsContent value="cashflow">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Income vs. spending</h2>
              <span className="soft">Net {cash(flow.reduce((s, f) => s + f.net, 0))}</span>
            </div>
            {flow.map((f) => (
              <div className="report-row" key={f.month}>
                <span className="report-name">{monthLabel(f.month)}</span>
                <span className="report-bars">
                  <Bar value={f.income} max={flowMax} tone="in" />
                  <Bar value={f.spent} max={flowMax} tone="out" />
                </span>
                <span className="report-figure">
                  <span className={f.net < 0 ? 'negative' : 'positive'}>
                    {f.net < 0 ? '−' : '+'}
                    {cash(Math.abs(f.net))}
                  </span>
                  <small>
                    {cash(f.income)} in · {cash(f.spent)} out
                  </small>
                </span>
              </div>
            ))}
          </section>
        </TabsContent>
        <TabsContent value="recurring">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Recurring costs</h2>
              <span className="soft">
                {cash(recurring.monthly)} a month
                {recurring.income ? ` · ${cash(recurring.income)} scheduled income` : ''}
              </span>
            </div>
            {recurring.list.map((r) => (
              <div className="report-row" key={r.kind + r.name}>
                <span className="report-name">
                  {r.name}
                  <small>
                    {r.kind} · {frequencyLabel(r.frequency)} · {cash(r.amount, 2)}
                  </small>
                </span>
                <span className="report-bars">
                  <Bar value={r.monthly} max={recurring.list[0]?.monthly ?? 1} tone="out" />
                </span>
                <span className="report-figure">{cash(r.monthly)}/mo</span>
              </div>
            ))}
            {!recurring.list.length && (
              <p className="form-hint">Add bills and installment plans to see what repeats.</p>
            )}
            <p className="form-hint">
              Scheduled bills and plan payments, as a monthly cost (yearly bills count 1/12, every
              two weeks counts 26/12).
            </p>
          </section>
        </TabsContent>
        <TabsContent value="interest">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Interest and fees</h2>
              <span className="soft">{cash(fees.total, 2)} in this period</span>
            </div>
            {[...fees.accounts, ...fees.plans].map((f) => (
              <div className="report-row" key={f.name}>
                <span className="report-name">{f.name}</span>
                <span className="report-bars">
                  <Bar
                    value={f.amount}
                    max={Math.max(...[...fees.accounts, ...fees.plans].map((x) => x.amount))}
                    tone="out"
                  />
                </span>
                <span className="report-figure">{cash(f.amount, 2)}</span>
              </div>
            ))}
            {!fees.total && <p className="form-hint">No interest or fees in this period.</p>}
            <p className="form-hint">
              Transactions filed under Interest &amp; fees, plus interest in installment-plan
              payments recorded in Folio.
            </p>
          </section>
        </TabsContent>
        <TabsContent value="debt">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Debt</h2>
              <span className="soft">
                {cash(debt.total)} owed
                {debt.change !== null &&
                  ` · ${debt.change <= 0 ? 'down' : 'up'} ${cash(Math.abs(debt.change))} this period`}
              </span>
            </div>
            <Line
              points={debt.history.map((h) => ({ date: h.date, value: h.debt }))}
              label={`Total debt over the period, now ${cash(debt.total)}`}
            />
            {debt.debts.map((d) => (
              <div className="report-row" key={d.kind + d.name}>
                <span className="report-name">
                  {d.name}
                  <small>
                    {d.kind}
                    {d.apr != null ? ` · ${d.apr}% APR` : ''}
                  </small>
                </span>
                <span className="report-bars">
                  <Bar value={d.owed} max={debt.debts[0]?.owed ?? 1} tone="out" />
                </span>
                <span className="report-figure">{cash(d.owed, 2)}</span>
              </div>
            ))}
            {!debt.debts.length && <p className="form-hint">Nothing owed. Nice.</p>}
            {debt.paidOnPlans > 0 && (
              <p className="form-hint">
                {cash(debt.paidOnPlans, 2)} of plan principal paid in this period.
              </p>
            )}
          </section>
        </TabsContent>
        <TabsContent value="worth">
          <section className="panel report-panel">
            <div className="panel-title">
              <h2>Net worth</h2>
              <span className="soft">
                {worth.length > 1
                  ? `${worth[worth.length - 1].value >= worth[0].value ? 'Up' : 'Down'} ${cash(Math.abs(worth[worth.length - 1].value - worth[0].value))} this period`
                  : period}
              </span>
            </div>
            <Line
              points={worth.map((w) => ({ date: w.date, value: w.value }))}
              label="Net worth over the period"
            />
            {[...worth]
              .reverse()
              .slice(0, 12)
              .map((w) => (
                <div className="report-row" key={w.date}>
                  <span className="report-name">{shortDate(w.date)}</span>
                  <span className="report-bars" />
                  <span className="report-figure">{cash(w.value, 2)}</span>
                </div>
              ))}
          </section>
        </TabsContent>
      </Tabs>
    </>
  );
}
