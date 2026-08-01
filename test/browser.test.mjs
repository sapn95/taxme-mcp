// Drives the real automation, in a real headless browser, against the local
// fixture portal. These are the paths that carry the risk: the login detection
// that decides whether we are looking at a session or at a stranger, the JSF
// form quirks, and the menu names that are prefixes of one another.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './fixture-portal.mjs';
import { startServer } from './client.mjs';

// Only a real hang should trip this: the portal's own waits are measured in
// seconds, and a loaded CI runner stretches them.
const SLOW = { timeout: 300000 };
let portal, srv, scratch;

// A storageState as the server writes it after a login: a session cookie, no
// expiry. Seeding it is how a restarted server gets its session back.
const seededState = session => JSON.stringify({
  cookies: [{
    name: 'TAXMESESSION', value: session, domain: '127.0.0.1', path: '/',
    expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
  }],
  origins: [],
});

before(async () => {
  portal = await start();
  scratch = mkdtempSync(join(tmpdir(), 'taxme-browser-'));
  const state = join(scratch, 'state.json');
  writeFileSync(state, seededState(portal.SESSION));
  srv = await startServer({
    TAXME_BASE_URL: portal.base,
    TAXME_STATE: state,
    TAXME_PROFILE: join(scratch, 'profile'),
  }, { timeout: 240000 });
});
after(async () => {
  await srv?.stop();
  await portal?.close();
  // The browser may still be flushing its profile as it goes down.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('session detection', () => {
  test('a seeded session is recognised as live', SLOW, async () => {
    const { data } = await srv.call('taxme_status');
    assert.equal(data.status, 'ok');
    assert.equal(portal.state.logins, 0, 'no login was needed — the cached session was reused');
  });

  test('"Angemeldet als: Benutzer" is a logged-out page, however normal it looks', SLOW, async () => {
    await portal.control({ anonymous: true });
    const { data } = await srv.call('taxme_status');
    assert.equal(data.status, 'login_required', 'a 200 with no real user must not count as a session');
    await portal.control({ anonymous: false });
  });

  test('no menu on the page is not a return that has no sections', SLOW, async () => {
    // Nothing has been opened yet, so the browser is on the case list. The menu
    // is on every page of the return and on no other page — three findings here
    // rest on that — so an empty menu means we are not on the return at all:
    // the session died, the tab was navigated away, nothing was ever opened.
    // Handing back an empty list reads as "your return has nothing in it",
    // which is the same empty answer read off a page that was never asked the
    // question that the Kontoauszug had to be fixed for.
    const { data } = await srv.call('taxme_menu');
    assert.equal(data.menu, undefined,
      `a page with no return on it came back as a return with no sections: ${JSON.stringify(data)}`);
    assert.match(data.error ?? '', /kein Menü/);
    assert.ok(data.url, 'and it says where the browser actually is');
  });

  test('and neither is a section nobody can find on a page that has no menu', SLOW, async () => {
    // The tool beside taxme_menu, reading the same menu off the same page.
    // With nothing open, asking for a section answered "Menüpunkt … nicht
    // gefunden" over an empty list of sections — which reads as this return
    // not having one, while the browser is on the case list or, when a session
    // dies, on the AGOV login form. taxme_menu was taught the difference and
    // this was not.
    const { data } = await srv.call('taxme_goto_section', { name: 'Personalien' });
    assert.match(data.error ?? '', /kein Menü/,
      `a page with no return on it was answered as a return without that section: ${JSON.stringify(data)}`);
    assert.ok(data.url, 'and it says where the browser actually is');

    // The other two that look a section up in this menu, and gave the same
    // wrong diagnosis of the same page. Neither of them clicks anything here:
    // the entry is not on the page, so both return before they act.
    const results = await srv.call('taxme_results');
    assert.match(results.data.error ?? '', /kein Menü/, JSON.stringify(results.data));
    const submit = await srv.call('taxme_submit_return');
    assert.match(submit.data.error ?? '', /kein Menü/, JSON.stringify(submit.data));
    assert.equal(submit.data.submitted, false, 'and it still says plainly that nothing was submitted');
    assert.deepEqual(portal.state.submitted, [], 'nothing may reach the portal from here');
    assert.deepEqual(portal.state.clicks, [], 'and nothing may be clicked');
  });
});

describe('browser choice', () => {
  test('TAXME_BROWSER=chromium uses the bundled build rather than a system browser', SLOW, async () => {
    // The default prefers a signed system browser for the passkey; asking for
    // chromium explicitly has to resolve to Playwright's own download.
    const own = await startServer({
      TAXME_BASE_URL: portal.base, TAXME_BROWSER: 'chromium',
      TAXME_STATE: join(scratch, 'chromium-state.json'), TAXME_PROFILE: join(scratch, 'chromium-profile'),
    }, { timeout: 240000 });
    const { data, isError } = await own.call('taxme_status');
    await own.stop();
    assert.equal(isError, false, `bundled chromium did not start: ${JSON.stringify(data)}`);
    assert.equal(data.status, 'login_required', 'a fresh profile with no state is logged out');
  });
});

