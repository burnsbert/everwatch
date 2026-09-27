// Spawns the *real* `python3 -m everwatch serve --demo` process (docs/
// DESIGN.md §7 WP9 row, build/wp4-handoff.md "E2E harness" swap note) so
// tests/e2e/real/*.spec.mjs exercise the actual Python HTTP/SSE server —
// not the JS stand-in in tests/e2e/fixture-server.mjs.
//
// Each call to `spawnBackend()` starts its own subprocess in its own temp
// EVERWATCH_HOME (so nothing ever touches a real user's state), on
// `--port 0` (so parallel tests never collide on a port), and returns once
// stdout has printed the `EVERWATCH_READY <port>` handshake line the CLI
// always writes before serving (everwatch/cli.py `_run_server`). `stop()`
// sends SIGTERM and escalates to SIGKILL if the process doesn't exit
// quickly, and is always safe to call twice.
//
// Never spawns the real (non-demo) backend, never plays sound
// (EVERWATCH_NO_SOUND=1), never opens a browser (`--no-open`).

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');

export const TOKEN = 'test';
export const SEED = 1;
// Matches docs/DESIGN.md §5.1/§7 and tests/golden/state_demo.json exactly
// (see everwatch/sources/demo_scenario.json's own "clock" field), so the
// golden fixture can stand in for "what a freshly spawned demo server's
// /api/state looks like" without re-deriving it here.
export const FIXED_CLOCK = 'fixed:2026-09-25T15:00:00-04:00';
export const PYTHON = process.env.EVERWATCH_E2E_PYTHON || 'python3';

const READY_RE = /^EVERWATCH_READY (\d+)\s*$/m;
const READY_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

/**
 * spawnBackend({ token, seed, clock, demoDiagnostics, extraArgs, env })
 * -> { url, port, token, proc, stop() }
 */
export async function spawnBackend({
  token = TOKEN, seed = SEED, clock = FIXED_CLOCK, demoDiagnostics = null,
  extraArgs = [], env = {},
} = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'everwatch-e2e-real-'));
  const args = [
    '-m', 'everwatch', 'serve', '--demo', '--seed', String(seed),
    '--port', '0', '--token', token, '--no-open',
  ];
  if (clock) args.push('--clock', clock);
  if (demoDiagnostics) args.push('--demo-diagnostics', demoDiagnostics);
  args.push(...extraArgs);

  const proc = spawn(PYTHON, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
      EVERWATCH_HOME: home,
      EVERWATCH_NO_SOUND: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.on('data', (d) => { stdoutBuf += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `everwatch serve --demo didn't print EVERWATCH_READY within ${READY_TIMEOUT_MS}ms\n`
        + `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    }, READY_TIMEOUT_MS);
    function onData() {
      const m = READY_RE.exec(stdoutBuf);
      if (m) { cleanup(); resolve(Number(m[1])); }
    }
    function onExit(code) {
      cleanup();
      reject(new Error(
        `everwatch serve --demo exited early (code ${code}) before EVERWATCH_READY\n`
        + `stdout: ${stdoutBuf}\nstderr: ${stderrBuf}`));
    }
    function cleanup() {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
    }
    proc.stdout.on('data', onData);
    proc.on('exit', onExit);
    onData(); // in case it raced ahead of the listener
  });

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const exited = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        proc.once('exit', () => { clearTimeout(t); resolve(true); });
      });
      if (!exited) proc.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    proc,
    home,
    stop,
    get stdout() { return stdoutBuf; },
    get stderr() { return stderrBuf; },
  };
}

/** Thin fetch client with the token header already set (mirrors
 * everwatch/web/js/api.mjs's own request()), for tests that assert on
 * server state directly rather than through the page. */
export function apiClient(server, { token = server.token } = {}) {
  async function request(method, p, body) {
    const headers = { 'X-Everwatch-Token': token, Accept: 'application/json' };
    const init = { method, headers };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(`${server.url}/api${p}`, init);
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; } }
    return { status: res.status, data };
  }
  return {
    request,
    getState: () => request('GET', '/state'),
    setLabel: (uid, label) => request('PUT', `/sessions/${encodeURIComponent(uid)}/label`, { label }),
    setColor: (uid, slot) => request('PUT', `/sessions/${encodeURIComponent(uid)}/color`, { slot: slot ?? null }),
    goto: (uid) => request('POST', `/sessions/${encodeURIComponent(uid)}/goto`, {}),
    closeTab: (windowId, tabIndex) => request('POST', `/tabs/${windowId}/${tabIndex}/close`, { confirm: true }),
    setProject: (n, name) => request('PUT', `/projects/${n}`, { name }),
    patchPrefs: (prefs) => request('PATCH', '/prefs', prefs),
    usageHistory: (since) => request('GET', `/usage/history${since !== undefined ? `?since=${since}` : ''}`),
    diagnostics: () => request('GET', '/diagnostics'),
  };
}
