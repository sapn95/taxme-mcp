# taxme-mcp

MCP server for the **Canton of Bern** tax portal **TaxMe / BE-Login**
([belogin.directories.be.ch](https://www.belogin.directories.be.ch)) — read
your account statement (open amounts per tax year) and your tax returns with
their status, from any MCP client.

BE-Login has **no public API** and authenticates through **SwissID/AGOV**, so
this server drives the portal with Playwright browser automation. It is
inherently fragile: portal updates can break selectors, and it depends on your
interactive SwissID/AGOV login. Read-only by design — it does not fill or
submit returns.

## How it works

- A persistent Chromium profile (`~/.taxme-mcp/profile`) keeps the session.
- When the session has expired, `taxme_login` opens a **visible** window; you
  complete the SwissID/AGOV login (incl. 2FA) yourself. Everything else runs
  headless.

## Tools

| Tool | Purpose |
| --- | --- |
| `taxme_status` | `ok` or `login_required` |
| `taxme_login` | open a visible window for the SwissID/AGOV login (waits up to 8 min) |
| `taxme_account_statement` | open amounts (CHF) per tax year — Kantons-/Gemeindesteuern, direkte Bundessteuer, Gemeindeabgaben |
| `taxme_list_returns` | tax returns (Steuererklärungen) with status (In Bearbeitung / Quittiert …) |

## Install

```bash
git clone git@github.com:sapn95/taxme-mcp.git
cd taxme-mcp && npm install
npx playwright install chromium   # skip if a playwright chromium is already cached
claude mcp add --scope user taxme -- node /path/to/taxme-mcp/index.js
```

## Env

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAXME_PROFILE` | `~/.taxme-mcp/profile` | browser profile dir (holds the session — secret) |
| `TAXME_CHROMIUM` | auto-detect | chromium executable override |

## Caveats

- Private use for your own BE-Login account. Respect the portal's terms.
- The profile directory contains live session cookies — never commit or share it.
- SwissID/AGOV sessions are short-lived; run `taxme_login` at the start of a session.
- JSF component ids in TaxMe are unstable; selectors use text/URLs with fallbacks — expect occasional breakage after portal releases.
- Only Canton of Bern (TaxMe). Other cantons use different portals.
