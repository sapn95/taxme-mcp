// A local stand-in for BE-Login / TaxMe, reproducing the DOM the automation
// actually depends on — and the JSF quirks it works around, because those are
// where the bugs are:
//
//   * the radio input is invisible; only its <label> is clickable
//   * a second radio group has no <label for> at all and swallows the click,
//     so it only commits when a `change` event is dispatched at it
//   * element ids contain colons ("form:pers:zivilstand:0"), so `#id` is not a
//     valid CSS selector
//   * amount fields take whole francs and silently drop the centimes
//   * the return opens in a separate browser tab
//   * menu entries and buttons are prefixes of each other ("Wertschriften" /
//     "Wertschriftenverzeichnis", "Speichern" / "Speichern und schliessen"),
//     so a substring match clicks the wrong one
//   * the session lives in a session cookie, and a request without it comes
//     back either as a redirect to AGOV or — worse — as a 200 that merely says
//     "Angemeldet als: Benutzer"
//   * a hidden JSF ViewState field carries a token that must never be echoed
//   * the account statement prints a due date under each year, and the 2024
//     assessment falls due in 2025, so the page contains years that are not
//     headings
//   * a section the portal has switched off leaves its widgets disabled, and a
//     disabled input is never submitted however checked it looks
//
// Nothing here talks to the real portal, and the server binds to 127.0.0.1 on
// an ephemeral port.
import { createServer } from 'node:http';

// Stand-ins for the two secrets a real session carries. The suite asserts that
// neither ever reaches a tool result or stderr.
export const SESSION = 'sess-do-not-leak-3f9c';
export const VIEWSTATE = 'viewstate-do-not-leak-9a71';

const CASES = '/taxme-npo/facelets/caseSelection.jsf';
const STATEMENT = '/taxme-bezug/gui/kontoauszug/forderungen';
const EDIT = '/tmo/facelets/edit.jsf';

const SECTIONS = [
  ['personalien', 'Personalien', 'Formular in Bearbeitung'],
  // Listed before "Wertschriften" on purpose: a substring match that takes the
  // first hit lands here instead.
  ['wvz', 'Wertschriftenverzeichnis', 'Formular in Bearbeitung'],
  ['wertschriften', 'Wertschriften', 'Abgeschlossenes Formular'],
  ['einkuenfte', 'Einkünfte', 'Formular in Bearbeitung'],
  ['liegenschaften', 'Liegenschaften', 'Ausgeschaltet aufgrund Ihrer Eingaben'],
  ['ergebnisse', 'Ergebnisse', 'Formular in Bearbeitung'],
  ['abschluss', 'Abschluss', 'Formular in Bearbeitung'],
];

const shell = (title, body) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${title}</title>
<style>
  /* As in the portal: the input itself is invisible, the label is the widget. */
  .jsf-radio { position: absolute; opacity: 0; width: 1px; height: 1px; }
  td { padding: 4px 10px; }
</style></head>
<body>
${body}
<script>
  function ev(k, v) { fetch('/__event?k=' + encodeURIComponent(k) + '&v=' + encodeURIComponent(v), { keepalive: true }); }
  // The whole-franc converter: centimes are dropped as you type.
  function franken(el) { if (/[.,]/.test(el.value)) el.value = el.value.replace(/[.,].*$/, ''); }
