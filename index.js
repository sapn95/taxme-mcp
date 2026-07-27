#!/usr/bin/env node
// taxme-mcp — MCP server for the Canton of Bern tax portal TaxMe / BE-Login.
//
// BE-Login has no public API; login goes through SwissID/AGOV. This server
// drives the portal with Playwright: a persistent profile keeps the session,
// and `taxme_login` opens a visible window for the interactive login.
//
// Read helpers expose the account statement and the list of returns. Edit
// helpers navigate and FILL a return: open it, walk the menu sections, read
// the fields on a page, set values (text / radio / checkbox), click buttons
// (Neuen Eintrag erfassen, Speichern, Nächste Seite …) and read the results.
// Filling the JSF form has quirks. A radio is set through its label, or failing
// that with a dispatched change event, because the input itself is hidden and
// the widget only commits on `change`. The edit view opens in its own tab. The
// amount fields take whole francs only: a value they alter is read back and
// reported as a warning rather than quietly accepted.
//
// SAFETY: this server fills DRAFTS. The final submission (Abschluss →
// einreichen) is only done by `taxme_submit_return`, which requires an
// explicit confirm:true. Nothing is submitted otherwise.
//
// SESSION CACHING: the AGOV/SwissID session is kept alive across server
// restarts. A persistent Chromium profile keeps the trusted-device state (so
// AGOV does not re-prompt 2FA), and — because a persistent profile drops
// session cookies when the browser closes — every successful call also mirrors
// the full session (incl. session cookies) to `state.json` via
// `storageState()`. On startup we re-seed the fresh context from that file, so
// once you run `taxme_login` the session survives restarts until it genuinely
// expires. See `seedFromState` / `saveState` below.
//
// Env:
//   TAXME_PROFILE   browser profile dir  (default: ~/.taxme-mcp/profile;
//                   empty = a throwaway profile, nothing is kept)
//   TAXME_STATE     storageState json    (default: ~/.taxme-mcp/state.json;
//                   empty = do not cache the session at all)
//   TAXME_BROWSER   chrome | chrome-canary | edge | brave | chromium | abs. path
//                   (default: prefer an installed signed browser — see below)
//   TAXME_CHROMIUM  legacy alias for TAXME_BROWSER
//   TAXME_BASE_URL  portal base URL (default: the real BE-Login) — this exists so
//                   the test suite can point the automation at a local fixture
//                   instead of the live portal of a real taxpayer.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Name and version come from package.json, never from a second copy here:
// `npm version` only bumps package.json, so a hardcoded string silently
// advertises a stale version to every client.
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// An environment variable that is SET, even to the empty string, is the answer.
// Falling back to the default on an empty value makes it impossible to say "no
// session cache" or "no browser preference", and it lets a caller that tried to
// isolate itself — a test above all — silently pick up the real profile, and
// with it the real taxpayer's logged-in session.
const envOr = (name, fallback) => (process.env[name] !== undefined ? process.env[name] : fallback);

const PROFILE = envOr('TAXME_PROFILE', join(homedir(), '.taxme-mcp', 'profile'));
const STATE = envOr('TAXME_STATE', join(homedir(), '.taxme-mcp', 'state.json'));
const BASE = envOr('TAXME_BASE_URL', 'https://www.belogin.directories.be.ch').replace(/\/+$/, '');
if (!BASE) throw new Error('TAXME_BASE_URL is set but empty — refusing to guess a portal URL');
// Throws here, at startup, rather than turning into a confusing failure inside
// the first tool call. Also the host the post-login redirect must land on.
const HOST = new URL(BASE).host;
const CASES = `${BASE}/taxme-npo/facelets/caseSelection.jsf`;
const KONTOAUSZUG = `${BASE}/taxme-bezug/gui/kontoauszug/forderungen`;

// Prefer an installed, signed browser. BE-Login authenticates through
// SwissID/AGOV, and only a signed system browser can reach the macOS platform
// authenticator: Playwright's bundled Chromium reports
// isUserVerifyingPlatformAuthenticatorAvailable() === false, so a passkey is
// never offered and the login falls back to password plus SMS. With Chrome the
// same login is one Touch ID confirmation. Override with TAXME_BROWSER
// (chrome | chrome-canary | edge | brave | chromium | absolute path).
const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chrome-canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};