describe('reading', () => {
  test('reads the open amounts per year, keeping the years apart', SLOW, async () => {
    const { data } = await srv.call('taxme_account_statement');
    assert.equal(data.status, 'ok');
    // Year keys come back numerically ordered, because they are integer-like
    // object keys — the page order is not preserved and does not matter.
    assert.deepEqual(Object.keys(data.open_amounts_chf).sort(), ['2024', '2025']);
    assert.equal(data.open_amounts_chf['2025'].kantons_gemeinde, "1'234.55",
      'the typographic apostrophe the portal serves is normalised');
    assert.equal(data.open_amounts_chf['2025'].bund, '210.00');
    assert.equal(data.open_amounts_chf['2024'].kantons_gemeinde, '0.00',
      'the trailing "Aktuelle Jahre" block must not be counted as 2024');
  });

  test('a due date is not a year heading', SLOW, async () => {
    // The 2024 assessment falls due on 30.09.2025. Starting a new year block
    // wherever four digits appear handed 2024's zeroes to 2025 and dropped 2024
    // — the statement then said the 2025 bill was settled while the page showed
    // 1'234.55 still open, which is the wrong answer in the direction that
    // costs money.
    const { data } = await srv.call('taxme_account_statement');
    assert.equal(data.open_amounts_chf['2025'].kantons_gemeinde, "1'234.55",
      `the due date below the 2024 heading moved the amounts: ${JSON.stringify(data.open_amounts_chf)}`);
    assert.ok(data.open_amounts_chf['2024'], 'and 2024 must not disappear into the date above it');
    assert.equal(data.open_amounts_chf['2024'].bund, '0.00');
  });

  test('amounts with no year heading are refused, not reported as nothing owed', SLOW, async () => {
    // An empty result is an answer: it reads as "you owe nothing". A page whose
    // layout we cannot tie to a year has to say so instead.
    await portal.control({ statementInline: true });
    const { data } = await srv.call('taxme_account_statement');
    await portal.control({ statementInline: false });
    assert.notEqual(data.status, 'ok', `reported a clean slate: ${JSON.stringify(data)}`);
    assert.match(data.error, /Jahresüberschrift/);
  });

  test('a page that is not a Kontoauszug is not read as nothing owed', SLOW, async () => {
    // An empty result is an answer, and it reads as "you owe nothing". That was
    // guarded for the one page that carries amounts under no heading — but the
    // parser produces the same empty result for any page at all, and the check
    // that decided the session was live is happy with a 200 that is not a
    // login. The portal answering the Kontoauszug link with a maintenance page
    // therefore came back as status ok and an empty list of open amounts: a
    // clean slate concluded from a page that had never been asked the
    // question, in the direction that costs money.
    await portal.control({ statementBroken: true });
    const { data } = await srv.call('taxme_account_statement');
    await portal.control({ statementBroken: false });
    assert.notEqual(data.status, 'ok',
      `a maintenance page was reported as nothing owed: ${JSON.stringify(data)}`);
    assert.match(data.error ?? '', /Kontoauszug/);

    const back = await srv.call('taxme_account_statement');
    assert.equal(back.data.status, 'ok', 'and the real statement is still read');
    assert.equal(back.data.open_amounts_chf['2025'].kantons_gemeinde, "1'234.55");
  });

  test('lists the returns with their status, and skips the header row', SLOW, async () => {
    // The header says "Steuererklärung" too. A parser that looks for that word
    // rather than for a year reported it as a return with the status "Status".
    const { data } = await srv.call('taxme_list_returns');
    assert.equal(data.status, 'ok');
    assert.deepEqual(data.returns, [
      { fall: 'Steuererklärung 2025', status: 'In Bearbeitung' },
      { fall: 'Steuererklärung 2024', status: 'Eingereicht' },
    ]);
  });

  test('a page that is not the case list is not read as "no returns"', SLOW, async () => {
    // The Kontoauszug was fixed for exactly this and the case list was left as
    // it was, on the tool that gets called first and whose answer decides
    // whether anybody looks any further. `ensure` rules out a redirect to the
    // login and an HTTP error and nothing else, so a maintenance page under the
    // case-list link produced no rows and came back as status ok with no
    // returns — "there is nothing to file", concluded from a page that had
    // never been asked, and a missed deadline is what that one costs.
    await portal.control({ casesBroken: true });
    const { data } = await srv.call('taxme_list_returns');
    await portal.control({ casesBroken: false });
    assert.notEqual(data.status, 'ok',
      `a maintenance page was reported as having no tax returns: ${JSON.stringify(data)}`);
    assert.match(data.error ?? '', /Fallübersicht/);

    const back = await srv.call('taxme_list_returns');
    assert.equal(back.data.status, 'ok', 'and the real list is still read');
    assert.equal(back.data.returns.length, 2);
  });

  test('returns that cannot be tied to a year are refused, not reported as none', SLOW, async () => {
    // The other half of the same fix, as the statement has it: a list that
    // plainly names returns but puts the year somewhere the row parser does not
    // look is a layout we did not understand — not an empty list.
    await portal.control({ casesUnparsable: true });
    const { data } = await srv.call('taxme_list_returns');
    await portal.control({ casesUnparsable: false });
    assert.notEqual(data.status, 'ok', `two visible returns came back as none: ${JSON.stringify(data)}`);
    assert.match(data.error ?? '', /keine liess sich als Zeile/);
  });

  test('a year that cannot be looked up is not reported as a year that is not there', SLOW, async () => {
    // "Steuererklärung 2025 nicht gefunden", with an empty list of what there
    // is as the evidence, over a portal that had served no list at all. The
    // year exists; the page does not.
    await portal.control({ casesBroken: true });
    const { data } = await srv.call('taxme_open_return', { year: 2025 });
    await portal.control({ casesBroken: false });
    assert.equal(data.returns, undefined,
      `it listed the returns it could not read: ${JSON.stringify(data)}`);
    assert.match(data.error ?? '', /Fallübersicht/,
      `the wrong diagnosis of the right refusal: ${JSON.stringify(data)}`);
  });
});