</script>
</body></html>`;

const menu = year => `<ul id="menu">${SECTIONS.map(([s, label, status]) => `
  <li><a href="${EDIT}?year=${year}&amp;s=${s}">${label}</a><div class="status">${status}</div></li>`).join('')}</ul>`;

const personalien = () => `
<table class="fields">
  <tr>
    <td>Zivilstand</td>
    <td>
      <input class="jsf-radio" type="radio" name="zst" id="form:pers:zivilstand:0" value="ledig" onchange="ev('zivilstand', this.value)">
      <label for="form:pers:zivilstand:0">ledig</label>
      <input class="jsf-radio" type="radio" name="zst" id="form:pers:zivilstand:1" value="verheiratet" onchange="ev('zivilstand', this.value)">
      <label for="form:pers:zivilstand:1">verheiratet</label>
    </td>
  </tr>
  <tr>
    <td>Konfession</td>
    <td>
      <!-- No label[for], and the click is swallowed: only a dispatched change commits. -->
      <input type="radio" name="konf" id="form:pers:konf:0" value="ref" onclick="return false" onchange="ev('konfession', this.value)"><span>evangelisch-reformiert</span>
      <input type="radio" name="konf" id="form:pers:konf:1" value="kath" onclick="return false" onchange="ev('konfession', this.value)"><span>römisch-katholisch</span>
    </td>
  </tr>
  <tr>
    <td>Kirchensteuer</td>
    <td>
      <input type="checkbox" id="form:pers:kirche" value="ja" onchange="ev('kirche', this.checked)">
      <label for="form:pers:kirche">Kirchensteuerpflichtig</label>
    </td>
  </tr>
  <tr>
    <td>Nebenerwerb</td>
    <td>
      <!-- No label, like the JSF widgets the comment in index.js describes.
           That is the path the fallback takes, and the fallback used to force
           checked=true whatever it had been asked for. -->
      <input type="checkbox" id="form:pers:nebenerwerb" value="ja" checked onchange="ev('nebenerwerb', this.checked)">
    </td>
  </tr>
  <tr>
    <td>Kinderabzug</td>
    <td>
      <!-- Switched off by the portal, and with no label — so the fill takes the
           JavaScript fallback, which can set the checked property on a disabled
           input just fine. The browser still never submits it. -->
      <input type="checkbox" id="form:pers:kinderabzug" value="ja" disabled onchange="ev('kinderabzug', this.checked)">
    </td>
  </tr>
  <tr>
    <!-- A joint return asks the same question of both spouses, and the portal
         puts the two answers side by side in ONE table row. So two separate
         radio groups — two different name attributes — share a row, and with
         it every scrap of surrounding text. -->
    <td>Krankheitskosten</td>
    <td>
      Person 1
      <input class="jsf-radio" type="radio" name="kk1" id="form:pers:kk1:0" value="ja" onchange="ev('kk-person1', this.value)">
      <label for="form:pers:kk1:0">beantragt</label>
      <input class="jsf-radio" type="radio" name="kk1" id="form:pers:kk1:1" value="nein" onchange="ev('kk-person1', this.value)">
      <label for="form:pers:kk1:1">verzichtet</label>
      Person 2
      <input class="jsf-radio" type="radio" name="kk2" id="form:pers:kk2:0" value="ja" onchange="ev('kk-person2', this.value)">
      <label for="form:pers:kk2:0">beantragt</label>
      <input class="jsf-radio" type="radio" name="kk2" id="form:pers:kk2:1" value="nein" onchange="ev('kk-person2', this.value)">
      <label for="form:pers:kk2:1">verzichtet</label>
    </td>
  </tr>
  <tr><td>Beruf</td><td><input type="text" id="form:pers:beruf" value=""></td></tr>
  <tr><td>Gemeinde</td><td>
    <select id="form:pers:gemeinde">
      <option value="">Bitte wählen</option>
      <option value="351">Bern</option>
      <option value="371">Köniz</option>
    </select></td></tr>
</table>`;

const einkuenfte = saved => `
<form method="post" action="${EDIT}?year=2025&amp;s=einkuenfte">
  <input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="${VIEWSTATE}">
  <table class="fields">
    <tr><td>Bruttolohn</td><td><input type="text" name="betrag" id="form:eink:0:betrag" value="" oninput="franken(this)"></td></tr>
  </table>
  <a href="${EDIT}?year=2025&amp;s=einkuenfte&amp;neu=1">Neuen Eintrag erfassen</a>
  <input type="submit" name="b" value="Speichern und schliessen">
  <input type="submit" name="b" value="Speichern">
  <button type="submit" name="b" value="Nächste Seite">Nächste Seite</button>
  ${saved ? '<div class="msg">Gespeichert</div>' : ''}
