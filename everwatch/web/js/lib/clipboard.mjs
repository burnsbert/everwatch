// Best-effort clipboard copy for "copy this command" buttons (diagnostics'
// `command`/`copy` action kinds — build/wp7-handoff.md). No external
// resources, no dependencies. `navigator.clipboard` needs a secure context
// and (in some embedders) a permission grant it may not have; the
// `execCommand('copy')` fallback works from a real user gesture even
// without that permission, including in headless Chromium. Either path is
// silently swallowed on failure — the button's own "Copied!" label change
// is the only feedback offered, deliberately, so a denied clipboard
// permission never surfaces as a scary error for a low-stakes convenience
// action.
export function copyText(text, doc = document, nav = navigator) {
  const value = String(text ?? '');
  try {
    if (nav?.clipboard?.writeText) {
      nav.clipboard.writeText(value).catch(() => fallbackCopy(value, doc));
      return;
    }
  } catch { /* fall through */ }
  fallbackCopy(value, doc);
}

function fallbackCopy(value, doc) {
  try {
    const ta = doc.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.append(ta);
    ta.select();
    doc.execCommand?.('copy');
    ta.remove();
  } catch { /* best effort only */ }
}
