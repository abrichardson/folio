import { useMemo, useState } from 'react';
import { Check, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  MAX_TRANSACTIONS,
  cash,
  olderThanBalance,
  parseCSV,
  today,
  type Account,
  type Finance,
  type Transaction,
} from '@/lib/finance';
import {
  dateRange,
  previousImportOf,
  type ImportedAccount,
  type ImportResult,
} from '@/lib/imports';
import {
  accountImportKey,
  decodeBankFile,
  suggestCategory,
  withoutDuplicates,
  type ImportedTransaction,
} from '@/lib/import/common';
import {
  applyStatement,
  looksLikeStatement,
  parseStatementText,
  type StatementSummary,
} from '@/lib/import/statement';
import { pdfTextLines } from './pdf-text';
import { parseOFX, ofxTypeLabel, type OfxFile, type OfxStatement } from '@/lib/import/ofx';
import {
  detectDateFormat,
  detectPurchasesPositive,
  detectMapping,
  parseAmount,
  accountDigitsFromFileName,
  csvHeaderSignature,
  readCsvRows,
  type CsvMapping,
  type DateFormat,
} from '@/lib/import/csv';
import { saveTextFile } from './save-file';
import { categorize, learnedCategories } from '@/lib/rules';

const MAX_FILE_BYTES = 10_000_000;
const MAX_ROWS = 50_000;
const NEW = '__new__';
const NONE = '-1';

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type PdfState = {
  summary: StatementSummary;
  target: string;
  name: string;
  institution: string;
};

type StatementChoice = {
  statement: OfxStatement;
  key: string;
  target: string;
  name: string;
  institution: string;
  type: Account['type'];
  setBalance: boolean;
};

type CsvState = {
  header: string[];
  rows: string[][];
  mapping: CsvMapping;
  dateFormat: DateFormat;
  purchasesPositive: boolean;
  account: string;
  /** Used when `account` is NEW. */
  newName: string;
  newInstitution: string;
  newType: Account['type'];
  newBalance: string;
  mask: string;
  signature: string;
  /** Name of the account whose saved column settings are in use. */
  savedFrom: string;
};

/** Column settings saved from the last import of this layout into `account`, if any. */
function savedCsv(account: Account | undefined, signature: string) {
  const saved = account?.importSettings?.csv;
  return saved && saved.headers === signature ? saved : undefined;
}

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
    <label className="form-field">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

const accountTypes: Account['type'][] = [
  'Checking',
  'Savings',
  'Investment',
  'Credit card',
  'Loan',
  'Property',
];
const liability = (type: Account['type']) => type === 'Credit card' || type === 'Loan';

function folioType(s: OfxStatement): Account['type'] {
  if (s.kind === 'creditcard') return 'Credit card';
  if (s.accountType === 'CREDITLINE') return 'Loan';
  if (s.accountType === 'CHECKING') return 'Checking';
  return 'Savings';
}

/** Folio stores amounts owed as positive balances; OFX reports them as negative. */
const folioBalance = (ofxBalance: number, type: Account['type']) =>
  liability(type) ? -ofxBalance : ofxBalance;

function ofxTransactions(s: OfxStatement, type: Account['type']): ImportedTransaction[] {
  return s.transactions.map((t) => {
    const check = t.checkNumber ? `Check ${t.checkNumber}` : '';
    const merchant = t.name || t.memo.slice(0, 100) || check || ofxTypeLabel(t.type);
    const notes = [t.name && t.memo !== t.name ? t.memo : '', check && t.name ? check : '']
      .filter(Boolean)
      .join(' · ');
    return {
      date: t.date,
      merchant,
      amount: t.amount,
      notes,
      importId: t.fitId ? `ofx:${t.fitId}` : undefined,
      category: suggestCategory({ merchant, amount: t.amount, accountType: type, ofxType: t.type }),
    };
  });
}

function toTransactions(rows: ImportedTransaction[], accountId: string): Transaction[] {
  return rows.map((t) => ({ id: crypto.randomUUID(), accountId, ...t }));
}

