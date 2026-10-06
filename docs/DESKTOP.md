# Building and releasing the desktop app

## Prerequisites

- Node 22.13 or newer and Rust (stable, via [rustup](https://rustup.rs)).
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- Windows: Microsoft C++ Build Tools and WebView2 (included in Windows 10/11), plus Perl (for example Strawberry Perl) to compile the bundled OpenSSL.
- Linux (development only): `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

The first Rust build compiles SQLCipher and OpenSSL from source and takes several minutes.

## Run and build

```sh
npm ci
npm run desktop:dev     # opens the app with live reload
npm run desktop:build   # installers in src-tauri/target/release/bundle/
```

For interface-only work, `npm run dev` serves the screens in a browser with fictional data and no password screen.

## Installers from GitHub

The **Desktop installers** workflow builds an unsigned macOS disk image (Apple Silicon and Intel) and Windows installers (`.msi` and `.exe`). It runs only on demand (**Actions → Desktop installers → Run workflow**, choosing the branch to build) and on version tags (`v*`). It does not run on pull requests. Download the files from the run's **Artifacts** section. For a version tag it also creates a GitHub Release with the installers attached; the website's download button points to the latest release.

To release: update `version` in `src-tauri/tauri.conf.json` and `package.json`, merge, then tag `main` (`git tag v0.2.0 && git push origin v0.2.0`).

Unsigned builds work but show warnings: on macOS, right-click the app and choose **Open** the first time; on Windows, choose **More info → Run anyway**.

## Signing (next step)

- **macOS:** with the Apple Developer account, create a **Developer ID Application** certificate, export it as a `.p12`, and add these repository secrets: `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID`. The workflow then needs to pass them to `tauri build`, which signs and notarizes the app.
- **Windows:** a code-signing certificate or Azure Trusted Signing removes the SmartScreen warning.

Never commit certificates or passwords; use GitHub repository secrets.

## Data location

The encrypted file is `folio.db` in `~/Library/Application Support/io.github.abrichardson.folio/` (macOS) or `%APPDATA%\io.github.abrichardson.folio\` (Windows). Automatic encrypted backups are in its `backups` subfolder. The identifier decides this folder. Early builds used a different identifier; on first launch Folio finds a sibling folder ending in `.folio` that holds a data file and moves it into place (only when there is exactly one such folder and Folio's own folder has no data file). On Windows the earlier build may still be listed as an installed app; uninstall it after confirming your data opens in the new one. Uninstalling never deletes the data folder.