</form>`;

const abschluss = (done, year) => `
<!-- No "TaxMe 2025 >" breadcrumb here, so the fallback breadcrumb is used. -->
<div class="hint">Sie befinden sich derzeit im Abschluss der Steuererklärung ${year}.</div>
<form method="post" action="${EDIT}?year=${year}&amp;s=abschluss">
  <input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="${VIEWSTATE}">
  <input type="button" id="form:abschluss:vorschau" value="Vorschau">
  <input type="submit" name="b" id="form:abschluss:einreichen" value="Steuererklärung einreichen">
</form>
${done ? '<div class="msg">Ihre Steuererklärung wurde eingereicht.</div>' : ''}`;

const cookiesOf = req => Object.fromEntries((req.headers.cookie || '').split(';')
  .map(s => s.trim().split('=')).filter(p => p[0]));

export function start() {
  const state = {
    logins: 0,          // completed AGOV logins
    submitted: [],      // every request that tried to submit a return
    clicks: [],         // the button value the portal actually received
    events: [],         // change events fired by the form widgets
    anonymous: false,   // 200 OK, but "Angemeldet als: Benutzer"
    autoLogin: false,   // the AGOV page completes by itself (stands in for the human)
    rejectSubmit: false, // the portal takes the click and refuses the return
    editLoggedOut: false, // the case list still works, the edit view bounces to AGOV
    editBroken: false,  // the edit view answers 200 with something that is not a return
    forceYear: null,    // the portal opens a different case than the link asked for
    statementInline: false, // a statement whose years are inside the rows, not above them
    landOn: null,       // the section a reopened return comes up on when the link names none
    noCalculation: false, // Ergebnisse exists but the portal has not computed anything yet
    abschlussBlocked: false, // the portal will not open Abschluss and keeps you where you were
  };

  const route = (req, res, body) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const form = new URLSearchParams(body || '');
    const html = (s, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(s);
    };
    const redirect = (to, headers = {}) => { res.writeHead(302, { Location: to, ...headers }); res.end(); };

    if (u.pathname === '/__control') {
      Object.assign(state, JSON.parse(u.searchParams.get('set') || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/__event') {
      state.events.push(`${u.searchParams.get('k')}=${u.searchParams.get('v')}`);
      res.writeHead(204); return res.end();
    }
    // AGOV/SwissID stands in for the identity provider. `auto=1` means the human
    // completes it; without it the page just sits there, as it does in reality.
    if (u.pathname === '/agov/login') {
      // The real login page carries a password box, and the field reader is a
      // generic tool an agent may call on any page — including this one.
      return html(shell('AGOV Login', `<h1>AGOV Anmeldung</h1>
        <label for="agov:user">Benutzer</label><input type="text" id="agov:user" value="test-user">
        <label for="agov:pw">Passwort</label><input type="password" id="agov:pw" value="hunter2-not-a-real-password">
        <a id="go" href="/agov/callback">Weiter mit AGOV</a>
        ${u.searchParams.get('auto') === '1' ? '<script>setTimeout(() => { location.href = "/agov/callback"; }, 500);</script>' : ''}`));
    }
    if (u.pathname === '/agov/callback') {
      state.logins++;
      // A session cookie: no Expires, so a persistent profile drops it on close.
      return redirect(CASES, { 'Set-Cookie': `TAXMESESSION=${SESSION}; Path=/; SameSite=Lax` });
    }

    if (cookiesOf(req).TAXMESESSION !== SESSION) {
      return redirect(`/agov/login?goto=${encodeURIComponent(u.pathname)}${state.autoLogin ? '&auto=1' : ''}`);
    }

    if (u.pathname === CASES) {
      // Logged in as nobody: the portal answers 200 and looks normal.
      if (state.anonymous) return html(shell('TaxMe', '<div id="user">Angemeldet als: Benutzer</div><h1>Fallübersicht</h1>'));
      return html(shell('TaxMe', `
        <div id="user">Angemeldet als: Test User</div>
        <h1>Fallübersicht</h1>
        <table>
          <!-- "Steuererklärung" in the header on purpose: a parser that looks
               for that word rather than for a year turns this row into a return
               whose status is the word "Status". -->
          <tr><th>Steuererklärung</th><th>Status</th></tr>
          <tr><td><a href="${EDIT}?year=2025" target="_blank">Steuererklärung 2025</a></td><td>In Bearbeitung</td></tr>
          <tr><td><a href="${EDIT}?year=2024" target="_blank">Steuererklärung 2024</a></td><td>Eingereicht</td></tr>
        </table>`));
    }

    if (u.pathname === STATEMENT) {
      // A statement that prints its years inside the rows instead of above
      // them. Nothing can be tied to a year here, and "nothing outstanding" is
      // the one answer that must not come back.
      if (state.statementInline) {
        return html(shell('Kontoauszug', `
          <div id="user">Angemeldet als: Test User</div>
          <h1>Kontoauszug</h1>
          <table>
            <tr><td>Steuerjahr 2025 — Kantons- und Gemeindesteuern</td><td>1’234.55</td></tr>
            <tr><td>Steuerjahr 2025 — Direkte Bundessteuer</td><td>210.00</td></tr>
          </table>`));
      }
      // Amounts carry the typographic apostrophe the portal uses, and the
      // trailing "Aktuelle Jahre" block must not be attributed to 2024.
      //
      // Every open claim also carries the date it falls due, and the 2024
      // assessment is payable on 30.09.2025 — so "2025" appears inside the 2024
      // block. A parser that starts a new year wherever it sees four digits
      // hands 2024's amounts to 2025 and loses 2024 altogether.
      return html(shell('Kontoauszug', `
        <div id="user">Angemeldet als: Test User</div>
        <h1>Kontoauszug</h1><h2>Offene Beträge</h2>
        <table>
          <tr><th colspan="2">2025</th></tr>
          <tr><td>Fällig am</td><td>30.09.2026</td></tr>
          <tr><td>Kantons- und Gemeindesteuern</td><td>1’234.55</td></tr>
          <tr><td>Direkte Bundessteuer</td><td>210.00</td></tr>
          <tr><td>Gemeindeabgaben</td><td>0.00</td></tr>
          <tr><th colspan="2">2024</th></tr>
          <tr><td>Fällig am</td><td>30.09.2025</td></tr>
          <tr><td>Kantons- und Gemeindesteuern</td><td>0.00</td></tr>
          <tr><td>Direkte Bundessteuer</td><td>0.00</td></tr>
          <tr><th colspan="2">Aktuelle Jahre</th></tr>
          <tr><td>Kantons- und Gemeindesteuern</td><td>9’999.00</td></tr>
        </table>`));
    }

    if (u.pathname === EDIT) {
      // The case list still answers, only the edit view does not: the session
      // that was good enough to list the returns has expired by the time the
      // link is clicked.
      if (state.editLoggedOut) return redirect(`/agov/login?goto=${encodeURIComponent(u.pathname)}`);
      // 200 OK and no session problem at all — the portal is simply busy. There
      // is no return on this page, whatever the click was aiming at.
      if (state.editBroken) return html(shell('Wartung', '<h1>Wartungsarbeiten</h1><p>Bitte später erneut versuchen.</p>'));
      // And the portal opening a case of its own choosing rather than the one
      // the link named.
      const year = state.forceYear || u.searchParams.get('year') || '2025';
      // A half-finished return comes back up where it was left, so the link
      // from the case list — which names no section — can land on any page of
      // the form, including the one that carries no "TaxMe 2025 >" breadcrumb.
      let s = u.searchParams.get('s') || state.landOn || '';
      // TaxMe will not let you into Abschluss while the form still has errors.
      // The click arrives, and the section you were on comes back with a
      // banner — so nothing on the page says "Abschluss" except the menu entry
      // that every page of the return carries anyway.
      let blocked = '';
      if (s === 'abschluss' && state.abschlussBlocked) {
        s = 'einkuenfte';
        blocked = '<div class="error">Bitte korrigieren Sie zuerst die Fehler im Formular.</div>';
      }
      const btn = form.get('b');
      if (btn) state.clicks.push(btn);
      // rejectSubmit models the portal refusing: the click arrives, nothing is
      // recorded, and the page comes back without a confirmation. That is what
      // validation failure and an expired session look like from outside.
      const submitting = btn && /einreichen/i.test(btn);
      if (submitting && !state.rejectSubmit) state.submitted.push({ year, at: Date.now() });

      const bodyFor = {
        personalien: personalien(),
        einkuenfte: einkuenfte(btn && btn.startsWith('Speichern')),
        abschluss: abschluss(state.submitted.length > 0, year),
        // The prose sits BETWEEN the navigation and the results panel on
        // purpose. "Ergebnisse" is a menu entry too, and a slice taken from
        // the first occurrence spends its whole window on this text and never
        // reaches the figures — which is what used to happen.
        //
        // noCalculation is the same page before the portal has computed
        // anything: it says so in words, and — like every page of this portal
        // — it is stamped with a date. There is no amount on it.
        ergebnisse: state.noCalculation
          ? `<p>${'Hinweis zur Berechnung. '.repeat(70)}</p>
          <h2>Ergebnisse</h2>
          <p>Für Steuerjahr ${year} ist keine Berechnung verfügbar.</p>
          <p>Stand der Daten: 30.09.${Number(year) + 1}</p>`
          : `<p>${'Hinweis zur Berechnung. '.repeat(70)}</p>
          <h2>Ergebnisse</h2>
          <table>
          <tr><td>Steuerbetrag Kanton und Gemeinde</td><td>4’321.00</td></tr>
          <tr><td>Steuerbetrag direkte Bundessteuer</td><td>210.00</td></tr></table>`,
        // The only save button on this page is the long one. Asking for
        // "Speichern" here can only be answered by "Speichern und schliessen",
        // which is a different thing to do to a form — so the reply has to name
        // the button that was really pressed. And seventy positions, because a
        // securities list really is that long: a form with more than sixty
        // boxes is the case readFields' own comment is written for, a reply
        // that shows sixty of them has to say so, and the box the test writes
        // to sits past the cut on purpose.
        wvz: `<h2>Wertschriftenverzeichnis</h2><p>Detail des Verzeichnisses.</p>
          <table class="fields">${Array.from({ length: 70 }, (_, i) =>
    `<tr><td>Wertschrift ${i + 1}</td><td><input type="text" id="form:wvz:${i}:betrag" value=""></td></tr>`).join('')}</table>
          <form method="post" action="${EDIT}?year=2025&amp;s=wvz">
            <input type="submit" name="b" value="Speichern und schliessen">
          </form>`,
        wertschriften: '<h2>Wertschriften</h2><p>Übersicht Wertschriften.</p>',
        liegenschaften: '<h2>Liegenschaften</h2>',
      }[s] || '<p>Bitte wählen Sie links einen Abschnitt.</p>';

      // The Abschluss page deliberately has no "TaxMe ... >" breadcrumb.
      const crumb = s === 'abschluss' ? '' : `<div id="crumb">TaxMe ${year} > ${SECTIONS.find(x => x[0] === s)?.[1] || 'Übersicht'}</div>`;
      return html(shell(`TaxMe ${year}`, `${crumb}${menu(year)}<div id="content">${blocked}${bodyFor}</div>`));
    }

    return html(shell('Fehler', '<h1>Seite nicht gefunden</h1>'), 404);
  };

  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => route(req, res, body));
  });

  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      resolve({
        base, state, SESSION, VIEWSTATE,
        // Flip fixture behaviour from a test without restarting anything.
        control: set => fetch(`${base}/__control?set=${encodeURIComponent(JSON.stringify(set))}`).then(r => r.json()),
        close: () => new Promise(done => { srv.close(done); }),
      });
    });
  });
}
