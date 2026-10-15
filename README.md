# Mailbot

A browser-based Gmail and Google Drive cleanup app. Every visitor connects their own Google account. Standard Gmail and Drive requests run directly between that browser and Google. Optional fast scanning uses a hosted, read-only IMAP header reader; it keeps no shared mailbox database.

## Features

- Gmail cleanup suggestions and a complete, resumable sender directory.
- Sender search, message selection, bulk Trash in groups of up to 1,000 with three overlapping requests, cancellation, and recent Gmail Undo.
- Optional fast scanning streams up to 500 headers per IMAP fetch, independently for each visitor.
- Google Drive file-type and ownership filters, largest-first sorting, search, and reviewed Trash actions.
- Account-specific browser caches. Temporary connections survive a same-tab reload until Google access expires.
- Privacy and data-control information at `privacy.html`.

## Develop and build

Use Node.js 22.13+ and pnpm 11.25.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
pnpm test
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

The intended project URL is https://imkaroboi.github.io/mailbot/ . The separate production Google Cloud client is supplied in `public/config.js`. Its Google consent configuration must still be approved for unrestricted access.

## Google account access: required production configuration

Hosting the website does not approve its Google OAuth access.

1. Use a production Google Cloud project with the Gmail API and Google Drive API enabled.
2. Configure external OAuth branding and the operator’s support contact. Add the actual website home page and privacy page, and verify an owned domain if Google requires it.
3. Create a **Web application** OAuth client. Its authorized JavaScript origin for this Pages site is `https://imkaroboi.github.io` (no `/mailbot/` path). Local development additionally uses `http://127.0.0.1:5173`.
4. Configure that public client ID in the repository variable or `public/config.js`.
5. Request verification for `https://www.googleapis.com/auth/gmail.modify` and, for the optional Drive feature, `https://www.googleapis.com/auth/drive`. Optional fast scanning additionally requires `https://mail.google.com/`. These scopes are restricted. A server that processes restricted Google data may require an independent security assessment. Google must approve unrestricted public access; test mode permits only added testers, and an unverified published app can still have warnings and a user cap. Workspace administrators can also restrict access. Publishing on GitHub Pages does not bypass those rules.
6. Test sign-in from the exact published origin and a separate Google account before announcing general availability.

Official requirements: [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [production OAuth policies](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance), and [GitHub Pages deployment](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Deploy the shared fast scanner

GitHub Pages hosts static files and cannot open IMAP connections. Deploy `backend/scanner` as a separate Node service. The included `render.yaml` deploys a free Docker web service from this repository; free services can sleep and have a slow first connection.

1. Deploy the Render blueprint, or build `backend/scanner/Dockerfile` on a host that permits outbound TLS on port 993.
2. Set `ALLOWED_ORIGINS=https://imkaroboi.github.io` and `GOOGLE_CLIENT_IDS` to the public production OAuth client ID. Both are allowlists, not secrets. Multiple approved values may be comma separated.
3. Verify `GET /health` over HTTPS. Set `scannerUrl` in `public/config.js` to that exact HTTPS origin, then publish. An unset URL keeps fast scanning unavailable; it never tries a visitor’s localhost.
4. Visitors explicitly choose **Connect fast scanning** and approve Google's full mail scope. Each grant is bound to the specific scanner origin; changing the host requires another fast-scanner connection. Do not add tokens or client secrets to deployment settings.
5. Finish Google's restricted-scope verification and any required security assessment before general availability. Test-mode Google apps only admit registered testers.

The server verifies the token's OAuth audience, expiry and scope with Google, then derives the mailbox from Google's profile. Request parameters cannot choose a different account or IMAP host. Each scan gets its own TLS connection to Gmail, opens folders read-only, and fetches headers in groups of 500 using stable UID snapshots. This allows concurrent Trash without shifting message positions. Connections close on cancellation or a 30-minute deadline. Default capacity is eight simultaneous requests, at most two per account; excess requests receive an explicit busy response. There is no mailbox-size cap.

No email bodies are fetched. Tokens and headers exist only in request memory, are not logged by the scanner, and are not written to files or databases. Configure the hosting provider to avoid request-body/header capture and application tracing. Hosting providers still process ordinary request metadata under their own policies.

## Performance and data controls

Fast IMAP scanning avoids one quota-charged metadata request per message. Throughput depends on Gmail, the host, network, and concurrent visitors; it is not a guaranteed emails-per-second service. Standard scanning remains available and caches completed headers. Bulk Trash runs directly from each visitor's browser to Google for all connection modes: up to 1,000 reviewed IDs per request, three requests overlapping, paged current-label checks, a rolling 5,000-unit per-account budget and rate-limit backoff. Available bulk-write quota is dispatched immediately; metadata reads remain paced. It does not perform one write per email. All standard scans and writes share Google's account/project limits.

`pnpm test` covers a synthetic 21,000-message stream, concurrent Trash UID stability, interrupted-stream handling, a 21,000-message cleanup in 21 bulk writes, cancellation, partial failures, per-account isolation, origin/auth checks and capacity limits. Synthetic tests verify behavior and request counts, not real-world speed.

Cleanup moves reviewed items to Trash, with current eligibility checks. It does not permanently delete items or empty Trash. Gmail Undo covers recent acknowledged moves. Drive restores are available through Google Drive Trash. Users control their own selections and Google authorizations.

Disconnect clears the saved token. **Clear saved index** removes the current account’s cached headers. Clearing browser site data removes all local records. Revoking access in Google Account connections ends the Google grant. Review the full privacy page for details.

No personal mailbox data, browser profiles, access tokens, OAuth client secrets, or local runtime state belong in this repository. Public OAuth client IDs are identifiers, not secrets. The included workflow requires only repository contents read access plus Pages deployment permissions. GitHub Pages controls its own HTTP response headers.
