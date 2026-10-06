# Architecture

## Runtime and persistence

Folio is a desktop app for macOS and Windows built with [Tauri 2](https://tauri.app). The interface is React and TypeScript, bundled by Vite into `dist/` and shown in the operating system's web view (WebKit on macOS, WebView2 on Windows). There is no server: the Rust side in `src-tauri/` owns the data file and exposes a small set of commands to the interface.

Finances live in one SQLCipher-encrypted SQLite file, `folio.db`, in the app's data folder (`~/Library/Application Support/io.github.abrichardson.folio/` on macOS, `%APPDATA%\io.github.abrichardson.folio\` on Windows; `vault::resolve_data_dir` moves the folder over once if the app's identifier has changed). The user chooses its password when the file is created; there is no recovery. SQLCipher derives the key from the password and encrypts every page, so the file is unreadable without it. Locking the app closes the file; it also locks itself after a chosen stretch without keyboard, mouse, or touch activity (15 minutes by default, stored in the workspace `settings`). Changing the password checks the current one against the file, then re-encrypts every page (`PRAGMA rekey`).

`finance_state` holds the validated workspace (accounts, budgets, goals, bills, balance history, import history) as one JSON document with a version number; `transactions` holds one JSON row per transaction, so Folio can keep years of history (up to 250,000 transactions). `load` reassembles the whole workspace. A save sends the workspace document plus only the transactions added, changed, or removed since the last save (`lib/persist.ts` works this out), all in one SQLite transaction. Saves name the version they were based on and fail if it has moved on (optimistic concurrency). The schema version is tracked with SQLite's `user_version`; each numbered migration in `src-tauri/src/vault.rs` upgrades older files in place (migration 2 moved transactions out of the document), and a file from a newer Folio is refused rather than downgraded.

`npm run dev` runs the interface in a plain browser for quick UI work. It skips the password screen and keeps fictional data in browser storage. Production builds only work inside the desktop app.

## Code map

| Area                                                             | Files                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| App entry and password screen                                    | `src/main.tsx`, `src/vault-gate.tsx`                   |
| Password change, automatic lock, encrypted backups (Settings)    | `src/security.tsx`                                     |
| Dashboard, accounts, transactions, budgets, goals, import/export | `src/finance-app.tsx`                                  |
| Credit cards and bills UI                                        | `src/cards-bills.tsx`                                  |
| Storage interface (desktop commands, browser dev fallback)       | `src/storage.ts`                                       |
| Save dialog for exports and backups                              | `src/save-file.ts`                                     |
| Finance validation, demo fixtures, CSV and calculations          | `lib/finance.ts`                                       |
| Import dialog (statement-to-account matching, column mapping)    | `src/import-form.tsx`                                  |
| OFX/QFX/QBO parsing                                              | `lib/import/ofx.ts`                                    |
| Bank CSV column detection, dates, and amounts                    | `lib/import/csv.ts`                                    |
| Exact cents, category suggestions, duplicate matching            | `lib/import/common.ts`                                 |
| Import history and Undo                                          | `lib/imports.ts`                                       |
| Saving only changed transactions                                 | `lib/persist.ts`                                       |
| Account register, running balances, reconciliation               | `lib/register.ts`, `src/register.tsx`                  |
| Rules, learned categories, custom categories, bulk edits         | `lib/rules.ts`, `lib/bulk.ts`, `src/rules-panel.tsx`   |
| Transfer matching between accounts                               | `lib/transfers.ts`, `src/transfers-dialog.tsx`         |
| Credit card statement summaries (balance, limit, APR, due date)  | `lib/import/statement.ts`, `lib/import/pdf-lines.ts`   |
| PDF text extraction (pdf.js, loaded on demand)                   | `src/pdf-text.ts`                                      |
| Recurrence and bill payment marks                                | `lib/bills.ts`                                         |
| Receipts (encrypted attachments)                                 | `src/receipts.tsx`                                     |
| Promotional balances on cards                                    | `lib/promotions.ts`, `src/promotions.tsx`              |
| Installment plans (BNPL, auto and personal loans)                | `lib/plans.ts`, `src/plans.tsx`                        |
| Cash-flow forecast, payment matching, suggested bills, reminders | `lib/cashflow.ts`, `src/cashflow.tsx`                  |
| Budget rollover and adjustments, goal progress and earmarks      | `lib/budgets.ts`, `src/budgets.tsx`                    |
| Reports and CSV export                                           | `lib/reports.ts`, `src/reports.tsx`                    |
| Plaid transaction mapping (kept for a future bank-sync relay)    | `lib/plaid-data.ts`                                    |
| Encrypted data file: create, unlock, load, save, migrations      | `src-tauri/src/vault.rs`                               |
| Desktop commands and app setup                                   | `src-tauri/src/lib.rs`                                 |
| Desktop configuration, window, security policy, bundling         | `src-tauri/tauri.conf.json`, `src-tauri/capabilities/` |
| Styling                                                          | `src/globals.css`                                      |