describe('opening a return', () => {
  test('follows the return into the tab it opens, and reads the menu there', SLOW, async () => {
    const { data } = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(data.status, 'ok', `open failed: ${JSON.stringify(data)}`);
    const sections = data.menu.map(m => m.section);
    assert.ok(sections.includes('Personalien') && sections.includes('Abschluss'), `got ${sections}`);
    assert.equal(data.menu.find(m => m.section === 'Wertschriften').status, 'Abgeschlossenes Formular');
    assert.equal(data.menu.find(m => m.section === 'Liegenschaften').status, 'Ausgeschaltet aufgrund Ihrer Eingaben');
  });

  test('a year that does not exist says so, and shows what there is', SLOW, async () => {
    const { data } = await srv.call('taxme_open_return', { year: 2099 });
    assert.match(data.error, /2099 nicht gefunden/);
    assert.equal(data.returns.length, 2, 'it lists the returns that do exist');
  });

  test('the menu is readable from the open return', SLOW, async () => {
    const { data } = await srv.call('taxme_menu');
    assert.equal(data.menu.length, 8);
  });

  test('a section name that is a prefix of another one still lands correctly', SLOW, async () => {
    // "Wertschriftenverzeichnis" comes first in the DOM, and :has-text() matches
    // substrings: the first hit is the wrong page.
    const { data } = await srv.call('taxme_goto_section', { name: 'Wertschriften' });
    assert.equal(data.breadcrumb, 'TaxMe 2025 > Wertschriften',
      `landed on the wrong section: ${data.breadcrumb}`);
  });

  test('the longer name still reaches the longer page', SLOW, async () => {
    const { data } = await srv.call('taxme_goto_section', { name: 'Wertschriftenverzeichnis' });
    assert.equal(data.breadcrumb, 'TaxMe 2025 > Wertschriftenverzeichnis');
  });

  test('a refusal that leaves you on the longer page is still a refusal', SLOW, async () => {
    // The landing check asked whether the breadcrumb CONTAINED the name that
    // had been clicked, and this menu is full of names that nest — the pair
    // `byText` needed an exact match for in the first place. So the portal
    // refusing to open Wertschriften and leaving the browser on
    // Wertschriftenverzeichnis answered "yes, the breadcrumb says
    // Wertschriften", and that page's seventy boxes came back as the fields of
    // a section that was never opened, under the name that was asked for: the
    // very failure the check exists to stop, on the one menu pair this fixture
    // was built around. We are on Wertschriftenverzeichnis from the test above.
    await portal.control({ wertschriftenBlocked: true });
    const blocked = await srv.call('taxme_goto_section', { name: 'Wertschriften' });
    await portal.control({ wertschriftenBlocked: false });
    // The way back first, so a failure here fails alone instead of stranding
    // the rest of the file on a page it does not expect.
    const back = await srv.call('taxme_goto_section', { name: 'Wertschriften' });
    assert.equal(blocked.data.fields, undefined,
      `the longer page's fields came back as Wertschriften: ${JSON.stringify(blocked.data).slice(0, 300)}`);
    assert.match(blocked.data.error ?? '', /nicht geöffnet/);
    assert.equal(blocked.data.breadcrumb, 'TaxMe 2025 > Wertschriftenverzeichnis',
      'and where the browser really is');
    assert.equal(back.data.section, 'Wertschriften', `and it still opens: ${JSON.stringify(back.data).slice(0, 200)}`);
    assert.equal(back.data.error, undefined);
  });

  test('a breadcrumb that shortens the label, or names no section, is not a refusal', SLOW, async () => {
    // The other half, and the one the previous version's commit message
    // claimed outright: "a portal that shortens a label in its breadcrumb
    // cannot turn a working navigation into a refusal". It could, because the
    // short forms of this portal are menu entries in their own right — the
    // breadcrumb of Wertschriftenverzeichnis reading "Wertschriften" named a
    // different entry of the very same menu, and the check refused a
    // navigation that had worked. Refusing what worked is the worse failure of
    // the two, by that message's own reckoning.
    await portal.control({ crumbLabel: 'Wertschriften' });
    const short = await srv.call('taxme_goto_section', { name: 'Wertschriftenverzeichnis' });
    // And a breadcrumb naming no entry of this menu settles nothing at all, so
    // nothing is claimed from it either way.
    await portal.control({ crumbLabel: 'Übersicht' });
    const none = await srv.call('taxme_goto_section', { name: 'Wertschriftenverzeichnis' });
    // Both flips undone before a word is asserted, or a failure here leaves
    // every later test reading a breadcrumb the portal does not really write.
    await portal.control({ crumbLabel: null });
    assert.equal(short.data.error, undefined,
      `a working navigation was refused over a shortened breadcrumb: ${JSON.stringify(short.data).slice(0, 300)}`);
    assert.ok(short.data.total > 60, 'and it is the long page, so the navigation really did happen');
    assert.equal(none.data.error, undefined, JSON.stringify(none.data).slice(0, 300));
    assert.ok(none.data.total > 60);
  });

  test('a breadcrumb that names the way you came is read to its end', SLOW, async () => {
    // The check that replaced the substring test asked for the LONGEST menu
    // entry the breadcrumb contains anywhere, which reads a path as a bag of
    // words. A breadcrumb IS a path — that is what the "TaxMe 2025 >" in front
    // of every one of them is — and a portal that names the section you came
    // through as well as the one you are on hands this two entries to choose
    // between. It chose the longer, which on any path is likelier to be the
    // ancestor than the page: Einkünfte opened perfectly well, and the tool
    // answered that the portal was still showing another page and had changed
    // nothing. Refusing a navigation that worked is the worse failure of the
    // two, by the same check's own reckoning.
    await portal.control({ crumbLabel: 'Wertschriftenverzeichnis > Einkünfte' });
    const path = await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    // Undone before a word is asserted, or a failure here leaves every later
    // test reading a breadcrumb the portal does not really write.
    await portal.control({ crumbLabel: null });
    assert.equal(path.data.error, undefined,
      `a navigation that worked was refused over the path it took: ${JSON.stringify(path.data).slice(0, 300)}`);
    assert.ok(path.data.fields?.some(f => f.id === 'form:eink:0:betrag'),
      `and it really is the Einkünfte page: ${JSON.stringify(path.data).slice(0, 300)}`);
  });

  test('a section whose name ends with another one still opens', SLOW, async () => {
    // German nests section names at both ends, and this menu only ever carried
    // one of the two: "Wertschriften" at the FRONT of
    // "Wertschriftenverzeichnis". A qualifier goes in front of its noun, so
    // "Einkünfte" is the END of "Übrige Einkünfte" — and the rule that read the
    // breadcrumb as a line and took the LAST entry named in it therefore picked
    // the shorter, nested name off the breadcrumb of the longer page. A click
    // on "Übrige Einkünfte" that the portal had opened perfectly well came back
    // as "das Portal hat 'Übrige Einkünfte' nicht geöffnet", with the
    // breadcrumb of that very page printed underneath as the evidence against
    // it. Refusing a navigation that worked is the worse failure of the two, by
    // this check's own reckoning.
    const { data } = await srv.call('taxme_goto_section', { name: 'Übrige Einkünfte' });
    assert.equal(data.error, undefined,
      `a working navigation was refused over the name nested in its own breadcrumb: ${JSON.stringify(data).slice(0, 300)}`);
    assert.equal(data.breadcrumb, 'TaxMe 2025 > Übrige Einkünfte');
    assert.ok(data.fields?.some(f => f.id === 'form:ueb:0:betrag'),
      `and it really is that page: ${JSON.stringify(data).slice(0, 300)}`);
  });

  test('a refusal that leaves you on the longer name is a refusal at either end', SLOW, async () => {
    // The other half of the same inversion, and the dangerous one. The portal
    // refuses to open Einkünfte and leaves the browser on Übrige Einkünfte;
    // the last menu entry named in that breadcrumb is "Einkünfte", sitting at
    // the end of it, so the check answered "yes, that is where we are" and
    // handed the other page's boxes back as `section: "Einkünfte"` — the exact
    // failure it was written to stop, surviving on the mirror image of the pair
    // it was written against. A caller then fills a wage into an Alimente box.
    await portal.control({ einkuenfteBlocked: true });
    const blocked = await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    await portal.control({ einkuenfteBlocked: false });
    // The way back first, so a failure here fails alone instead of stranding
    // the rest of the file on a page it does not expect.
    const back = await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    assert.equal(blocked.data.fields, undefined,
      `the other page's fields came back as Einkünfte: ${JSON.stringify(blocked.data).slice(0, 300)}`);
    assert.match(blocked.data.error ?? '', /nicht geöffnet/);
    assert.equal(blocked.data.breadcrumb, 'TaxMe 2025 > Übrige Einkünfte',
      'and where the browser really is');
    assert.equal(back.data.section, 'Einkünfte', `and it still opens: ${JSON.stringify(back.data).slice(0, 200)}`);
    assert.equal(back.data.error, undefined);
  });

  test('opening a second return moves the tools onto it, not back to the first', SLOW, async () => {
    // The tools used to work on "the first edit tab there is" rather than on the
    // one that was opened. Against this fixture that happens to pick the right
    // tab anyway — this test passes with the tracking removed, so it is not
    // proof of the old bug — but "whichever tab comes first" is not something
    // to leave deciding which tax year gets written to.
    const second = await srv.call('taxme_open_return', { year: 2024 });
    assert.equal(second.data.status, 'ok', JSON.stringify(second.data));
    assert.equal(second.data.year, 2024, 'it says which return it opened');
    const { data } = await srv.call('taxme_goto_section', { name: 'Personalien' });
    assert.match(data.breadcrumb, /TaxMe 2024/, `still on the other return: ${data.breadcrumb}`);

    // Back to 2025 — the rest of this file works on that one.
    const back = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(back.data.year, 2025);
  });

  test('checking the session mid-edit does not navigate the return away', SLOW, async () => {
    // The reading tools used to be handed the edit tab, so a status check in
    // the middle of filling a form took that tab to the case list — unsaved
    // values and all — and every later edit tool then worked on the wrong page.
    await srv.call('taxme_goto_section', { name: 'Personalien' });
    await srv.call('taxme_status');
    await srv.call('taxme_account_statement');
    await srv.call('taxme_list_returns');
    const { data } = await srv.call('taxme_snapshot');
    assert.match(data.breadcrumb, /TaxMe 2025 > Personalien/,
      `the return was navigated away: ${data.breadcrumb}`);
  });

  test('a tab that came back as the login page is not an open return', SLOW, async () => {
    // The session that was good enough to list the returns can be gone by the
    // time the link is clicked. The tool used to report status ok and the year
    // it had been asked for, with an empty menu, while the tab sat on the AGOV
    // login form — and every later edit tool then worked on that form.
    await portal.control({ editLoggedOut: true });
    const { data } = await srv.call('taxme_open_return', { year: 2025 });
    await portal.control({ editLoggedOut: false });
    assert.notEqual(data.status, 'ok', `claimed the return was open: ${JSON.stringify(data)}`);
    assert.equal(data.status, 'login_required', JSON.stringify(data));
    assert.match(data.error, /taxme_login/);

    const back = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(back.data.status, 'ok', JSON.stringify(back.data));
  });

  test('a maintenance page is not a return either, and is not called a login', SLOW, async () => {
    await portal.control({ editBroken: true });
    const { data } = await srv.call('taxme_open_return', { year: 2025 });
    await portal.control({ editBroken: false });
    assert.equal(data.status, 'not_open', JSON.stringify(data));
    assert.match(data.error, /liess sich nicht öffnen/);

    const back = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(back.data.status, 'ok', JSON.stringify(back.data));
  });

  test('a portal that opens a different case says so instead of renaming it', SLOW, async () => {
    // Reporting the requested year while the page shows another one puts every
    // later fill into the wrong tax return under the right heading.
    await portal.control({ forceYear: '2024' });
    const { data } = await srv.call('taxme_open_return', { year: 2025 });
    await portal.control({ forceYear: null });
    assert.equal(data.status, 'wrong_year', `2024 was opened and reported as 2025: ${JSON.stringify(data)}`);
    assert.equal(data.opened_year, 2024);

    const back = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(back.data.status, 'ok', JSON.stringify(back.data));
    assert.match(back.data.breadcrumb, /TaxMe 2025/, 'and it reports what the page says, not what it was asked');
  });

  test('a page with no year in its breadcrumb is checked all the same', SLOW, async () => {
    // The year check read the breadcrumb and nothing else. A half-finished
    // return comes back up where it was left, and the Abschluss page prints no
    // "TaxMe 2025 >" line — so on exactly that page the check found nothing to
    // compare, skipped itself, and echoed the year that had been asked for back
    // as though the page had confirmed it. The wrong case reported under the
    // right heading is the one mistake this tool exists to prevent.
    await portal.control({ landOn: 'abschluss', forceYear: '2024' });
    const { data } = await srv.call('taxme_open_return', { year: 2025 });
    await portal.control({ landOn: null, forceYear: null });
    assert.equal(data.status, 'wrong_year',
      `2024 was opened and reported as 2025: ${JSON.stringify(data).slice(0, 200)}`);
    assert.equal(data.opened_year, 2024);

    const back = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(back.data.status, 'ok', JSON.stringify(back.data));
    assert.equal(back.data.year, 2025);
  });

  test('a section that does not exist reports the menu instead of guessing', SLOW, async () => {
    const { data } = await srv.call('taxme_goto_section', { name: 'Kryptowährungen' });
    assert.match(data.error, /nicht gefunden/);
    assert.equal(data.menu.length, 8);
  });

  test('a section the portal refused to open is not handed back as that section', SLOW, async () => {
    // TaxMe refuses to open a section while the form still has errors: the
    // click arrives, the section you were on comes back with a banner, and this
    // tool returned that page's fields as "the fields on that page" — the tool
    // description and the README both say "its fields". Asking for Abschluss
    // here came back with the Einkünfte page's Bruttolohn box, no error and
    // nothing to suggest the navigation had not happened, and a caller then
    // fills the number it meant to fill into another section's form.
    // taxme_results and taxme_submit_return were each taught to check exactly
    // this, one round apart; the tool whose whole job is opening a section
    // still believed its own click.
    await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    await portal.control({ abschlussBlocked: true });
    const blocked = await srv.call('taxme_goto_section', { name: 'Abschluss' });
    await portal.control({ abschlussBlocked: false });
    assert.equal(blocked.data.fields, undefined,
      `another section's fields came back as Abschluss: ${JSON.stringify(blocked.data).slice(0, 300)}`);
    assert.match(blocked.data.error ?? '', /nicht geöffnet/);
    assert.match(blocked.data.breadcrumb ?? '', /Einkünfte/, 'and where the browser really is');

    const back = await srv.call('taxme_goto_section', { name: 'Abschluss' });
    assert.equal(back.data.section, 'Abschluss', `and it still opens: ${JSON.stringify(back.data).slice(0, 200)}`);
    assert.equal(back.data.error, undefined);
  });

  test('a click that lands on the login form is not the section that was asked for', SLOW, async () => {
    // The session that was good enough to open the return can be gone by the
    // time the next menu entry is clicked: the link goes to the edit view, the
    // portal bounces it to AGOV, and a login form has no breadcrumb. The
    // landing check read the breadcrumb and nothing else, and an empty
    // breadcrumb "settles nothing" — so it stood down, and the AGOV form's own
    // user name and password boxes came back as `section: "Personalien"` with
    // no error at all. The menu settles it completely and was right there,
    // already read: taxme_menu refuses this very page.
    await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    await portal.control({ editLoggedOut: true });
    const gone = await srv.call('taxme_goto_section', { name: 'Personalien' });
    const asMenu = await srv.call('taxme_menu');
    await portal.control({ editLoggedOut: false });
    // Back onto the return before asserting: this test leaves the edit tab on
    // the login form, and a failure here would otherwise hand every later test
    // in the file a page with no tax return on it.
    const back = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(gone.data.fields, undefined,
      `the login form came back as a section of the return: ${JSON.stringify(gone.data).slice(0, 300)}`);
    assert.match(gone.data.error ?? '', /kein Menü/);
    assert.match(asMenu.data.error ?? '', /kein Menü/,
      'the two tools have to say the same thing about the same page');
    assert.equal(back.data.status, 'ok', JSON.stringify(back.data));
  });
});

