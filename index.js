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
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
    // storageState() saves origins too, and this threw them away — so any
    // authentication state the portal keeps in localStorage was lost on a
    // restart while the comment above promised the full session came back.
    for (const o of saved.origins || []) {
      if (!o?.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
      const page = await c.newPage().catch(() => null);
      if (!page) continue;
      try {
        await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(entries => {
          for (const { name, value } of entries) {
            try { localStorage.setItem(name, value); } catch { /* quota or a blocked origin */ }
          }
        }, o.localStorage);
      } catch { /* an origin we cannot reach is one we cannot seed */ }
      await page.close().catch(() => {});
    }
  } catch { /* ignore unreadable/corrupt state.json */ }
}

// Mirror the live session (incl. session cookies + origins) to state.json so it
// survives a server restart. Called after login and after every successful,
// authenticated call. Best-effort — never throws into a tool result.
// Returns what actually happened, so a caller can stop promising persistence
// it did not get: 'saved', 'disabled' (TAXME_STATE is empty by choice), or
// 'failed'. It still never throws into a tool result.
async function saveState(c = ctx) {
  try {
    if (!STATE) return 'disabled';
    if (!c) return 'failed';
    // A session cookie is password-equivalent: whoever reads this file is
    // logged in as the taxpayer. It was written with the process umask, which
    // on a normal machine means every local user could read it.
    mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
    chmodSync(dirname(STATE), 0o700);
    await c.storageState({ path: STATE });
    chmodSync(STATE, 0o600);
    return 'saved';
  } catch { return 'failed'; }
}

