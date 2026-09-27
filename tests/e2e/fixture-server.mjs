// A tiny stand-in for `python3 -m everwatch serve --demo` so WP4's e2e tests
// can run before the real HTTP/SSE server lands (WP3). It serves
// everwatch/web with the §3.8 security headers and implements the §3.5 API
// in memory: token + JSON content-type checks, a real SSE stream
// (`hello`, `state`, `screens`, …), and a call log tests can assert on.
//
// WP9 swap: point playwright.config.mjs's webServer at the Python demo
// server and replace `backend.*` control calls with demo-scenario steps.
//
// Usage (in tests): `const b = await startFixtureServer(); … b.emit('state', …); await b.close();`
// Usage (CLI):      `node tests/e2e/fixture-server.mjs --port 4178`

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../everwatch/web');
export const FIXTURE_PATH = path.resolve(HERE, '../js/fixtures/state_sample.json');
export const TOKEN = 'test';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'";

export function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

// Default `Diagnostics` (§3.5 / build/wp7-handoff.md): the 13 backend
// checks in CHECK_ORDER, shaped like the `all_ok` demo preset so a test that
// doesn't care about diagnostics still sees something plausible. Tests that
// do care use `backend.patchCheck(id, patch)` / `backend.setDiagnostics(...)`.
function defaultDiagnostics(now, agents = 0) {
  const ok = (id, title, detail) => ({
    id, title, status: 'ok', detail, action: null,
  });
  return {
    generated_at: now,
    checks: [
      ok('python_version', 'Python 3.9+', 'Python 3.11 is running Everwatch.'),
      ok('iterm_installed', 'iTerm2 installed', 'iTerm2 is installed.'),
      ok('iterm_running', 'iTerm2 running', 'iTerm2 is running.'),
      ok('automation', 'Automation → iTerm2', 'Everwatch can already control iTerm2.'),
      ok('shell_integration', 'Shell integration', 'Every session reports its working directory.'),
      ok('agents_detected', 'Agents detected', `${agents} agent session(s) running.`), // matches the header's count
      ok('claude_usage', 'Claude usage', 'Usage data is current.'),
      ok('codex_usage', 'Codex usage', 'Usage data is current.'),
      ok('tab_colors', 'Tab colors', 'Tab colors are working.'),
      {
        id: 'notifications', title: 'Notifications', status: 'unknown', detail: "Notifications aren't available in browser mode.", action: null,
      },
      {
        id: 'hotkeys', title: 'Hotkeys', status: 'unknown', detail: "Hotkeys aren't available in browser mode.", action: null,
      },
      ok('quota_email', 'Quota email', 'Enabled at 90% of the monthly limit.'),
      {
        id: 'ultrawatch_import', title: 'ultrawatch import', status: 'info', detail: 'No ultrawatch state.json was found.', action: null,
      },
    ],
  };
}