describe('filling the form', () => {
  test('an item without a value is refused before the browser is touched', SLOW, async () => {
    // It used to reach the fill and write the literal string "undefined" into
    // the field — a malformed request quietly corrupting a draft.
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Beruf' }] });
    assert.match(data.error, /values\[0\]/);
    assert.match(data.error, /value/);
  });

  for (const value of [null, {}, [], ['Koch']]) {
    test(`a value of ${JSON.stringify(value)} is refused, not typed out`, SLOW, async () => {
      // Only the `undefined` spelling was caught. null was typed in as the word
      // "null", an object as "[object Object]" and an empty array wiped the
      // field — each reported as a successful fill, each a draft quietly
      // corrupted by a malformed request.
      const { data } = await srv.call('taxme_fill', { values: [{ target: 'form:pers:beruf', value }] });
      assert.match(data.error ?? '', /values\[0\]/, `it was accepted: ${JSON.stringify(data).slice(0, 200)}`);
      assert.equal(data.results, undefined, 'nothing was filled');
    });
  }

  before(async () => { await srv.call('taxme_goto_section', { name: 'Personalien' }); });

  test('lists the fields with their JSF ids, labels and row context', SLOW, async () => {
    const { data } = await srv.call('taxme_get_fields');
    const ids = data.fields.map(f => f.id);
    assert.ok(ids.includes('form:pers:zivilstand:0'), `got ${ids}`);
    assert.ok(ids.includes('form:pers:gemeinde'));
    assert.ok(!ids.includes('javax.faces.ViewState'), 'hidden fields stay out of the field list');
    const beruf = data.fields.find(f => f.id === 'form:pers:beruf');
    assert.equal(beruf.context, 'Beruf');
  });

  test('sets a radio whose input is invisible, through its label', SLOW, async () => {
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Zivilstand', value: 'verheiratet' }] });
    assert.equal(data.results[0].ok, true, JSON.stringify(data.results[0]));
    assert.equal(data.results[0].set, 'form:pers:zivilstand:1');
    const after = data.fields_after.find(f => f.id === 'form:pers:zivilstand:1');
    assert.equal(after.value, 'checked:verheiratet');
    assert.ok(portal.state.events.includes('zivilstand=verheiratet'),
      'the widget only commits on a change event — it never fired');
  });

  test('sets a radio that has no label and swallows the click', SLOW, async () => {
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Konfession', value: 'kath' }] });
    assert.equal(data.results[0].set, 'form:pers:konf:1');
    assert.equal(data.fields_after.find(f => f.id === 'form:pers:konf:1').value, 'checked:kath');
    assert.ok(portal.state.events.includes('konfession=kath'),
      'without a dispatched change the portal never learns about the choice');
  });

  test('ticks and unticks a checkbox, and does nothing when it is already right', SLOW, async () => {
    const on = await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: true }] });
    assert.equal(on.data.results[0].checkbox, true);
    assert.equal(on.data.fields_after.find(f => f.id === 'form:pers:kirche').value, 'checked:ja');

    const again = await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: 'true' }] });
    assert.equal(again.data.fields_after.find(f => f.id === 'form:pers:kirche').value, 'checked:ja');

    const off = await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: false }] });
    assert.equal(off.data.results[0].checkbox, false);
    assert.equal(off.data.fields_after.find(f => f.id === 'form:pers:kirche').value, 'unchecked:ja');
  });

  test('"ja" ticks the box it is the value of, rather than clearing it', SLOW, async () => {
    // taxme_get_fields shows this box as "unchecked:ja", so "ja" is the obvious
    // thing to send back. Only true / "true" / "checked" / 1 counted as ticked
    // and everything else silently meant cleared — the box stayed empty, the
    // reply said checkbox:false and ok:true, and church tax liability was
    // recorded as "no" while the request had said yes.
    for (const value of ['ja', 'yes', '1', 'x']) {
      const off = await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: false }] });
      assert.equal(off.data.fields_after.find(f => f.id === 'form:pers:kirche').value, 'unchecked:ja');
      const on = await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value }] });
      assert.equal(on.data.results[0].ok, true, `${JSON.stringify(value)}: ${JSON.stringify(on.data.results[0])}`);
      assert.equal(on.data.fields_after.find(f => f.id === 'form:pers:kirche').value, 'checked:ja',
        `${JSON.stringify(value)} left the box empty and called it done`);
    }
  });

  test('a word that is neither yes nor no is refused, not read as no', SLOW, async () => {
    await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: true }] });
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: 'vielleicht' }] });
    assert.equal(data.results[0].ok, false, JSON.stringify(data.results[0]));
    assert.ok(data.results[0].accepts?.ja?.includes('ja'), `it says what it takes: ${JSON.stringify(data.results[0])}`);
    assert.equal(data.fields_after.find(f => f.id === 'form:pers:kirche').value, 'checked:ja',
      'and it left the box as it found it');
    await srv.call('taxme_fill', { values: [{ target: 'Kirchensteuerpflichtig', value: false }] });
  });

  test('a checkbox the portal has switched off is refused, not forced', SLOW, async () => {
    // It has no label, so this is the JavaScript fallback: it set `checked` on
    // a disabled input, dispatched the change and reported the box as ticked.
    // The browser never submits a disabled input, so the portal heard nothing —
    // an answer reported as given that was never given.
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'form:pers:kinderabzug', value: true }] });
    assert.equal(data.results[0].ok, false, `claimed a disabled box was ticked: ${JSON.stringify(data.results[0])}`);
    assert.equal(data.results[0].locked, 'disabled');
    assert.equal(data.fields_after.find(f => f.id === 'form:pers:kinderabzug').value, 'unchecked:ja',
      'and it really is still empty');
  });

  test('unticks a checkbox that has no label — the widget the fallback is for', SLOW, async () => {
    // Kirchensteuerpflichtig has a <label>, so it is set by clicking that. The
    // JSF widgets this server was written for do not, and that fallback ended
    // with `checked = true` whatever it had been asked to do: unticking clicked
    // the box off and forced it straight back on, then reported success. On a
    // tax return that is the answer inverted, reported as done.
    const off = await srv.call('taxme_fill', { values: [{ target: 'form:pers:nebenerwerb', value: false }] });
    assert.equal(off.data.results[0].ok, true, JSON.stringify(off.data.results[0]));
    assert.equal(off.data.results[0].checkbox, false);
    assert.equal(off.data.fields_after.find(f => f.id === 'form:pers:nebenerwerb').value, 'unchecked:ja',
      'the box must actually be empty, not merely reported as empty');

    const on = await srv.call('taxme_fill', { values: [{ target: 'form:pers:nebenerwerb', value: true }] });
    assert.equal(on.data.fields_after.find(f => f.id === 'form:pers:nebenerwerb').value, 'checked:ja');
  });

  test('two questions in one table row are two groups, not one', SLOW, async () => {
    // A joint return puts the same question to both spouses side by side in a
    // single table row, so the two groups share every scrap of surrounding
    // text. Grouping radios by that text ran them together and then picked the
    // first member with the wanted value — answering for whichever spouse came
    // first in the DOM, even here, where the other one is named by its exact
    // id. On a tax return that is a deduction claimed for the wrong person.
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'form:pers:kk2:0', value: 'ja' }] });
    assert.equal(data.results[0].ok, true, JSON.stringify(data.results[0]));
    assert.equal(data.results[0].set, 'form:pers:kk2:0', 'it answered for the other spouse');
    assert.equal(data.fields_after.find(f => f.id === 'form:pers:kk2:0').value, 'checked:ja');
    assert.ok(portal.state.events.includes('kk-person2=ja'),
      `person 2 was never answered for: ${portal.state.events}`);
    assert.ok(!portal.state.events.includes('kk-person1=ja'),
      `person 1 was answered for instead: ${portal.state.events}`);
  });

  test('the group a radio belongs to is reported, so the two can be told apart', SLOW, async () => {
    // Without the name there is nothing in the listing that separates the two
    // spouses' buttons: same row, same context, and ids a caller has no reason
    // to read structure into.
    const { data } = await srv.call('taxme_get_fields');
    const p1 = data.fields.find(f => f.id === 'form:pers:kk1:0');
    const p2 = data.fields.find(f => f.id === 'form:pers:kk2:0');
    assert.equal(p1.name, 'kk1');
    assert.equal(p2.name, 'kk2');
    assert.equal(p1.context, p2.context, 'the fixture is supposed to put them in one row');
  });

  test('an unknown radio value is refused, with the options that do exist', SLOW, async () => {
    // It used to fall back to whichever radio the lookup landed on and return
    // ok:true — a civil status silently set to something nobody asked for.
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'zivilstand', value: 'geschieden' }] });
    const r = data.results[0];
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /geschieden/);
    assert.ok(r.options?.some(o => o.value === 'ledig'), `it lists what is on offer: ${JSON.stringify(r.options)}`);
  });

  test('an empty value does not quietly pick the first option of a group', SLOW, async () => {
    // The JSF widgets on this portal carry no <label for> — that is the whole
    // reason the fill has a JavaScript fallback at all — so every one of their
    // radios is reported with label:"". The option was matched against that
    // label, so an empty value matched the first button of the group and set
    // it: Konfession answered as evangelisch-reformiert, the change event
    // fired at the portal, and ok:true reported back. On a tax return a
    // confession decides a church tax, and nobody had asked for one.
    const before = portal.state.events.length;
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Konfession', value: '' }] });
    assert.equal(data.results[0].ok, false, `it answered for the taxpayer: ${JSON.stringify(data.results[0])}`);
    assert.ok(data.results[0].options?.some(o => o.value === 'ref'),
      `and it says what is on offer: ${JSON.stringify(data.results[0])}`);
    assert.deepEqual(portal.state.events.slice(before), [], 'the portal was told about a choice nobody made');
    assert.equal(data.fields_after.find(f => f.id === 'form:pers:konf:1').value, 'checked:kath',
      'and it left the group as it found it');
  });

  test('a radio the portal hands back unanswered is not reported as set', SLOW, async () => {
    // The radio was the only kind of field here that claimed success without
    // looking. The checkbox reads back because an inverted answer once got
    // through, the text box because the whole-franc converter alters what it is
    // given, the dropdown because a readback that fails is no proof — and the
    // radio returned ok:true on the strength of having called setChoice. A JSF
    // group is re-rendered by the server when it hears the change, and this one
    // comes back with nothing selected: the reply said the option was chosen
    // while the widget was empty, and on a tax return a radio decides a civil
    // status, a confession, which spouse claims a deduction.
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Vorsorge', value: 'saeule3a' }] });
    assert.equal(data.results[0].ok, false,
      `an answer that did not stick was reported as given: ${JSON.stringify(data.results[0])}`);
    assert.match(data.results[0].error, /nicht übernommen|nicht bestätigen/);
    assert.equal(data.fields_after.find(f => f.id === 'form:pers:vs:0').value, 'unchecked:saeule3a',
      'the fixture is supposed to drop the answer — otherwise this proves nothing');
  });

  test('picks a dropdown option by value and by visible label', SLOW, async () => {
    const byValue = await srv.call('taxme_fill', { values: [{ target: 'Gemeinde', value: '351' }] });
    assert.equal(byValue.data.results[0].ok, true, JSON.stringify(byValue.data.results[0]));
    assert.equal(byValue.data.results[0].value, '351', JSON.stringify(byValue.data.results[0]));
    const byLabel = await srv.call('taxme_fill', { values: [{ target: 'Gemeinde', value: 'Köniz' }] });
    assert.equal(byLabel.data.results[0].ok, true, JSON.stringify(byLabel.data.results[0]));
    assert.equal(byLabel.data.results[0].value, '371');
  });

  test('an option a dropdown does not have is refused with the ones it does', SLOW, async () => {
    // The radio group answers this in half a second and names what is on
    // offer. The dropdown handed the value to Playwright as an option value
    // and then, when that failed, as a visible label — and for selectOption
    // "failed" means waiting out the default timeout for an option that will
    // never appear. Sixty seconds for a value the list does not have, and a
    // raw Playwright call log where the radio has a sentence; thirty of those
    // seconds for an option named by the text on it, which taxme_get_fields
    // shows and taxme_fill invites, and which then worked. taxme_fill goes
    // through its batch one item at a time, so a few of these outlast the
    // client's own request timeout while the browser is still being driven.
    const started = Date.now();
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Gemeinde', value: 'Thun' }] });
    assert.equal(data.results[0].ok, false, JSON.stringify(data.results[0]).slice(0, 300));
    assert.match(data.results[0].error, /gibt es in dieser Liste nicht/,
      `a Playwright timeout came back as the answer: ${JSON.stringify(data.results[0]).slice(0, 300)}`);
    assert.ok(data.results[0].options?.some(o => o.label === 'Köniz'),
      `and it says what is on offer: ${JSON.stringify(data.results[0]).slice(0, 300)}`);
    // Twenty seconds is far under the two timeouts this used to sit through
    // and far over anything the fixture needs, so it fails on the wait and not
    // on a loaded machine.
    assert.ok(Date.now() - started < 20000, `it waited ${Date.now() - started} ms out for an option that is not there`);
  });

  test('a dropdown the portal hands back unchanged is not reported as chosen', SLOW, async () => {
    // The radio above was called the last fill path that claimed success
    // without looking, and the round that fixed it counted checkbox, text and
    // select as the three that "each read back". The select read back and
    // never compared: only a readback that THREW was a failure, and whatever
    // the widget returned went into the reply's own `value` field beside
    // ok:true, where it reads as the portal confirming the choice rather than
    // contradicting it. A JSF select is re-rendered by the server exactly as a
    // JSF radio group is, and this one comes back the way it was — the option
    // was picked, the change fired, the box is empty again — so the answer was
    // "ok:true, value: ''", which is a tariff nobody chose reported as chosen.
    const byValue = await srv.call('taxme_fill', { values: [{ target: 'Quellensteuertarif', value: 'A0' }] });
    assert.equal(byValue.data.fields_after.find(f => f.id === 'form:pers:tarif').value, '',
      'the fixture is supposed to drop the choice — otherwise this proves nothing');
    assert.equal(byValue.data.results[0].ok, false,
      `a choice that did not stick was reported as made: ${JSON.stringify(byValue.data.results[0])}`);
    assert.match(byValue.data.results[0].error, /blieb nicht stehen/);
    // And the same the other way in, because a caller may name the option by
    // the text on it and must not be failed for that instead.
    const byLabel = await srv.call('taxme_fill', { values: [{ target: 'Quellensteuertarif', value: 'Tarif B1' }] });
    assert.equal(byLabel.data.results[0].ok, false,
      `${JSON.stringify(byLabel.data.results[0])}`);
    assert.match(byLabel.data.results[0].error, /blieb nicht stehen/);
  });

  test('types into a text field addressed by its id', SLOW, async () => {
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'form:pers:beruf', value: 'Lokführer' }] });
    assert.equal(data.results[0].filled, 'form:pers:beruf');
    assert.equal(data.results[0].value, 'Lokführer');
    assert.equal(data.results[0].warning, undefined);
  });

  test('a field that does not exist fails alone, without losing the rest of the batch', SLOW, async () => {
    const { data } = await srv.call('taxme_fill', {
      values: [{ target: 'Gibt es nicht', value: 'x' }, { target: 'form:pers:beruf', value: 'Gärtnerin' }],
    });
    assert.equal(data.results[0].ok, false);
    assert.match(data.results[0].error, /nicht gefunden/);
    assert.equal(data.results[1].value, 'Gärtnerin', 'the second field was still filled');
  });

  test('an amount that loses its centimes is reported, not silently accepted', SLOW, async () => {
    await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    const { data } = await srv.call('taxme_fill', { values: [{ target: 'Bruttolohn', value: '84350.75' }] });
    assert.equal(data.results[0].value, '84350', `the portal drops the centimes: ${JSON.stringify(data.results[0])}`);
    assert.match(data.results[0].warning, /ganzen Franken/);

    const whole = await srv.call('taxme_fill', { values: [{ target: 'Bruttolohn', value: '84350' }] });
    assert.equal(whole.data.results[0].warning, undefined, 'a whole-franc amount is not flagged');
  });
});

