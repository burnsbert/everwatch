// Web ↔ Swift shell bridge (§3.5, shell/README.md "Web ↔ shell contract").
// Web → shell: window.webkit.messageHandlers.everwatch.postMessage(obj).
// Shell → web: the shell's document-start script defines
// window.everwatchNative = {shell, token, shellVersion, queue, dispatch};
// install() replaces `dispatch` and drains `queue`. There is no sound
// message: the shell decides sound on its own (§1 P-66).

export const OUTBOUND = Object.freeze([
  'appearance', 'openCompact', 'openSettings', 'requestNotifications',
  'openSystemSettings', 'setHotkeys', 'ready',
]);
export const INBOUND = Object.freeze(['notificationClicked', 'focus', 'openSettings', 'nativeStatus']);

export function createBridge(win = globalThis) {
  const native = win?.everwatchNative || null;
  const handler = () => win?.webkit?.messageHandlers?.everwatch || null;
  const shell = !!(native && native.shell);
  let installed = false;

  function post(msg) {
    if (!msg || !OUTBOUND.includes(msg.type)) throw new Error(`unknown bridge message ${msg?.type}`);
    const h = handler();
    if (!h || typeof h.postMessage !== 'function') return false;
    try {
      h.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  return {
    shell,
    shellVersion: native?.shellVersion || '',
    available: () => !!handler(),
    post,
    /** Route shell → web messages to `onMessage`, including any queued ones. */
    install(onMessage) {
      if (!native || installed) return 0;
      installed = true;
      const accept = (m) => {
        if (m && typeof m === 'object' && INBOUND.includes(m.type)) onMessage(m);
      };
      native.dispatch = accept;
      const queued = Array.isArray(native.queue) ? native.queue.splice(0) : [];
      queued.forEach(accept);
      return queued.length;
    },
    appearance: (theme) => post({ type: 'appearance', theme }),
    openCompact: () => post({ type: 'openCompact' }),
    openSettings: () => post({ type: 'openSettings' }),
    requestNotifications: () => post({ type: 'requestNotifications' }),
    openSystemSettings: (pane) => post({ type: 'openSystemSettings', pane }),
    setHotkeys: (show, next) => post({ type: 'setHotkeys', show, next }),
    ready: () => post({ type: 'ready' }),
  };
}
