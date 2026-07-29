// The session is the whole point of the persistent profile: an AGOV login costs
// the user a Touch ID confirmation, so a restart must not ask for another one.
// These tests log in against the fixture, restart, and check that no second
// login happened — and that a state file the caller switched off stays off.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, statSync, readlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { start } from './fixture-portal.mjs';
import { startServer } from './client.mjs';

const SLOW = { timeout: 300000 };
const REAL_STATE = join(homedir(), '.taxme-mcp', 'state.json');
let portal, scratch;
const servers = [];

const spawnServer = async (env) => {
  const s = await startServer({ TAXME_BASE_URL: portal.base, ...env }, { timeout: 240000 });
  servers.push(s);
  return s;
};

before(async () => {
  portal = await start();
  scratch = mkdtempSync(join(tmpdir(), 'taxme-session-'));
});
after(async () => {
  await Promise.all(servers.map(s => s.stop()));
  await portal?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

// Whether the fixture's AGOV page completes by itself decides what "logged out"
// means, so every test says which world it is in rather than inheriting it.
const human = present => portal.control({ autoLogin: present });

describe('session caching', () => {
  const stateFile = () => join(scratch, 'state.json');

  test('a login is mirrored to state.json', SLOW, async () => {
    await human(true);   // the fixture stands in for the person at the keyboard
    const srv = await spawnServer({ TAXME_STATE: stateFile(), TAXME_PROFILE: join(scratch, 'p1') });
    const { data } = await srv.call('taxme_login');
    assert.equal(data.status, 'ok', JSON.stringify(data));
    assert.match(data.message, /state\.json/);
    assert.equal(portal.state.logins, 1, 'exactly one login');
    assert.ok(existsSync(stateFile()), 'the session was written');
    assert.ok(readFileSync(stateFile(), 'utf8').includes(portal.SESSION),
      'a session cookie is dropped when a persistent profile closes, so it has to be in the file');
  });

  test('a restart with a fresh profile reuses it instead of logging in again', SLOW, async () => {
    await human(false);   // nobody is there to log in again
    const srv = await spawnServer({ TAXME_STATE: stateFile(), TAXME_PROFILE: join(scratch, 'p2') });
    const { data } = await srv.call('taxme_status');
    assert.equal(data.status, 'ok', 'the cached session did not survive the restart');
    assert.equal(portal.state.logins, 1, 'a second login was triggered');
  });

  test('a fresh profile with no state file is simply logged out', SLOW, async () => {
    await human(false);
    const srv = await spawnServer({ TAXME_STATE: join(scratch, 'absent.json'), TAXME_PROFILE: join(scratch, 'p3') });
    const { data } = await srv.call('taxme_status');
    assert.equal(data.status, 'login_required');
  });

  test('a corrupt state file means logged out, not a crash', SLOW, async () => {
    await human(false);
    const broken = join(scratch, 'broken.json');
    writeFileSync(broken, '{ this is not json');
    const srv = await spawnServer({ TAXME_STATE: broken, TAXME_PROFILE: join(scratch, 'p4') });
    const { data, isError } = await srv.call('taxme_status');
    assert.equal(isError, false);
    assert.equal(data.status, 'login_required');
  });

  test('an empty TAXME_STATE means no session cache — never the real one', SLOW, async () => {
    // The `env || default` form would silently fall back to the state file of
    // the actual taxpayer here, and this test would drive the real portal.
    await human(false);
    const before = existsSync(REAL_STATE) ? statSync(REAL_STATE).mtimeMs : null;
    const srv = await spawnServer({ TAXME_STATE: '', TAXME_PROFILE: join(scratch, 'p5') });
    const { data } = await srv.call('taxme_status');
    assert.equal(data.status, 'login_required', 'no state file means no session');
    const now = existsSync(REAL_STATE) ? statSync(REAL_STATE).mtimeMs : null;
    assert.equal(now, before, `${REAL_STATE} was read or written by a test`);
  });
});

describe('what counts as a completed login', () => {
  test('being on the portal is not being logged in to it', SLOW, async () => {
    // taxme_login waited for the browser to reach the portal's host and called
    // that the login. But the login page is served on the portal's own host —
    // the fixture's AGOV page is, and so is BE-Login's own — so the condition
    // was already true when the tool's very first navigation landed there:
    // waitForURL returned before anybody had touched the keyboard. Driven
    // against the fixture with nobody logging in, the tool answered status ok
    // and "BE-Login/AGOV erfolgreich, Session in state.json gespeichert" over a
    // browser sitting on the AGOV form, wrote a state file with no session in
    // it, and the next call came back login_required. That cannot be tested by
    // leaving nobody at the keyboard — a fixed tool then waits the full eight
    // minutes, which is the point of it — so the human is let through here and
    // the portal is the thing that says nobody is logged in: "Angemeldet als:
    // Benutzer", the 200 that looks normal and is not a session, which `ensure`
    // was taught to catch and this tool never asked about at all.
    await human(true);
    await portal.control({ anonymous: true });
    const stateFile = join(scratch, 'anon.json');
    const srv = await spawnServer({ TAXME_STATE: stateFile, TAXME_PROFILE: join(scratch, 'p6') });
    const { data } = await srv.call('taxme_login');
    await portal.control({ anonymous: false });
    assert.notEqual(data.status, 'ok',
      `a login that never happened was reported as done: ${JSON.stringify(data)}`);
    assert.equal(data.status, 'login_required', JSON.stringify(data));
    assert.match(data.message, /nicht abgeschlossen/);
    assert.ok(!existsSync(stateFile),
      'and nothing was cached — the promise of a session that survives a restart was the worst part of it');
  });

  test('a login that does go through is still reported as one', SLOW, async () => {
    // The other half: the check must not turn every login into a failure.
    await human(true);
    const srv = await spawnServer({ TAXME_STATE: join(scratch, 'good.json'), TAXME_PROFILE: join(scratch, 'p7') });
    const { data } = await srv.call('taxme_login');
    assert.equal(data.status, 'ok', JSON.stringify(data));
    assert.equal(data.session_cache, 'saved');
    assert.ok(readFileSync(join(scratch, 'good.json'), 'utf8').includes(portal.SESSION));
  });
});

describe('a profile another browser is holding', () => {
  test('clears the stale lock and starts anyway', SLOW, async () => {
    await human(false);
    const profile = join(scratch, 'contended');
    // The first server keeps the profile — the same situation a browser that
    // was killed rather than closed leaves behind.
    const holder = await spawnServer({ TAXME_STATE: join(scratch, 'h.json'), TAXME_PROFILE: profile });
    await holder.call('taxme_status');
    const lockBefore = readlinkSync(join(profile, 'SingletonLock'));

    const second = await spawnServer({ TAXME_STATE: join(scratch, 's.json'), TAXME_PROFILE: profile });
    const { data, isError } = await second.call('taxme_status');
    assert.equal(isError, false, 'the second server could not start a browser at all');
    assert.ok(['ok', 'login_required'].includes(data.status), JSON.stringify(data));
    assert.notEqual(readlinkSync(join(profile, 'SingletonLock')), lockBefore,
      'the lock was never re-taken, so the launch cannot have been the one that healed it');
  });
});