describe('clicking', () => {
  test('clicks the button whose label matches exactly, not the longer one', SLOW, async () => {
    const before = portal.state.clicks.length;
    const { data } = await srv.call('taxme_click', { label: 'Speichern' });
    assert.equal(data.clicked, 'Speichern');
    assert.deepEqual(portal.state.clicks.slice(before), ['Speichern'],
      '"Speichern und schliessen" comes first in the DOM and must not win');
  });

  test('clicks a <button> as readily as a submit input', SLOW, async () => {
    const before = portal.state.clicks.length;
    await srv.call('taxme_click', { label: 'Nächste Seite' });
    assert.deepEqual(portal.state.clicks.slice(before), ['Nächste Seite']);
  });

  test('names the button it really pressed when only a longer one exists', SLOW, async () => {
    // On this page the only save button reads "Speichern und schliessen", and
    // the substring fallback presses it. The reply used to echo the label it
    // had been given, so a form that had been saved AND closed came back as
    // "Speichern" — and the next tool worked on a page that was gone.
    await srv.call('taxme_goto_section', { name: 'Wertschriftenverzeichnis' });
    const before = portal.state.clicks.length;
    const { data } = await srv.call('taxme_click', { label: 'Speichern' });
    assert.deepEqual(portal.state.clicks.slice(before), ['Speichern und schliessen'],
      'the fixture must have received the long button — otherwise this proves nothing');
    assert.equal(data.clicked, 'Speichern und schliessen', `it reported a click it did not make: ${JSON.stringify(data.clicked)}`);
    assert.equal(data.requested, 'Speichern', 'and says what had been asked for');
    await srv.call('taxme_goto_section', { name: 'Einkünfte' });
    // Asserted after the way back, so a failure here does not strand the rest
    // of the file on a page it does not expect.
    assert.ok(data.truncated > 0, `this page has more boxes than fit, and the reply has to say so: ${JSON.stringify(Object.keys(data))}`);
  });

  test('follows a link that changes the url, and says that it did', SLOW, async () => {
    const { data } = await srv.call('taxme_click', { label: 'Neuen Eintrag erfassen' });
    assert.equal(data.url_changed, true);
    assert.ok(data.fields.some(f => f.id === 'form:eink:0:betrag'), 'the new row is there');
  });

  test('a label nothing matches is an error, not a random click', SLOW, async () => {
    const before = portal.state.clicks.length;
    const { raw, isError } = await srv.call('taxme_click', { label: 'Alles löschen' });
    assert.equal(isError, true);
    assert.match(raw, /kein klickbares Element/);
    assert.equal(portal.state.clicks.length, before, 'nothing was clicked');
  });

  test('a label that names nothing is not a licence to press the first thing there is', SLOW, async () => {
    // The last resort of the lookup is `:has-text("…")`, and `:has-text("")`
    // is true of every element on the page — so an empty or blank label did
    // not match nothing, it matched EVERYTHING, and the first hit was clicked.
    // taxme_click pressed whichever button or link comes first in the DOM and
    // reported it as the one that had been asked for; taxme_goto_section took
    // the open form to the first menu entry — unsaved values and all, which is
    // the very thing readingPage exists to prevent — and came back
    // `section: "Personalien"` with no error at all. taxme_fill has refused a
    // blank target since the round that found it writing "undefined" into a
    // tax return; the two tools that CLICK rather than fill had not been told.
    const where = await srv.call('taxme_snapshot');
    const before = portal.state.clicks.length;
    const blank = await srv.call('taxme_click', { label: '' });
    const spaces = await srv.call('taxme_goto_section', { name: '   ' });
    const after = await srv.call('taxme_snapshot');
    assert.equal(blank.isError, true, `an empty label pressed something: ${blank.raw.slice(0, 300)}`);
    assert.match(spaces.data.error ?? '', /nicht gefunden/,
      `a blank name opened a section nobody named: ${JSON.stringify(spaces.data).slice(0, 300)}`);
    assert.equal(spaces.data.fields, undefined, 'and hands back no page as that section');
    assert.equal(portal.state.clicks.length, before, 'nothing was clicked');
    assert.equal(after.data.breadcrumb, where.data.breadcrumb,
      `the browser was navigated away on an argument that named nothing: ${after.data.breadcrumb}`);
  });
});

