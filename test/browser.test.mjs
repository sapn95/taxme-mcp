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
    assert.equal(data.menu.length, 7);
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
    assert.equal(data.menu.length, 7);
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

  test('picks a dropdown option by value and by visible label', SLOW, async () => {
    const byValue = await srv.call('taxme_fill', { values: [{ target: 'Gemeinde', value: '351' }] });
    assert.equal(byValue.data.results[0].value, '351', JSON.stringify(byValue.data.results[0]));
    const byLabel = await srv.call('taxme_fill', { values: [{ target: 'Gemeinde', value: 'Köniz' }] });
    assert.equal(byLabel.data.results[0].value, '371');
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
});
