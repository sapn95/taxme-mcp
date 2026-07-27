// Offline checks: the MCP surface, the startup guards, and the browser
// preference logic. Nothing here launches a browser except the one case that
// deliberately proves an empty TAXME_BROWSER stops looking at the legacy alias.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { startServer, startBroken } from './client.mjs';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chrome-canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};

const servers = [];
const spawnServer = async (env, opts) => { const s = await startServer(env, opts); servers.push(s); return s; };
after(async () => { await Promise.all(servers.map(s => s.stop())); });

describe('protocol', () => {
  test('advertises itself with the name and version from package.json', async () => {
    const srv = await spawnServer({ TAXME_BROWSER: '/nonexistent' });
    assert.equal(srv.init.result.serverInfo.name, PKG.name);
    assert.equal(srv.init.result.serverInfo.version, PKG.version);
  });

  test('every tool has a usable description and an object schema', async () => {
    const srv = await spawnServer({ TAXME_BROWSER: '/nonexistent' });
    const tools = await srv.tools();
    assert.ok(tools.length >= 13, `expected the full tool set, got ${tools.length}`);
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length, 'duplicate tool name');
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name}: description too thin`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: schema is not an object`);
      for (const r of t.inputSchema.required || []) {
        assert.ok(Object.hasOwn(t.inputSchema.properties, r), `${t.name}: required "${r}" undeclared`);
      }
    }
  });

  test('the one destructive tool is described as gated, and is the only one', async () => {
    const srv = await spawnServer({ TAXME_BROWSER: '/nonexistent' });
    const tools = await srv.tools();
    const submit = tools.find(t => t.name === 'taxme_submit_return');
    assert.ok(submit, 'taxme_submit_return must exist');
    assert.match(submit.description, /confirm:true/, 'the gate belongs in the description');
    assert.ok(Object.hasOwn(submit.inputSchema.properties, 'confirm'));
    assert.ok(!(submit.inputSchema.required || []).includes('confirm'),
      'confirm must be optional, so omitting it is the safe default rather than a schema error');
    const others = tools.filter(t => t !== submit && /einreichen|submit|freigeben/i.test(t.description));
    assert.deepEqual(others.map(t => t.name), [], 'no second path to a submission');
  });

  test('an unknown tool is reported, not silently ignored', async () => {
    const srv = await spawnServer({ TAXME_BROWSER: '/nonexistent' });
    const { data } = await srv.call('taxme_nope');
    assert.match(data.error, /unknown tool taxme_nope/);
  });

  test('a client that goes away takes the server with it', async () => {
    // Deliberately not registered for the after() sweep: this one is gone.
    const srv = await startServer({ TAXME_BROWSER: '/nonexistent' });
    await srv.stop();
    assert.equal(await srv.exited, 0,
      'closing stdin must shut the server down cleanly, not leave it holding a browser');
  });

  test('taxme_fill rejects a malformed values list before touching the browser', async () => {
    const srv = await spawnServer({ TAXME_BROWSER: '/nonexistent' });
    const { data } = await srv.call('taxme_fill', { values: 'Beruf=Koch' });
    assert.match(data.error, /values/);
    assert.ok(!data.error.includes('nonexistent'), 'it must not have tried to start a browser');
  });
});

describe('startup guards', () => {
  test('an empty TAXME_BASE_URL is refused rather than replaced by the real portal', async () => {
    const { code, stderr } = await startBroken({ TAXME_BASE_URL: '', TAXME_STATE: '', TAXME_PROFILE: '' });
    assert.notEqual(code, 0, 'the server must not start');
    assert.match(stderr, /TAXME_BASE_URL is set but empty/);
    assert.ok(!stderr.includes('belogin.directories.be.ch'), 'and must not fall back to it');
  });

  test('a malformed TAXME_BASE_URL fails at startup, not inside the first call', async () => {
    const { code, stderr } = await startBroken({ TAXME_BASE_URL: 'not a url', TAXME_STATE: '', TAXME_PROFILE: '' });
    assert.notEqual(code, 0);
    assert.match(stderr, /Invalid URL/i);
  });
});

describe('browser preference', () => {
  test('an explicit path that does not exist names TAXME_BROWSER', async () => {
    const srv = await spawnServer({ TAXME_BROWSER: '/nonexistent/browser' });
    const { raw } = await srv.call('taxme_status');
    assert.match(raw, /TAXME_BROWSER="\/nonexistent\/browser" not found/);
  });

  test('a shorthand resolves to the known application path', async () => {
    // Whichever of the four is not installed here — on a stock CI runner that
    // is all of them, on this machine at least one.
    const missing = Object.entries(BROWSERS).find(([, p]) => !existsSync(p));
    assert.ok(missing, 'no shorthand left to test with — all four browsers installed');
    const srv = await spawnServer({ TAXME_BROWSER: missing[0] });
    const { raw } = await srv.call('taxme_status');
    assert.ok(raw.includes(missing[1]), `expected the mapped path in: ${raw.slice(0, 200)}`);
  });

  test('the legacy TAXME_CHROMIUM still works, and says which variable it read', async () => {
    const srv = await spawnServer({ TAXME_CHROMIUM: '/nonexistent/legacy' });
    const { raw } = await srv.call('taxme_status');
    assert.match(raw, /TAXME_CHROMIUM="\/nonexistent\/legacy" not found/);
  });

  test('an empty TAXME_BROWSER is authoritative and does not fall through to the alias', async () => {
    // The `a || b` form would read the legacy variable here. A variable that is
    // set, even to nothing, has to win — otherwise "no preference" is unsayable.
    const srv = await spawnServer({ TAXME_BROWSER: '', TAXME_CHROMIUM: '/nonexistent/legacy' }, { timeout: 60000 });
    const { raw } = await srv.call('taxme_status');
    assert.ok(!raw.includes('/nonexistent/legacy'), `fell through to the alias: ${raw.slice(0, 200)}`);
  });
});