describe('snapshot and results', () => {
  test('reports the breadcrumb, and writes a screenshot when asked', SLOW, async () => {
    const { data } = await srv.call('taxme_snapshot', { screenshot: true });
    assert.match(data.breadcrumb, /^TaxMe 2025 > /);
    assert.ok(data.url.startsWith(portal.base));
    assert.ok(existsSync(data.screenshot), `no screenshot at ${data.screenshot}`);
    rmSync(data.screenshot, { force: true });
  });

  test('reads the tax calculation, not the menu entry above it', SLOW, async () => {
    // "Ergebnisse" is also a navigation item, and it comes first in the DOM.
    // The fixture puts enough prose between the two that a slice taken from
    // the first occurrence runs out before the figures.
    const { data } = await srv.call('taxme_results');
    assert.ok(data.text, `no calculation came back: ${JSON.stringify(data).slice(0, 160)}`);
    assert.match(data.text, /Steuerbetrag Kanton und Gemeinde/);
    // Exactly one separator, not "either or neither": 4321.00 is a different
    // number badly formatted, and the assertion used to accept it.
    assert.match(data.text, /4['’]321\.00/);
    assert.ok(!/Formular in Bearbeitung/.test(data.text), 'it returned the menu instead');
  });

  test('a page that says there is no calculation is not read as one', SLOW, async () => {
    // Requiring any digit let "Für Steuerjahr 2025 ist keine Berechnung
    // verfügbar" through, because a year is a digit — so the check was
    // tightened to require an amount. A date is shaped like an amount: it ends
    // in a dot and two digits exactly as 4'321.00 does, and this portal stamps
    // one on every page it serves. The sentence the check was written for came
    // straight back through the new one.
    await portal.control({ noCalculation: true });
    const { data } = await srv.call('taxme_results');
    await portal.control({ noCalculation: false });
    assert.match(data.error ?? '', /keine Berechnung/,
      `a date was read as a tax bill: ${JSON.stringify(data).slice(0, 240)}`);
    assert.match(data.text, /keine Berechnung verfügbar/, 'and it shows what the page actually said');
  });

  test('the calculation is still read when there is one, dates and all', SLOW, async () => {
    // The other half: stripping the dates must not take the amounts with them.
    const { data } = await srv.call('taxme_results');
    assert.match(data.text ?? '', /4['’]321\.00/, `a real calculation was refused: ${JSON.stringify(data).slice(0, 240)}`);
  });

  test('a page the portal never left is not the Ergebnisse page', SLOW, async () => {
    // "Ergebnisse" is a left-menu entry, and the menu is on every page of the
    // return — so testing the page text for the word could not fail, exactly as
    // the same test for "Abschluss" could not. TaxMe refuses to open a section
    // while the form still has errors: the click lands, the overview you were
    // on comes back with a banner, and this then sliced from the menu entry
    // and handed that page back as the tax calculation. An overview page totals
    // things up, so the amount the check insists on was there too — the
    // portal's own error banner came back inside the "calculation".
    //
    // Telling the menu entry from a heading fixed that only for as long as no
    // page but the results page ever writes the word in its content, and a
    // refusal banner is one word of German away from doing so: a portal that
    // will not compute anything until the form is right says which section it
    // is refusing. The banner then IS the anchor, the overview's own total sits
    // underneath it, and the refusal came back as `text` with no error at all —
    // the failure the anchor rule was written to stop, wearing the sentence
    // that announces it. So the landing is settled first, off the menu and the
    // breadcrumb, exactly as taxme_goto_section settles a click on any other
    // entry of the same menu.
    await portal.control({ ergebnisseBlocked: true });
    const { data } = await srv.call('taxme_results');
    await portal.control({ ergebnisseBlocked: false });
    assert.equal(data.text, undefined,
      `another page was handed back as the calculation: ${JSON.stringify(data).slice(0, 300)}`);
    assert.match(data.error ?? '', /nicht geöffnet|nicht öffnen/,
      `and it has to say the section was never opened: ${JSON.stringify(data).slice(0, 300)}`);
    assert.match(data.breadcrumb ?? '', /Wertschriften/, 'and where the browser actually is');

    const back = await srv.call('taxme_results');
    assert.match(back.data.text ?? '', /4['’]321\.00/, 'and the real calculation is still read');
  });

  test('and neither is one whose breadcrumb the menu does not recognise', SLOW, async () => {
    // The landing check that settles this rests on the breadcrumb naming an
    // entry of the menu, and a breadcrumb naming none settles nothing — which
    // is deliberate, because this portal shortens labels and writes words that
    // are no menu entry at all, and refusing a navigation that worked is the
    // worse failure. So the refusal above is only caught while the portal
    // co-operates by naming, in a breadcrumb, the page it left you on. Give it
    // the same refusal under a breadcrumb reading "Übersicht" and the whole
    // thing came back exactly as before the check existed: the portal's own
    // "die Ergebnisse lassen sich erst danach berechnen" as line one of `text`,
    // the overview page's Total Bruttoertrag underneath it as the tax bill, no
    // error and no breadcrumb to see it by. The anchor is what has to hold
    // here: a heading names its section, and a sentence that mentions the
    // section is not one.
    await portal.control({ ergebnisseBlocked: true, crumbLabel: 'Übersicht' });
    const blind = await srv.call('taxme_results');
    // Both flips undone before a word is asserted, or a failure here leaves
    // every later test reading a page the portal does not really serve.
    await portal.control({ ergebnisseBlocked: false, crumbLabel: null });
    assert.equal(blind.data.text, undefined,
      `a refusal banner came back as the calculation: ${JSON.stringify(blind.data).slice(0, 300)}`);
    assert.match(blind.data.error ?? '', /nicht geöffnet/,
      `and it has to say the section was never opened: ${JSON.stringify(blind.data).slice(0, 300)}`);
    assert.ok(!/1['’]234\.00/.test(JSON.stringify(blind.data)),
      'and the other page\'s total must not be in the answer at all');

    const back = await srv.call('taxme_results');
    assert.match(back.data.text ?? '', /4['’]321\.00/, 'and the real calculation is still read');
  });

  test('nor is one whose refusal happens to put the word first', SLOW, async () => {
    // The same page again, refused the same way under the same unrecognised
    // breadcrumb, with one thing changed: the banner says it the other way
    // round. German lets it — "Ergebnisse lassen sich erst berechnen, wenn die
    // Fehler im Formular korrigiert sind" is the identical refusal to "… die
    // Ergebnisse lassen sich erst danach berechnen" — and the rule that was
    // meant to catch the previous case tells the two apart by nothing but that
    // word order. So the refusal came back as `text` exactly as it did before
    // that rule existed: the portal's own sentence as line one, the overview
    // page's Total Bruttoertrag underneath it as the tax bill, no error and no
    // breadcrumb to see it by. Word order is the portal's phrasing; it is not
    // evidence about which page the browser is standing on.
    await portal.control({ ergebnisseBlocked: true, crumbLabel: 'Übersicht', bannerLeadsWithSection: true });
    const led = await srv.call('taxme_results');
    // Every flip undone before a word is asserted, or a failure here leaves
    // every later test reading a page the portal does not really serve.
    await portal.control({ ergebnisseBlocked: false, crumbLabel: null, bannerLeadsWithSection: false });
    assert.equal(led.data.text, undefined,
      `a refusal came back as the calculation because it began with the word: ${JSON.stringify(led.data).slice(0, 300)}`);
    assert.match(led.data.error ?? '', /nicht geöffnet/,
      `and it has to say the section was never opened: ${JSON.stringify(led.data).slice(0, 300)}`);
    assert.ok(!/1['’]234\.00/.test(JSON.stringify(led.data)),
      'and the other page\'s total must not be in the answer at all');

    const back = await srv.call('taxme_results');
    assert.match(back.data.text ?? '', /4['’]321\.00/, 'and the real calculation is still read');
  });

  test('a click that landed on the login form is not a return with no calculation', SLOW, async () => {
    // The other end of the same click. taxme_goto_section was taught last round
    // that a page carrying no menu is no return at all — the menu entry links
    // to the edit view, a session that died in the meantime gets bounced to
    // AGOV, and that form has neither menu nor breadcrumb. This tool asks the
    // same question of the same page one line further on and asked it smaller:
    // "is the word Ergebnisse anywhere on this page". On the login form it is
    // not, so the answer was "die Seite nach dem Klick enthält keine
    // Ergebnisse" — which is what a return the portal has not computed yet
    // looks like, a real state of this portal with its own message — over an
    // empty breadcrumb and without even the url of where the browser had gone.
    // An empty answer read off a page that was never asked the question.
    await portal.control({ editLoggedOut: true });
    const gone = await srv.call('taxme_results');
    const asMenu = await srv.call('taxme_menu');
    await portal.control({ editLoggedOut: false });
    // Back onto the return before asserting: this test leaves the edit tab on
    // the login form, and a failure here would otherwise hand every later test
    // in the file a page with no tax return on it.
    const reopened = await srv.call('taxme_open_return', { year: 2025 });
    assert.equal(gone.data.text, undefined, JSON.stringify(gone.data).slice(0, 300));
    assert.match(gone.data.error ?? '', /kein Menü/,
      `a dead session came back as a page with no calculation on it: ${JSON.stringify(gone.data).slice(0, 300)}`);
    assert.ok(gone.data.url, 'and it says where the browser actually is');
    assert.match(asMenu.data.error ?? '', /kein Menü/,
      'the two tools have to say the same thing about the same page');
    assert.equal(reopened.data.status, 'ok', JSON.stringify(reopened.data));
  });
});

describe('a form with more boxes than fit in a reply', () => {
  test('the tools that hand the page back say when they cut it, not only get_fields', SLOW, async () => {
    // A Wertschriftenverzeichnis has more than sixty positions, which is the
    // case readFields' own comment is written for. taxme_get_fields was taught
    // to report the cut; goto_section, fill and click went on slicing in
    // silence — and those are the ones a caller reads to check what just
    // happened. Sixty of seventy-one came back looking like the whole form,
    // and fields_after did not hold the box the fill had written to, so a fill
    // that landed read exactly like one that never did.
    const section = await srv.call('taxme_goto_section', { name: 'Wertschriftenverzeichnis' });
    assert.ok(section.data.total > 60,
      `the fixture is supposed to serve a long form here: ${JSON.stringify(section.data).slice(0, 200)}`);
    assert.equal(section.data.truncated, section.data.total - section.data.fields.length);

    const { data } = await srv.call('taxme_fill', { values: [{ target: 'form:wvz:64:betrag', value: '1200' }] });
    assert.equal(data.results[0].filled, 'form:wvz:64:betrag', JSON.stringify(data.results[0]));
    assert.ok(!data.fields_after.some(f => f.id === 'form:wvz:64:betrag'),
      'the box has to sit past the cut, or this proves nothing');
    assert.ok(data.truncated > 0,
      `sixty fields came back as the whole form: ${JSON.stringify(Object.keys(data))}`);
    assert.equal(data.total, section.data.total);
  });
});
