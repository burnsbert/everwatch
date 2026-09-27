// SSE client (§3.5): EventSource on /api/events?token=…, JSON event
// dispatch, and a reconnect state machine with capped backoff plus a
// liveness watchdog (the server pings every 15 s). Everything external —
// EventSource, timers — is injected so node:test can drive it.

export const EVENT_TYPES = Object.freeze([
  'hello', 'state', 'screens', 'transition', 'notify', 'toast',
  'action_result', 'quota_prompt', 'diagnostics', 'ping',
]);

export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);
export const WATCHDOG_MS = 45000;

/** Delay before reconnect attempt `n` (0-based), capped at the last step. */
export function backoffDelay(n, steps = BACKOFF_MS) {
  return steps[Math.min(Math.max(0, n), steps.length - 1)];
}

// Native timers must be called unbound (`timers.setTimeout(...)` with
// `this === timers` throws "Illegal invocation" in browsers).
const REAL_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

/**
 * createEventStream({url, EventSourceImpl, onEvent(type, data, id),
 *   onStatus(status), onError(err), timers})
 * status: 'connecting' → 'open' → 'reconnecting' → 'open' … ; 'closed' after stop().
 */
export function createEventStream({
  url, EventSourceImpl, onEvent = () => {}, onStatus = () => {}, onError = () => {},
  timers = REAL_TIMERS, backoff = BACKOFF_MS, watchdogMs = WATCHDOG_MS,
}) {
  let es = null;
  let status = 'idle';
  let attempt = 0;
  let retryTimer = null;
  let watchdog = null;
  let stopped = false;

  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    onStatus(s);
  };

  const clearWatchdog = () => {
    if (watchdog !== null) timers.clearTimeout(watchdog);
    watchdog = null;
  };

  const armWatchdog = () => {
    clearWatchdog();
    if (!watchdogMs) return;
    watchdog = timers.setTimeout(() => {
      watchdog = null;
      reconnect('watchdog');
    }, watchdogMs);
  };

  const teardown = () => {
    if (!es) return;
    es.onopen = null;
    es.onerror = null;
    try { es.close(); } catch { /* already closed */ }
    es = null;
  };

  function handle(type, ev) {
    armWatchdog();
    let data = null;
    try {
      data = ev.data ? JSON.parse(ev.data) : null;
    } catch (err) {
      onError(Object.assign(new Error(`bad ${type} payload`), { cause: err, type }));
      return;
    }
    onEvent(type, data, ev.lastEventId || null);
  }

  function open() {
    if (stopped) return;
    teardown();
    setStatus(attempt === 0 && status !== 'reconnecting' ? 'connecting' : 'reconnecting');
    es = new EventSourceImpl(url);
    const mine = es;
    es.onopen = () => {
      if (es !== mine) return;
      attempt = 0;
      setStatus('open');
      armWatchdog();
    };
    es.onerror = () => {
      if (es !== mine) return;
      // CONNECTING (0): the browser is retrying on its own; CLOSED (2):
      // it gave up (e.g. HTTP error) and we must reconnect ourselves.
      if (mine.readyState === 2) reconnect('closed');
      else setStatus('reconnecting');
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => { if (es === mine) handle(type, ev); });
    }
    armWatchdog();
  }

  function reconnect(reason) {
    if (stopped) return;
    teardown();
    clearWatchdog();
    setStatus('reconnecting');
    if (retryTimer !== null) return;
    const delay = backoffDelay(attempt, backoff);
    attempt += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
    onError(Object.assign(new Error(`sse ${reason}; retry in ${delay}ms`), { reason, delay }));
  }

  return {
    start() {
      stopped = false;
      open();
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      clearWatchdog();
      teardown();
      setStatus('closed');
    },
    /** Force a reconnect now (e.g. after the window regains focus). */
    reconnect: () => reconnect('manual'),
    get status() { return status; },
    get attempt() { return attempt; },
  };
}
