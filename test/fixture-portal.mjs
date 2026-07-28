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

const abschluss = done => `
<!-- No "TaxMe 2025 >" breadcrumb here, so the fallback breadcrumb is used. -->
<div class="hint">Sie befinden sich derzeit im Abschluss der Steuererklärung 2025.</div>
<form method="post" action="${EDIT}?year=2025&amp;s=abschluss">
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
      // Amounts carry the typographic apostrophe the portal uses, and the
      // trailing "Aktuelle Jahre" block must not be attributed to 2024.
      return html(shell('Kontoauszug', `
        <div id="user">Angemeldet als: Test User</div>
        <h1>Kontoauszug</h1><h2>Offene Beträge</h2>
        <table>
          <tr><th colspan="2">2025</th></tr>
          <tr><td>Kantons- und Gemeindesteuern</td><td>1’234.55</td></tr>
          <tr><td>Direkte Bundessteuer</td><td>210.00</td></tr>
          <tr><td>Gemeindeabgaben</td><td>0.00</td></tr>
          <tr><th colspan="2">2024</th></tr>
          <tr><td>Kantons- und Gemeindesteuern</td><td>0.00</td></tr>
          <tr><td>Direkte Bundessteuer</td><td>0.00</td></tr>
          <tr><th colspan="2">Aktuelle Jahre</th></tr>
          <tr><td>Kantons- und Gemeindesteuern</td><td>9’999.00</td></tr>
        </table>`));
    }

    if (u.pathname === EDIT) {
      const year = u.searchParams.get('year') || '2025';
      const s = u.searchParams.get('s') || '';
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
        abschluss: abschluss(state.submitted.length > 0),
        ergebnisse: `<h2>Ergebnisse</h2><table>
          <tr><td>Steuerbetrag Kanton und Gemeinde</td><td>4’321.00</td></tr>
          <tr><td>Steuerbetrag direkte Bundessteuer</td><td>210.00</td></tr></table>`,
        wvz: '<h2>Wertschriftenverzeichnis</h2><p>Detail des Verzeichnisses.</p>',
        wertschriften: '<h2>Wertschriften</h2><p>Übersicht Wertschriften.</p>',
        liegenschaften: '<h2>Liegenschaften</h2>',
      }[s] || '<p>Bitte wählen Sie links einen Abschnitt.</p>';

      // The Abschluss page deliberately has no "TaxMe ... >" breadcrumb.
      const crumb = s === 'abschluss' ? '' : `<div id="crumb">TaxMe ${year} > ${SECTIONS.find(x => x[0] === s)?.[1] || 'Übersicht'}</div>`;
      return html(shell(`TaxMe ${year}`, `${crumb}${menu(year)}<div id="content">${bodyFor}</div>`));
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
