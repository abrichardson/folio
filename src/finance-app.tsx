'use client';
import type { Storage } from './storage';
import { saveTextFile } from './save-file';
import ImportForm from './import-form';
import { BackupsPanel, SecurityPanel } from './security';
import { RegisterView } from './register';
import { CategoryPill } from './category-pill';
import { ReceiptsField } from './receipts';
import { PromotionDeadlines } from './promotions';
import { CategoriesPanel, RulesPanel } from './rules-panel';
import { applyRule, bankDescription, ruleTextFor } from '@/lib/rules';
import * as bulk from '@/lib/bulk';
import { transferPartner, unlinkTransfer } from '@/lib/transfers';
import { TransfersForm } from './transfers-dialog';
import { savedRows, workspaceChanges, type SavedRows } from '@/lib/persist';
import { CardsView, BillsView } from './cards-bills';
import { PlansView } from './plans';
import { BudgetsView, GoalsView } from './budgets';
import { ReportsView } from './reports';
import { addMonths, budgetMonth, goalProgress } from '@/lib/budgets';
import { CashFlowView, ForecastStrip } from './cashflow';
import { reminders } from '@/lib/cashflow';
import { dueItems } from '@/lib/bills';
import { useState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Wallet,
  ChartPie,
  Target,
  Settings,
  Plus,
  Leaf,
  ShieldCheck,
  TrendingUp,
  ChevronRight,
  ChevronLeft,
  Search,
  Download,
  Upload,
  Pencil,
  Trash2,
  Landmark,
  CreditCard,
  CalendarDays,
  LoaderCircle,
  LockKeyhole,
  Undo2,
  Paperclip,
  HandCoins,
  Waves,
  ChartColumn,
} from 'lucide-react';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
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
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Empty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import {
  cash,
  sampleState,
  emptyState,
  netWorth,
  totalDebt,
  withTodaySnapshot,
  monthly,
  parts,
  mainCategory,
  today,
  liability,
  allCategories,
  spendingCategories,
  stateSchema,
  balanceNote,
  receiptIds,
  awaitingReimbursement,
  type Account,
  type Finance,
  type Rule,
  type Receipt,
} from '@/lib/finance';
import { applyImport, describeUndo, sameValue, undoImport } from '@/lib/imports';
const nav = [
  ['Overview', LayoutDashboard],
  ['Transactions', ArrowLeftRight],
  ['Accounts', Wallet],
  ['Credit cards', CreditCard],
  ['Bills', CalendarDays],
  ['Cash flow', Waves],
  ['Loans', HandCoins],
  ['Budgets', ChartPie],
  ['Goals', Target],
  ['Reports', ChartColumn],
] as const;
type View = (typeof nav)[number][0] | 'Settings';
// A form's record before the server-side schema validates it on save.
type DraftRecord = { id: string; [field: string]: unknown };
type Modal = {
  kind: 'transaction' | 'account' | 'budget' | 'goal' | 'import' | 'transfers';
  id?: string;
} | null;
const fmtDate = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clamp = (v: number) => Math.max(0, Math.min(100, v));
/** Select value for "this money pays back nothing". */
const NONE_REPAID = '__none__';
function Choice({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const choices = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
function Navigation({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {nav.map(([name, Icon]) => (
        <SidebarMenuItem key={name}>
          <SidebarMenuButton
            isActive={view === name}
            onClick={() => {
              setView(name);
              setOpenMobile(false);
            }}
          >
            <Icon />
            <span>{name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
function NoData({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
      {children}
    </Empty>
  );
}
function download(name: string, text: string, type = 'text/plain') {
  saveTextFile(name, text, type).then(
    (saved) => saved && toast.success(`Saved ${name}`),
    (e: Error) => toast.error(e.message),
  );
}
function csvCell(v: string) {
  return '"' + v.replace(/"/g, '""') + '"';
}
function initialView(): View {
  const hash = decodeURIComponent(location.hash.slice(1));
  return [...nav.map((n) => n[0]), 'Settings'].includes(hash) ? (hash as View) : 'Overview';
}
export default function FinanceApp({
  storage,
  onLock,
}: {
  storage: Storage;
  onLock: () => Promise<void>;
}) {
  const [data, setData] = useState<Finance>(sampleState);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  /** Transactions as the data file holds them, so saves send only what changed. */
  const savedRef = useRef<SavedRows | null>(null);
  const [view, setView] = useState<View>(initialView);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [account, setAccount] = useState('all');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<Modal>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<void>;
  } | null>(null);
  const [range, setRange] = useState('6');
  const [addBill, setAddBill] = useState(false);
  const [addPlan, setAddPlan] = useState(false);
  /** Transactions checked for a bulk change on the Transactions page. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** The account whose register is open on the Accounts page. */
  const [registerId, setRegisterId] = useState<string | null>(null);
  function load() {
    return storage
      .load()
      .then(({ payload, version }) => {
        // A new file starts with the fictional demo until "Start with my finances".
        const loaded = payload ? stateSchema.parse(JSON.parse(payload)) : null;
        savedRef.current = loaded && savedRows(loaded);
        setData(loaded ?? sampleState());
        setVersion(version);
        setReady(true);
        // In-app reminders for payments due soon (or overdue) and not yet marked paid.
        const due = loaded && !loaded.demo ? reminders(loaded, today()) : [];
        if (due.length)
          toast(`${due.length} payment${due.length === 1 ? '' : 's'} due soon or overdue`, {
            description: due
              .slice(0, 3)
              .map((d) => d.name)
              .join(' · '),
            action: { label: 'View bills', onClick: () => navigate('Bills') },
            duration: 10000,
          });
        // Once a day, keep an encrypted copy of the file as it was when unlocked.
        storage.backups
          ?.daily(today())
          .catch((e: unknown) =>
            toast.error(
              `Today's automatic backup failed. ${e instanceof Error ? e.message : ''}`.trim(),
            ),
          );
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Unable to load your finances.'));
  }
  function retryLoad() {
    setError('');
    void load();
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when unlocked
  }, []);
  function navigate(v: View) {
    setView(v);
    setRegisterId(null);
    setSelected(new Set());
    history.replaceState(null, '', '#' + v);
    window.scrollTo({ top: 0, behavior: 'auto' });
    setPage(1);
  }
  async function save(
    next: Finance,
    message = 'Changes saved',
    action?: { label: string; onClick: () => void },
  ) {
    if (busy.current || !ready) return false;
    const parsed = stateSchema.safeParse(next);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message || 'Please check your entries.');
      return false;
    }
    busy.current = true;
    setSaving(true);
    try {
      const changes = workspaceChanges(parsed.data, savedRef.current);
      const nextVersion = await storage.save(
        changes.payload,
        changes.upsert,
        changes.remove,
        version,
      );
      savedRef.current = changes.saved;
      // Delete stored receipts that nothing refers to any more (removed or deleted entries).
      const kept = receiptIds(parsed.data);
      const orphaned = [...receiptIds(data)].filter((id) => !kept.has(id));
      if (orphaned.length) storage.attachments.remove(orphaned).catch(() => {});
      setData(parsed.data);
      setVersion(nextVersion);
      toast.success(message, action ? { action, duration: 10000 } : undefined);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Changes could not be saved.');
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  // Lock after a stretch without keyboard, mouse, or touch activity.
  const autoLockMinutes = data.settings.autoLockMinutes;
  useEffect(() => {
    if (!autoLockMinutes) return;
    let last = Date.now();
    const active = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, active, { passive: true });
    const timer = window.setInterval(() => {
      if (!busy.current && Date.now() - last >= autoLockMinutes * 60_000) void onLock();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, active);
    };
  }, [autoLockMinutes, onLock]);
  const modelRef = useRef({ data, month, navigate });
  modelRef.current = { data, month, navigate };
  useEffect(() => {
    const ctx = (
      document as unknown as {
        modelContext?: { registerTool: (tool: unknown, options: unknown) => Promise<void> | void };
      }
    ).modelContext;
    if (!ctx?.registerTool) return;
    const ctrl = new AbortController();
    const register = (tool: unknown) => {
      try {
        Promise.resolve(ctx.registerTool(tool, { signal: ctrl.signal })).catch(() => {});
      } catch {
        // Browsers without WebMCP support ignore tool registration.
      }
    };
    register({
      name: 'read_finance_summary',
      description:
        'Read the displayed monthly income, expenses, and net worth in USD cents. Sample data is explicitly identified.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: (input: unknown) => {
        if (!input || typeof input !== 'object' || Object.keys(input).length)
          throw new Error('Expected an empty object.');
        const { data, month } = modelRef.current;
        const m = monthly(data, month);
        return {
          demo: data.demo,
          month,
          netWorth: netWorth(data),
          income: m.income,
          spending: m.spent,
        };
      },
    });
    register({
      name: 'navigate_finance_view',
      description: 'Open an existing finance view. Does not change financial records.',
      inputSchema: {
        type: 'object',
        properties: { view: { type: 'string', enum: nav.map((n) => n[0]) } },
        required: ['view'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: (input: unknown) => {
        const v = (input as { view?: string })?.view;
        if (!nav.some((n) => n[0] === v) || Object.keys(input as object).length !== 1)
          throw new Error('Choose an existing finance view.');
        modelRef.current.navigate(v as View);
        return { view: v };
      },
    });
    return () => ctrl.abort();
  }, []);
  const m = monthly(data, month);
  const budgetRows = data.budgets.map((b) => ({ b, ...budgetMonth(data, b, month) }));
  const totalBudget = budgetRows.reduce((sum, r) => sum + r.available, 0);
  const lastMonth = monthly(data, addMonths(month, -1));
  const assets = data.accounts.filter((a) => !liability(a)).reduce((sum, a) => sum + a.balance, 0);
  const debts = data.accounts.filter(liability).reduce((sum, a) => sum + a.balance, 0);
  const filtered = m.tx
    .filter(
      (t) =>
        (category === 'all' || parts(t).some((p) => p.category === category)) &&
        (account === 'all' || t.accountId === account) &&
        `${t.merchant} ${t.notes}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 15));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * 15, safePage * 15);
  const recent = [...m.tx].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const monthLabel = new Date(month + '-01T12:00:00').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  function changeMonth(delta: number) {
    const d = new Date(month + '-01T12:00:00');
    d.setMonth(d.getMonth() + delta);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    setPage(1);
  }
  function startFresh() {
    setConfirm({
      title: 'Start with your own finances?',
      description:
        'This removes the sample workspace and opens a clean slate for your accounts. You can load sample data again while your workspace is empty.',
      action: async () => {
        if (await save(emptyState(), 'Your fresh start is ready')) {
          setConfirm(null);
          navigate('Accounts');
          setModal({ kind: 'account' });
        }
      },
    });
  }
  function remove(kind: 'transaction' | 'account' | 'budget' | 'goal', id: string) {
    if (
      (kind === 'account' && data.accounts.find((a) => a.id === id)?.plaidItemId) ||
      (kind === 'transaction' && data.transactions.find((t) => t.id === id)?.plaidItemId)
    ) {
      toast.error('Disconnect the bank before deleting synced records.');
      return;
    }
    if (kind === 'account' && data.bills.some((b) => b.accountId === id)) {
      toast.error('Change this account in your bills before deleting it.');
      return;
    }
    if (kind === 'account' && data.transactions.some((t) => t.accountId === id)) {
      toast.error('Remove or move this account’s transactions before deleting the account.');
      return;
    }
    setConfirm({
      title: `Delete this ${kind}?`,
      description: 'This record will be permanently removed from your workspace.',
      action: async () => {
        const next = structuredClone(data);
        if (kind === 'transaction')
          next.transactions = next.transactions.filter((t) => t.id !== id);
        if (kind === 'account') {
          next.accounts = next.accounts.filter((a) => a.id !== id);
          snapshot(next);
        }
        if (kind === 'budget') next.budgets = next.budgets.filter((b) => b.id !== id);
        if (kind === 'goal') next.goals = next.goals.filter((g) => g.id !== id);
        if (await save(next, 'Record deleted')) {
          setConfirm(null);
          setModal(null);
        }
      },
    });
  }
  /** Asks before undoing an import, describing exactly what will change. */
  function askUndo(importId: string) {
    try {
      // Read the latest workspace: this can be called from a toast created before a save.
      const { summary } = undoImport(modelRef.current.data, importId, new Date().toISOString());
      setConfirm({
        title: 'Undo this import?',
        description: describeUndo(summary),
        action: async () => {
          const { next } = undoImport(modelRef.current.data, importId, new Date().toISOString());
          snapshot(next);
          if (await save(next, 'Import undone')) setConfirm(null);
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'This import cannot be undone.');
    }
  }
  function snapshot(next: Finance) {
    next.snapshots = withTodaySnapshot(next);
  }
  function exportCSV() {
    const rows = [
      ['date', 'merchant', 'amount', 'category', 'account', 'notes'],
      ...filtered.map((t) => [
        t.date,
        t.merchant,
        (t.amount / 100).toFixed(2),
        t.splits
          ? t.splits.map((p) => `${p.category} ${(p.amount / 100).toFixed(2)}`).join('; ')
          : t.category,
        data.accounts.find((a) => a.id === t.accountId)?.name || '',
        t.notes,
      ]),
    ];
    download(
      `folio-transactions-${month}.csv`,
      rows
        .map((r) => r.map((c) => csvCell(/^[=+@\t\r]/.test(c) ? "'" + c : c)).join(','))
        .join('\r\n'),
      'text/csv',
    );
    toast.success('Transactions exported');
  }
  const titles: Record<View, string> = {
    Overview: 'A little clarity goes a long way.',
    Transactions: 'Every little thing, accounted for.',
    Accounts: 'Your money, all together.',
    'Credit cards': 'Stay a step ahead of your cards.',
    Bills: 'No more dates to keep in your head.',
    Loans: 'Every plan, on schedule.',
    'Cash flow': 'See the weeks ahead.',
    Budgets: 'A plan for the everyday.',
    Goals: 'Make room for what matters.',
    Reports: 'The bigger picture, in numbers.',
    Settings: 'Your workspace, your way.',
  };
  const title = titles[view];
  const subtitles: Record<View, string> = {
    Overview: 'Here’s where things stand this month.',
    Transactions: 'Track the details. Understand the bigger picture.',
    'Credit cards': 'Balances, limits, and the next payment — together.',
    Bills: 'A simple plan for what’s due and what’s paid.',
    Accounts: 'A clear view of what you have and what you owe.',
    Loans: 'Buy-now-pay-later plans and loans, with what’s left to pay.',
    'Cash flow': 'Income, bills, and payments ahead, and the balance they leave.',
    Budgets: 'Give your spending a little intention.',
    Goals: 'Turn someday into something you can see.',
    Reports: 'Where money went, what repeats, and how debt and net worth are moving.',
    Settings: 'Manage your data and make a fresh start.',
  };
  const headingAction = () =>
    view === 'Bills'
      ? setAddBill(true)
      : view === 'Loans'
        ? setAddPlan(true)
        : setModal({
            kind:
              view === 'Accounts' || view === 'Credit cards'
                ? 'account'
                : view === 'Budgets'
                  ? 'budget'
                  : view === 'Goals'
                    ? 'goal'
                    : 'transaction',
          });
  const actionButton = (
    <button disabled={!ready || saving} className="primary" onClick={headingAction}>
      <Plus size={17} />
      Add{' '}
      {view === 'Bills'
        ? 'bill'
        : view === 'Loans'
          ? 'plan'
          : view === 'Credit cards'
            ? 'credit card'
            : view === 'Accounts'
              ? 'account'
              : view === 'Budgets'
                ? 'budget'
                : view === 'Goals'
                  ? 'goal'
                  : 'transaction'}
    </button>
  );
  const budgetList = (compact = false) => (
    <>
      {budgetRows.slice(0, compact ? 3 : 50).map(({ b, spent, available }) => (
        <div className="budget-line" key={b.id}>
          <div>
            <span>{b.category}</span>
            <span>
              {cash(spent)} <span className="soft">/ {cash(available)}</span>
            </span>
          </div>
          <Progress
            className={spent > available ? 'over-budget' : ''}
            value={clamp(available > 0 ? (spent / available) * 100 : 100)}
            aria-label={`${b.category} budget used`}
          />
        </div>
      ))}
    </>
  );
  const miniGoals = (
    <>
      {data.goals.slice(0, 2).map((g, i) => {
        const p = goalProgress(data, g);
        return (
          <button className="goal-mini" key={g.id} onClick={() => navigate('Goals')}>
            <div className="goal-label">
              <span className="goal-emblem">
                {i === 0 ? <ShieldCheck size={17} /> : <Target size={17} />}
              </span>
              <h3>{g.name}</h3>
              <span className="goal-percent">{Math.round((p.saved / g.target) * 100)}%</span>
            </div>
            <p>
              {cash(p.saved)} <span>of {cash(g.target)}</span>
            </p>
            <Progress value={clamp((p.saved / g.target) * 100)} aria-label={`${g.name} progress`} />
          </button>
        );
      })}
      {!data.goals.length && (
        <NoData
          title="What are you saving for?"
          description="Give your next big plan a place to grow."
        >
          <button className="secondary" onClick={() => setModal({ kind: 'goal' })}>
            Set a goal
          </button>
        </NoData>
      )}
    </>
  );
  return (
    <SidebarProvider style={{ '--sidebar-width': '232px' } as React.CSSProperties}>
      <Toaster position="bottom-right" />
      <Sidebar className="folio-sidebar">
        <SidebarHeader>
          <div className="brand">
            <Leaf size={29} />
            <span>
              folio<span className="brand-dot">.</span>
            </span>
          </div>
          <div className="workspace">PERSONAL WORKSPACE</div>
        </SidebarHeader>
        <SidebarContent>
          <Navigation view={view} setView={navigate} />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenuButton isActive={view === 'Settings'} onClick={() => navigate('Settings')}>
            <Settings />
            <span>Settings & data</span>
          </SidebarMenuButton>
          <SidebarMenuButton disabled={saving} onClick={() => void onLock()}>
            <LockKeyhole />
            <span>Lock Folio</span>
          </SidebarMenuButton>
          <div className="private-note">
            <ShieldCheck size={17} /> Stored only on this computer.
          </div>
          <div className="profile">
            <div className="avatar">F</div>
            <div>
              My workspace<small>Personal account</small>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            <SidebarTrigger />
            My workspace <ChevronRight size={14} /> <b>{view}</b>
          </div>
          <span className="privacy">
            {saving ? (
              <>
                <LoaderCircle size={15} className="animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <ShieldCheck size={15} /> Private workspace
              </>
            )}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {view === 'Overview' ? 'YOUR MONEY, AT A GLANCE' : view.toUpperCase()}
              </p>
              <h1>{title}</h1>
              <p>{subtitles[view]}</p>
            </div>
            {!['Settings', 'Cash flow', 'Reports'].includes(view) && actionButton}
          </div>
          {error ? (
            <div className="error-banner" role="alert">
              {error} <button onClick={retryLoad}>Try again</button>
            </div>
          ) : null}
          {!ready && !error ? (
            <div className="loading-grid" aria-label="Loading your finances">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-36 rounded-xl" />
              ))}
            </div>
          ) : !ready ? null : (
            <>
              {data.demo && (
                <div className="demo-banner">
                  <span>
                    <span className="demo-tag">DEMO</span>You’re exploring with sample data.
                  </span>
                  <button disabled={saving} onClick={startFresh}>
                    Start with my finances <ChevronRight size={14} />
                  </button>
                </div>
              )}
              {['Overview', 'Transactions', 'Budgets'].includes(view) && (
                <div className="period-bar">
                  <div className="month-picker">
                    <button aria-label="Previous month" onClick={() => changeMonth(-1)}>
                      <ChevronLeft size={16} />
                    </button>
                    <CalendarDays size={15} />
                    <span>{monthLabel}</span>
                    <button aria-label="Next month" onClick={() => changeMonth(1)}>
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  {month !== today().slice(0, 7) && (
                    <button className="text-button" onClick={() => setMonth(today().slice(0, 7))}>
                      This month
                    </button>
                  )}
                  <span className="period-note">
                    {data.demo ? 'Sample workspace' : 'Your saved finances'}
                  </span>
                </div>
              )}
              {view === 'Overview' && (
                <>
                  <UpcomingBills data={data} onOpen={() => navigate('Bills')} />
                  <ForecastStrip data={data} onOpen={() => navigate('Cash flow')} />
                  <PromotionDeadlines data={data} onOpen={() => navigate('Credit cards')} />
                  <div className="stat-grid">
                    <div className="stat primary-stat">
                      <span>Total net worth</span>
                      <strong>{cash(netWorth(data), 2)}</strong>
                      <p>
                        <TrendingUp size={15} /> Across {data.accounts.length} accounts
                        {totalDebt(data) ? ` · ${cash(totalDebt(data))} owed` : ''}
                      </p>
                    </div>
                    <div className="stat">
                      <span>Income this month</span>
                      <strong>{cash(m.income)}</strong>
                      <p>Money coming in</p>
                    </div>
                    <div className="stat">
                      <span>Spending this month</span>
                      <strong>{cash(m.spent, 2)}</strong>
                      <p>
                        {lastMonth.spent
                          ? `${m.spent <= lastMonth.spent ? '↓' : '↑'} ${cash(Math.abs(m.spent - lastMonth.spent))} vs. last month`
                          : 'Excludes transfers'}
                      </p>
                    </div>
                    <div className="stat">
                      <span>Left this month</span>
                      <strong>{cash(m.income - m.spent, 2)}</strong>
                      <p>
                        {m.income > 0
                          ? `${Math.round((1 - m.spent / m.income) * 100)}% of income remaining`
                          : 'Income less expenses'}
                      </p>
                    </div>
                  </div>
                  <div className="overview-grid">
                    <section className="panel wealth">
                      <div className="panel-title">
                        <h2>Net worth over time</h2>
                        <Choice
                          label="Chart period"
                          value={range}
                          onChange={setRange}
                          options={[
                            { value: '3', label: 'Last 3 months' },
                            { value: '6', label: 'Last 6 months' },
                            { value: '12', label: 'Last 12 months' },
                          ]}
                        />
                      </div>
                      <p className="muted">
                        {data.demo
                          ? 'A sample of how your big picture can grow.'
                          : 'Snapshots from your saved account balances.'}
                      </p>
                      <WorthChart data={data} range={Number(range)} />
                      <div className="chart-footer">
                        <span>
                          <i /> Assets {cash(assets)}
                        </span>
                        <span>Liabilities {cash(debts)}</span>
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-title">
                        <h2>Monthly budget</h2>
                        <button
                          className="icon-button"
                          aria-label="View budgets"
                          onClick={() => navigate('Budgets')}
                        >
                          <ChartPie size={19} />
                        </button>
                      </div>
                      {data.budgets.length ? (
                        <>
                          <div className="budget-number">
                            {cash(m.spent)} <span>of {cash(totalBudget)}</span>
                          </div>
                          <Progress
                            value={clamp((m.spent / totalBudget) * 100)}
                            className={m.spent > totalBudget ? 'over-budget' : ''}
                            aria-label="Total budget used"
                          />
                          <p className="muted budget-caption">
                            {m.spent <= totalBudget
                              ? `${cash(totalBudget - m.spent)} left in your overall plan.`
                              : `${cash(m.spent - totalBudget)} over your overall plan.`}
                          </p>
                          {budgetList(true)}
                          <button
                            className="text-button budget-link"
                            onClick={() => navigate('Budgets')}
                          >
                            See all budgets
                          </button>
                        </>
                      ) : (
                        <NoData
                          title="Give every dollar a plan"
                          description="Create category budgets to track spending."
                        >
                          <button
                            className="secondary"
                            onClick={() => setModal({ kind: 'budget' })}
                          >
                            Create a budget
                          </button>
                        </NoData>
                      )}
                    </section>
                  </div>
                  <div className="overview-grid">
                    <section className="panel">
                      <div className="panel-title">
                        <h2>Recent transactions</h2>
                        <button className="text-button" onClick={() => navigate('Transactions')}>
                          View all
                        </button>
                      </div>
                      {recent.map((t) => (
                        <button
                          className="transaction-row"
                          key={t.id}
                          onClick={() => setModal({ kind: 'transaction', id: t.id })}
                        >
                          <div className={'merchant-icon ' + (t.amount > 0 ? 'income-icon' : '')}>
                            {t.amount > 0 ? <Landmark size={17} /> : t.merchant[0]}
                          </div>
                          <div className="merchant-details">
                            <b>{t.merchant}</b>
                            <small>
                              {t.category} · {fmtDate(t.date)}
                            </small>
                          </div>
                          <strong className={t.amount > 0 ? 'positive' : ''}>
                            {t.amount > 0 ? '+' : ''}
                            {cash(t.amount, 2)}
                          </strong>
                        </button>
                      ))}
                      {!recent.length && (
                        <NoData
                          title="A clean slate"
                          description="Add a transaction or import a CSV to see your spending here."
                        />
                      )}
                    </section>
                    <section className="panel">
                      <div className="panel-title">
                        <h2>Little steps, big plans</h2>
                        <button
                          className="icon-button"
                          aria-label="View goals"
                          onClick={() => navigate('Goals')}
                        >
                          <Target size={19} />
                        </button>
                      </div>
                      {miniGoals}
                    </section>
                  </div>
                </>
              )}
              {view === 'Transactions' && (
                <section className="panel transaction-panel">
                  <div className="toolbar">
                    <label className="search-field">
                      <Search size={17} />
                      <input
                        aria-label="Search transactions"
                        placeholder="Search transactions…"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(1);
                        }}
                      />
                    </label>
                    <Choice
                      label="Filter category"
                      value={category}
                      onChange={(v) => {
                        setCategory(v);
                        setPage(1);
                      }}
                      options={[
                        { value: 'all', label: 'All categories' },
                        ...choices(allCategories(data)),
                      ]}
                    />
                    <Choice
                      label="Filter account"
                      value={account}
                      onChange={(v) => {
                        setAccount(v);
                        setPage(1);
                      }}
                      options={[
                        { value: 'all', label: 'All accounts' },
                        ...data.accounts.map((a) => ({ value: a.id, label: a.name })),
                      ]}
                    />
                    <button className="secondary" onClick={() => setModal({ kind: 'import' })}>
                      <Upload size={15} />
                      Import
                    </button>
                    <button className="secondary" onClick={() => setModal({ kind: 'transfers' })}>
                      <ArrowLeftRight size={15} />
                      Match transfers
                    </button>
                    <button className="secondary" onClick={exportCSV}>
                      <Download size={15} />
                      Export
                    </button>
                  </div>
                  {selected.size > 0 && (
                    <div className="bulk-bar" role="region" aria-label="Selected transactions">
                      <b>{selected.size} selected</b>
                      <Choice
                        label="Set category for selected"
                        value=""
                        placeholder="Set category…"
                        onChange={async (c) => {
                          if (
                            await save(
                              bulk.setCategory(data, selected, c),
                              `${selected.size} filed under ${c}`,
                            )
                          )
                            setSelected(new Set());
                        }}
                        options={choices(allCategories(data))}
                      />
                      <button
                        className="secondary"
                        disabled={saving}
                        onClick={async () => {
                          if (await save(bulk.markCleared(data, selected), 'Marked cleared'))
                            setSelected(new Set());
                        }}
                      >
                        Mark cleared
                      </button>
                      <button
                        className="secondary danger"
                        disabled={saving}
                        onClick={() => {
                          const doomed = bulk.deletable(data, selected);
                          const reconciled = doomed.filter((t) => t.status === 'reconciled').length;
                          setConfirm({
                            title: `Delete ${doomed.length} transaction${doomed.length === 1 ? '' : 's'}?`,
                            description: `They will be permanently removed.${
                              reconciled
                                ? ` ${reconciled} of them ${reconciled === 1 ? 'is' : 'are'} reconciled, so reconciled balances will change.`
                                : ''
                            }${
                              doomed.length < selected.size
                                ? ' Bank-synced transactions are skipped.'
                                : ''
                            }`,
                            action: async () => {
                              if (await save(bulk.deleteTransactions(data, selected), 'Deleted')) {
                                setSelected(new Set());
                                setConfirm(null);
                              }
                            },
                          });
                        }}
                      >
                        Delete
                      </button>
                      <button className="text-button" onClick={() => setSelected(new Set())}>
                        Clear selection
                      </button>
                    </div>
                  )}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="select-cell">
                          <input
                            type="checkbox"
                            aria-label="Select all on this page"
                            checked={
                              pageRows.length > 0 && pageRows.every((t) => selected.has(t.id))
                            }
                            onChange={(e) =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                for (const t of pageRows) {
                                  if (e.target.checked) next.add(t.id);
                                  else next.delete(t.id);
                                }
                                return next;
                              })
                            }
                          />
                        </TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Merchant</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead className="amount-cell">Amount</TableHead>
                        <TableHead>
                          <span className="sr-only">Edit</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageRows.map((t) => (
                        <TableRow
                          key={t.id}
                          data-state={selected.has(t.id) ? 'selected' : undefined}
                        >
                          <TableCell className="select-cell">
                            <input
                              type="checkbox"
                              aria-label={`Select ${t.merchant}`}
                              checked={selected.has(t.id)}
                              onChange={() =>
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(t.id)) next.delete(t.id);
                                  else next.add(t.id);
                                  return next;
                                })
                              }
                            />
                          </TableCell>
                          <TableCell className="date-cell">{fmtDate(t.date)}</TableCell>
                          <TableCell>
                            <button
                              className="merchant-link"
                              onClick={() => setModal({ kind: 'transaction', id: t.id })}
                            >
                              {t.merchant}
                            </button>
                            {!!t.receipts?.length && (
                              <Paperclip
                                size={13}
                                className="receipt-mark"
                                aria-label={`${t.receipts.length} receipt${t.receipts.length === 1 ? '' : 's'}`}
                              />
                            )}
                            {t.notes && <small className="row-note">{t.notes}</small>}
                          </TableCell>
                          <TableCell>
                            <CategoryPill transaction={t} />
                            {t.pending && (
                              <small className="row-note">Pending · excluded from totals</small>
                            )}
                          </TableCell>
                          <TableCell className="account-cell">
                            {data.accounts.find((a) => a.id === t.accountId)?.name}
                          </TableCell>
                          <TableCell className={'amount-cell ' + (t.amount > 0 ? 'positive' : '')}>
                            {t.amount > 0 ? '+' : ''}
                            {cash(t.amount, 2)}
                          </TableCell>
                          <TableCell>
                            <button
                              className="icon-button"
                              aria-label={`Edit ${t.merchant}`}
                              onClick={() => setModal({ kind: 'transaction', id: t.id })}
                            >
                              <Pencil size={15} />
                            </button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {!filtered.length && (
                    <NoData
                      title="No transactions here yet"
                      description="Try a different month or filter, or add your first transaction."
                    />
                  )}
                  <div className="table-footer">
                    <span>
                      {filtered.length} transactions · Net{' '}
                      {cash(
                        filtered
                          .filter((t) => !t.pending)
                          .flatMap(parts)
                          .filter((p) => p.category !== 'Transfer')
                          .reduce((s, p) => s + p.amount, 0),
                        2,
                      )}
                    </span>
                    <div>
                      <button
                        className="icon-button"
                        disabled={safePage <= 1}
                        aria-label="Previous page"
                        onClick={() => setPage(safePage - 1)}
                      >
                        <ChevronLeft size={17} />
                      </button>
                      <span>
                        {safePage} / {pageCount}
                      </span>
                      <button
                        className="icon-button"
                        disabled={safePage >= pageCount}
                        aria-label="Next page"
                        onClick={() => setPage(safePage + 1)}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </div>
                  </div>
                </section>
              )}
              {((view === 'Accounts' && !registerId) || view === 'Settings') && (
                <BankDownloadsNote />
              )}
              {view === 'Credit cards' && (
                <CardsView
                  data={data}
                  saving={saving}
                  save={save}
                  onAdd={() => setModal({ kind: 'account' })}
                />
              )}
              {view === 'Bills' && (
                <BillsView
                  data={data}
                  saving={saving}
                  save={save}
                  requestAdd={addBill}
                  onAddHandled={() => setAddBill(false)}
                />
              )}
              {view === 'Cash flow' && <CashFlowView data={data} saving={saving} save={save} />}
              {view === 'Reports' && <ReportsView data={data} />}
              {view === 'Loans' && (
                <PlansView
                  data={data}
                  saving={saving}
                  save={save}
                  requestAdd={addPlan}
                  onAddHandled={() => setAddPlan(false)}
                />
              )}
              {view === 'Accounts' && registerId && (
                <RegisterView
                  data={data}
                  accountId={registerId}
                  saving={saving}
                  save={save}
                  onBack={() => setRegisterId(null)}
                  onEditTransaction={(id) => setModal({ kind: 'transaction', id })}
                />
              )}
              {view === 'Accounts' && !registerId && (
                <>
                  {data.accounts.some((a) => a.balanceUnavailable) && (
                    <p className="error-banner">
                      Some linked balances are unavailable. Totals use the last saved balances, or
                      zero where no balance was received.
                    </p>
                  )}
                  <div className="account-summary">
                    <div>
                      <span>Assets</span>
                      <strong>{cash(assets, 2)}</strong>
                    </div>
                    <div>
                      <span>Liabilities</span>
                      <strong>{cash(debts, 2)}</strong>
                    </div>
                    <div>
                      <span>Net worth</span>
                      <strong className="positive">{cash(netWorth(data), 2)}</strong>
                    </div>
                  </div>
                  <p className="helper-note">
                    Balances come from your statements. Transaction entries never adjust balances a
                    second time.
                  </p>
                  <div className="account-grid">
                    {data.accounts.map((a) => (
                      <section className="panel account-card" key={a.id}>
                        <div className="panel-title">
                          <div className="bank-icon">
                            {liability(a) ? <CreditCard /> : <Landmark />}
                          </div>
                          <button
                            className="icon-button"
                            aria-label={`Edit ${a.name}`}
                            onClick={() => setModal({ kind: 'account', id: a.id })}
                          >
                            <Pencil size={16} />
                          </button>
                        </div>
                        <p className="bank-name">{a.institution}</p>
                        <h2>{a.name}</h2>
                        <strong className="account-balance">
                          {cash(liability(a) ? -a.balance : a.balance, 2)}
                        </strong>
                        <div className="account-bottom">
                          <span>{a.type}</span>
                          <span>{a.plaidItemId ? 'Plaid Sandbox' : balanceNote(a)}</span>
                        </div>
                        <button
                          className="text-button register-link"
                          onClick={() => {
                            setRegisterId(a.id);
                            window.scrollTo({ top: 0, behavior: 'auto' });
                          }}
                        >
                          Open register
                        </button>
                      </section>
                    ))}
                  </div>
                  {!data.accounts.length && (
                    <section className="panel">
                      <NoData
                        title="Bring your accounts together"
                        description="Start with a checking account, a credit card, or your savings."
                      >
                        <button className="primary" onClick={() => setModal({ kind: 'account' })}>
                          <Plus size={16} />
                          Add your first account
                        </button>
                      </NoData>
                    </section>
                  )}
                </>
              )}
              {view === 'Budgets' && (
                <BudgetsView
                  data={data}
                  month={month}
                  saving={saving}
                  save={save}
                  onEdit={(id) => setModal({ kind: 'budget', id })}
                  empty={
                    <section className="panel">
                      <NoData
                        title="Plan for your priorities"
                        description="Add a monthly limit for groceries, dining, or any spending category."
                      >
                        <button className="primary" onClick={() => setModal({ kind: 'budget' })}>
                          Create your first budget
                        </button>
                      </NoData>
                    </section>
                  }
                />
              )}
              {view === 'Goals' && (
                <GoalsView
                  data={data}
                  onEdit={(id) => setModal({ kind: 'goal', id })}
                  empty={
                    <section className="panel">
                      <NoData
                        title="Something worth saving for"
                        description="An emergency fund, a trip, a home. Start with what matters to you."
                      >
                        <button className="primary" onClick={() => setModal({ kind: 'goal' })}>
                          Create your first goal
                        </button>
                      </NoData>
                    </section>
                  }
                />
              )}
              {view === 'Settings' && (
                <section className="panel settings-panel">
                  <h2>Your data belongs to you.</h2>
                  <div className="setting-row">
                    <div>
                      <h3>Download a backup</h3>
                      <p>
                        Export accounts, transactions, budgets, goals, bills, and balance history.
                        Bank credentials are never included.
                      </p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() =>
                        download(
                          'folio-backup-' + today() + '.json',
                          JSON.stringify(data, null, 2),
                          'application/json',
                        )
                      }
                    >
                      <Download size={16} />
                      Download backup
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Restore a backup</h3>
                      <p>Replace this workspace with a previously exported Folio backup.</p>
                    </div>
                    <label className="secondary file-label">
                      Restore backup
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          try {
                            if (file.size > 200_000_000) throw new Error('Backup is too large.');
                            const restored = stateSchema.parse(JSON.parse(await file.text()));
                            setConfirm({
                              title: 'Replace your workspace?',
                              description: `Restore ${restored.accounts.length} accounts and ${restored.transactions.length} transactions from ${file.name}. Download your current backup first if you want to keep it.`,
                              action: async () => {
                                if (await save(restored, 'Backup restored')) setConfirm(null);
                              },
                            });
                          } catch {
                            toast.error('This file is not a valid Folio backup.');
                          }
                        }}
                      />
                    </label>
                  </div>
                  <div className="setting-row">
                    <div>
                      <h3>Currency</h3>
                      <p>All balances and transactions are recorded in US dollars.</p>
                    </div>
                    <span className="pill">USD</span>
                  </div>
                  {!data.accounts.length && !data.transactions.length && (
                    <div className="setting-row">
                      <div>
                        <h3>Explore sample data</h3>
                        <p>Load a fictional workspace to explore Folio.</p>
                      </div>
                      <button
                        className="secondary"
                        disabled={saving}
                        onClick={() => save(sampleState(), 'Sample workspace loaded')}
                      >
                        Load sample data
                      </button>
                    </div>
                  )}
                  <div className="setting-row">
                    <div>
                      <h3>Clear workspace</h3>
                      <p>Permanently remove all financial records. Download a backup first.</p>
                    </div>
                    <button
                      className="secondary danger"
                      disabled={saving}
                      onClick={() =>
                        setConfirm({
                          title: 'Clear all your finances?',
                          description:
                            'All accounts, transactions, budgets, goals, bills, and balance history will be permanently deleted. Disconnect banks first. This cannot be undone without a backup.',
                          action: async () => {
                            if (await save(emptyState(), 'Workspace cleared')) setConfirm(null);
                          },
                        })
                      }
                    >
                      Clear all data
                    </button>
                  </div>
                </section>
              )}
              {view === 'Settings' && (
                <>
                  <SecurityPanel
                    storage={storage}
                    autoLockMinutes={data.settings.autoLockMinutes}
                    saving={saving}
                    onAutoLock={(autoLockMinutes) =>
                      void save(
                        { ...data, settings: { ...data.settings, autoLockMinutes } },
                        autoLockMinutes ? 'Automatic lock updated' : 'Automatic lock turned off',
                      )
                    }
                  />
                  <BackupsPanel storage={storage} disabled={saving} onRestored={load} />
                  <CategoriesPanel data={data} saving={saving} save={save} />
                  <RulesPanel data={data} saving={saving} save={save} />
                  <ImportHistory data={data} saving={saving} onUndo={askUndo} />
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            Made for a healthier relationship with money.<span>All amounts in USD</span>
          </footer>
        </div>
      </main>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !saving) setModal(null);
        }}
      >
        <DialogContent className="finance-dialog">
          <DialogHeader>
            <DialogTitle>
              {modal?.kind === 'import'
                ? 'Import transactions'
                : modal?.kind === 'transfers'
                  ? 'Match transfers'
                  : `${modal?.id ? 'Edit' : 'Add'} ${modal?.kind || 'record'}`}
            </DialogTitle>
            <DialogDescription>
              {modal?.kind === 'account'
                ? 'Enter the current balance shown on your account statement.'
                : modal?.kind === 'import'
                  ? 'Bring in transactions from your bank with a QFX, OFX, or CSV file.'
                  : modal?.kind === 'transfers'
                    ? 'Link money moving between your own accounts.'
                    : 'A little detail makes the big picture clearer.'}
            </DialogDescription>
          </DialogHeader>
          {modal &&
            (modal.kind === 'transfers' ? (
              <TransfersForm
                data={data}
                saving={saving}
                onSave={async (next, linked) => {
                  if (await save(next, `${linked} transfer${linked === 1 ? '' : 's'} linked`))
                    setModal(null);
                }}
              />
            ) : modal.kind === 'import' ? (
              <ImportForm
                data={data}
                saving={saving}
                onSave={async (result) => {
                  const importId = crypto.randomUUID();
                  const next = applyImport(data, result, importId, new Date().toISOString());
                  const transactions = result.accounts.flatMap((a) => a.transactions);
                  const balances = result.accounts.filter((a) => a.balance?.applied).length;
                  if (balances || result.accounts.some((a) => a.created)) snapshot(next);
                  const message = result.message;
                  const parts = [
                    transactions.length
                      ? `${transactions.length} transactions imported`
                      : 'No new transactions',
                  ];
                  if (balances) parts.push(`${balances} balance${balances > 1 ? 's' : ''} updated`);
                  if (
                    await save(next, message ?? parts.join(' · '), {
                      label: 'Undo',
                      onClick: () => askUndo(importId),
                    })
                  ) {
                    setModal(null);
                    // Show the newest imported month so the new rows are visible right away.
                    const latest = transactions.reduce((d, t) => (t.date > d ? t.date : d), '');
                    if (latest) {
                      setMonth(latest.slice(0, 7));
                      setPage(1);
                    }
                  }
                }}
              />
            ) : (
              <RecordForm
                defaultType={view === 'Credit cards' ? 'Credit card' : undefined}
                key={modal.kind + (modal.id || 'new')}
                modal={modal}
                data={data}
                saving={saving}
                storage={storage}
                onReceipts={(id, receipts) =>
                  save(
                    {
                      ...data,
                      transactions: data.transactions.map((t) =>
                        t.id === id ? { ...t, receipts } : t,
                      ),
                    },
                    'Receipts updated',
                  )
                }
                onDelete={() => modal.id && remove(modal.kind as 'account', modal.id)}
                onUnlinkTransfer={async (transferId) => {
                  if (await save(unlinkTransfer(data, transferId), 'Transfer unlinked'))
                    setModal(null);
                }}
                onSave={async (record, rule) => {
                  let next = structuredClone(data);
                  const key =
                    modal.kind === 'account'
                      ? 'accounts'
                      : modal.kind === 'transaction'
                        ? 'transactions'
                        : modal.kind === 'budget'
                          ? 'budgets'
                          : 'goals';
                  const list = next[key] as { id: string }[];
                  const index = list.findIndex((item) => item.id === record.id);
                  if (index >= 0) list[index] = record;
                  else list.push(record);
                  if (modal.kind === 'account') snapshot(next);
                  let message = `${modal.kind[0].toUpperCase() + modal.kind.slice(1)} saved`;
                  if (rule) {
                    next.rules = [...next.rules, rule];
                    const applied = applyRule(next, rule);
                    next = applied.next;
                    message = `Rule added · ${applied.changed} other transaction${applied.changed === 1 ? '' : 's'} updated`;
                  }
                  if (await save(next, message)) setModal(null);
                }}
              />
            ))}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <button className="primary" disabled={saving} onClick={() => confirm?.action()}>
              {saving ? 'Saving…' : 'Confirm'}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
function WorthChart({ data, range }: { data: Finance; range: number }) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - range);
  const points = data.snapshots
    .filter((s) => new Date(s.date + 'T12:00:00') >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2)
    return (
      <div className="chart-empty">
        <TrendingUp size={27} />
        <p>Your story starts here.</p>
        <span>Update your account balances over time to build your net worth history.</span>
      </div>
    );
  const values = points.map((p) => p.value);
  const low = Math.min(...values),
    high = Math.max(...values),
    spread = Math.max(high - low, 10000);
  const ys = values.map((v) => 180 - ((v - low) / spread) * 145);
  const start = Date.parse(points[0].date),
    duration = Date.parse(points[points.length - 1].date) - start || 1;
  const xs = points.map((p) => 10 + ((Date.parse(p.date) - start) / duration) * 670);
  const path = ys.map((y, i) => `${i ? 'L' : 'M'}${xs[i]} ${y}`).join(' ');
  return (
    <div className="chart real-chart">
      <div className="chart-y">
        <span>{cash(high)}</span>
        <span>{cash(low)}</span>
      </div>
      <svg
        viewBox="0 0 700 210"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Net worth from ${cash(values[0])} to ${cash(values.at(-1)!)} across ${points.length} snapshots`}
      >
        <defs>
          <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#177660" stopOpacity=".18" />
            <stop offset="100%" stopColor="#177660" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[30, 85, 140, 195].map((y) => (
          <line key={y} x1="0" y1={y} x2="700" y2={y} stroke="#e9edea" strokeDasharray="4 5" />
        ))}
        <path d={`${path} L${xs.at(-1)} 210 L10 210 Z`} fill="url(#fill)" />
        <path
          d={path}
          fill="none"
          stroke="#177660"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
        {ys.map((y, i) => (
          <circle key={points[i].date} cx={xs[i]} cy={y} r="4" fill="#177660">
            <title>
              {fmtDate(points[i].date)}: {cash(values[i], 2)}
            </title>
          </circle>
        ))}
      </svg>
      <div className="axis">
        {points
          .filter(
            (_, i) =>
              i === 0 ||
              i === points.length - 1 ||
              i % Math.max(1, Math.ceil(points.length / 5)) === 0,
          )
          .map((p) => (
            <span key={p.date}>{fmtDate(p.date)}</span>
          ))}
      </div>
    </div>
  );
}
function RecordForm({
  modal,
  data,
  saving,
  onSave,
  storage,
  onReceipts,
  onDelete,
  onUnlinkTransfer,
  defaultType,
}: {
  modal: NonNullable<Modal>;
  data: Finance;
  saving: boolean;
  onSave: (record: DraftRecord, rule?: Rule) => Promise<void>;
  storage: Storage;
  onReceipts: (transactionId: string, receipts: Receipt[]) => Promise<boolean>;
  onDelete: () => void;
  onUnlinkTransfer?: (transferId: string) => void;
  defaultType?: string;
}) {
  // "Remember for this payee": turns this edit into a rule for past and future entries.
  const [remember, setRemember] = useState(false);
  // Split parts as typed (positive dollar amounts, signed like the transaction on save).
  const [split, setSplit] = useState<{ category: string; amount: string; note: string }[] | null>(
    () => {
      const t =
        modal.kind === 'transaction' ? data.transactions.find((x) => x.id === modal.id) : null;
      return t?.splits
        ? t.splits.map((p) => ({
            category: p.category,
            amount: String(Math.abs(p.amount) / 100),
            note: p.note,
          }))
        : null;
    },
  );
  const existing =
    modal.kind === 'account'
      ? data.accounts.find((a) => a.id === modal.id)
      : modal.kind === 'transaction'
        ? data.transactions.find((t) => t.id === modal.id)
        : modal.kind === 'budget'
          ? data.budgets.find((b) => b.id === modal.id)
          : data.goals.find((g) => g.id === modal.id);
  const [form, setForm] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {
      name: '',
      institution: '',
      type: defaultType || 'Checking',
      balance: '',
      merchant: '',
      date: today(),
      amount: '',
      direction: 'Expense',
      reimbursable: '',
      reimburses: NONE_REPAID,
      category: 'Other',
      accountId: data.accounts[0]?.id || '',
      notes: '',
      limit: '',
      target: '',
      saved: '0',
      group: '',
      rollover: '',
      kind: 'savings',
    };
    if (existing)
      for (const [key, value] of Object.entries(existing)) {
        initial[key] = ['balance', 'limit', 'target', 'saved', 'amount'].includes(key)
          ? String((key === 'balance' ? Number(value) : Math.abs(Number(value))) / 100)
          : String(value);
      }
    if (existing && 'amount' in existing)
      initial.direction = existing.amount >= 0 ? 'Income' : 'Expense';
    if (modal.kind === 'goal')
      initial.accountId =
        (existing && 'accountId' in existing && existing.accountId) || NONE_REPAID;
    return initial;
  });
  const [formError, setFormError] = useState('');
  const change = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const field = (
    key: string,
    label: string,
    type = 'text',
    extra: Record<string, unknown> = {},
  ) => (
    <label className="form-field">
      {label}
      <input
        required
        disabled={
          !!existing &&
          'plaidItemId' in existing &&
          !!existing.plaidItemId &&
          ['balance', 'institution', 'amount', 'date', 'merchant'].includes(key)
        }
        type={type}
        value={form[key]}
        onInput={(e) => change(key, e.currentTarget.value)}
        maxLength={type === 'text' ? 100 : undefined}
        {...extra}
      />
    </label>
  );
  const moneyField = (key: string, label: string, min = 0) =>
    field(key, label, 'number', { min, step: '.01', max: 1000000000 });
  const selectField = (key: string, label: string, options: { value: string; label: string }[]) => (
    <label className="form-field">
      {label}
      <Choice label={label} value={form[key]} onChange={(v) => change(key, v)} options={options} />
    </label>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    const cents = (key: string) => Math.round(Number(form[key]) * 100);
    const id = modal.id || crypto.randomUUID();
    let r: DraftRecord = { id };
    if (modal.kind === 'account')
      r = {
        id,
        name: form.name.trim(),
        institution: form.institution.trim(),
        type: form.type,
        balance: cents('balance'),
      };
    if (modal.kind === 'transaction') {
      if (!form.accountId) {
        setFormError('Add an account before recording transactions.');
        return;
      }
      const sign = form.direction === 'Expense' ? -1 : 1;
      r = {
        id,
        date: form.date,
        merchant: form.merchant.trim(),
        category: form.category,
        accountId: form.accountId,
        amount: cents('amount') * sign,
        notes: form.notes,
        splits: undefined,
        reimbursable: sign < 0 && form.reimbursable === 'true' ? true : undefined,
        reimburses:
          sign > 0 && form.reimburses && form.reimburses !== NONE_REPAID
            ? form.reimburses
            : undefined,
      };
      // A repayment is filed under the expense's category, so the two net out.
      const repaid = data.transactions.find((t) => t.id === r.reimburses);
      if (repaid && !split) r = { ...r, category: repaid.category };
      if (split) {
        const pieces = split.map((p) => ({
          category: p.category,
          amount: Math.round(Number(p.amount) * 100) * sign,
          note: p.note.trim().slice(0, 100),
        }));
        if (pieces.some((p) => !Number.isFinite(p.amount) || p.amount === 0)) {
          setFormError('Enter an amount for each part of the split.');
          return;
        }
        const total = pieces.reduce((sum, p) => sum + p.amount, 0);
        if (total !== r.amount) {
          setFormError(
            `The parts add up to ${cash(Math.abs(total), 2)}; the transaction is ${cash(Math.abs(Number(r.amount)), 2)}.`,
          );
          return;
        }
        r = { ...r, splits: pieces, category: mainCategory(pieces) };
      }
    }
    if (modal.kind === 'budget') {
      if (data.budgets.some((b) => b.category === form.category && b.id !== id)) {
        setFormError('This category already has a budget. Edit the existing budget instead.');
        return;
      }
      const before = existing && 'rollover' in existing ? existing : undefined;
      const rollover = form.rollover === 'true';
      r = {
        id,
        category: form.category,
        limit: cents('limit'),
        group: form.group.trim() || undefined,
        rollover,
        // Rollover counts from the month it was turned on.
        rolloverFrom: rollover
          ? before?.rollover && before.rolloverFrom
            ? before.rolloverFrom
            : today().slice(0, 7)
          : undefined,
      };
    }
    if (modal.kind === 'goal')
      r = {
        id,
        name: form.name.trim(),
        target: cents('target'),
        saved: cents('saved'),
        date: form.date,
        kind: form.kind,
        accountId: form.accountId === NONE_REPAID ? undefined : form.accountId,
      };
    if (existing && 'plaidItemId' in existing && existing.plaidItemId) {
      if (modal.kind === 'account') r = { ...existing, name: r.name };
      if (modal.kind === 'transaction')
        r = { ...existing, category: r.category, categoryEdited: true, notes: r.notes };
    } else if (existing) r = { ...existing, ...r };
    if (modal.kind === 'account') {
      const before = existing as Account | undefined;
      // A balance typed in is dated today; an unchanged one keeps its date and source.
      if (!before || before.balance !== r.balance)
        r = { ...r, balanceDate: today(), balanceSource: 'manual' };
    }
    if (
      modal.kind === 'transaction' &&
      existing &&
      'importBatch' in existing &&
      existing.importBatch &&
      !sameValue(r, existing)
    ) {
      r = { ...r, edited: true };
      // Keep the bank's description so importing the same file again still finds it.
      if ('merchant' in existing && r.merchant !== existing.merchant && !existing.originalMerchant)
        r = { ...r, originalMerchant: existing.merchant };
    }
    if (remember && modal.kind === 'transaction' && existing && 'merchant' in existing) {
      const description = bankDescription(existing);
      const merchant = String(r.merchant);
      await onSave(r, {
        id: crypto.randomUUID(),
        contains: ruleTextFor(description),
        ...(merchant !== description ? { rename: merchant } : {}),
        category: String(r.category),
      });
      return;
    }
    await onSave(r);
  }
  return (
    <form onSubmit={submit} className="record-form">
      {!!existing &&
        'transferId' in existing &&
        existing.transferId &&
        (() => {
          const partner = transferPartner(data, existing);
          if (!partner) return null;
          const account = data.accounts.find((a) => a.id === partner.accountId)?.name;
          return (
            <p className="form-hint">
              Linked transfer: {partner.amount > 0 ? 'arrives in' : 'leaves'} {account} on{' '}
              {fmtDate(partner.date)} as “{partner.merchant}”.{' '}
              <button
                type="button"
                className="text-button inline"
                onClick={() => onUnlinkTransfer?.(existing.transferId!)}
              >
                Unlink
              </button>
            </p>
          );
        })()}
      {!!existing && 'status' in existing && existing.status === 'reconciled' && (
        <p className="form-hint">
          This transaction is reconciled to a statement. Changing its amount, date, or account
          changes the reconciled balance.
        </p>
      )}
      {!!existing && 'plaidItemId' in existing && !!existing.plaidItemId && (
        <p className="form-hint">
          Bank-synced record. Amounts, dates, account types, and account assignments come from
          Plaid; your notes and category edits are preserved.
        </p>
      )}
      {modal.kind === 'account' && (
        <>
          {field('name', 'Account name')}
          {field('institution', 'Institution')}
          <div className="form-grid">
            {selectField(
              'type',
              'Account type',
              choices(['Checking', 'Savings', 'Investment', 'Credit card', 'Loan', 'Property']),
            )}
            {moneyField(
              'balance',
              'Current balance (USD)',
              form.type === 'Checking' ? -1000000000 : 0,
            )}
          </div>
          <p className="form-hint">
            For credit cards and loans, enter the amount owed as a positive number.
          </p>
        </>
      )}
      {modal.kind === 'transaction' && (
        <>
          {!data.accounts.length && (
            <p className="error-banner">First add an account from the Accounts page.</p>
          )}
          {field('merchant', 'Merchant or description')}
          <div className="form-grid">
            {moneyField('amount', 'Amount (USD)', 0.01)}
            {selectField('direction', 'Direction', choices(['Expense', 'Income']))}
          </div>
          <div className="form-grid">
            {field('date', 'Date', 'date')}
            {split ? (
              <div className="form-field">
                Category
                <span className="split-note">Split across {split.length} categories</span>
              </div>
            ) : (
              selectField('category', 'Category', choices(allCategories(data)))
            )}
          </div>
          {!(existing && 'plaidItemId' in existing && existing.plaidItemId) && (
            <SplitEditor
              split={split}
              setSplit={setSplit}
              total={Math.round(Number(form.amount || 0) * 100)}
              category={form.category}
              categories={allCategories(data)}
            />
          )}
          {selectField(
            'accountId',
            'Account',
            data.accounts.map((a) => ({ value: a.id, label: a.name })),
          )}
          <label className="form-field">
            Notes (optional)
            <textarea
              value={form.notes}
              onChange={(e) => change('notes', e.target.value)}
              maxLength={500}
            />
          </label>
          {form.direction === 'Expense' ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.reimbursable === 'true'}
                onChange={(e) => change('reimbursable', String(e.target.checked))}
              />
              <span>I&apos;ll be reimbursed for this (work expense, shared cost)</span>
            </label>
          ) : (
            (() => {
              const open = awaitingReimbursement(data).filter(
                (t) => t.id !== modal.id || form.reimburses === t.id,
              );
              const current = data.transactions.find((t) => t.id === form.reimburses);
              const options = current && !open.includes(current) ? [current, ...open] : open;
              return options.length
                ? selectField('reimburses', 'This pays back (optional)', [
                    { value: NONE_REPAID, label: 'Nothing — regular income' },
                    ...options.map((t) => ({
                      value: t.id,
                      label: `${t.merchant} · ${fmtDate(t.date)} · ${cash(-t.amount, 2)}`,
                    })),
                  ])
                : null;
            })()
          )}
          {!!existing && 'merchant' in existing && (
            <ReceiptsField
              receipts={existing.receipts ?? []}
              storage={storage}
              disabled={saving}
              onChange={(receipts) => onReceipts(existing.id, receipts)}
            />
          )}
          {!!existing && 'merchant' in existing && !existing.plaidItemId && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>
                Remember for this payee: entries whose description contains “
                {ruleTextFor(bankDescription(existing))}” get this name and category, now and in
                future imports.
              </span>
            </label>
          )}
          <p className="form-hint">
            Use the Transfer category to exclude account transfers from income and spending.
          </p>
        </>
      )}
      {modal.kind === 'budget' && (
        <>
          {selectField('category', 'Spending category', choices(spendingCategories(data)))}
          {moneyField('limit', 'Monthly limit (USD)', 0.01)}
          <label className="form-field">
            Group (optional)
            <input
              list="budget-groups"
              maxLength={40}
              placeholder="Essentials, Lifestyle, …"
              value={form.group}
              onInput={(e) => change('group', e.currentTarget.value)}
            />
            <datalist id="budget-groups">
              {[...new Set(data.budgets.map((b) => b.group).filter(Boolean))].map((g) => (
                <option value={g} key={g} />
              ))}
            </datalist>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.rollover === 'true'}
              onChange={(e) => change('rollover', String(e.target.checked))}
            />
            <span>Roll over what&apos;s left (or overspent) into next month</span>
          </label>
          <p className="form-hint">
            This limit repeats every month; adjust a single month from its budget card. Rollover
            suits irregular costs such as car repairs or gifts: set aside a monthly amount and let
            it build up.
          </p>
        </>
      )}
      {modal.kind === 'goal' && (
        <>
          {field('name', 'Goal name')}
          <div className="form-grid">
            {moneyField('target', 'Target amount (USD)', 0.01)}
            {moneyField('saved', 'Amount saved (USD)')}
          </div>
          {field('date', 'Target date', 'date')}
          <div className="form-grid">
            {selectField('kind', 'Kind of goal', [
              { value: 'savings', label: 'Savings' },
              { value: 'emergency', label: 'Emergency fund' },
              { value: 'purchase', label: 'A purchase' },
              { value: 'debt', label: 'Pay down a debt' },
            ])}
            {selectField(
              'accountId',
              form.kind === 'debt' ? 'Debt to pay down' : 'Kept in (earmarked)',
              [
                { value: NONE_REPAID, label: 'No account' },
                ...data.accounts
                  .filter((a) => (form.kind === 'debt' ? liability(a) : !liability(a)))
                  .map((a) => ({ value: a.id, label: a.name })),
              ],
            )}
          </div>
          <p className="form-hint">
            {form.kind === 'debt'
              ? 'With a card or loan chosen, progress is the target (the starting balance) less what is still owed.'
              : 'Choosing an account earmarks the amount saved there, so you can see what in that account is still unassigned.'}
          </p>
        </>
      )}
      {formError && (
        <p className="negative" role="alert">
          {formError}
        </p>
      )}
      <div className="form-actions">
        {modal.id && (
          <button
            type="button"
            className="icon-button danger"
            aria-label={`Delete ${modal.kind}`}
            disabled={saving}
            onClick={onDelete}
          >
            <Trash2 size={18} />
          </button>
        )}
        <button
          className="primary"
          disabled={saving || (modal.kind === 'transaction' && !data.accounts.length)}
        >
          {saving ? 'Saving…' : `Save ${modal.kind}`}
        </button>
      </div>
    </form>
  );
}
function UpcomingBills({ data, onOpen }: { data: Finance; onOpen: () => void }) {
  const end = new Date();
  end.setDate(end.getDate() + 7);
  const upcoming = dueItems(data, today(), end.toISOString().slice(0, 10)).filter(
    (b) => !b.paid && !b.income,
  );
  if (!upcoming.length) return null;
  return (
    <button className="upcoming-strip" onClick={onOpen}>
      <CalendarDays size={20} />
      <span>
        <b>
          {upcoming.length} payment{upcoming.length === 1 ? '' : 's'} due in the next 7 days
        </b>
        <small>
          {upcoming
            .slice(0, 2)
            .map((b) => b.name)
            .join(' · ')}
        </small>
      </span>
      <strong>{cash(upcoming.reduce((sum, b) => sum + (b.amount ?? 0), 0))}</strong>
      <ChevronRight size={18} />
    </button>
  );
}
function BankDownloadsNote() {
  return (
    <section className="panel bank-connections">
      <div className="panel-title">
        <div className="bank-title">
          <span className="bank-icon">
            <Landmark size={20} />
          </span>
          <div>
            <h2>Bank downloads</h2>
            <p>Bring in transactions from files your bank provides.</p>
          </div>
        </div>
      </div>
      <p className="helper-note">
        Download transactions from your bank&apos;s website as QFX/OFX (Quicken format) or CSV and
        use <b>Import</b> on the Transactions page. QFX/OFX files also bring in the account and its
        statement balance. A credit card statement PDF fills in the card&apos;s balance, limit, APR,
        minimum payment, and due date. Automatic bank sync is planned.
      </p>
    </section>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function ImportHistory({
  data,
  saving,
  onUndo,
}: {
  data: Finance;
  saving: boolean;
  onUndo: (importId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const names = new Map(data.accounts.map((a) => [a.id, a.name]));
  const records = [...data.imports].reverse();
  const shown = all ? records : records.slice(0, 20);
  return (
    <section className="panel settings-panel extra-settings import-history">
      <h2>Import history</h2>
      {!records.length && (
        <p className="form-hint">
          Files you import are listed here. You can undo an import later; transactions you edited
          since are kept.
        </p>
      )}
      {shown.map((r) => (
        <div className="setting-row" key={r.id}>
          <div>
            <h3>
              {r.fileName || 'Imported file'} <span className="pill">{r.format}</span>
            </h3>
            <p>
              Imported {shortDate(r.at)}
              {r.undoneAt ? ` · undone ${shortDate(r.undoneAt)}` : ''}
            </p>
            {r.accounts.map((a) => (
              <p key={a.accountId}>
                <b>{names.get(a.accountId) ?? a.after.name}</b>
                {a.created ? ' (new account)' : ''}: {a.added} new · {a.duplicates} already in Folio
                {a.skipped ? ` · ${a.skipped} rows skipped` : ''}
                {a.from ? ` · ${a.from === a.to ? a.from : `${a.from} to ${a.to}`}` : ''}
                {a.balance
                  ? ` · balance ${cash(a.balance.amount, 2)}${
                      a.balance.date ? ` as of ${a.balance.date}` : ''
                    }${a.balance.applied ? '' : ' (existing balance kept)'}`
                  : ''}
              </p>
            ))}
          </div>
          {r.undoneAt ? (
            <span className="pill">Undone</span>
          ) : (
            <button className="secondary" disabled={saving} onClick={() => onUndo(r.id)}>
              <Undo2 size={16} />
              Undo
            </button>
          )}
        </div>
      ))}
      {records.length > shown.length && (
        <button className="text-button" onClick={() => setAll(true)}>
          Show all {records.length} imports
        </button>
      )}
    </section>
  );
}

/** Divides a transaction across categories; the parts must add up to its amount. */
function SplitEditor({
  split,
  setSplit,
  total,
  category,
  categories,
}: {
  split: { category: string; amount: string; note: string }[] | null;
  setSplit: (s: { category: string; amount: string; note: string }[] | null) => void;
  total: number;
  category: string;
  categories: string[];
}) {
  if (!split)
    return (
      <div className="row-actions">
        <button
          type="button"
          className="text-button split-toggle"
          onClick={() =>
            setSplit([
              { category, amount: total ? String(total / 100) : '', note: '' },
              { category: 'Other', amount: '', note: '' },
            ])
          }
        >
          Split across categories
        </button>
        <button
          type="button"
          className="text-button split-toggle"
          title="For a loan payment: the principal moves money to the loan account; the interest is an expense."
          onClick={() =>
            setSplit([
              { category: 'Transfer', amount: '', note: 'Principal' },
              { category: 'Interest & fees', amount: '', note: 'Interest' },
            ])
          }
        >
          Loan payment: principal and interest
        </button>
      </div>
    );
  const used = split.reduce((sum, p) => sum + Math.round(Number(p.amount || 0) * 100), 0);
  const left = total - used;
  const update = (i: number, patch: Partial<(typeof split)[number]>) =>
    setSplit(split.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="split-editor">
      {split.map((p, i) => (
        <div className="split-row" key={i}>
          <Choice
            label={`Category for part ${i + 1}`}
            value={p.category}
            onChange={(v) => update(i, { category: v })}
            options={choices(categories)}
          />
          <input
            aria-label={`Amount for part ${i + 1}`}
            type="number"
            min="0.01"
            step="0.01"
            value={p.amount}
            placeholder="0.00"
            onChange={(e) => update(i, { amount: e.target.value })}
          />
          <input
            aria-label={`Note for part ${i + 1}`}
            value={p.note}
            maxLength={100}
            placeholder="Note"
            onChange={(e) => update(i, { note: e.target.value })}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove part ${i + 1}`}
            disabled={split.length <= 2}
            onClick={() => setSplit(split.filter((_, j) => j !== i))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="split-footer">
        <span className={left === 0 ? 'positive' : 'negative'}>
          {left === 0
            ? 'Parts add up to the total'
            : `${cash(Math.abs(left), 2)} ${left > 0 ? 'left to assign' : 'over the total'}`}
        </span>
        <div className="row-actions">
          {left > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setSplit([...split, { category: 'Other', amount: String(left / 100), note: '' }])
              }
            >
              Add the rest as a part
            </button>
          )}
          {split.length < 30 && left <= 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setSplit([...split, { category: 'Other', amount: '', note: '' }])}
            >
              Add a part
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setSplit(null)}>
            Don&apos;t split
          </button>
        </div>
      </div>
    </div>
  );
}
