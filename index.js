#!/usr/bin/env node
// taxme-mcp — MCP server for the Canton of Bern tax portal TaxMe / BE-Login.
//
// BE-Login has no public API; login goes through SwissID/AGOV. This server
// drives the portal with Playwright: a persistent profile keeps the session,
// and `taxme_login` opens a visible window for the interactive SwissID/AGOV
// login. Read-only helpers then expose the account statement (open amounts per
// tax year) and the list of tax returns with their status.
//
// Env:
//   TAXME_PROFILE   browser profile dir  (default: ~/.taxme-mcp/profile)
//   TAXME_CHROMIUM  chromium executable  (default: auto-detect playwright cache)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = process.env.TAXME_PROFILE || join(homedir(), '.taxme-mcp', 'profile');
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
  return ctx;
}
async function page() { const c = await browser(headed); return c.pages()[0] || await c.newPage(); }

// Navigate somewhere inside BE-Login; returns 'ok' or 'login_required'.
async function ensure(p, url, timeout = 30000) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await p.waitForTimeout(2500);
  const u = p.url();
  if (u.includes('swissid.ch') || u.includes('agov') || u.includes('/Portal/Error') || /login|anmeld/i.test(u)) return 'login_required';
  const body = await p.innerText('body').catch(() => '');
  if (/Angemeldet als: (Benutzer|\s*$)/.test(body)) return 'login_required';
  return 'ok';
}

async function readAccountStatement(p) {
  const st = await ensure(p, KONTOAUSZUG);
  if (st !== 'ok') return { status: 'login_required' };
  await p.waitForTimeout(2500);
  const text = await p.innerText('body');
  const years = {};
  const re = /(\b20\d{2})\b([\s\S]*?)(?=\b20\d{2}\b|Aktuelle Jahre|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const year = m[1], block = m[2];
    const grab = label => { const r = new RegExp(label + "\\s+([0-9'’.]+)").exec(block); return r ? r[1].replace(/[’']/g, "'") : null; };
    const kg = grab('Kantons- und Gemeindesteuern');
    const bund = grab('Direkte Bundessteuer');
    if (kg !== null || bund !== null) years[year] = { kantons_gemeinde: kg, bund, gemeindeabgaben: grab('Gemeindeabgaben') };
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

const TOOLS = [
  { name: 'taxme_status', description: 'Check whether the BE-Login/TaxMe session is alive (ok) or an interactive SwissID/AGOV login is needed.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_login', description: 'Open a visible browser window on BE-Login so the user can complete the SwissID/AGOV login. Waits up to 8 minutes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_account_statement', description: 'Read the Kontoauszug: open tax amounts (CHF) per tax year (Kantons-/Gemeindesteuern, direkte Bundessteuer, Gemeindeabgaben).', inputSchema: { type: 'object', properties: {} } },
  { name: 'taxme_list_returns', description: 'List the tax returns (Steuererklärungen) with their status (e.g. In Bearbeitung, Quittiert).', inputSchema: { type: 'object', properties: {} } },
];

const server = new Server({ name: 'taxme-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'taxme_status') { const p = await page(); return text({ status: await ensure(p, CASES) }); }
    if (name === 'taxme_login') {
      await browser(true);
      const p = await page();
      await p.goto(CASES, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.bringToFront().catch(() => {});
      await p.waitForURL(u => { const s = String(u); return s.includes('belogin.directories.be.ch') && !s.includes('agov') && !s.includes('Error'); }, { timeout: 480000 });
      await p.waitForTimeout(3000);
      return text({ status: 'ok', message: 'BE-Login/AGOV erfolgreich, Session gespeichert.' });
    }
    const p = await page();
    if (name === 'taxme_account_statement') return text(await readAccountStatement(p));
    if (name === 'taxme_list_returns') return text(await listReturns(p));
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
