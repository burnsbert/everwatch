// Quota-email prompt (P-69): an in-app modal replacing ultrawatch's
// `osascript display dialog`. Driven by `state.quotaPrompt` (SSE
// `quota_prompt` event / echoed in `State`). "Skip This Month" and "Draft
// Email" both mark the month server-side; only Draft opens the Gmail URL
// (server-side, via `open`). This view just posts the two endpoints.

import { setText } from './dom.mjs';

export function createQuota({ api, store, doc = document }) {
  const dialog = doc.getElementById('quota-dialog');
  const body = doc.getElementById('quota-body');
  const skipBtn = doc.getElementById('quota-skip');
  const draftBtn = doc.getElementById('quota-draft');

  function dismiss() {
    store.dispatch({ type: 'quotaPrompt' });
  }
  function fail(kind) {
    return (err) => store.dispatch({ type: 'toast', message: `${kind} failed: ${err?.body?.error || err?.message || err}`, level: 'danger' });
  }
  skipBtn.addEventListener('click', () => { api.quotaSkip().catch(fail('quota skip')); dismiss(); });
  draftBtn.addEventListener('click', () => { api.quotaDraft().catch(fail('quota draft')); dismiss(); });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); api.quotaSkip().catch(fail('quota skip')); dismiss(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) { api.quotaSkip().catch(fail('quota skip')); dismiss(); } });

  return {
    update(m) {
      const q = m.quotaPrompt;
      if (!q) {
        if (dialog.open) dialog.close();
        return;
      }
      setText(body, `Claude usage is at ${Math.round(q.pct ?? 0)}% of this month’s limit${q.to ? `, projected to hit it ${q.to}` : ''}. Draft a heads-up email now, or skip for this month.`);
      if (!dialog.open) {
        dialog.showModal();
        skipBtn.focus();
      }
    },
  };
}
