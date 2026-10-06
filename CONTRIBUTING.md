# Contributing to Folio

## Get started

Clone the repository:

```sh
git clone https://github.com/abrichardson/folio.git
cd folio
npm ci
npm run desktop:dev
```

Use Node 22.13 or newer and Rust; platform prerequisites are in `docs/DESKTOP.md`. `npm run dev` serves the interface in a browser with fictional data for quick UI work. Development builds of the desktop app use the same data folder as an installed copy, so do not develop against a file holding real finances.

## Work in parallel

Assign each agent a small task, its own branch, and a separate working tree. Example, starting from the main checkout:

```sh
git fetch origin
git worktree add ../folio-bills -b feature/bill-reminders origin/main
```

Install dependencies in each worktree. If working through Codex's managed worktree feature, let Codex create and manage the worktree instead. Agree on ownership before editing shared modules such as `lib/finance.ts` or `src/finance-app.tsx`. Use separate development ports if running multiple previews.

Before opening a pull request:

```sh
npm run format:check
npm run lint
npm test
npm run test:rust
npm run typecheck
npm run build
git diff --check
git status --short
```

Push the feature branch (to a fork if you are not a collaborator) and open a pull request into `main`. Include the problem, changed behavior, tests performed, and any migration or setup requirements. Never share credentials, real financial records, or screenshots of real finances in issues or pull requests. Report security problems privately as described in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Documents and data

Keep architecture, product decisions, setup notes, and project status in `docs/`. Keep sanitized visual references there only when useful. Use fictional test fixtures. Store local financial exports and sensitive personal documents in the ignored `private/`, `exports/`, or `backups/` directories, or outside the checkout.

## Releases

GitHub is the shared development repository. The **Desktop installers** workflow builds macOS and Windows installers on demand or from version tags; it is not run on pull requests. A version tag (`v0.2.0`) also publishes the installers as a GitHub Release, which the website links to. Signing credentials, when added, live only in GitHub repository secrets. See `docs/DESKTOP.md`.
