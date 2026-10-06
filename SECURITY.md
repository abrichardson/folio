# Security

Folio keeps finances in a password-encrypted file (SQLCipher) on your own computer. It has no server, no account, no telemetry, and makes no network connections: the app's content security policy allows only its own files and its local command channel.

## Reporting a vulnerability

Please report security problems privately through GitHub's **Security → Report a vulnerability** on this repository, not in a public issue. Include the version, operating system, and steps to reproduce. Do not include real financial data; describe the problem with fictional figures.

## What is in scope

- Reading or changing the data file without the password, or weakening its encryption.
- Data written unencrypted, other than a JSON backup or export the user chooses to save.
- Anything that lets the app load remote code or contact a server.
- Statement or bank-file parsing that can be made to run code or corrupt the data file.

## Good to know

- There is no password recovery. A forgotten password cannot be reset by anyone.
- Installers are not yet code-signed. Download them only from this repository's Releases page.
