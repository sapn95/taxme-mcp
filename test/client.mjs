// Minimal MCP client over stdio, so the tests drive the server exactly as a
// real client would rather than importing its internals.
//
// The defaults here are a safety belt: every server started from a test gets a
// throwaway profile and state file and, unless the test says otherwise, a base
// URL that cannot resolve. A test that forgets to point at the fixture fails —
// it does not quietly open the real taxpayer's session.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

export async function startServer(env = {}, { timeout = 30000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'taxme-test-'));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TAXME_BASE_URL: 'http://127.0.0.1:1',   // refused, not the real portal
      // The automation pauses to let TaxMe rebuild the page. The fixtures these
      // tests drive have rebuilt it before the pause starts, so the pauses are
      // the run. Set here rather than at each spawn: a default a caller has to
      // remember is one that is eventually forgotten, and then a single file
      // quietly costs more than all the others together. Overridable, because
      // fast enough is a property of the machine — on a loaded one a pause can
      // lose the race it exists to win, and a run that must be slowed down is
      // better than one that must be believed.
      TAXME_WAIT_SCALE: process.env.TAXME_WAIT_SCALE || '0.08',
      TAXME_PROFILE: join(scratch, 'profile'),
      TAXME_STATE: join(scratch, 'state.json'),
      ...env,
    },
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  const exited = new Promise(resolve => { child.on('exit', code => resolve(code)); });

  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    line = line.trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    // unref: a pending timeout must not hold the test runner's event loop open
    setTimeout(() => reject(new Error(`${method} timed out after ${timeout}ms`)), timeout).unref();
  });

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    init,
    scratch,
    stderr: () => stderr,
    exited,
    async tools() { return (await rpc('tools/list')).result.tools; },
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      const raw = (r.result?.content || []).map(c => c.text).join('\n');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      return {
        raw,
        isError: !!r.result?.isError,
        data: (typeof parsed === 'object' && parsed !== null) ? parsed : {},
        parsed,
      };
    },
    // Close stdin and let the server shut itself down, the way a real client
    // disconnecting does — then insist. Waiting matters: the process still owns
    // a browser, and deleting the profile underneath it races the shutdown.
    async stop() {
      if (child.exitCode !== null || child.signalCode) return;
      child.stdin.end();
      const term = setTimeout(() => child.kill(), 5000);
      const hard = setTimeout(() => child.kill('SIGKILL'), 10000);
      term.unref(); hard.unref();
      await exited;
      clearTimeout(term); clearTimeout(hard);
    },
  };
}

// Start a server that is expected to refuse to start at all, and report what it
// said on the way out.
export function startBroken(env = {}) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  return new Promise(resolve => { child.on('exit', code => resolve({ code, stderr })); });
}
