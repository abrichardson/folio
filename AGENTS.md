# Working on Folio

Folio is a private personal finance desktop app for macOS and Windows (Tauri). Finances are stored locally in an SQLCipher-encrypted file; there is no server. Read `README.md`, `docs/ARCHITECTURE.md`, `docs/DESKTOP.md`, and `docs/PROJECT_STATUS.md` before changing behavior. Use `CONTRIBUTING.md` for setup and collaboration.

## Collaboration

- Use a separate checkout or Git worktree and a unique feature branch per agent. Coordinate file ownership when work overlaps; do not run multiple agents against the same working tree.
- Keep pull requests focused. Explain the user-visible change, validation, and remaining limitations. Review current changes before editing; never discard another agent's work.
- Commit code, migrations, tests, and relevant documentation together. Keep project status current when capabilities or setup change.
- Batch changes into few pushes. The Desktop installers workflow runs only on demand or for version tags; ask the owner before running it or tagging a release.
- GitHub stores shared source. Installers are built by the Desktop installers workflow. Do not add hosted services, telemetry, or network calls without an explicit task; the app's security policy allows no remote connections.

## Required invariants

- Never commit credentials, real financial records, database snapshots, exports, or private screenshots. Use fictional fixtures. Signing credentials and API keys belong in GitHub secrets or the system keychain, never in the repository.
- Never write finances unencrypted, except a backup or export the user explicitly saves. Keep all data access in `src-tauri/src/vault.rs`, validate workspaces before saving, and preserve the optimistic concurrency check. Never log passwords or financial records.
- Money is integer USD cents. Transfers and pending transactions do not count toward income or spending. Transaction entry does not automatically change account snapshots.
- Plaid secrets must never ship inside the app. Any future bank sync goes through a separate relay, uses Plaid Sandbox until an explicit task says otherwise, and keeps access tokens encrypted and out of JSON backups.
- Bill payment marks are reminders; they do not move money or create transactions.
- Change the data file only through new, numbered migrations in `vault.rs` that upgrade existing files in place; never break opening an older file. Do not change the app identifier `io.github.abrichardson.folio`, which decides where data is stored (`vault::resolve_data_dir` moves data from a previous identifier's folder once).

## Validation

Use Node 22.13 or later and install with `npm ci`. Format with `npm run format` and keep `npm run lint` clean; CI enforces both. Run `npm test`, `npm run test:rust`, and `npm run typecheck` for logic changes, and `npm run build` plus `cargo clippy` in `src-tauri/` for application or configuration changes. For UI changes inspect wide and narrow windows. Add meaningful regression coverage for changed financial or synchronization behavior. Do not require Plaid secrets for unit tests.

Report exactly what was tested. Say which operating systems the desktop app was actually run on; a CI build is not a test on that system. Keep secrets out of terminal output, logs, PRs, and screenshots.