// The two checks the real backend derives from the live iTerm2 status on
// every tick (everwatch/diagnostics.py check_iterm_running/check_automation,
// browser-mode shape), so a test that sets `iterm.status` never shows a
// header chip that disagrees with Diagnostics.
const LAUNCH = { kind: 'endpoint', label: 'Launch iTerm2', method: 'POST', path: '/api/iterm/launch' };
function itermChecks(status) {
  const running = status === 'not_running'
    ? { status: 'warn', detail: "iTerm2 isn't running. Everwatch keeps polling and recovers on its own once it starts.", action: LAUNCH }
    : status === 'connecting'
      ? { status: 'info', detail: 'Connecting to iTerm2…', action: null }
      : { status: 'ok', detail: 'iTerm2 is running.', action: null };
  const automation = status === 'permission_denied'
    ? {
      status: 'error',
      detail: 'Everwatch needs permission to control iTerm2. Open System Settings → Privacy & Security → Automation, find Everwatch, and enable iTerm2.',
      action: { kind: 'link', label: 'Open System Settings', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation' },
    }
    : status === 'ok'
      ? { status: 'ok', detail: 'Everwatch can already control iTerm2.', action: null }
      : {
        status: 'unknown',
        detail: 'Automation permission is not yet known -- it is granted the first time Everwatch successfully queries iTerm2.',
        action: { kind: 'endpoint', label: 'Connect to iTerm2', method: 'POST', path: '/api/refresh' },
      };
  return { iterm_running: running, automation };
}

export async function startFixtureServer({ port = 0, fixture = loadFixture(), sseHello = true } = {}) {
  let state = structuredClone(fixture);
  let rev = state.rev || 1;
  let actionSeq = 0;
  let diagnostics = defaultDiagnostics(state.now, state.counts?.agents);
  const calls = [];
  const clients = new Set();
  const opts = { sseHello, failNext: {}, autoActionResult: true, sseReject: false };

  const withoutScreens = () => {
    const { screens, ...rest } = state;
    return rest;
  };

  function send(res, type, data) {
    rev += 1;
    res.write(`id: ${rev}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function emit(type, data) {
    for (const res of clients) send(res, type, data);
  }

  function broadcastState() {
    state.rev = ++rev;
    emit('state', withoutScreens());
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return { __invalid: raw }; }
  }

  const session = (uid) => state.sessions.find((s) => s.uid === uid);

  async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    if (p === '/api/events') {
      if (url.searchParams.get('token') !== TOKEN) return json(res, 403, { error: 'forbidden' });
      if (opts.sseReject) return json(res, 503, { error: 'unavailable' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 500\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      if (opts.sseHello) send(res, 'hello', { version: state.version, config: { snapshot_interval: 2, fresh_seconds: 30, flash_seconds: 1.5, toast_seconds: 3.5 }, state: withoutScreens() });
      return undefined;
    }
    if (req.headers['x-everwatch-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
    const mutating = method !== 'GET';
    if (mutating && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 403, { error: 'content-type' });
    }
    const b = mutating ? await body(req) : {};
    calls.push({ method, path: p, body: b });
    const fail = opts.failNext[p];
    if (fail) {
      delete opts.failNext[p];
      return json(res, fail.status, fail.body);
    }
    let m;
    if (method === 'GET' && p === '/api/state') return json(res, 200, state);
    if (method === 'GET' && (m = /^\/api\/sessions\/([^/]+)\/screen$/.exec(p))) {
      const uid = decodeURIComponent(m[1]);
      const s = session(uid);
      return s ? json(res, 200, { uid, text: state.screens[uid] || '', screen_hash: s.screen_hash }) : json(res, 404, { error: 'no such session' });
    }
    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/(goto|visit)$/.exec(p))) {
      const uid = decodeURIComponent(m[1]);
      const s = session(uid);
      if (!s) return json(res, 404, { error: 'no such session' });
      if (m[2] === 'visit') {
        s.attention = false;
        broadcastState();
        return json(res, 200, { ok: true });
      }
      const id = `a${++actionSeq}`;
      json(res, 200, { id });
      if (opts.autoActionResult) setTimeout(() => emit('action_result', { id, kind: 'goto', ok: true, detail: '' }), 10);
      return undefined;
    }
    // W-10 live preview lease + reply (the real backend's rules live in
    // everwatch/terminput.py; tests/e2e/reply.spec.mjs drives screen changes
    // itself with setScreens / emit).
    if ((method === 'POST' || method === 'DELETE') && (m = /^\/api\/sessions\/([^/]+)\/live$/.exec(p))) {
      const live = method === 'POST' && !!session(decodeURIComponent(m[1])); // best-effort, never 404s
      return json(res, 200, { ok: true, live, interval: 1, lease: 6 });
    }
    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/send$/.exec(p))) {
      if (!session(decodeURIComponent(m[1]))) return json(res, 404, { error: 'unknown_session' });
      const id = `a${++actionSeq}`;
      json(res, 200, { id });
      if (opts.autoActionResult) setTimeout(() => emit('action_result', { id, kind: 'send', ok: true, detail: '' }), 10);
      return undefined;
    }
    if (method === 'PUT' && (m = /^\/api\/sessions\/([^/]+)\/label$/.exec(p))) {
      const s = session(decodeURIComponent(m[1]));
      if (!s) return json(res, 404, { error: 'no such session' });
      const label = String(b.label ?? '').trim();
      s.label = label;
      s.display_name = label || s.name;
      s.title = label || s.title;
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (method === 'PUT' && (m = /^\/api\/sessions\/([^/]+)\/color$/.exec(p))) {
      const s = session(decodeURIComponent(m[1]));
      if (!s) return json(res, 404, { error: 'no such session' });
      const SLOT_COLORS = ['blue', 'purple', 'green', 'red', 'yellow'];
      s.project = b.slot ?? null;
      s.tab_color = b.slot ? SLOT_COLORS[b.slot - 1] : null;
      state.projects = {
        ...state.projects,
        slots: (state.projects?.slots || []).map((slot) => ({
          ...slot,
          count: state.sessions.filter((x) => x.project === slot.n).length,
        })),
      };
      broadcastState();
      return json(res, 200, { id: `a${++actionSeq}` });
    }
    if (method === 'POST' && p === '/api/tabs/new') return json(res, 200, { id: `a${++actionSeq}` });
    if (method === 'POST' && /^\/api\/tabs\/\d+\/\d+\/close$/.test(p)) {
      return b.confirm === true ? json(res, 200, { id: `a${++actionSeq}` }) : json(res, 400, { error: 'confirm required' });
    }
    if (method === 'PUT' && (m = /^\/api\/projects\/(\d)$/.exec(p))) {
      const n = Number(m[1]);
      state.projects = {
        ...state.projects,
        slots: (state.projects?.slots || []).map((slot) => (slot.n === n ? { ...slot, name: String(b.name ?? '').trim() } : slot)),
      };
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE' && p === '/api/projects') {
      state.projects = { ...state.projects, slots: (state.projects?.slots || []).map((slot) => ({ ...slot, name: '' })) };
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/api/history') {
      const uid = url.searchParams.get('uid');
      const all = state.historyTransitions || [];
      if (uid) {
        const stats = (state.historyStats || {})[uid] || { count: 0, seconds: 0 };
        return json(res, 200, { transitions: all.filter((t) => t.uid === uid), stats });
      }
      return json(res, 200, { transitions: all });
    }
    if (method === 'GET' && p === '/api/usage/history') {
      const since = Number(url.searchParams.get('since') || 0);
      const samples = (state.usageHistorySamples || []).filter((s) => s.at >= since);
      return json(res, 200, { samples });
    }
    if (method === 'POST' && ['/api/refresh', '/api/iterm/launch', '/api/quota/draft', '/api/quota/skip'].includes(p)) return json(res, 200, { ok: true });
    if (method === 'GET' && p === '/api/diagnostics') return json(res, 200, diagnostics);
    if (method === 'POST' && p === '/api/diagnostics/recheck') {
      diagnostics = { ...diagnostics, generated_at: state.now };
      emit('diagnostics', diagnostics);
      return json(res, 200, diagnostics);
    }
    if (method === 'POST' && p === '/api/colors/install') return json(res, 200, { id: `a${++actionSeq}` });
    if (method === 'POST' && p === '/api/import/ultrawatch') {
      return json(res, 200, { imported: { labels: 2, projects: 1, prefs: ['view', 'sort'] } });
    }
    if (method === 'PATCH' && p === '/api/prefs') {
      const prefs = { ...state.prefs, ...b };
      if (typeof prefs.split_ratio === 'number') prefs.split_ratio = Math.max(0.2, Math.min(0.8, Math.round(prefs.split_ratio * 100) / 100));
      state.prefs = prefs;
      // The real backend surfaces these two confirmed values outside
      // `prefs` (`projects.open`, top-level `debug_state`); mirror that here
      // so the client's fallback-to-server-truth path is exercised too.
      if ('projects_open' in b) state.projects = { ...state.projects, open: !!b.projects_open };
      if ('debug_state' in b) state.debug_state = !!b.debug_state;
      broadcastState();
      return json(res, 200, prefs);
    }
    return json(res, 404, { error: `no route ${method} ${p}` });
  }

  async function staticFile(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(WEB, `.${rel}`);
    if (!file.startsWith(WEB + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handle = url.pathname.startsWith('/api/') ? api : staticFile;
    handle(req, res, url).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err) });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    calls,
    opts,
    get state() { return state; },
    get clientCount() { return clients.size; },
    emit,
    /** Replace/merge top-level state and push a `state` event. */
    setState(patch) {
      const before = state.iterm?.status;
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      broadcastState();
      if (state.iterm?.status !== before) {
        const derived = itermChecks(state.iterm?.status);
        diagnostics = {
          ...diagnostics,
          generated_at: state.now,
          checks: diagnostics.checks.map((c) => (derived[c.id] ? { ...c, ...derived[c.id] } : c)),
        };
        emit('diagnostics', diagnostics);
      }
    },
    /** Patch one session by uid and push a `state` event. */
    patchSession(uid, patch) {
      state.sessions = state.sessions.map((s) => (s.uid === uid ? { ...s, ...patch } : s));
      broadcastState();
    },
    setScreens(screens) {
      state.screens = { ...state.screens, ...screens };
      emit('screens', { rev: ++rev, screens });
    },
    get diagnostics() { return diagnostics; },
    /** Replace/merge the whole `Diagnostics` object and push a `diagnostics` event. */
    setDiagnostics(patch) {
      diagnostics = { ...diagnostics, ...(typeof patch === 'function' ? patch(diagnostics) : patch), generated_at: state.now };
      emit('diagnostics', diagnostics);
    },
    /** Patch one check by id (e.g. `backend.patchCheck('automation', {status:'error', ...})`). */
    patchCheck(id, patch) {
      diagnostics = {
        ...diagnostics,
        generated_at: state.now,
        checks: diagnostics.checks.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      };
      emit('diagnostics', diagnostics);
    },
    reset(fx = fixture) {
      state = structuredClone(fx);
      diagnostics = defaultDiagnostics(state.now, state.counts?.agents);
      calls.length = 0;
      opts.failNext = {};
      opts.sseHello = sseHello;
      opts.autoActionResult = true;
      opts.sseReject = false;
    },
    /** End every open SSE stream cleanly (the page's EventSource reconnects). */
    dropClients() {
      for (const res of clients) res.end();
      clients.clear();
    },
    async close() {
      for (const res of clients) res.destroy();
      clients.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 4178;
  startFixtureServer({ port }).then((s) => {
    process.stdout.write(`fixture server ${s.url}/#t=${TOKEN}\n`);
  });
}
