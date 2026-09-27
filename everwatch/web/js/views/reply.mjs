// Reply bar (docs/DESIGN.md W-10): sits under the preview's screen and types
// into the selected iTerm2 session through POST /api/sessions/{uid}/send.
// A text box (↩ sends it and presses Return, ⇧↩ types it without Return),
// Esc / ⌃C / ↩ key buttons, and — when the screen shows a Claude Code /
// Codex menu or a y/n question (lib/prompts.mjs) — one quick-reply button
// per answer. Nothing is ever sent without a click or a keypress in the box.
// A quick reply carries the screen_hash of the screen it was read from; the
// backend re-reads the session and refuses if it changed (a stale screen
// must never approve a prompt the user didn't see). "Don't ask again" /
// "always" answers get no button (docs/DESIGN.md §2).
// Keys typed in the box never reach the global keymap (main.mjs ignores
// form controls other than the filter and palette inputs).

import { h, setText, attr, reconcile } from './dom.mjs';
import { detectPrompt, sanitizeReply, optionLabel, quickReplies } from '../lib/prompts.mjs';

export const KEY_NAMES = { esc: 'Esc', 'ctrl-c': 'Ctrl-C', enter: 'Return' };

function errorText(err) {
  const b = err?.body;
  if (b && typeof b === 'object') return b.detail || b.error || err.message;
  return err?.message || 'request failed';
}

let seq = 0;

export function createReplyBar({ api, store }) {
  seq += 1;
  const hintId = `reply-hint-${seq}`; // split and zoom each have a bar
  const quickList = h('div', { class: 'reply-quick-list' });
  const quick = h('div', { class: 'reply-quick', role: 'group', 'aria-label': 'Quick replies', hidden: true },
    h('span', { class: 'reply-quick-label', text: 'Reply' }), quickList);
  const input = h('input', {
    class: 'reply-input', type: 'text', maxlength: '2000',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-label': 'Type into this session', 'aria-describedby': hintId,
  });
  const sendBtn = h('button', { type: 'button', class: 'btn btn--small btn--primary reply-send', title: 'Type it and press Return (↩)', text: 'Send' });
  const keyBtn = (key, text) => h('button', {
    type: 'button', class: 'btn btn--small reply-key', dataset: { key }, text,
    title: `Send ${KEY_NAMES[key]}`, 'aria-label': `Send ${KEY_NAMES[key]}`,
  });
  const keys = h('div', { class: 'reply-keys' }, keyBtn('esc', 'Esc'), keyBtn('ctrl-c', '⌃C'), keyBtn('enter', '↩'));
  const hint = h('p', { id: hintId, class: 'reply-hint', text: '↩ send + Return · ⇧↩ type without Return · esc leave the box' });
  const root = h('div', { class: 'reply', hidden: true },
    quick, h('div', { class: 'reply-form' }, input, sendBtn, keys), hint);

  let uid = null;
  let name = '';
  let screenHash = null;
  let inflight = 0;

  const toast = (message, level) => store?.dispatch({ type: 'toast', message, level, key: 'reply' });

  async function send(body, what) {
    if (!uid) return false;
    const target = uid;
    const who = name;
    inflight += 1;
    sendBtn.disabled = true;
    try {
      await api.send(target, body);
      toast(`Sent ${what} to ${who}`, 'info');
      return true;
    } catch (err) {
      toast(`Couldn't send to ${who}: ${errorText(err)}`, 'danger');
      return false;
    } finally {
      inflight -= 1;
      sendBtn.disabled = inflight > 0;
    }
  }

  async function sendText(enter) {
    const text = sanitizeReply(input.value);
    if (!text) {
      input.focus();
      return;
    }
    const ok = await send({ text, enter }, enter ? `“${text}” + Return` : `“${text}”`);
    if (ok && sanitizeReply(input.value) === text) input.value = '';
  }

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      sendText(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.blur();
      root.closest('.preview')?.querySelector('.screen')?.focus();
    }
  });
  sendBtn.addEventListener('click', () => sendText(true));
  keys.addEventListener('click', (e) => {
    const b = e.target.closest('.reply-key');
    if (b) send({ key: b.dataset.key }, KEY_NAMES[b.dataset.key]);
  });
  quickList.addEventListener('click', (e) => {
    const b = e.target.closest('.reply-option');
    if (b?.__option) send({ ...b.__option.send, expect_hash: b.__hash ?? undefined }, `“${b.textContent}”`);
  });

  function update({ session: s, screen } = {}) {
    const show = !!s && !s.is_self && !s.is_dashboard;
    root.hidden = !show;
    if (!show) {
      uid = null;
      return;
    }
    if (s.uid !== uid) input.value = ''; // a draft belongs to the session it was typed for
    uid = s.uid;
    name = s.display_name || s.name || 'session';
    attr(input, 'placeholder', `Type to ${name}…`);

    const prompt = detectPrompt(screen || '', { kind: s.kind || null });
    const options = quickReplies(prompt);
    screenHash = Number.isInteger(s.screen_hash) ? s.screen_hash : null;
    quick.hidden = !options.length;
    attr(quick, 'title', prompt?.question || null);
    reconcile(quickList, options, (o) => `${prompt.kind}:${o.n}:${o.label}`,
      () => h('button', { type: 'button', class: 'btn btn--small reply-option' }),
      (el, o) => {
        el.__option = o;
        el.__hash = screenHash;
        setText(el, optionLabel(o, prompt.kind));
        el.classList.toggle('is-selected', !!o.selected);
        attr(el, 'title', o.send.key ? `Send ${KEY_NAMES[o.send.key] || o.send.key}` : `Send “${o.send.text}”${o.send.enter ? ' + Return' : ''}`);
      });
  }

  return { el: root, update, input };
}