function findChromium() {
  const want = envOr('TAXME_BROWSER', process.env.TAXME_CHROMIUM || '');
  if (want && want !== 'chromium') {
    const path = BROWSERS[want] || want;
    // Name the variable the value actually came from, so the fix is obvious.
    const from = process.env.TAXME_BROWSER !== undefined ? 'TAXME_BROWSER' : 'TAXME_CHROMIUM';
    if (!existsSync(path)) throw new Error(`${from}="${want}" not found (looked at ${path})`);
    return path;
  }
  if (!want) {
    for (const key of ['chrome', 'chrome-canary', 'edge', 'brave']) {
      if (existsSync(BROWSERS[key])) return BROWSERS[key];
    }
  }
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* scan */ }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter(n => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

// Re-seed a fresh context from the cached storageState. A persistent Chromium
// profile drops non-persistent session cookies when it closes, so on startup we
// inject the cookies we saved after the last successful call — restoring the
// AGOV/SwissID session without a fresh login. Best-effort: a missing or corrupt
// state file just means we start logged-out and `taxme_login` is needed.
async function seedFromState(c) {
  if (!STATE || !existsSync(STATE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE, 'utf8'));
    if (Array.isArray(saved.cookies) && saved.cookies.length) {
      await c.addCookies(saved.cookies).catch(() => {});
    }
  } catch { /* ignore unreadable/corrupt state.json */ }
}

// Mirror the live session (incl. session cookies + origins) to state.json so it
// survives a server restart. Called after login and after every successful,
// authenticated call. Best-effort — never throws into a tool result.
async function saveState(c = ctx) {
  try { if (STATE && c) await c.storageState({ path: STATE }); } catch { /* best-effort */ }
}

let ctx = null, headed = false;
async function browser(wantHeaded = false) {
  if (ctx && (headed || !wantHeaded)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  // An empty TAXME_PROFILE means "no persistent profile": Playwright then uses a
  // throwaway directory, so nothing of the session is left on disk.
  if (PROFILE) mkdirSync(PROFILE, { recursive: true });
  const launch = () => chromium.launchPersistentContext(PROFILE, {
    headless: !wantHeaded, executablePath: findChromium(),
    locale: 'de-CH', viewport: { width: 1400, height: 1000 },
  });
  try {
    ctx = await launch();
  } catch (e) {
    // A browser killed rather than closed leaves SingletonLock behind and Chrome
    // then refuses to start at all, so every later call fails the same way.
    if (!PROFILE || !/ProcessSingleton|SingletonLock/.test(e.message || '')) throw e;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(join(PROFILE, f), { force: true }); } catch { /* nothing to clear */ }
    }
    ctx = await launch();
  }
  headed = wantHeaded;
  await seedFromState(ctx);
  return ctx;
}

// The "work page": the TaxMe edit tab if open, else the main BE-Login page.
async function page() {
  const c = await browser(headed);
  const pages = c.pages();
  const edit = pages.find(p => p.url().includes('/tmo') && p.url().includes('edit.jsf'));
  return edit || pages[pages.length - 1] || await c.newPage();
}

async function ensure(p, url, timeout = 30000) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await p.waitForTimeout(2500);
  const u = p.url();
  if (u.includes('swissid.ch') || u.includes('agov') || u.includes('/Portal/Error') || /\/login|anmeld/i.test(u)) return 'login_required';
  const body = await p.innerText('body').catch(() => '');
  if (/Angemeldet als:\s*(Benutzer|\n|$)/.test(body)) return 'login_required';
  await saveState();   // confirmed live session — refresh the cached state
  return 'ok';
}

// ---- read helpers ----
async function readAccountStatement(p) {
  const st = await ensure(p, KONTOAUSZUG);
  if (st !== 'ok') return { status: 'login_required' };
  await p.waitForTimeout(2500);
  const text = await p.innerText('body');
  const years = {};
  const re = /(\b20\d{2})\b([\s\S]*?)(?=\b20\d{2}\b|Aktuelle Jahre|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[2];
    const grab = label => { const r = new RegExp(label + "\\s+([0-9'’.]+)").exec(block); return r ? r[1].replace(/[’']/g, "'") : null; };
    const kg = grab('Kantons- und Gemeindesteuern'), bund = grab('Direkte Bundessteuer');
    if (kg !== null || bund !== null) years[m[1]] = { kantons_gemeinde: kg, bund, gemeindeabgaben: grab('Gemeindeabgaben') };
  }
  return { status: 'ok', open_amounts_chf: years };
}

async function listReturns(p) {
  const st = await ensure(p, CASES);
  if (st !== 'ok') return { status: 'login_required' };
  await p.waitForTimeout(4000);
  const rows = await p.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('table tr')) {
      const cells = [...tr.querySelectorAll('td, th')].map(c => c.innerText.replace(/\s+/g, ' ').trim());
      if (cells.length >= 2 && /Steuererkl|20\d{2}/.test(cells[0])) out.push({ fall: cells[0], status: cells[1] });
    }
    return out;
  });
  return { status: 'ok', returns: rows };
}

