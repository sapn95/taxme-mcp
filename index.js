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
// Filling the JSF form has quirks — they are handled here (radios set via the
// label / a dispatched change event, whole-franc amounts, the edit popup tab).
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
//   TAXME_PROFILE   browser profile dir  (default: ~/.taxme-mcp/profile)
//   TAXME_STATE     storageState json    (default: ~/.taxme-mcp/state.json)
//   TAXME_CHROMIUM  chromium executable  (default: auto-detect playwright cache)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PROFILE = process.env.TAXME_PROFILE || join(homedir(), '.taxme-mcp', 'profile');
const STATE = process.env.TAXME_STATE || join(homedir(), '.taxme-mcp', 'state.json');
const BASE = 'https://www.belogin.directories.be.ch';
const CASES = `${BASE}/taxme-npo/facelets/caseSelection.jsf`;
const KONTOAUSZUG = `${BASE}/taxme-bezug/gui/kontoauszug/forderungen`;

function findChromium() {
  if (process.env.TAXME_CHROMIUM) return process.env.TAXME_CHROMIUM;
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
  if (!existsSync(STATE)) return;
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
  try { if (c) await c.storageState({ path: STATE }); } catch { /* best-effort */ }
}

let ctx = null, headed = false;
async function browser(wantHeaded = false) {
  if (ctx && (headed || !wantHeaded)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !wantHeaded, executablePath: findChromium(),
    locale: 'de-CH', viewport: { width: 1400, height: 1000 },
  });
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
    const el = [...document.querySelectorAll('*')].find(n => /Sie befinden sich derzeit/.test(n.textContent || '') && n.children.length < 3);
    const m = document.body.innerText.match(/TaxMe \d{4} >[^\n]*/);
    return m ? m[0] : (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
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
    let pick = group.find(x => x.value.endsWith(':' + value)) || group.find(x => x.label.toLowerCase() === String(value).toLowerCase()) || f;
    await setChoice(p, pick.id);
    return { target, ok: true, set: pick.id };
  }
  if (f.type === 'checkbox') {
    const want = value === true || value === 'true' || value === 'checked' || value === 1;
    const isOn = f.value.startsWith('checked');
    if (want !== isOn) await setChoice(p, f.id);
    return { target, ok: true, checkbox: want };
  }
  await p.locator(`[id="${f.id}"]`).fill(String(value));
  return { target, ok: true, filled: f.id };
}

async function clickByText(p, label) {
  const before = p.url();
  const el = p.locator(`a:has-text("${label}"), button:has-text("${label}"), input[type=submit][value*="${label}"], input[type=button][value*="${label}"]`).first();
  if (!(await el.count())) throw new Error(`kein klickbares Element "${label}"`);
  await el.click({ timeout: 10000 });
  await p.waitForTimeout(4000).catch(() => {});
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  return { clicked: label, url_changed: p.url() !== before };
}

// ---- tool definitions ----
const TOOLS = [
  { name: 'taxme_status', description: 'ok / login_required.', inputSchema: { type: 'object', properties: {} } },
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

const server = new Server({ name: 'taxme-mcp', version: '0.3.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'taxme_status') { const p = await page(); return text({ status: await ensure(p, CASES) }); }
    if (name === 'taxme_login') {
      await browser(true);
      const c = await browser(true);
      const p = c.pages()[0] || await c.newPage();
      await p.goto(CASES, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.bringToFront().catch(() => {});
      await p.waitForURL(u => { const s = String(u); return s.includes('belogin.directories.be.ch') && !s.includes('agov') && !s.includes('Error'); }, { timeout: 480000 });
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
      const link = main.locator(`a:has-text("Steuererklärung ${args.year}")`).first();
      if (!(await link.count())) return text({ error: `Steuererklärung ${args.year} nicht gefunden`, returns: (await listReturns(main)).returns });
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
      const el = p.locator(`a:has-text("${args.name}")`).first();
      if (!(await el.count())) return text({ error: `Menüpunkt "${args.name}" nicht gefunden`, menu: await readMenu(p) });
      await el.click({ timeout: 10000 });
      await p.waitForTimeout(5000); await p.waitForLoadState('domcontentloaded').catch(() => {});
      await saveState();
      return text({ breadcrumb: (await snapshot(p)).breadcrumb, fields: await readFields(p) });
    }
    if (name === 'taxme_fill') {
      const p = await page();
      const results = [];
      for (const v of args.values) { results.push(await fillOne(p, v.target, v.value)); await p.waitForTimeout(600); }
      await saveState();
      return text({ results, fields_after: await readFields(p) });
    }
    if (name === 'taxme_click') { const p = await page(); const r = await clickByText(p, args.label); await saveState(); return text({ ...r, breadcrumb: (await snapshot(p)).breadcrumb, fields: await readFields(p) }); }
    if (name === 'taxme_results') {
      const p = await page();
      const el = p.locator('a:has-text("Ergebnisse")').first();
      if (await el.count()) { await el.click().catch(() => {}); await p.waitForTimeout(6000); }
      const body = (await p.innerText('body')).replace(/\n{2,}/g, '\n');
      const i = body.indexOf('Ergebnisse');
      await saveState();
      return text({ text: body.slice(i > 0 ? i : 0, (i > 0 ? i : 0) + 1500) });
    }
    if (name === 'taxme_submit_return') {
      const p = await page();
      const el = p.locator('a:has-text("Abschluss")').first();
      if (await el.count()) { await el.click().catch(() => {}); await p.waitForTimeout(6000); }
      const snap = await snapshot(p, true);
      if (args.confirm !== true) {
        return text({ dry_run: true, message: 'Nicht eingereicht. Abschluss-Seite geöffnet. Zum tatsächlichen Einreichen taxme_submit_return mit confirm:true aufrufen.', ...snap, buttons: (await readFields(p)).filter(f => /submit|button/.test(f.type)) });
      }
      // real submit: click the final "einreichen/freigeben" button
      let clicked = null;
      for (const label of ['Steuererklärung einreichen', 'Einreichen', 'Definitiv freigeben', 'Freigeben']) {
        const b = p.locator(`a:has-text("${label}"), input[type=submit][value*="${label}"], button:has-text("${label}")`).first();
        if (await b.count()) { await b.click(); clicked = label; break; }
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