let ctx = null, headed = false;
let shotDir = null;   // private, 0700, made on first use
async function browser(wantHeaded = false) {
  if (ctx && (headed || !wantHeaded)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  // An empty TAXME_PROFILE means "no persistent profile": Playwright then uses a
  // throwaway directory, so nothing of the session is left on disk.
  // The profile holds the trusted-device state and the live session in
  // Chromium's own store — the same material as state.json, and it was created
  // with the process umask.
  if (PROFILE) {
    mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
    try { chmodSync(PROFILE, 0o700); } catch { /* not ours to tighten */ }
  }
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
// The tab taxme_open_return last landed on. Picking "the first edit tab" instead
// meant that opening a second return left every later tool on the first one:
// values read from, and written into, a different tax year than the one the
// caller had just opened — reported as success either way.
let editPage = null;

async function page() {
  const c = await browser(headed);
  if (editPage && !editPage.isClosed()) return editPage;
  const pages = c.pages();
  const edit = pages.find(p => p.url().includes('/tmo') && p.url().includes('edit.jsf'));
  return edit || pages[pages.length - 1] || await c.newPage();
}

// A tab for the reading tools, which navigate away from wherever they are.
// They used to be handed the edit tab, so checking the session or the account
// statement in the middle of filling a return navigated that tab off the form
// — unsaved values and all — and every later edit tool then worked on the case
// list. The open return is left alone.
async function readingPage() {
  const c = await browser(headed);
  if (!editPage || editPage.isClosed()) return page();
  const other = c.pages().find(p => p !== editPage && !p.isClosed());
  return other || c.newPage();
}

async function ensure(p, url, timeout = 30000) {
  const res = await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await p.waitForTimeout(2500);
  // A 404 or a maintenance page is not a session. Only the login heuristics
  // below used to decide, so any page that merely did not look like a login
  // form was reported as authenticated — and the cached state refreshed on the
  // strength of it.
  const code = res?.status?.() ?? 200;
  if (code >= 400) return 'unreachable';
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
  // Only a session problem is a session problem: "unreachable" told the caller
  // to log in again when the portal had answered 404.
  if (st !== 'ok') return { status: st };
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
  // Only a session problem is a session problem: "unreachable" told the caller
  // to log in again when the portal had answered 404.
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(4000);
  const rows = await p.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('table tr')) {
      const cells = [...tr.querySelectorAll('td, th')].map(c => c.innerText.replace(/\s+/g, ' ').trim());
      // A data row, not a header: "Steuererklärung / Status" as a header used to
      // become a return with the status "Status". A year is what makes it real.
      if (tr.querySelector('th')) continue;
      if (cells.length >= 2 && /\b20\d{2}\b/.test(cells[0])) out.push({ fall: cells[0], status: cells[1] });
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

// Interactive fields on the current page. `limit` keeps a tool result readable;
// resolution passes none, because a form with more than sixty boxes is exactly
// the kind where the field you want is the sixty-first — and it used to be
// unreachable even when addressed by its exact id.
async function readFields(p, limit = 60) {
  const all = await p.evaluate(() => {
    const fields = [];
    for (const e of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      if (!e.offsetParent && e.type !== 'radio' && e.type !== 'checkbox') continue;
      const row = e.closest('tr') || e.closest('.form-group') || e.parentElement;
      let label = '';
      if (e.labels && e.labels[0]) label = e.labels[0].innerText;
      const ctxTxt = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 90) : '';
      // A tool result goes straight into the model's context. On the AGOV login
      // page one of these inputs is the account password, and reporting its
      // value put the credential there for the sake of describing a form whose
      // shape is the only thing anyone needs.
      const masked = e.type === 'password' && e.value ? '(hidden)' : e.value;
      fields.push({
        id: e.id, tag: e.tagName.toLowerCase(), type: e.type || '',
        value: (e.type === 'radio' || e.type === 'checkbox') ? (e.checked ? 'checked' : 'unchecked') + ':' + e.value : masked,
        label: (label || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        context: ctxTxt,
      });
    }
    return fields;
  });
  return limit === null ? all : all.slice(0, limit);
}

// Where we are, with nothing that could be replayed. An AGOV/OIDC step carries
// the authorisation code, the state and a session id in its query string, and a
// JSF portal is fond of ;jsessionid= in the path. A snapshot goes straight into
// the model's context, so it gets the shape of the location and nothing more.
function safeUrl(u) {
  try {
    const x = new URL(u);
    // An opaque URL has no origin: new URL('about:blank').origin is the string
    // "null" and its pathname is "blank", so concatenating them reported the
    // browser as sitting at "nullblank". These carry nothing to redact.
    if (x.origin === 'null' || x.origin === '') return `${x.protocol}${x.pathname}`;
    return `${x.origin}${x.pathname.replace(/;jsessionid=[^/;?]*/i, ';jsessionid=…')}${x.search ? '?…' : ''}`;
  } catch { return '(unparsable url)'; }
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
  const out = { url: safeUrl(p.url()), breadcrumb: crumb };
  if (wantShot) {
    // A screenshot of a tax return is as sensitive as the return. It used to go
    // into the shared temp directory under a name made of a millisecond stamp:
    // two servers a millisecond apart overwrite each other, and everyone on the
    // machine can read the result. A private directory, made once, 0700.
    shotDir ??= mkdtempSync(join(tmpdir(), 'taxme-shots-'));
    const path = join(shotDir, `shot-${randomUUID()}.png`);
    // The path used to be reported whether or not anything was written, so a
    // caller was told a screenshot of the submission existed when none did.
    try {
      await p.screenshot({ path });
      chmodSync(path, 0o600);
      out.screenshot = path;
    } catch (e) {
      out.screenshot_error = e.message.split('\n')[0].slice(0, 120);
    }
  }
  return out;
}

// Set a single radio/checkbox to a WANTED state (label click, else JS click +
// change). The wanted state used to be assumed: the fallback ended with
// `checked = true` unconditionally, so unchecking a box clicked it off and then
// forced it back on — and reported success. On a tax return that is an answer
// inverted, which is worse than any error.
async function setChoice(p, id, want = true) {
  const lbl = p.locator(`label[for="${id}"]`);
  if (await lbl.count() && await lbl.first().isVisible().catch(() => false)) {
    await lbl.first().click();
    // A label click toggles; if the widget did not land where it was asked to,
    // fall through to setting it outright rather than trusting the click.
    const now = await p.evaluate(i => document.getElementById(i)?.checked, id);
    if (now === want) return;
  }
  await p.evaluate(({ i, want }) => {
    const r = document.getElementById(i);
    if (!r) return;
    if (r.checked !== want) r.click();
    r.checked = want;
    r.dispatchEvent(new Event('change', { bubbles: true }));
  }, { i: id, want });
}

// Resolve a target (exact id, then exact label, then a substring) to one field.
// A substring that matches several fields used to take the first quietly, which
// on a tax form means filling a number into whichever box happened to come
// first in the DOM. Ambiguity is now an error that names the candidates.
async function resolveField(p, target) {
  const fields = await readFields(p, null);
  const want = String(target).toLowerCase();
  const exactId = fields.find(x => x.id === target);
  if (exactId) return exactId;
  const exactLabel = fields.filter(x => (x.label || '').toLowerCase() === want);
  if (exactLabel.length === 1) return exactLabel[0];
  // Only things a caller could address and would want to fill: a submit button
  // has no id and its row context happens to contain every label on the page.
  const usable = fields.filter(x => x.id && !/^(submit|button|reset|image|file)$/.test(x.type));
  // A label match beats a context match — the context is the whole row, so it
  // matches a neighbouring field just as readily as the intended one.
  const byLabel = usable.filter(x => (x.label || '').toLowerCase().includes(want));
  const loose = byLabel.length ? byLabel : usable.filter(x => (x.context || '').toLowerCase().includes(want));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    // A radio group is many inputs and one question. Matching all of its
    // members is not ambiguity — fillOne picks the member by value below.
    if (loose.every(x => x.type === 'radio' && x.context === loose[0].context)) return loose[0];
    const e = new Error(`"${target}" passt auf ${loose.length} Felder — bitte eine id angeben: ${loose.map(x => x.id).slice(0, 8).join(', ')}`);
    e.ambiguous = true;
    throw e;
  }
  return undefined;
}

async function fillOne(p, target, value) {
  const f = await resolveField(p, target);
  if (!f) return { target, ok: false, error: 'Feld nicht gefunden' };
  if (f.type === 'radio') {
    // value can be the radio value or a label; find the matching radio in the group
    const all = await readFields(p, null);
    const group = all.filter(x => x.type === 'radio' && x.context === f.context);
    // No fallback to the resolved field: an unknown value used to select
    // whichever radio the lookup happened to land on and call it a success.
    const pick = group.find(x => x.value.endsWith(':' + value))
      || group.find(x => x.label.toLowerCase() === String(value).toLowerCase());
    if (!pick) {
      return {
        target, ok: false,
        error: `Wert "${value}" gibt es in dieser Gruppe nicht`,
        options: group.map(x => ({ id: x.id, value: x.value.split(':').slice(1).join(':'), label: x.label })),
      };
    }
    await setChoice(p, pick.id, true);
    return { target, ok: true, set: pick.id };
  }
  if (f.type === 'checkbox') {
    const want = value === true || value === 'true' || value === 'checked' || value === 1;
    const isOn = f.value.startsWith('checked');
    if (want !== isOn) await setChoice(p, f.id, want);
    // Read it back. Claiming a state without looking is how the inverted
    // checkbox went unnoticed in the first place.
    const now = await p.evaluate(i => document.getElementById(i)?.checked, f.id);
    if (now !== want) return { target, ok: false, error: `Checkbox blieb ${now ? 'gesetzt' : 'leer'}`, checkbox: now };
    return { target, ok: true, checkbox: want };
  }
  // JSF ids contain colons ("form:tab:0:betrag"), so `#id` is not a valid CSS
  // selector — the attribute form is the only one that works here.
  const loc = p.locator(`[id="${f.id}"]`);
  if (f.tag === 'select') {
    // A dropdown cannot be typed into; accept either the option value or its
    // visible label, because a caller reading taxme_get_fields sees both.
    await loc.selectOption({ value: String(value) }).catch(() => loc.selectOption({ label: String(value) }));
    const chosen = await loc.inputValue().catch(() => null);
    // A readback that failed is not proof the value went in. Reporting ok on it
    // is the same mistake as reporting a submission because a button was hit.
    if (chosen === null) return { target, ok: false, error: 'Wert liess sich nach dem Setzen nicht zurücklesen', selected: f.id };
    return { target, ok: true, selected: f.id, value: chosen };
  }
  // Nothing here fills a password. taxme_login is the only thing that should
  // ever touch one, and it hands the keyboard to the human; a fill against a
  // password box would put the value in the request, the readback and the
  // warning text — three copies in the model's context.
  if (f.type === 'password') {
    return { target, ok: false, error: 'Passwortfelder werden nicht befüllt — die Anmeldung läuft über taxme_login.' };
  }
  await loc.fill(String(value));
  // Read the value back. The amount fields are whole-franc converters that
  // reject or truncate anything with a decimal part, and reporting "ok" while
  // the field holds something else is how a wrong number ends up in a tax
  // return. So the quirk is not silently corrected, it is reported.
  const after = await loc.inputValue().catch(() => null);
  if (after === null) return { target, ok: false, error: 'Wert liess sich nach dem Setzen nicht zurücklesen', filled: f.id };
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
  { name: 'taxme_get_fields', description: 'List interactive fields on the current page (id, type, value, label, context). Long forms are cut at limit (default 60) and the reply says how many were left out; taxme_fill still resolves against every field.', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many fields to return (default 60)' } } } },
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

// One tool call at a time. Every one of them drives the same page: two running
// together interleave, so one call's navigation lands while the other is
// mid-fill, and an answer — or a value written into a tax return — belongs to
// neither request. A client is free to pipeline requests, so this is not exotic.
let turnQueue = Promise.resolve();
function takeTurn() {
  let release;
  const held = new Promise(r => { release = r; });
  const ourTurn = turnQueue;
  turnQueue = turnQueue.then(() => held);
  return ourTurn.then(() => release);
}

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  const release = await takeTurn();
  try {
    if (name === 'taxme_status') { const p = await readingPage(); return text({ status: await ensure(p, CASES) }); }
    if (name === 'taxme_login') {
      const c = await browser(true);
      const p = c.pages()[0] || await c.newPage();
      await p.goto(CASES, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.bringToFront().catch(() => {});
      // Host equality, not "the string appears somewhere". A SwissID URL carries
      // the portal address inside its redirect parameter, so a substring test
      // was satisfied while still sitting on the login page — and the session
      // was then cached as if authentication had completed.
      await p.waitForURL(u => {
        try {
          const x = new URL(String(u));
          return x.host === HOST && !x.pathname.includes('Error');
        } catch { return false; }
      }, { timeout: 480000 });
      await p.waitForTimeout(3000);
      await saveState();   // persist the fresh AGOV session to state.json
      // It used to say the session was cached whatever had happened — including
      // when caching is switched off, which is a promise the next restart breaks.
      const cached = await saveState();
      return text({
        status: 'ok',
        session_cache: cached,
        message: cached === 'saved'
          ? 'BE-Login/AGOV erfolgreich, Session in state.json gespeichert (überlebt Server-Neustarts).'
          : cached === 'disabled'
            ? 'BE-Login/AGOV erfolgreich. TAXME_STATE ist leer — die Session wird NICHT zwischengespeichert und ist nach einem Neustart weg.'
            : 'BE-Login/AGOV erfolgreich, aber die Session konnte nicht gespeichert werden — nach einem Neustart ist ein neuer Login nötig.',
      });
    }
    if (name === 'taxme_account_statement') return text(await readAccountStatement(await readingPage()));
    if (name === 'taxme_list_returns') return text(await listReturns(await readingPage()));

    if (name === 'taxme_open_return') {
      const c = await browser(headed);
      const main = c.pages().find(x => x.url().includes('caseSelection')) || c.pages()[0] || await c.newPage();
      const st = await ensure(main, CASES);
      if (st === 'login_required') return text({ status: 'login_required', message: 'Bitte zuerst taxme_login.' });
      if (st !== 'ok') return text({ status: st, message: 'Das Portal hat nicht geantwortet wie erwartet.' });
      await main.waitForTimeout(3000);
      const link = await byText(main, `Steuererklärung ${args.year}`);
      if (!link) return text({ error: `Steuererklärung ${args.year} nicht gefunden`, returns: (await listReturns(main)).returns });
      const [popup] = await Promise.all([ c.waitForEvent('page', { timeout: 15000 }).catch(() => null), link.click() ]);
      const ep = popup || main;
      await ep.waitForLoadState('domcontentloaded'); await ep.waitForTimeout(7000);
      await ep.bringToFront().catch(() => {});
      // Remember which tab this is. Every later tool works on the return that
      // was actually opened, not on whichever edit tab happens to come first.
      if (editPage && editPage !== ep && !editPage.isClosed()) await editPage.close().catch(() => {});
      editPage = ep;
      return text({ status: 'ok', year: args.year, menu: await readMenu(ep) });
    }
    if (name === 'taxme_menu') return text({ menu: await readMenu(await page()) });
    if (name === 'taxme_get_fields') {
      // Say so when the list was cut, rather than presenting sixty of ninety
      // fields as if that were the form.
      const all = await readFields(await page(), null);
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 60;
      return text({
        fields: all.slice(0, limit),
        ...(all.length > limit ? { truncated: all.length - limit, total: all.length, hint: 'pass limit to see more; taxme_fill resolves against all of them regardless' } : {}),
      });
    }
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
      // Checked before a browser is touched. An item without `value` reached
      // the fill and wrote the literal string "undefined" into the field — a
      // malformed request quietly corrupting a draft tax return.
      const badItem = args.values.findIndex(v =>
        !v || typeof v !== 'object'
        || typeof v.target !== 'string' || !v.target.trim()
        || !Object.hasOwn(v, 'value') || v.value === undefined);
      if (badItem >= 0) {
        return text({ error: `values[${badItem}] braucht ein nicht-leeres target und ein value`, got: args.values[badItem] ?? null });
      }
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
      // The click used to be optional and its failure swallowed, after which
      // this returned a slice of whatever page was open — a personal-details
      // form presented as a tax calculation.
      const el = await byText(p, 'Ergebnisse');
      if (!el) return text({ error: 'Menüpunkt "Ergebnisse" nicht gefunden', menu: await readMenu(p) });
      try {
        await el.click();
      } catch (e) {
        return text({ error: `"Ergebnisse" liess sich nicht öffnen: ${e.message.split('\n')[0].slice(0, 120)}` });
      }
      await p.waitForTimeout(6000);
      const body = (await p.innerText('body')).replace(/\n{2,}/g, '\n');
      // The word appears in the navigation as well, and that entry comes first
      // in the DOM: slicing from the first occurrence returned menu text, and
      // on a page with a long menu the 1500-character window ran out before
      // the calculation. The panel is the later one.
      const i = body.lastIndexOf('Ergebnisse');
      if (i < 0) {
        return text({ error: 'Die Seite nach dem Klick enthält keine Ergebnisse', breadcrumb: (await snapshot(p, false)).breadcrumb });
      }
      const rest = body.slice(i);
      const slice = rest.slice(0, 1500);
      // And it has to look like a calculation. Any digit used to count, so
      // "Für Steuerjahr 2025 ist keine Berechnung verfügbar" came back as a
      // successful result — a year is a digit. An amount is the evidence.
      if (!/\d[\d'’.]*[.,]\d{2}\b/.test(slice)) {
        return text({ error: 'Unter "Ergebnisse" steht keine Berechnung', breadcrumb: (await snapshot(p, false)).breadcrumb, text: slice });
      }
      await saveState();
      // Cut, and say so. A calculation with more rows than fit was presented
      // as the whole of it.
      return text({
        text: slice,
        ...(rest.length > 1500 ? { truncated: rest.length - 1500, hint: 'die Berechnung ist länger als der zurückgegebene Ausschnitt' } : {}),
      });
    }
    if (name === 'taxme_submit_return') {
      const p = await page();
      // Getting to Abschluss is a precondition, not a nicety. It used to be
      // attempted, its failure swallowed, and the search for an "einreichen" or
      // "freigeben" button then run against whatever page was open — which is
      // how a confirmed call reaches an irreversible action that belongs to
      // something else entirely.
      const el = await byText(p, 'Abschluss');
      if (!el) return text({ submitted: false, error: 'Menüpunkt "Abschluss" nicht gefunden — es wurde nichts geklickt', menu: await readMenu(p) });
      try {
        await el.click();
      } catch (e) {
        return text({ submitted: false, error: `"Abschluss" liess sich nicht öffnen: ${e.message.split('\n')[0].slice(0, 120)}` });
      }
      await p.waitForTimeout(6000);
      // And confirm we are actually there before looking for the button.
      const onAbschluss = /Abschluss/i.test(await p.innerText('body').catch(() => ''));
      if (!onAbschluss) {
        return text({ submitted: false, error: 'Nach dem Klick ist die Abschluss-Seite nicht offen — es wurde nichts eingereicht', ...(await snapshot(p, false)) });
      }
      const snap = await snapshot(p, args.confirm !== true);
      if (args.confirm !== true) {
        return text({ dry_run: true, message: 'Nicht eingereicht. Abschluss-Seite geöffnet. Zum tatsächlichen Einreichen taxme_submit_return mit confirm:true aufrufen.', ...snap, buttons: (await readFields(p)).filter(f => /submit|button/.test(f.type)) });
      }
      // real submit: click the final "einreichen/freigeben" button
      let clicked = null;
      for (const label of ['Steuererklärung einreichen', 'Einreichen', 'Definitiv freigeben', 'Freigeben']) {
        const b = await byText(p, label, true);
        if (b) { await b.click(); clicked = label; break; }
      }
      if (!clicked) {
        return text({ submitted: false, error: 'Kein Einreiche-Button auf der Abschluss-Seite gefunden', ...(await snapshot(p, true)) });
      }
      await p.waitForTimeout(6000);
      // A click is not a submission. The portal can reject the return for its
      // own reasons — validation, an expired session — and this reported
      // "submitted: true" purely because something with the right label had
      // been pressed. That is the one wrong answer this server must never give.
      const body = await p.innerText('body').catch(() => '');
      const confirmed = /wurde eingereicht|erfolgreich eingereicht|Einreichung erfolgreich|eingereicht am/i.test(body);
      if (!confirmed) {
        return text({
          submitted: false,
          clicked,
          error: 'Der Button wurde geklickt, aber die Seite bestätigt keine Einreichung — bitte im Portal prüfen, bevor erneut eingereicht wird.',
          ...(await snapshot(p, true)),
        });
      }
      return text({ submitted: true, clicked, ...(await snapshot(p, true)) });
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  } finally {
    // Whatever happened, the next caller gets its turn.
    release();
  }
});

await server.connect(new StdioServerTransport());
