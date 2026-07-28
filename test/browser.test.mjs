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

  test('lists the returns with their status, and skips the header row', SLOW, async () => {
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

  test('a section that does not exist reports the menu instead of guessing', SLOW, async () => {
    const { data } = await srv.call('taxme_goto_section', { name: 'Kryptowährungen' });
    assert.match(data.error, /nicht gefunden/);
    assert.equal(data.menu.length, 7);
  });
});

describe('filling the form', () => {
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

  test('reads the tax calculation', SLOW, async () => {
    const { data } = await srv.call('taxme_results');
    assert.match(data.text, /Steuerbetrag Kanton und Gemeinde/);
    assert.match(data.text, /4'?’?321\.00/);
  });
});
