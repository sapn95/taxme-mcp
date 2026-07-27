# taxme-mcp

[![npm](https://img.shields.io/npm/v/taxme-mcp?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/taxme-mcp) [![CI](https://img.shields.io/github/actions/workflow/status/sapn95/taxme-mcp/ci.yml?branch=main&logo=github&label=CI)](https://github.com/sapn95/taxme-mcp/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/taxme-mcp?logo=node.js&logoColor=white&color=5FA04E)](https://nodejs.org) [![licence](https://img.shields.io/npm/l/taxme-mcp?color=blue)](LICENSE)

**Read and fill your Canton of Bern tax return (TaxMe / BE-Login) — drafts only, submission is gated.**

> **Unofficial, and inherently fragile.** This drives a web portal with a real
> browser because the service offers no retrieval API. Portal updates break
> selectors without warning, and a broken selector means a failed run rather
> than a wrong result. It is published because it is useful, not because it is
> guaranteed — pin a version, read the errors, and expect to update. Use it for
> **your own** account and respect the provider's terms of service.

An [MCP](https://modelcontextprotocol.io) server for the **Canton of Bern** tax
portal **TaxMe / BE-Login** ([belogin.directories.be.ch](https://www.belogin.directories.be.ch)).
From any MCP client (Claude Code, Claude Desktop, …) you can read your account
statement and your tax returns, and **navigate and fill a return** — open it,
walk the menu sections, read the fields on a page, set values, click buttons and
read the tax calculation.

## What it is (and the SwissID / AGOV constraint)

BE-Login has **no public API** and authenticates through **SwissID / AGOV**
(the Swiss government login, incl. 2FA). There is no headless way in: the login
is an interactive browser flow you have to complete yourself. So this server
drives the real portal with [Playwright](https://playwright.dev) browser
automation. Two consequences:

- **You log in once, in a visible browser window** (`taxme_login`). Everything
  after that runs headless against the session you established.
- **It is inherently fragile.** Portal releases can change page structure and
  break selectors; the server uses text/URL-based selectors with fallbacks, but
  expect occasional breakage after a TaxMe update.

It is **full-featured**: besides reading, it can open a return, walk the menu,
read fields, **fill** them (text / radio / checkbox), click buttons (*Neuen
Eintrag erfassen*, *Speichern*, *Nächste Seite* …) and read the results.

> **Safety:** the server only fills **drafts**. The final submission
> (`taxme_submit_return`) is gated behind an explicit `confirm: true`; without
> it you get a dry-run of the *Abschluss* page and **nothing is submitted**.

Private use, for your own BE-Login account only. Respect the portal's terms of
use.

## Prerequisites

- **Node.js ≥ 18** (`node --version`).
- Install dependencies and a Chromium build for Playwright:

  ```bash
  git clone git@github.com:sapn95/taxme-mcp.git
  cd taxme-mcp
  npm install
  npx playwright install chromium   # downloads a Chromium into the Playwright cache
  ```

  `npx playwright install chromium` is required unless a Playwright Chromium is
  already cached on the machine. See [Troubleshooting](#troubleshooting) if the
  browser can't be found.

## Session model — log in once, stay logged in

The whole point of this server is that **you don't re-login every time.**

1. Run **`taxme_login`** once. A visible Chromium window opens; complete the
   SwissID / AGOV login (incl. 2FA) yourself. The server waits up to ~8 minutes.
2. The session is cached two ways so it survives **server restarts**:
   - a persistent Chromium profile in `~/.taxme-mcp/profile` (keeps the
     trusted-device state, so AGOV doesn't re-prompt 2FA), and
   - the full session — including session cookies — mirrored to
     **`~/.taxme-mcp/state.json`** via Playwright `storageState()` after login
     and after every successful call.
3. On startup the server re-seeds a fresh browser context from `state.json`, so
   the AGOV session keeps working across restarts **until it genuinely
   expires**.
4. When it does expire, any tool returns `{"status": "login_required"}` — just
   run `taxme_login` again.

So the normal flow is: `taxme_login` once, then use the read/edit tools freely;
re-login only when you actually get `login_required`.

> **Security:** `state.json` (and the `profile/` directory) contain **live
> session cookies** for your tax account. They are secrets. Both are in
> `.gitignore` — **never commit or share them.** Anyone with `state.json` can
> act as you on the portal until the session expires. Delete them to force a
> clean logout.

Override the locations with env vars if you want:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAXME_PROFILE` | `~/.taxme-mcp/profile` | browser profile dir (holds the session — **secret**) |
| `TAXME_STATE` | `~/.taxme-mcp/state.json` | cached `storageState` json (session cookies — **secret**) |
| `TAXME_CHROMIUM` | auto-detect | path to a Chromium executable (override the auto-detect) |

## Which browser, and why it decides how you log in

BE-Login authenticates through SwissID/AGOV, and the browser is not a matter of
taste: Playwright's bundled Chromium reports
`isUserVerifyingPlatformAuthenticatorAvailable() === false`, so the portal never
offers a **passkey** and falls back to password plus SMS. An installed, signed
browser reports `true` and can reach the macOS platform authenticator, which
turns the same login into one Touch ID confirmation.

The server therefore prefers an installed system browser — `chrome`,
`chrome-canary`, `edge`, `brave`, in that order — and only falls back to the
bundled Chromium. Override with `TAXME_BROWSER` (a key from that list, `chromium`,
or an absolute path); `TAXME_CHROMIUM` still works as an alias.

For the underlying detail, including why a *software* passkey cannot be used at
all, see the write-up in
[private-routines/reference/swissid-login.md](https://github.com/sapn95/private-routines).

Register a passkey once in Safari or Chrome under your SwissID account settings;
after that the portal offers it ahead of the password.

## Register in Claude Code

From the repo directory, register the server for your user (use an **absolute**
path to `index.js`):

```bash
claude mcp add taxme --scope user -- node /absolute/path/to/taxme-mcp/index.js
```

That writes an entry into `~/.claude.json`. Equivalent manual snippet:

```jsonc
{
  "mcpServers": {
    "taxme": {
      "command": "node",
      "args": ["/absolute/path/to/taxme-mcp/index.js"]
      // optional:
      // "env": { "TAXME_STATE": "/custom/path/state.json" }
    }
  }
}
```

Restart Claude Code (or reconnect the MCP server), then run the `taxme_login`
tool once to establish the session.

Other MCP clients (Claude Desktop, etc.) take the same `command` / `args` in
their own MCP config.

## Tool reference

**Read / session**

| Tool | Args | Purpose |
| --- | --- | --- |
| `taxme_status` | — | `ok` or `login_required` |
| `taxme_login` | — | open a **visible** window for the SwissID/AGOV login (waits up to ~8 min); caches the session |
| `taxme_account_statement` | — | open amounts (CHF) per tax year — Kantons-/Gemeindesteuern, direkte Bundessteuer, Gemeindeabgaben |
| `taxme_list_returns` | — | tax returns (Steuererklärungen) with status (*In Bearbeitung* / *Quittiert* …) |

**Navigate & edit a return**

| Tool | Args | Purpose |
| --- | --- | --- |
| `taxme_open_return` | `year` (number) | open a return for editing; returns the menu sections (handles the edit popup tab) |
| `taxme_menu` | — | left-menu sections + status of the open return |
| `taxme_goto_section` | `name` (string) | click a menu section by name (substring); returns its fields |
| `taxme_get_fields` | — | interactive fields on the current page (`id`, `type`, `value`, `label`, `context`) |
| `taxme_snapshot` | `screenshot` (bool) | breadcrumb + url of the current page; `screenshot: true` writes a PNG and returns its path |
| `taxme_fill` | `values: [{target, value}]` | set fields — `target` = field `id` **or** a label/context substring; text→typed, radio→value or label, checkbox→`true`/`false` |
| `taxme_click` | `label` (string) | click a button/link by visible text (*Neuen Eintrag erfassen*, *Speichern*, *Nächste Seite*, *Vorherige Seite*, *Ändern* …) |
| `taxme_results` | — | read the *Ergebnisse* / Steuerberechnung of the open return |

**Submit (gated)**

| Tool | Args | Purpose |
| --- | --- | --- |
| `taxme_submit_return` | `confirm` (bool) | **⚠️ DANGER — irreversible final submission** (*Abschluss → Steuererklärung einreichen*). Without `confirm: true` it only opens the *Abschluss* page and returns a **dry-run**; **nothing is submitted**. Only `confirm: true` actually files the return. |

A typical edit session: `taxme_login` → `taxme_list_returns` →
`taxme_open_return {year}` → `taxme_goto_section {name}` → `taxme_get_fields` →
`taxme_fill {values}` → `taxme_click {label: "Speichern"}` → `taxme_results`.

## JSF quirks handled

TaxMe is a JSF (JavaServer Faces) app with a few sharp edges the server already
smooths over, so you don't have to:

- **Radio buttons** are set by clicking the associated `<label>`, falling back to
  a JS `click()` + a dispatched `change` event — plain `.check()` on the input
  doesn't reliably trigger JSF's listeners. In `taxme_fill` a radio `value` may
  be the option value **or** its visible label.
- **Amounts are whole francs.** Enter `12000`, not `12000.00` / `12'000` — the
  form expects integer francs.
- **The edit popup tab:** opening a return spawns a **new browser tab**;
  `taxme_open_return` waits for and switches to that popup, and the other edit
  tools always target the live edit tab automatically.
- **JSF component ids are unstable** across releases, so selectors are
  text/URL-based with fallbacks.

## Troubleshooting

- **`{"status": "login_required"}`** — the session expired (or you never logged
  in). Run `taxme_login` and complete SwissID/AGOV in the window that opens.
  This is normal and expected periodically.
- **The login window doesn't appear / login can't complete** — `taxme_login`
  runs **headed** on purpose (AGOV needs interaction). It must run on a machine
  with a display; it won't work over a headless/SSH session with no desktop.
  Everything else runs headless.
- **Chromium not found** — install it with `npx playwright install chromium`, or
  point `TAXME_CHROMIUM` at an existing Chromium/Chrome-for-Testing binary. The
  server auto-detects the Playwright cache
  (`~/Library/Caches/ms-playwright/chromium-*` on macOS).
- **Everything says `login_required` even right after logging in** — your
  `state.json` / profile may be stale or corrupt. Delete `~/.taxme-mcp/state.json`
  (and, if needed, `~/.taxme-mcp/profile/`) and run `taxme_login` again.
- **Selectors broke after a portal update** — TaxMe changed its markup. Use
  `taxme_snapshot { "screenshot": true }` and `taxme_get_fields` to see the
  current page, and open an issue.
- **Only Canton of Bern.** Other cantons use different portals; this server is
  TaxMe-specific.

## Releasing

Published from CI with **npm Trusted Publishing** (OIDC) — there is no npm token
anywhere: no secret to store, rotate or leak. npm recommends this over an
automation token, and is restricting tokens that bypass 2FA.

One-time setup per package, on npmjs.com -> the package -> Settings ->
Trusted Publisher:

| Field | Value |
| --- | --- |
| Organization or user | sapn95 |
| Repository | taxme-mcp |
| Workflow filename | release.yml |
| Allowed actions | npm publish |

The workflow filename must match exactly. That is deliberate: it stops any other
workflow in the repo from publishing under your name.

Then every release is one command:

    npm version patch && git push --follow-tags

The tag triggers the release workflow: it upgrades npm (trusted publishing needs
>= 11.5.1 and Node >= 22.14), refuses a tag whose version disagrees with
package.json, runs the gate, and publishes with a signed provenance statement.

### If the publish fails with 404

    npm notice publish Signed provenance statement ... from GitHub Actions
    npm error 404 Not Found - PUT https://registry.npmjs.org/taxme-mcp

Provenance was signed, so OIDC worked — the registry simply does not accept this
workflow as a publisher yet. That means the **trusted publisher is not configured**,
or the repository / workflow name does not match. npm answers 404 rather than 403
so as not to reveal whether the package exists. It is not a credential problem:
there is no credential, by design.

## Checks

    npm test

Runs exactly what CI runs, offline and without credentials: a syntax check, the
protocol smoke test and the hygiene scan.

The smoke test completes the MCP handshake over stdio and asserts the things that
have actually broken here — a server version drifting from package.json, a tool
in the dispatcher but missing from the tool list (or advertised and unhandled), a
required property absent from a schema, and descriptions too thin to choose a
tool from. The hygiene scan refuses secrets, tracked session files and personal
identifiers.

## License

[MIT](./LICENSE) © sapn95