// Left menu of the edit view: section name -> status
async function readMenu(p) {
  return p.evaluate(() => {
    const items = [];
    const body = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < body.length - 1; i++) {
      if (/^(Formular in Bearbeitung|Abgeschlossenes Formular|Ausgeschaltet aufgrund Ihrer Eingaben)$/.test(body[i + 1])) {
        items.push({ section: body[i], status: body[i + 1] });
      }
    }
    return items;
  });
}

// Interactive fields on the current page.
async function readFields(p) {
  return p.evaluate(() => {
    const fields = [];
    for (const e of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      if (!e.offsetParent && e.type !== 'radio' && e.type !== 'checkbox') continue;
      const row = e.closest('tr') || e.closest('.form-group') || e.parentElement;
      let label = '';
      if (e.labels && e.labels[0]) label = e.labels[0].innerText;
      const ctxTxt = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 90) : '';
      fields.push({
        id: e.id, tag: e.tagName.toLowerCase(), type: e.type || '',
        value: (e.type === 'radio' || e.type === 'checkbox') ? (e.checked ? 'checked' : 'unchecked') + ':' + e.value : e.value,
        label: (label || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        context: ctxTxt,
      });
    }
    return fields.slice(0, 60);
  });
}

async function snapshot(p, wantShot) {
  const crumb = await p.evaluate(() => {
    // Only content elements: `*` also matches <html>, which has two children
    // and contains every string on the page, so the fallback used to return the
    // whole document as a "breadcrumb".
    const el = [...document.querySelectorAll('div, span, p, td, li, h1, h2, h3')]
      .find(n => /Sie befinden sich derzeit/.test(n.textContent || '') && n.children.length < 3);
    const m = document.body.innerText.match(/TaxMe \d{4} >[^\n]*/);
    return m ? m[0] : (el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : '');
  });
  const out = { url: p.url(), breadcrumb: crumb };
  if (wantShot) { const path = join(tmpdir(), `taxme_${Date.now()}.png`); await p.screenshot({ path }).catch(() => {}); out.screenshot = path; }
  return out;
}