## Commands

The interface calls these Rust commands (see `src/storage.ts`): `vault_status`, `vault_create`, `vault_unlock`, `vault_lock`, `state_load`, `state_save`, `save_text_file` (system Save dialog), the backup and password commands, and `attachment_add`, `attachment_get`, `attachment_delete`, and `attachment_save_copy` for receipts. Receipt bytes cross the command channel as raw binary rather than JSON. The window's content security policy allows only the app's own scripts and the command channel, so the interface cannot load remote code or contact other servers.

## Bank data

Bank transactions come in through file import. `lib/import/ofx.ts` reads OFX 1.x (SGML) and 2.x (XML), which covers QFX and QBO downloads, and returns each bank or credit card statement with its transactions and ledger balance; investment and non-USD statements are skipped with a warning. Amounts are converted to integer cents with string arithmetic, never floating point. Each OFX account gets an `importKey` (a truncated SHA-256 of bank ID and account number, so the number itself is not stored) to match later imports, and each transaction keeps `importId` (`ofx:` + FITID) for duplicate checks. OFX reports amounts owed as negative balances; Folio stores them as positive balances on credit card and loan accounts. CSV import guesses a column mapping and date style that the user can change. Category suggestions mark transfers and credit card payments as `Transfer` so they are excluded from income and spending.

Every import is recorded in `imports` (`lib/imports.ts`): file name, format, a SHA-256 of the file (to recognize it if imported again), and for each account the new, duplicate, and skipped counts, the date range, the file's balance and whether it was applied, and copies of the account before and after. Imported transactions carry `importBatch`; editing one by hand sets `edited`. Undo removes the import's unedited transactions, reverts only the account fields the import set and nobody changed since (card details field by field), and removes an account the import created when nothing else uses it. Balances carry `balanceDate` and `balanceSource`; an OFX or statement balance older than the account's current one is not applied, though its missing transactions and details still are. The register (`lib/register.ts`) counts an account's non-pending transactions from `openingBalance` (the balance at the start of a date) in the account's own sign: purchases raise what is owed on cards and loans. The difference from the bank is the register balance on `balanceDate` minus `balance`. Transactions carry `status` (`cleared` or `reconciled`); bank-file imports arrive cleared, reconciling marks the ticked entries reconciled and records `lastReconciled`, and Undo of an import keeps reconciled entries.

Categories are the built-in list plus `customCategories`; every transaction, budget, and rule must use one of them. `rules` run on import in order (first match on the bank description, ignoring case), then categories learned from hand-picked entries for the same payee (`payeeKey` drops words with digits). A renamed entry keeps the bank's text in `originalMerchant`, which duplicate detection uses. A split transaction stores `splits` (two or more parts that add up to its amount) and keeps its largest part's category in `category`; totals and budgets go through `parts()` and `spentIn()` in `lib/finance.ts`. Transfer matching (`lib/transfers.ts`) pairs an outflow with the same inflow in another account within 5 days, closest dates first, and gives both sides a shared `transferId` and the Transfer category.

CSV column choices are saved per account in `importSettings.csv`, keyed by the file's header row, and reused for the next file with the same columns.

