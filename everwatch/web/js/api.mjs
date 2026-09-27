// JSON API client for every §3.5 endpoint. Every request carries
// `X-Everwatch-Token`; mutating requests are `Content-Type: application/json`
// (the server 403s anything else, §3.8). `fetch` is injected for tests.

export const TOKEN_HEADER = 'X-Everwatch-Token';
export const TOKEN_STORAGE_KEY = 'everwatch.token';

export class ApiError extends Error {
  constructor(status, body, path) {
    const detail = body && typeof body === 'object' && body.error ? body.error : `HTTP ${status}`;
    super(`${path}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/**
 * Where the token comes from, in order: the shell's document-start script
 * (`window.everwatchNative.token`), a `#t=<token>` fragment from
 * `everwatch open` (moved into sessionStorage and stripped from the URL),
 * then sessionStorage from an earlier load of this tab.
 */
export function resolveToken({ native, location, storage, history } = {}) {
  if (native && typeof native.token === 'string' && native.token) return native.token;
  const hash = location?.hash || '';
  const m = /^#(?:.*&)?t=([^&]+)/.exec(hash);
  if (m) {
    const token = decodeURIComponent(m[1]);
    try { storage?.setItem(TOKEN_STORAGE_KEY, token); } catch { /* private mode */ }
    if (history?.replaceState && location) {
      history.replaceState(null, '', `${location.pathname || '/'}${location.search || ''}`);
    }
    return token;
  }
  try {
    return storage?.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

const enc = encodeURIComponent;

function query(params) {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function createApi({ token = '', base = '', fetchImpl = globalThis.fetch } = {}) {
  async function request(method, path, body) {
    const headers = { [TOKEN_HEADER]: token, Accept: 'application/json' };
    const init = { method, headers, cache: 'no-store', credentials: 'same-origin' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetchImpl(`${base}/api${path}`, init);
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
    }
    if (!res.ok) throw new ApiError(res.status, data, path);
    return data;
  }

  return {
    token,
    request,
    eventsUrl: () => `${base}/api/events${query({ token })}`,
    getState: () => request('GET', '/state'),
    getScreen: (uid) => request('GET', `/sessions/${enc(uid)}/screen`),
    goto: (uid) => request('POST', `/sessions/${enc(uid)}/goto`, {}),
    visit: (uid) => request('POST', `/sessions/${enc(uid)}/visit`, {}),
    // W-10: type into a session ({text, enter} or {key}); hold/release a live-preview lease
    send: (uid, body) => request('POST', `/sessions/${enc(uid)}/send`, body),
    live: (uid, on = true) => request(on ? 'POST' : 'DELETE', `/sessions/${enc(uid)}/live`, {}),
    setLabel: (uid, label) => request('PUT', `/sessions/${enc(uid)}/label`, { label }),
    setColor: (uid, slot) => request('PUT', `/sessions/${enc(uid)}/color`, { slot: slot ?? null }),
    newTab: () => request('POST', '/tabs/new', {}),
    closeTab: (windowId, tabIndex) => request('POST', `/tabs/${enc(windowId)}/${enc(tabIndex)}/close`, { confirm: true }),
    refresh: () => request('POST', '/refresh', {}),
    patchPrefs: (prefs) => request('PATCH', '/prefs', prefs),
    setProject: (n, name) => request('PUT', `/projects/${enc(n)}`, { name }),
    clearProjects: () => request('DELETE', '/projects', {}),
    history: ({ uid, minutes = 60 } = {}) => request('GET', `/history${query({ uid, minutes })}`),
    usageHistory: ({ since } = {}) => request('GET', `/usage/history${query({ since })}`),
    diagnostics: () => request('GET', '/diagnostics'),
    recheckDiagnostics: () => request('POST', '/diagnostics/recheck', {}),
    quotaDraft: () => request('POST', '/quota/draft', {}),
    quotaSkip: () => request('POST', '/quota/skip', {}),
    installColors: () => request('POST', '/colors/install', {}),
    importUltrawatch: () => request('POST', '/import/ultrawatch', {}),
    launchIterm: () => request('POST', '/iterm/launch', {}),
  };
}
