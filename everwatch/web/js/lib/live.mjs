// Live-preview lease (docs/DESIGN.md W-10). While the selected session's
// preview is on screen and the page is visible, hold a lease on that one
// session (POST /api/sessions/{uid}/live, renewed every RENEW_MS; the
// server drops a lease after 6 s without a renewal) so the backend re-reads
// its screen about once a second instead of every snapshot. Switching
// sessions or hiding the preview releases it (DELETE). Failures are
// silent — the preview just falls back to the normal snapshot cadence.

export const RENEW_MS = 2000;

/** The uid that should be live for this UI state, or null. */
export function liveTargetOf({ route, view, compact, visible, session }) {
  if (!visible || compact || route !== 'main') return null;
  if (view !== 'split' && view !== 'zoom') return null;
  if (!session || session.is_self || session.is_dashboard) return null;
  return session.uid || null;
}

export function createLiveLease({
  api, renewMs = RENEW_MS, timers = { setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: (t) => globalThis.clearInterval(t) },
} = {}) {
  let current = null;
  let timer = null;
  const quiet = (p) => { p?.catch?.(() => {}); };

  function set(uid) {
    const next = uid || null;
    if (next === current) return;
    if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
    if (current) quiet(api.live(current, false));
    current = next;
    if (current) {
      const leased = current;
      quiet(api.live(leased, true));
      timer = timers.setInterval(() => quiet(api.live(leased, true)), renewMs);
    }
  }

  return {
    set,
    stop: () => set(null),
    get current() { return current; },
  };
}
