// The one thing this server must never do is submit a tax return that nobody
// asked it to submit. Everything here drives the real automation against the
// fixture and then asks the fixture — not the server — whether a submission
// arrived.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './fixture-portal.mjs';
import { startServer } from './client.mjs';

const SLOW = { timeout: 300000 };
let portal, srv, scratch, stateFile;

// Everything the server ever said, so the leak check at the end looks at the
// whole conversation rather than at one hand-picked call.
const transcript = [];
const call = async (name, args) => {
  const r = await srv.call(name, args);
  transcript.push(`${name} ${JSON.stringify(args ?? {})} -> ${r.raw}`);
  return r;
};

before(async () => {
  portal = await start();
  scratch = mkdtempSync(join(tmpdir(), 'taxme-safety-'));
  stateFile = join(scratch, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    cookies: [{
      name: 'TAXMESESSION', value: portal.SESSION, domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
    }],
    origins: [],
  }));
  srv = await startServer({
    TAXME_BASE_URL: portal.base,
    TAXME_STATE: stateFile,
    TAXME_PROFILE: join(scratch, 'profile'),
  }, { timeout: 240000 });
  const opened = await call('taxme_open_return', { year: 2025 });
  assert.equal(opened.data.status, 'ok', `could not open the return: ${opened.raw}`);
});
after(async () => {
  await srv?.stop();
  await portal?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('the submit gate', () => {
  test('without confirmation it opens the Abschluss page and submits nothing', SLOW, async () => {
    const { data } = await call('taxme_submit_return');
    assert.equal(data.dry_run, true);
    assert.match(data.message, /Nicht eingereicht/);
    assert.match(data.message, /confirm:true/);
    assert.deepEqual(portal.state.submitted, [], 'a submission reached the portal');
    // The dry run is only useful if it shows what the real call would press.
    assert.ok(data.buttons.some(b => b.id === 'form:abschluss:einreichen'),
      `the submit button is not in the dry run: ${JSON.stringify(data.buttons)}`);
    assert.equal(data.would_click, 'Steuererklärung einreichen',
      `the dry run has to name the one button a confirmed call would press: ${JSON.stringify(data.would_click)}`);
    assert.ok(existsSync(data.screenshot), 'a dry run leaves a screenshot to look at');
    rmSync(data.screenshot, { force: true });
  });

  test('confirm:false is a refusal, not a formality', SLOW, async () => {
    const { data } = await call('taxme_submit_return', { confirm: false });
    assert.equal(data.dry_run, true);
    assert.equal(data.submitted, undefined);
    assert.deepEqual(portal.state.submitted, []);
    rmSync(data.screenshot, { force: true });
  });

  // Everything that is truthy, or looks like consent, but is not the boolean.
  for (const confirm of ['true', 1, 'yes', ['true']]) {
    test(`confirm=${JSON.stringify(confirm)} does not pass the gate`, SLOW, async () => {
      const { data } = await call('taxme_submit_return', { confirm });
      assert.equal(data.dry_run, true, `the gate accepted ${JSON.stringify(confirm)}`);
      assert.deepEqual(portal.state.submitted, [], 'a submission reached the portal');
      rmSync(data.screenshot, { force: true });
    });
  }

  test('a page the portal never left is not the Abschluss page', SLOW, async () => {
    // TaxMe refuses to open Abschluss while the form still has errors: the
    // click lands, and the section you were on comes back with a banner. The
    // check written to catch that tested the page text for the word
    // "Abschluss" — which is a menu entry, and the menu is on every page of
    // the return, so it passed wherever the click had ended up and could not
    // fail at all. The dry run then announced "Abschluss-Seite geöffnet" over
    // a breadcrumb reading "Einkünfte" and handed back that page's "Speichern"
    // as the button a confirmed call would press.
    await portal.control({ abschlussBlocked: true });
    const dry = await call('taxme_submit_return');
    // And with the confirmation given, which is the case that matters: there
    // is nothing on this page to press, and nothing may be pressed.
    const { data } = await call('taxme_submit_return', { confirm: true });
    // Put the portal back before asserting, so a failure here fails alone
    // instead of leaving every later test locked out of the Abschluss page.
    await portal.control({ abschlussBlocked: false });
    assert.equal(dry.data.dry_run, undefined,
      `another page was called the Abschluss page: ${JSON.stringify(dry.data).slice(0, 240)}`);
    assert.equal(dry.data.submitted, false);
    assert.match(dry.data.error, /Abschluss-Seite ist nicht offen/);
    assert.equal(data.submitted, false, JSON.stringify(data).slice(0, 240));
    assert.deepEqual(portal.state.submitted, [], 'a submission reached the portal');
    assert.deepEqual(portal.state.clicks, [], 'something on the wrong page was pressed');
    if (data.screenshot) rmSync(data.screenshot, { force: true });
  });

  // Last, because it is the only test here that is allowed to submit — and
  // because without it the assertions above would pass against a fixture that
  // simply cannot accept a submission.
  test('a click the portal did not honour is not a submission', SLOW, async () => {
    // The one wrong answer this server must never give. It used to report
    // submitted:true purely because something with the right label had been
    // pressed — validation failures, an expired session, all of it invisible.
    await portal.control({ rejectSubmit: true });
    const { data } = await call('taxme_submit_return', { confirm: true });
    await portal.control({ rejectSubmit: false });
    assert.equal(data.submitted, false, `claimed a submission the portal refused: ${JSON.stringify(data).slice(0, 200)}`);
    assert.match(data.error, /bestätigt keine Einreichung/);
    assert.deepEqual(portal.state.submitted, [], 'and the fixture agrees nothing arrived');
    if (data.screenshot) rmSync(data.screenshot, { force: true });
  });

  test('confirm:true really does submit, which is what makes the rest mean something', SLOW, async () => {
    const { data } = await call('taxme_submit_return', { confirm: true });
    assert.equal(data.submitted, true, JSON.stringify(data));
    assert.equal(data.clicked, 'Steuererklärung einreichen');
    assert.equal(portal.state.submitted.length, 1, 'exactly one submission');
    assert.equal(portal.state.submitted[0].year, '2025');
    rmSync(data.screenshot, { force: true });
  });

  // Everything below runs on the return the test above filed, which is the only
  // way to get a page that says "eingereicht" before anything has been clicked.
  test('a confirmation that predates the click is not proof of the click', SLOW, async () => {
    // The proof of a submission is a sentence in the page text, and it was only
    // ever read after the button had been pressed. The return above is in, so
    // the Abschluss page now carries that sentence beforehand — and here the
    // portal refuses the click, nothing leaves the browser, and this reported
    // submitted:true all the same, on the strength of a sentence that had been
    // there all along. The one wrong answer this server must never give, given
    // by the very check written to prevent it.
    assert.equal(portal.state.submitted.length, 1, 'this test needs the return above to be filed');
    await portal.control({ rejectSubmit: true });
    const clicksBefore = portal.state.clicks.length;
    const { data } = await call('taxme_submit_return', { confirm: true });
    await portal.control({ rejectSubmit: false });
    assert.equal(data.submitted, false,
      `a refused click was reported as a submission: ${JSON.stringify(data).slice(0, 240)}`);
    assert.equal(data.already_submitted, true, JSON.stringify(data).slice(0, 240));
    assert.deepEqual(portal.state.clicks.slice(clicksBefore), [],
      'and the irreversible button must not be pressed a second time to find out');
    assert.equal(portal.state.submitted.length, 1, 'nothing new arrived at the portal');
    if (data.screenshot) rmSync(data.screenshot, { force: true });
  });

  test('the dry run says so, instead of offering the button again', SLOW, async () => {
    // A dry run exists to tell a caller what confirming would do. On a return
    // that is already in it announced "Abschluss-Seite geöffnet" and held up
    // the einreichen button — an invitation to file the thing twice, over a
    // page plainly reporting the first one.
    const { data } = await call('taxme_submit_return');
    assert.equal(data.already_submitted, true,
      `the dry run offered the button again without a word: ${JSON.stringify(data).slice(0, 240)}`);
    assert.match(data.message, /bereits eingereicht/i);
    assert.equal(portal.state.submitted.length, 1);
    if (data.screenshot) rmSync(data.screenshot, { force: true });
  });

  test('a filed return is named as such, not as a page we never reached', SLOW, async () => {
    // What a real portal does once the return is in: the confirmation stays,
    // the button goes. "Kein Einreiche-Button — die Abschluss-Seite ist nicht
    // offen" is then the wrong diagnosis of the right refusal, and the page
    // itself says which of the two it is.
    await portal.control({ submittedKeepsButton: false });
    const { data } = await call('taxme_submit_return', { confirm: true });
    await portal.control({ submittedKeepsButton: true });
    assert.equal(data.submitted, false, JSON.stringify(data).slice(0, 240));
    assert.equal(data.already_submitted, true, JSON.stringify(data).slice(0, 240));
    assert.match(data.error, /bereits eingereicht/i);
    assert.equal(portal.state.submitted.length, 1, 'nothing new arrived at the portal');
    if (data.screenshot) rmSync(data.screenshot, { force: true });
  });
});

describe('secrets', () => {
  test('the session is genuinely in play — otherwise the next test proves nothing', SLOW, async () => {
    assert.ok(readFileSync(stateFile, 'utf8').includes(portal.SESSION),
      'the cached session must contain the cookie the fixture handed out');
    assert.ok(transcript.length >= 7, 'the transcript covers the whole run');
  });

  test('no session cookie and no ViewState ever reaches a tool result or stderr', SLOW, async () => {
    // A last sweep over the tools that return page content.
    for (const t of ['taxme_status', 'taxme_snapshot', 'taxme_get_fields', 'taxme_menu']) await call(t);
    const blob = transcript.join('\n') + '\n' + srv.stderr();
    assert.ok(!blob.includes(portal.SESSION), 'the session cookie surfaced in the output');
    assert.ok(!blob.includes(portal.VIEWSTATE), 'the JSF ViewState surfaced in the output');
  });

  test('a password box on the login page is described, not read out', SLOW, async () => {
    // taxme_get_fields is generic: an agent may call it on any page, and the
    // AGOV login page has a password box. Reporting its shape is useful;
    // reporting its value puts the account password into the model's context.
    const fresh = await startServer({
      TAXME_BASE_URL: portal.base,
      TAXME_PROFILE: join(mkdtempSync(join(tmpdir(), 'taxme-pw-')), 'profile'),
    }, { timeout: 240000 });
    try {
      // A fresh server sits on about:blank until something navigates; with no
      // session this lands on the login page.
      const st = await fresh.call('taxme_status', {});
      assert.equal(st.data.status, 'login_required', 'the fixture must not consider us logged in here');
      const { raw, data } = await fresh.call('taxme_get_fields', {});
      const pw = (data.fields || []).find(f => f.type === 'password');
      assert.ok(pw, `no password field was seen at all: ${raw.slice(0, 200)}`);
      assert.equal(pw.value, '(hidden)', 'the value must be masked, and the field still reported');
      assert.ok(!raw.includes('hunter2'), 'the password itself must not appear anywhere in the result');
    } finally {
      await fresh.stop();
    }
  });

  test('a password field cannot be filled, so its value never round-trips', SLOW, async () => {
    // get_fields masks the value it reads. The fill path read it back too — in
    // the result, and again in the mismatch warning — and nothing masked that.
    const fresh = await startServer({
      TAXME_BASE_URL: portal.base,
      TAXME_PROFILE: join(mkdtempSync(join(tmpdir(), 'taxme-pwfill-')), 'profile'),
    }, { timeout: 240000 });
    try {
      await fresh.call('taxme_status', {});
      const { raw, data } = await fresh.call('taxme_fill', { values: [{ target: 'agov:pw', value: 'geheim-1234' }] });
      assert.equal(data.results[0].ok, false, JSON.stringify(data.results[0]));
      assert.ok(!raw.includes('geheim-1234'), 'the value we sent came back');
      assert.ok(!raw.includes('hunter2'), 'the value already in the box came back');
    } finally {
      await fresh.stop();
    }
  });

  test('nothing but JSON-RPC is written to stdout, and stderr stays quiet', SLOW, async () => {
    const err = srv.stderr();
    assert.ok(!/Error|Cannot find|ERR_|at Object\./.test(err), `noisy stderr: ${err.slice(0, 400)}`);
  });
});