// Set a single radio/checkbox reliably (label click, else JS click + change).
async function setChoice(p, id) {
  const lbl = p.locator(`label[for="${id}"]`);
  if (await lbl.count() && await lbl.first().isVisible().catch(() => false)) { await lbl.first().click(); return; }
  await p.evaluate(i => { const r = document.getElementById(i); if (r) { r.click(); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }, id);
}

// Resolve a target (exact id or label/context substring) to a concrete field.
async function resolveField(p, target) {
  const fields = await readFields(p);
  let f = fields.find(x => x.id === target);
  if (!f) f = fields.find(x => (x.label && x.label.toLowerCase().includes(target.toLowerCase())) || (x.context && x.context.toLowerCase().includes(target.toLowerCase())));
  return f;
}

async function fillOne(p, target, value) {
  const f = await resolveField(p, target);
  if (!f) return { target, ok: false, error: 'Feld nicht gefunden' };
  if (f.type === 'radio') {
    // value can be the radio value or a label; find the matching radio in the group
    const all = await readFields(p);
    const group = all.filter(x => x.type === 'radio' && x.context === f.context);
    const pick = group.find(x => x.value.endsWith(':' + value)) || group.find(x => x.label.toLowerCase() === String(value).toLowerCase()) || f;
    await setChoice(p, pick.id);
    return { target, ok: true, set: pick.id };
  }
  if (f.type === 'checkbox') {
    const want = value === true || value === 'true' || value === 'checked' || value === 1;
    const isOn = f.value.startsWith('checked');
    if (want !== isOn) await setChoice(p, f.id);
    return { target, ok: true, checkbox: want };
  }
  // JSF ids contain colons ("form:tab:0:betrag"), so `#id` is not a valid CSS
  // selector — the attribute form is the only one that works here.
  const loc = p.locator(`[id="${f.id}"]`);
  if (f.tag === 'select') {
    // A dropdown cannot be typed into; accept either the option value or its
    // visible label, because a caller reading taxme_get_fields sees both.
    await loc.selectOption({ value: String(value) }).catch(() => loc.selectOption({ label: String(value) }));
    return { target, ok: true, selected: f.id, value: await loc.inputValue().catch(() => null) };
  }
  await loc.fill(String(value));
  // Read the value back. The amount fields are whole-franc converters that
  // reject or truncate anything with a decimal part, and reporting "ok" while
  // the field holds something else is how a wrong number ends up in a tax
  // return. So the quirk is not silently corrected, it is reported.
  const after = await loc.inputValue().catch(() => null);
  const out = { target, ok: true, filled: f.id, value: after };
  if (after !== null && after !== String(value)) {
    out.warning = `Feld übernahm "${after}" statt "${value}" — Beträge in ganzen Franken erfassen.`;
  }
  return out;
}

const cssStr = s => String(s).replace(/["\\]/g, '\\$&');                       // for [value="…"]
const rxExact = s => new RegExp(`^\\s*${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

// Resolve a visible label to one element: an exact match first, a substring one
// only as a fallback. The menu and the button bar are full of names that are
// prefixes of each other — "Speichern" / "Speichern und schliessen",
// "Wertschriften" / "Wertschriftenverzeichnis" — and `:has-text()` matches
// substrings, so simply taking the first hit clicks the wrong thing.
async function byText(p, label, withInputs = false) {
  const v = cssStr(label);
  const tries = [p.locator('a, button').filter({ hasText: rxExact(label) })];
  if (withInputs) tries.push(p.locator(`input[type=submit][value="${v}"], input[type=button][value="${v}"]`));
  tries.push(p.locator(`a:has-text("${v}"), button:has-text("${v}")`));
  if (withInputs) tries.push(p.locator(`input[type=submit][value*="${v}"], input[type=button][value*="${v}"]`));
  for (const t of tries) if (await t.count()) return t.first();
  return null;
}

async function clickByText(p, label) {
  const before = p.url();
  const el = await byText(p, label, true);
  if (!el) throw new Error(`kein klickbares Element "${label}"`);
  await el.click({ timeout: 10000 });
  await p.waitForTimeout(4000).catch(() => {});
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  return { clicked: label, url_changed: p.url() !== before };
}

// ---- tool definitions ----
const TOOLS = [
  { name: 'taxme_status', description: 'Check whether the BE-Login/TaxMe session is alive (ok) or an interactive SwissID/AGOV login is needed (login_required). Call this before anything else; it also refreshes the cached session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_login', description: 'Open a visible window for the SwissID/AGOV login (waits up to 8 min).', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_account_statement', description: 'Open tax amounts (CHF) per tax year.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_list_returns', description: 'Tax returns with status.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_open_return', description: 'Open a tax return (year) for editing; returns the menu sections. Handles the edit popup tab.', inputSchema: { type: 'object', properties: { year: { type: 'number' } }, required: ['year'] } },
  { name: 'taxme_menu', description: 'Left-menu sections of the open return with their status.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_goto_section', description: 'Click a menu section by name (substring) in the open return; returns the fields on that page.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'taxme_get_fields', description: 'List interactive fields on the current page (id, type, value, label, context).', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_snapshot', description: 'Current page breadcrumb/url; set screenshot:true for a PNG path.', inputSchema: { type: 'object', properties: { screenshot: { type: 'boolean' } } } },
  { name: 'taxme_fill', description: 'Set fields on the current page. Each value: {target, value}. target = field id OR a label/context substring. Text→typed (use whole francs for amounts), radio→value or label, checkbox→true/false.', inputSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'object', properties: { target: { type: 'string' }, value: {} }, required: ['target', 'value'] } } }, required: ['values'] } },
  { name: 'taxme_click', description: 'Click a button/link by visible text (e.g. "Neuen Eintrag erfassen", "Speichern", "Nächste Seite", "Vorherige Seite", "Ändern").', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
  { name: 'taxme_results', description: 'Read the Ergebnisse / Steuerberechnung of the open return.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_submit_return', description: 'DANGER: final submission (Abschluss → Steuererklärung einreichen). Irreversible. Requires confirm:true; otherwise returns a dry-run of the Abschluss page.', inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } },
];

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Take the browser down with us. A client that disconnects, or a Ctrl-C, used
// to leave a Chromium running on the profile — which then holds the very lock
// the next start has to break, and keeps a logged-in session open on a machine
// nobody is watching.
let goingDown = false;
async function shutdown() {
  if (goingDown) return;
  goingDown = true;
  try { if (ctx) await ctx.close(); } catch { /* going down anyway */ }
  process.exit(0);
}
server.onclose = () => { void shutdown(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'taxme_status') { const p = await page(); return text({ status: await ensure(p, CASES) }); }
    if (name === 'taxme_login') {
      const c = await browser(true);
      const p = c.pages()[0] || await c.newPage();
      await p.goto(CASES, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.bringToFront().catch(() => {});
      await p.waitForURL(u => { const s = String(u); return s.includes(HOST) && !s.includes('agov') && !s.includes('Error'); }, { timeout: 480000 });
      await p.waitForTimeout(3000);
      await saveState();   // persist the fresh AGOV session to state.json
      return text({ status: 'ok', message: 'BE-Login/AGOV erfolgreich, Session in state.json gespeichert (überlebt Server-Neustarts).' });
    }
    if (name === 'taxme_account_statement') return text(await readAccountStatement(await page()));
    if (name === 'taxme_list_returns') return text(await listReturns(await page()));

    if (name === 'taxme_open_return') {
      const c = await browser(headed);
      const main = c.pages().find(x => x.url().includes('caseSelection')) || c.pages()[0] || await c.newPage();
      const st = await ensure(main, CASES);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Bitte zuerst taxme_login.' });
      await main.waitForTimeout(3000);
      const link = await byText(main, `Steuererklärung ${args.year}`);
      if (!link) return text({ error: `Steuererklärung ${args.year} nicht gefunden`, returns: (await listReturns(main)).returns });
      const [popup] = await Promise.all([ c.waitForEvent('page', { timeout: 15000 }).catch(() => null), link.click() ]);
      const ep = popup || main;
      await ep.waitForLoadState('domcontentloaded'); await ep.waitForTimeout(7000);
      await ep.bringToFront().catch(() => {});
      return text({ status: 'ok', menu: await readMenu(ep) });
    }
    if (name === 'taxme_menu') return text({ menu: await readMenu(await page()) });
    if (name === 'taxme_get_fields') return text({ fields: await readFields(await page()) });
    if (name === 'taxme_snapshot') return text(await snapshot(await page(), args.screenshot));

    if (name === 'taxme_goto_section') {
      const p = await page();
      // expand a collapsed parent if needed by clicking the parent group first is not required for JSF here
      const el = await byText(p, args.name);
      if (!el) return text({ error: `Menüpunkt "${args.name}" nicht gefunden`, menu: await readMenu(p) });
      await el.click({ timeout: 10000 });
      await p.waitForTimeout(5000); await p.waitForLoadState('domcontentloaded').catch(() => {});
      await saveState();
      return text({ breadcrumb: (await snapshot(p)).breadcrumb, fields: await readFields(p) });
    }
    if (name === 'taxme_fill') {
      if (!Array.isArray(args.values)) return text({ error: 'values muss eine Liste von {target, value} sein' });
      const p = await page();
      const results = [];
      for (const v of args.values) {
        // One unfillable field must not abort the batch: the fields before it
        // are already changed in the portal, and losing that report is worse
        // than the failure itself.
        try { results.push(await fillOne(p, v.target, v.value)); }
        catch (e) { results.push({ target: v.target, ok: false, error: e.message || String(e) }); }
        await p.waitForTimeout(600);
      }
      await saveState();
      return text({ results, fields_after: await readFields(p) });
    }
    if (name === 'taxme_click') { const p = await page(); const r = await clickByText(p, args.label); await saveState(); return text({ ...r, breadcrumb: (await snapshot(p)).breadcrumb, fields: await readFields(p) }); }
    if (name === 'taxme_results') {
      const p = await page();
      const el = await byText(p, 'Ergebnisse');
      if (el) { await el.click().catch(() => {}); await p.waitForTimeout(6000); }
      const body = (await p.innerText('body')).replace(/\n{2,}/g, '\n');
      const i = body.indexOf('Ergebnisse');
      await saveState();
      return text({ text: body.slice(i > 0 ? i : 0, (i > 0 ? i : 0) + 1500) });
    }
    if (name === 'taxme_submit_return') {
      const p = await page();
      const el = await byText(p, 'Abschluss');
      if (el) { await el.click().catch(() => {}); await p.waitForTimeout(6000); }
      const snap = await snapshot(p, true);
      if (args.confirm !== true) {
        return text({ dry_run: true, message: 'Nicht eingereicht. Abschluss-Seite geöffnet. Zum tatsächlichen Einreichen taxme_submit_return mit confirm:true aufrufen.', ...snap, buttons: (await readFields(p)).filter(f => /submit|button/.test(f.type)) });
      }
      // real submit: click the final "einreichen/freigeben" button
      let clicked = null;
      for (const label of ['Steuererklärung einreichen', 'Einreichen', 'Definitiv freigeben', 'Freigeben']) {
        const b = await byText(p, label, true);
        if (b) { await b.click(); clicked = label; break; }
      }
      await p.waitForTimeout(6000);
      return text({ submitted: !!clicked, clicked, ...(await snapshot(p, true)) });
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
