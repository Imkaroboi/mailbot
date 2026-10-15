# Mailbot

A browser-based Gmail and Google Drive cleanup app. Every visitor connects their own Google account. Google API requests run directly between that browser and Google; this app has no token proxy or shared mailbox database.

## Features

- Gmail cleanup suggestions and a complete, resumable sender directory.
- Sender search, message selection, bulk Trash, cancellation, and recent Gmail Undo.
- Google Drive file-type and ownership filters, largest-first sorting, search, and reviewed Trash actions.
- Account-specific browser caches. Temporary connections survive a same-tab reload until Google access expires.
- Privacy and data-control information at `privacy.html`.

## Develop and build

Use Node.js 22.13+ and pnpm 11.25.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
pnpm build
```

`dist/` contains the standalone static website. For a project website, set its path when building:

```sh
PAGES_BASE_PATH=/mailbot/ pnpm build
```

## Publish with GitHub Pages

1. Push this source to a public GitHub repository.
2. In Settings → Pages, set Source to **GitHub Actions**.
3. The included `Publish Mailbot` workflow installs locked dependencies, checks TypeScript, builds the app with the Pages base path, and deploys it. It runs on pushes to `main` and can be started manually.
4. Optionally set the repository variable `GOOGLE_CLIENT_ID` to your production **public web OAuth client ID**. Do not add a client secret. A build without this variable uses `public/config.js`.

The intended project URL is https://imkaroboi.github.io/mailbot/ . An existing development OAuth client is supplied in `public/config.js` for initial configuration; use a separate production Google Cloud project/client before unrestricted release.

## Google account access: required production configuration

Hosting the website does not approve its Google OAuth access.

1. Use a production Google Cloud project with the Gmail API and Google Drive API enabled.
2. Configure external OAuth branding and the operator’s support contact. Add the actual website home page and privacy page, and verify an owned domain if Google requires it.
3. Create a **Web application** OAuth client. Its authorized JavaScript origin for this Pages site is `https://imkaroboi.github.io` (no `/mailbot/` path). Local development additionally uses `http://127.0.0.1:5173`.
4. Configure that public client ID in the repository variable or `public/config.js`.
5. Request verification for `https://www.googleapis.com/auth/gmail.modify` and, for the optional Drive feature, `https://www.googleapis.com/auth/drive`. These scopes are restricted. Google must approve unrestricted public access; test mode permits only added testers, and an unverified published app can still have warnings and a user cap. Workspace administrators can also restrict access. Publishing on GitHub Pages does not bypass those rules.
6. Test sign-in from the exact published origin and a separate Google account before announcing general availability.

Official requirements: [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [production OAuth policies](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance), and [GitHub Pages deployment](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Public edition limits and data controls

This edition uses the standard Gmail REST API. The fast IMAP reader in the local edition runs on a computer and is intentionally excluded from this static website. An initial large sender scan can be slow under Gmail’s quota; completed header batches are cached and reused. The hosted edition never sends Google credentials to a loopback address or to a Mailbot server.

Cleanup moves reviewed items to Trash, with current eligibility checks. It does not permanently delete items or empty Trash. Gmail Undo covers recent acknowledged moves. Drive restores are available through Google Drive Trash. Users control their own selections and Google authorizations.

Disconnect clears the saved token. **Clear saved index** removes the current account’s cached headers. Clearing browser site data removes all local records. Revoking access in Google Account connections ends the Google grant. Review the full privacy page for details.

No personal mailbox data, browser profiles, access tokens, OAuth client secrets, or local runtime state belong in this repository. Public OAuth client IDs are identifiers, not secrets. The included workflow requires only repository contents read access plus Pages deployment permissions. GitHub Pages controls its own HTTP response headers.
