# Folio

A private personal finance app for macOS and Windows, in the spirit of classic Quicken. Your finances stay on your computer in a password-encrypted file. Built with Tauri, React, TypeScript, and encrypted SQLite.

**[Download Folio](https://github.com/abrichardson/folio/releases/latest)** · [Website](https://abrichardson.github.io/folio/) · Open source under the [MIT License](LICENSE).

Start with [Contributing](CONTRIBUTING.md) for collaboration, [Architecture](docs/ARCHITECTURE.md) for the code map, [Desktop](docs/DESKTOP.md) to build and release installers, and [Project status](docs/PROJECT_STATUS.md) for current capabilities and plans. Agent instructions are in [AGENTS.md](AGENTS.md).

## Features

- Overview with monthly cash flow, net worth history, budgets, and savings goals.
- Accounts: add, edit, and delete manual balances; liabilities subtract from net worth.
- Transactions: add/edit/delete, notes, monthly navigation, search, account/category filters, and CSV export.
- Bank file import: QFX/OFX/QBO (Quicken, Money, and QuickBooks formats) and CSV. QFX/OFX files create or match accounts, can set the statement balance, and use the bank's transaction IDs to skip duplicates. CSV import can create a new account (suggesting its last four digits from file names like `acct_1234_…csv`) or add to an existing one. It recognizes common bank column names, US and international date styles, a backup date column when the main one is blank or `null` (as in Truist exports), Debit/Credit type columns, separate debit/credit amount columns, and cards that show purchases as positive numbers (detected automatically, as in Discover exports); you can adjust the column mapping before importing.
- Credit card statement PDFs: Import (or **Fill from a statement PDF** when editing a card) reads the new balance, credit limit, purchase APR, minimum payment, due date, closing date, and last four digits from the statement's summary boxes, entirely on this computer. Tested against Discover, Capital One, Citi store cards, and Synchrony (including PayPal) layouts; anything not found is left for you to fill in. A card has one balance: the balance owed you edit on Credit cards is the same balance shown on Accounts and in net worth.
- Import history (Settings & data): each import lists the file, accounts, date range, new, duplicate, and skipped transactions, and balance changes. **Undo** (also offered right after an import) removes the imported transactions and restores the account details it changed, while keeping transactions you edited since and any later changes such as a newer balance. Choosing a file you already imported says so; it adds only what is missing.
- Every balance shows its date and source (for example "Statement PDF · Sep 10, 2026"). An older statement or download adds missing transactions and card details but never replaces a newer balance.
- CSV column choices, date style, and purchase sign are remembered per account and reused for the next file with the same columns.
- Holds years of history: up to 250,000 transactions, stored one per row in the encrypted file so saves stay quick.
- Account register (Accounts → Open register): every transaction in date order with a running balance from an opening balance (Folio suggests one that matches the bank), cleared marks, and the register, cleared, and bank balances side by side with any difference. **Reconcile** against a statement: tick what appears on it until the difference is zero, then finish to lock those entries in.
- Your own categories, renamed or removed everywhere at once. Rules ("description contains WHOLEFDS → show as Whole Foods, Groceries") run on every import and can be applied to past transactions; "Remember for this payee" in a transaction creates one. Without a rule, imports reuse the category you last chose by hand for the same payee.
- **Match transfers** on the Transactions page pairs money leaving one of your accounts with the same amount arriving in another within 5 days (a card payment and the card's payment received, a move to savings) and files both as Transfer, so neither counts as spending or income.
- **Split** a transaction across categories (a store run that is part groceries, part household); budgets and monthly totals count each part, and a Transfer part (cash back) is excluded.
- Select several transactions to set their category, mark them cleared, or delete them together.
- Transfers and credit card payments are recognized on import and excluded from income and spending, so a card payment is not counted twice.
- Receipts: attach photos or PDFs to a transaction (up to 15 MB each); they are stored encrypted inside the data file. Mark expenses as reimbursable, link the repayment, and see what is still owed to you. Refunds lower spending in their category. **Loan payment** in the split editor divides a payment into principal (Transfer) and Interest & fees.
- Promotional balances on each card (true 0% or deferred interest): deadline, the monthly payment that clears it in time, deferred interest at risk, and reminders on the Overview. Statement PDFs fill them in from PayPal Credit and Synchrony promotional tables. Promotions are part of the card's balance, never counted twice.
- **Loans**: buy-now-pay-later plans (Affirm, Klarna, Afterpay, …) and auto or personal loans, grouped by provider, each with its own schedule. Principal owed and the scheduled payments (with interest still to come) are shown separately; record payments, apply a refund (which shortens the plan), or mark one paid off early. Plan principal counts as debt in net worth.
- **Cash flow**: a 30, 60, or 90 day forecast of your checking balance from scheduled income (paychecks), bills, card payments (minimum, statement balance, or your own amount), and plan installments, with the lowest balance and a warning before it drops below zero or your chosen cushion. Bills can repeat every two weeks or quarterly, and stop after a last date.
- Bills learn from imports: transactions that match a scheduled bill, paycheck, or card payment can be confirmed as paid in one click, and payees that charge on a steady schedule are suggested as new bills. Payments due soon or overdue show a reminder when Folio opens.
- Budgets with groups (Essentials, Lifestyle, …), a different amount for a single month, and rollover of what is left or overspent, which also makes funds for irregular costs such as car repairs or gifts.
- Goals for savings, an emergency fund, a purchase, or paying down a debt, with the monthly amount that reaches each on time. A savings goal can be earmarked in an account, showing what in the account is still unassigned; a debt goal linked to a card or loan follows its balance.
- **Reports** for a chosen period: spending by category compared with the period before, top payees, income vs. spending by month, recurring costs per month, interest and fees, debt, and net worth, each exportable as CSV.
- Automatic encrypted backups: a copy of your file once a day (30 days kept), before updates, and before restores; restore any of them, or save a copy to another drive, from Settings.
- Change your password, and lock automatically after 5, 15 (default), 30, or 60 minutes without activity.
- Full JSON backup/restore and confirmed workspace reset.
- Responsive layout, accessible dialogs, keyboard navigation, and reduced motion support.

## Data and privacy

Everything is stored in one file on your computer, encrypted with a password you choose when you first open Folio. There is no account, server, or cloud copy, and there is no way to recover a forgotten password. **Lock Folio** in the sidebar closes the file, and Folio locks itself after 15 minutes without use (change this in Settings). Folio keeps encrypted daily backups beside the file; each one opens with the password you had when it was made. **Download backup** in Settings saves an unencrypted JSON copy wherever you choose; keep it somewhere safe.

Writes are validated before saving and use a version number to reject conflicting edits. Amounts are integer USD cents. A new file starts with a fictional demo; choose **Start with my finances** to begin with empty records.

Account balances are manual statement snapshots. Recording transactions does not adjust balances. Transfers are excluded from income and spending. Budget limits repeat monthly and edits affect historical views. Goal savings are informational and do not add to net worth. Import skips transactions already in Folio: bank transaction IDs match exactly, and otherwise date, description, amount, and account must all match. Matches are counted, so two identical purchases on the same day both import, while importing the same file again adds nothing. Imported categories are suggestions; check transfers between your own accounts.

Automatic bank sync, investment account imports, live investment prices, multiple currencies, automatic recurring-bill detection, and syncing between computers are not included yet.

## Development

Requires Node 22.13+ and, for the desktop app, Rust. See [docs/DESKTOP.md](docs/DESKTOP.md) for platform prerequisites.

```sh
npm ci
npm run desktop:dev   # the desktop app with live reload
npm run dev           # interface only, in a browser, with fictional data
```

Checks (CI runs all of them):

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:rust
npm run build
```

Run `npm run format` to apply Prettier formatting and `cargo fmt` in `src-tauri/` for Rust. Do not commit financial exports, backups, or data files.

## Credit cards and bills

Credit cards show balance, known credit limit, utilization, statement balance, minimum payment, next due date, purchase APR, and last payment, entered on the card's details. Negative credit-card balances represent credit owed to you and increase net worth.

Bills support one-time, weekly, every-two-weeks, monthly, quarterly, and yearly schedules (optionally ending on a date), income as well as payments, an accessible list and calendar, overdue items, per-occurrence paid/undo status, and autopay reminder labels. Monthly dates clamp to the last day of shorter months without drifting in following months. Card minimum payments appear in Bills automatically when a due date exists. Marking a bill paid does not send money, create a transaction, or enroll in autopay. Changes to recurring schedules apply to past and future views.