Credit card statement PDFs are read on this computer with pdf.js (`pdfjs-dist`, pinned to 4.10 because 5.x drops text on some Synchrony pages). It is loaded only when a PDF is opened, runs with `isEvalSupported: false`, and its worker is a bundled file, so the content security policy needs no changes. `lib/import/pdf-lines.ts` groups positioned text into lines (wide gaps become `|`), and `lib/import/statement.ts` reads the labeled summary fields US issuers print (New Balance, Minimum Payment Due, Payment Due Date, Credit Limit/Line, the Purchases row of the interest table), with dates as numbers or words, values beside their label or in the row under a row of labels, and purchase rows named Purchases, Standard Purchases, Purchases & Balance Transfers, or listed under a PURCHASES heading. Applying a statement sets the card account's single `balance` and its `credit` details, including `statementDate`; fields the statement lacks keep their previous values.

Automatic bank sync needs Plaid, whose secret cannot ship inside an installable app; the plan is an optional relay service that holds the secret and passes data to the app without storing it. The earlier server-side Plaid implementation is in Git history (before the desktop conversion) as a starting point.

## Bills and financial semantics

Amounts use integer cents. Manual account balances are snapshots; adding a transaction does not alter the balance. Negative card balances increase net worth. Bill recurrence clamps month-end dates without cumulative drift, and payment marks apply to individual occurrences. Card due dates and minimum payments can generate bill reminders. Marking paid neither moves funds nor creates a ledger transaction.

Receipts live in the `attachments` table (migration 3), one encrypted row per file, keyed by an ID the transaction's `receipts` list refers to. After a successful save, files no transaction refers to any more are deleted. The JSON backup keeps the receipt list but not the files; the encrypted backups keep both.

Income is the Income category plus custom categories listed in `incomeCategories`. Spending in a category is net: refunds and reimbursements filed under it lower it. `reimbursable` marks an expense you expect back; `reimburses` on money received links the repayment.

A card's `promotions` are portions of its single balance, each with a deadline (`endDate`), kind (`deferred` interest charged in full if any balance remains, or `zero`), and the date its balance was true (`asOf`); merging promotions from a statement never replaces newer figures. Installment `plans` keep `principal` (what is owed now, subtracted in net worth) apart from the schedule `lib/plans.ts` derives from the APR, installment, frequency, and payments left; recorded payments split into principal and interest in `history`.

The forecast (`lib/cashflow.ts`) starts from the balances of `planner.accountIds` (every checking account when empty) and adds unpaid bill and income occurrences, the card payments each card's `paymentPlan` calls for, and plan installments, leaving out anything paid from other accounts. Unpaid items up to 30 days overdue count today; later card months repeat the current amount and are marked as estimates. Payment matching proposes, never applies: confirming adds payment marks. Suggestions need three or more dated charges at a steady weekly, two-week, monthly, or quarterly gap with amounts within 25%.

Budgets keep `limit` as the usual amount, `adjustments` for single months, and with `rollover` carry each month's remainder (or overspending) forward from `rolloverFrom`. A debt goal linked to a card or loan measures progress as its target less the balance owed. Snapshots record `debt` beside net worth so reports can show debt over time.

## Backups

Automatic backups are copies of the encrypted `folio.db` in a `backups` folder beside it, named `folio-<date>-<kind>-<seconds>.db`. Folio makes one the first time it is unlocked each day (the newest 30 are kept), one before a file from an earlier version is upgraded, one before a restore, and one whenever the user chooses **Back up now** (10 of each of those kinds are kept). Copies are taken between commands while the app holds the connection lock, so no write is in progress. A backup stays encrypted with the password in use when it was made. Restoring checks that password against the backup before closing anything, keeps the current file as a backup, copies the backup into place, and opens it (upgrading it if it is older); if it cannot be opened, the previous file is put back. **Save a copy** writes a backup wherever the user chooses, such as another drive. All of this lives in `src-tauri/src/vault.rs`; the Settings panels are in `src/security.tsx`.

**Download backup** in Settings writes an unencrypted JSON copy of the workspace through the system Save dialog, so store it somewhere safe.