export default function ImportForm({
  data,
  saving,
  onSave,
}: {
  data: Finance;
  saving: boolean;
  onSave: (result: ImportResult) => Promise<void>;
}) {
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [ofx, setOfx] = useState<{ file: OfxFile; choices: StatementChoice[] } | null>(null);
  const [csv, setCsv] = useState<CsvState | null>(null);
  const [pdf, setPdf] = useState<PdfState | null>(null);
  const [fileHash, setFileHash] = useState('');

  async function read(file: File) {
    setFileName(file.name);
    setError('');
    setOfx(null);
    setCsv(null);
    setPdf(null);
    setFileHash('');
    setReading(true);
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('Choose a file smaller than 10 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      setFileHash(await sha256(bytes));
      if (new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-') return await readPdf(bytes);
      const text = decodeBankFile(bytes);
      if (/<OFX>/i.test(text)) await readOfx(text);
      else readCsv(text, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The file could not be read.');
    } finally {
      setReading(false);
    }
  }

  async function readPdf(bytes: Uint8Array) {
    const summary = parseStatementText(await pdfTextLines(bytes));
    if (!looksLikeStatement(summary))
      throw new Error(
        'Folio could not find credit card statement details in this PDF. Scanned statements and bank statements are not supported yet.',
      );
    const cards = data.accounts.filter((a) => a.type === 'Credit card');
    const match = summary.last4 ? cards.find((a) => a.mask === summary.last4) : undefined;
    setPdf({
      summary,
      target: match?.id ?? NEW,
      name: `${summary.issuer ?? 'Credit'} card${summary.last4 ? ' ••' + summary.last4 : ''}`,
      institution: summary.issuer ?? '',
    });
  }

  async function readOfx(text: string) {
    const file = parseOFX(text);
    const choices: StatementChoice[] = [];
    for (const statement of file.statements) {
      const key = await accountImportKey(statement.bankId, statement.accountNumber);
      const type = folioType(statement);
      const last4 = statement.accountNumber.slice(-4);
      const match =
        data.accounts.find((a) => a.importKey === key) ??
        data.accounts.find((a) => !a.importKey && a.mask === last4 && a.type === type);
      choices.push({
        statement,
        key,
        target: match?.id ?? NEW,
        name: `${ofxTypeLabel(statement.accountType)} ${last4 ? '••' + last4 : ''}`.trim(),
        institution: file.institution || 'Imported',
        type,
        // An older statement adds missing transactions but keeps a newer balance.
        setBalance:
          statement.balance !== null && !(match && olderThanBalance(match, statement.balanceDate)),
      });
    }
    setOfx({ file, choices });
  }

  function readCsv(text: string, name: string) {
    const records = parseCSV(text);
    const header = (records.shift() ?? []).map((h) => h.trim());
    if (!records.length) throw new Error('The file has no transaction rows.');
    if (records.length > MAX_ROWS) throw new Error('Import up to 10,000 rows at a time.');
    const mapping = detectMapping(header);
    const values = (index: number) =>
      records.map((r) => (index >= 0 ? (r[index] ?? '').trim() : '')).filter(Boolean);
    const isBlank = (index: number) => values(index).every((v) => /^(null|n\/?a|-+)$/i.test(v));
    // Some banks (Truist, for one) leave the transaction date as "null"; use the posted date.
    if (mapping.dateFallback >= 0 && isBlank(mapping.date) && !isBlank(mapping.dateFallback))
      [mapping.date, mapping.dateFallback] = [mapping.dateFallback, mapping.date];
    const mask = accountDigitsFromFileName(name);
    const signature = csvHeaderSignature(header);
    // Prefer the account named by the file; otherwise the one account that last imported
    // a file with these columns.
    const sameLayout = data.accounts.filter((a) => savedCsv(a, signature));
    const match =
      (mask ? data.accounts.find((a) => a.mask === mask) : undefined) ??
      (!mask && sameLayout.length === 1 ? sameLayout[0] : undefined);
    const state: CsvState = {
      header,
      rows: records,
      mapping,
      dateFormat: detectDateFormat(values(mapping.date)),
      purchasesPositive: detectPurchasesPositive(records, mapping),
      account: match?.id ?? (mask || !data.accounts.length ? NEW : data.accounts[0].id),
      newName: mask ? `Checking ••${mask}` : 'Imported account',
      newInstitution: '',
      newType: 'Checking',
      newBalance: '',
      mask,
      signature,
      savedFrom: '',
    };
    setCsv(withSavedSettings(state, state.account));
  }

  /** Switches the CSV target account, using its saved column settings when they fit. */
  function withSavedSettings(state: CsvState, account: string): CsvState {
    const target = data.accounts.find((a) => a.id === account);
    const saved = savedCsv(target, state.signature);
    return saved
      ? {
          ...state,
          account,
          mapping: { ...saved.mapping },
          dateFormat: saved.dateFormat,
          purchasesPositive: saved.purchasesPositive,
          savedFrom: target!.name,
        }
      : { ...state, account, savedFrom: '' };
  }

  // Categories picked by hand before, by payee, to file new rows the same way.
  const learned = useMemo(() => learnedCategories(data.transactions), [data.transactions]);
  const plan = useMemo(() => {
    const results: ImportedAccount[] = [];
    const lines: { label: string; fresh: number; duplicates: number; sample: Transaction[] }[] = [];
    let errors: string[] = [];
    let problem = '';
    // Statements and CSV files get a preview line; a statement PDF has its own panel.
    const add = (result: ImportedAccount, preview = true) => {
      results.push(result);
      if (preview)
        lines.push({
          label: result.account.name,
          fresh: result.transactions.length,
          duplicates: result.duplicates,
          sample: result.transactions.slice(0, 3),
        });
    };
    if (ofx) {
      for (const c of ofx.choices) {
        const existing = data.accounts.find((a) => a.id === c.target);
        const type = existing?.type ?? c.type;
        const id = existing?.id ?? crypto.randomUUID();
        const s = c.statement;
        const statementBalance = s.balance === null ? null : folioBalance(s.balance, type);
        const applied = c.setBalance && statementBalance !== null;
        if (!existing && !c.name.trim()) problem = 'Give each new account a name.';
        const dated = applied
          ? {
              balance: statementBalance,
              balanceDate: s.balanceDate ?? today(),
              balanceSource: 'ofx' as const,
            }
          : {};
        const account: Account = existing
          ? {
              ...existing,
              importKey: c.key,
              mask: existing.mask ?? (s.accountNumber.slice(-4) || undefined),
              ...dated,
            }
          : {
              id,
              name: c.name.trim().slice(0, 100),
              institution: c.institution.trim().slice(0, 100) || 'Imported',
              type,
              balance: 0,
              importKey: c.key,
              mask: s.accountNumber.slice(-4) || undefined,
              ...dated,
            };
        const incoming = ofxTransactions(s, type);
        const { fresh, duplicates } = withoutDuplicates(data.transactions, incoming, id);
        const [from, to] = dateRange(incoming);
        add({
          account,
          created: !existing,
          transactions: toTransactions(categorize(fresh, data.rules, learned), id),
          duplicates,
          skipped: 0,
          from,
          to,
          balance:
            statementBalance === null
              ? null
              : { amount: statementBalance, date: s.balanceDate, applied },
        });
      }
      if (
        new Set(ofx.choices.filter((c) => c.target !== NEW).map((c) => c.target)).size !==
        ofx.choices.filter((c) => c.target !== NEW).length
      )
        problem = 'Import each statement into a different account.';
    }
    if (csv) {
      const m = csv.mapping;
      const existing = data.accounts.find((a) => a.id === csv.account);
      let target: Account | undefined = existing;
      if (!existing && csv.account === NEW) {
        const balance = csv.newBalance.trim() ? parseAmount(csv.newBalance) : 0;
        if (!csv.newName.trim()) problem = 'Give the new account a name.';
        else if (balance === null)
          problem = 'Enter the current balance as a number, or leave it blank.';
        else
          target = {
            id: crypto.randomUUID(),
            name: csv.newName.trim().slice(0, 100),
            institution: csv.newInstitution.trim().slice(0, 100) || 'Imported',
            type: csv.newType,
            balance,
            ...(csv.newBalance.trim()
              ? { balanceDate: today(), balanceSource: 'manual' as const }
              : {}),
            ...(csv.mask ? { mask: csv.mask } : {}),
          };
      }
      if (!problem && !target) problem = 'Choose an account to import into.';
      else if (!problem && (m.date < 0 || m.description < 0))
        problem = 'Choose the date and description columns.';
      else if (!problem && m.amount < 0 && m.debit < 0 && m.credit < 0)
        problem = 'Choose an amount column, or the debit and credit columns.';
      else if (!problem && target) {
        const read = readCsvRows(csv.rows, {
          mapping: m,
          dateFormat: csv.dateFormat,
          purchasesPositive: csv.purchasesPositive,
          accountType: target.type,
        });
        errors = read.errors;
        const { fresh, duplicates } = withoutDuplicates(
          data.transactions,
          read.transactions,
          target.id,
        );
        const [from, to] = dateRange(read.transactions);
        add({
          // Remember this file layout's columns for the next import into the account.
          account: {
            ...target,
            importSettings: {
              ...target.importSettings,
              csv: {
                headers: csv.signature,
                mapping: { ...m },
                dateFormat: csv.dateFormat,
                purchasesPositive: csv.purchasesPositive,
              },
            },
          },
          created: !existing,
          transactions: toTransactions(categorize(fresh, data.rules, learned), target.id),
          duplicates,
          skipped: read.errors.length,
          from,
          to,
          balance: null,
        });
      }
    }
    if (pdf) {
      const existing = data.accounts.find((a) => a.id === pdf.target);
      if (!existing && !pdf.name.trim()) problem = 'Give the new card a name.';
      else {
        const base: Account = existing ?? {
          id: crypto.randomUUID(),
          name: pdf.name.trim().slice(0, 100),
          institution: pdf.institution.trim().slice(0, 100) || 'Imported',
          type: 'Credit card',
          balance: 0,
        };
        const s = pdf.summary;
        add(
          {
            account: applyStatement(base, s),
            created: !existing,
            transactions: [],
            duplicates: 0,
            skipped: 0,
            from: null,
            to: null,
            balance:
              s.newBalance === null
                ? null
                : {
                    amount: s.newBalance,
                    date: s.closingDate,
                    applied: !olderThanBalance(base, s.closingDate),
                  },
          },
          false,
        );
      }
    }
    const transactions = results.flatMap((r) => r.transactions);
    const balances = results.filter((r) => r.balance?.applied).length;
    if (!problem && data.transactions.length + transactions.length > MAX_TRANSACTIONS)
      problem = `Folio holds up to ${MAX_TRANSACTIONS.toLocaleString()} transactions; this import would exceed that.`;
    return { results, transactions, lines, errors, balances, problem };
  }, [ofx, csv, pdf, data, learned]);

  const columnOptions = (csv?.header ?? []).map((h, i) => ({
    value: String(i),
    label: h || `Column ${i + 1}`,
  }));
  const optionalColumns = [{ value: NONE, label: 'None' }, ...columnOptions];
  const setMapping = (field: keyof CsvMapping, v: string) =>
    csv && setCsv({ ...csv, mapping: { ...csv.mapping, [field]: Number(v) } });
  const updateChoice = (index: number, patch: Partial<StatementChoice>) =>
    ofx &&
    setOfx({ ...ofx, choices: ofx.choices.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  const sampleOut = csv ? plan.transactions.filter((t) => t.amount < 0).length : 0;
  const sampleIn = csv ? plan.transactions.filter((t) => t.amount > 0).length : 0;
  const ready =
    !reading &&
    !error &&
    !plan.problem &&
    (plan.transactions.length > 0 || plan.balances > 0 || (!!pdf && plan.results.length > 0));
  const previous = fileHash ? previousImportOf(data, fileHash) : undefined;

  return (
    <div className="record-form">
      <p className="form-hint">
        Download transactions from your bank&apos;s website as <b>QFX/OFX</b> (Quicken or Money
        format) or <b>CSV</b>, then choose the file here. Transactions already in Folio are skipped.
        A credit card <b>statement PDF</b> updates the card&apos;s balance, limit, APR, and payment
        due.
      </p>
      <label className="upload-zone">
        <Upload size={24} />
        <b>
          {reading ? 'Reading file…' : fileName || 'Choose a QFX, OFX, QBO, CSV, or statement PDF'}
        </b>
        <span>Up to 50,000 rows · 10 MB max</span>
        <input
          type="file"
          title="Choose a bank file"
          accept=".qfx,.ofx,.qbo,.csv,.pdf,text/csv,application/x-ofx,application/pdf"
          disabled={reading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
            e.target.value = '';
          }}
        />
      </label>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      {previous && !error && (
        <p className="form-hint">
          You imported this file on {new Date(previous.at).toLocaleDateString('en-US')}.
          Transactions already in Folio are skipped, so importing it again adds only what is
          missing.
        </p>
      )}

      {ofx?.file.warnings.map((w) => (
        <p key={w} className="form-hint">
          {w}
        </p>
      ))}
      {ofx?.choices.map((c, i) => {
        const s = c.statement;
        const existing = data.accounts.find((a) => a.id === c.target);
        const type = existing?.type ?? c.type;
        return (
          <div className="import-statement" key={c.key}>
            <h3>
              {ofxTypeLabel(s.accountType)} ending {s.accountNumber.slice(-4) || '????'}
            </h3>
            <p className="form-hint">
              {s.transactions.length} transactions
              {s.balance !== null &&
                ` · statement balance ${cash(folioBalance(s.balance, type), 2)}${
                  liability(type) ? ' owed' : ''
                }${s.balanceDate ? ` on ${s.balanceDate}` : ''}`}
            </p>
            <Pick
              label="Import into"
              value={c.target}
              onChange={(target) => updateChoice(i, { target })}
              options={[
                { value: NEW, label: 'A new account' },
                ...data.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.type})` })),
              ]}
            />
            {c.target === NEW && (
              <div className="form-grid">
                <label className="form-field">
                  Account name
                  <input
                    value={c.name}
                    onChange={(e) => updateChoice(i, { name: e.target.value })}
                  />
                </label>
                <label className="form-field">
                  Institution
                  <input
                    value={c.institution}
                    onChange={(e) => updateChoice(i, { institution: e.target.value })}
                  />
                </label>
                <Pick
                  label="Account type"
                  value={c.type}
                  onChange={(v) => updateChoice(i, { type: v as Account['type'] })}
                  options={accountTypes.map((t) => ({ value: t, label: t }))}
                />
              </div>
            )}
            {s.balance !== null && (
              <label className="switch-row">
                <Switch
                  checked={c.setBalance}
                  onCheckedChange={(setBalance) => updateChoice(i, { setBalance })}
                />
                Set the account balance to the statement balance
              </label>
            )}
            {existing && s.balance !== null && olderThanBalance(existing, s.balanceDate) && (
              <p className="form-hint">
                {existing.name} already has a newer balance from {existing.balanceDate}.
                {c.setBalance
                  ? ' Turning this on replaces it with this older one.'
                  : ' It is kept; missing transactions are still added.'}
              </p>
            )}
          </div>
        );
      })}

      {csv && (
        <div className="import-statement">
          <Pick
            label="Import into"
            value={csv.account}
            onChange={(account) => setCsv(withSavedSettings(csv, account))}
            options={[
              { value: NEW, label: 'A new account' },
              ...data.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.type})` })),
            ]}
          />
          {csv.account === NEW && (
            <div className="form-grid">
              <label className="form-field">
                Account name
                <input
                  value={csv.newName}
                  onChange={(e) => setCsv({ ...csv, newName: e.target.value })}
                />
              </label>
              <label className="form-field">
                Institution
                <input
                  value={csv.newInstitution}
                  placeholder="e.g. Truist"
                  onChange={(e) => setCsv({ ...csv, newInstitution: e.target.value })}
                />
              </label>
              <Pick
                label="Account type"
                value={csv.newType}
                onChange={(v) => setCsv({ ...csv, newType: v as Account['type'] })}
                options={accountTypes.map((t) => ({ value: t, label: t }))}
              />
              <label className="form-field">
                Current balance (optional)
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={csv.newBalance}
                  onChange={(e) => setCsv({ ...csv, newBalance: e.target.value })}
                />
              </label>
            </div>
          )}
          <p className="form-hint">
            {csv.savedFrom
              ? `Using the columns saved from your last import into ${csv.savedFrom}. Change any that look wrong.`
              : 'Folio matched these columns. Change any that look wrong. Your choices are remembered for this account.'}
          </p>
          <div className="form-grid">
            <Pick
              label="Date"
              value={String(csv.mapping.date)}
              onChange={(v) => setMapping('date', v)}
              options={optionalColumns}
            />
            <Pick
              label="Backup date (if blank)"
              value={String(csv.mapping.dateFallback)}
              onChange={(v) => setMapping('dateFallback', v)}
              options={optionalColumns}
            />
            <Pick
              label="Date style"
              value={csv.dateFormat}
              onChange={(v) => setCsv({ ...csv, dateFormat: v as DateFormat })}
              options={[
                { value: 'mdy', label: 'Month/Day/Year' },
                { value: 'dmy', label: 'Day/Month/Year' },
                { value: 'ymd', label: 'Year-Month-Day' },
              ]}
            />
            <Pick
              label="Description"
              value={String(csv.mapping.description)}
              onChange={(v) => setMapping('description', v)}
              options={optionalColumns}
            />
            <Pick
              label="Amount"
              value={String(csv.mapping.amount)}
              onChange={(v) => setMapping('amount', v)}
              options={[
                { value: NONE, label: 'Separate debit and credit columns' },
                ...columnOptions,
              ]}
            />
            {csv.mapping.amount < 0 && (
              <>
                <Pick
                  label="Debit (money out)"
                  value={String(csv.mapping.debit)}
                  onChange={(v) => setMapping('debit', v)}
                  options={optionalColumns}
                />
                <Pick
                  label="Credit (money in)"
                  value={String(csv.mapping.credit)}
                  onChange={(v) => setMapping('credit', v)}
                  options={optionalColumns}
                />
              </>
            )}
            <Pick
              label="Category (optional)"
              value={String(csv.mapping.category)}
              onChange={(v) => setMapping('category', v)}
              options={optionalColumns}
            />
            <Pick
              label="Notes (optional)"
              value={String(csv.mapping.notes)}
              onChange={(v) => setMapping('notes', v)}
              options={optionalColumns}
            />
          </div>
          {csv.mapping.amount >= 0 && (
            <label className="switch-row">
              <Switch
                checked={csv.purchasesPositive}
                onCheckedChange={(purchasesPositive) => setCsv({ ...csv, purchasesPositive })}
              />
              Purchases are positive numbers in this file
            </label>
          )}
        </div>
      )}

      {pdf && (
        <div className="import-statement">
          <h3>
            {pdf.summary.issuer ?? 'Credit card'} statement
            {pdf.summary.last4 ? ` · card ending ${pdf.summary.last4}` : ''}
          </h3>
          <dl className="statement-facts">
            {(
              [
                ['Statement closing', pdf.summary.closingDate],
                ['Balance owed', pdf.summary.newBalance],
                ['Credit limit', pdf.summary.creditLimit],
                ['Minimum payment', pdf.summary.minimumPayment],
                ['Payment due', pdf.summary.dueDate],
                ['Purchase APR', pdf.summary.purchaseApr],
                [
                  'Promotions',
                  pdf.summary.promotions?.length ? pdf.summary.promotions.length : null,
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {value === null
                    ? 'Not found'
                    : label === 'Purchase APR'
                      ? `${value}%`
                      : label === 'Promotions'
                        ? `${value} found`
                        : typeof value === 'number'
                          ? cash(value, 2)
                          : value}
                </dd>
              </div>
            ))}
          </dl>
          <Pick
            label="Apply to"
            value={pdf.target}
            onChange={(target) => setPdf({ ...pdf, target })}
            options={[
              { value: NEW, label: 'A new credit card' },
              ...data.accounts
                .filter((a) => a.type === 'Credit card')
                .map((a) => ({
                  value: a.id,
                  label: `${a.name}${a.mask ? ' ••' + a.mask : ''}`,
                })),
            ]}
          />
          {pdf.target === NEW ? (
            <div className="form-grid">
              <label className="form-field">
                Card name
                <input
                  value={pdf.name}
                  onChange={(e) => setPdf({ ...pdf, name: e.target.value })}
                />
              </label>
              <label className="form-field">
                Institution
                <input
                  value={pdf.institution}
                  onChange={(e) => setPdf({ ...pdf, institution: e.target.value })}
                />
              </label>
            </div>
          ) : (
            (() => {
              const card = data.accounts.find((a) => a.id === pdf.target);
              return card?.mask && pdf.summary.last4 && card.mask !== pdf.summary.last4 ? (
                <p className="negative">
                  This statement is for a card ending {pdf.summary.last4}, but {card.name} ends in{' '}
                  {card.mask}.
                </p>
              ) : null;
            })()
          )}
          {(() => {
            const card = data.accounts.find((a) => a.id === pdf.target);
            return card && olderThanBalance(card, pdf.summary.closingDate) ? (
              <p className="form-hint">
                {card.name} already has a newer balance from {card.balanceDate}. This older
                statement only fills in details that are missing.
              </p>
            ) : null;
          })()}
          <p className="form-hint">
            The balance owed becomes the card&apos;s balance. Details not found are left unchanged
            and can be edited on the Credit cards page. Statement transactions are not imported; use
            a QFX or CSV download for those.
          </p>
        </div>
      )}
      {plan.problem && (
        <p className="negative" role="alert">
          {plan.problem}
        </p>
      )}
      {!reading && !error && !plan.problem && plan.lines.length > 0 && (
        <div className="import-preview">
          {plan.lines.map((line) => (
            <div key={line.label} className="import-line">
              <p>
                <Check size={16} />
                {line.label}: {line.fresh} new · {line.duplicates} already in Folio
              </p>
              {line.sample.map((t) => (
                <div key={t.id}>
                  <span>
                    {t.date} · {t.merchant} · {t.category}
                  </span>
                  <b>{cash(t.amount, 2)}</b>
                </div>
              ))}
            </div>
          ))}
          {csv && plan.transactions.length > 0 && (
            <p>
              {sampleOut} money out · {sampleIn} money in. If purchases show as money in, turn on
              “Purchases are positive numbers”.
            </p>
          )}
          {plan.errors.length > 0 && (
            <div className="import-errors">
              <p>{plan.errors.length} row(s) will be skipped:</p>
              {plan.errors.slice(0, 3).map((e) => (
                <span key={e}>{e}</span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="text-button"
          onClick={() =>
            saveTextFile(
              'folio-import-template.csv',
              'date,description,amount,category,notes\n' + today() + ',Coffee shop,-5.50,Dining,\n',
              'text/csv',
            ).then(
              (saved) => saved && toast.success('Template saved'),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          CSV template
        </button>
        <button
          className="primary"
          disabled={!ready || saving}
          onClick={() =>
            onSave({
              fileName,
              format: pdf ? 'PDF' : ofx ? 'OFX' : 'CSV',
              ...(fileHash ? { fileHash } : {}),
              accounts: plan.results,
              message: pdf
                ? `${plan.results[0]?.account.name ?? 'Card'} updated from statement`
                : undefined,
            })
          }
        >
          {saving
            ? 'Importing…'
            : pdf
              ? pdf.target === NEW
                ? 'Add card'
                : 'Update card'
              : plan.transactions.length || !plan.balances
                ? `Import ${plan.transactions.length} transactions`
                : 'Update balances'}
        </button>
      </div>
    </div>
  );
}
