// Settings (docs/DESIGN.md §4.2 / build/wp4-handoff.md "extension points").
// Appearance, Notifications, Sound, Hotkeys, Display, Projects, Data, About.
// Every toggle/select is a thin wrapper over `run('theme.set'|'hints.toggle'
// |'sound.toggle'|'dollars.toggle'|'debug.toggle'|'hotkeys.set', …)` or a
// direct `setPrefs`-backed command already registered in commands.mjs — this
// view owns no persistence logic of its own.
// Presentation (docs/design/VISUAL_SPEC.md §4.15): System Settings grouping —
// the section title sits outside one group per section, rows inside it with
// inset hairlines, the control right-aligned; the hotkey recorder is a
// single field with an inline clear button.

import { h, icon, setText, attr } from './dom.mjs';
import { createPage } from './page.mjs';
import { mergeNativeStatus, findCheck } from '../lib/diagnostics_ui.mjs';
import {
  actionButton, codeNodes, copyButton, requestDiagnosticsOnce,
} from './diag_actions.mjs';
import { GITHUB_URL, LICENSE_URL, RELEASES_URL } from '../lib/links.mjs';
import { keyOf } from '../keymap.mjs';

function section(title, ...rows) {
  return h('section', { class: 'settings-section' },
    h('h3', { class: 'settings-h3', text: title }),
    h('div', { class: 'settings-group' }, ...rows));
}

/** One row: label (+ optional description node) on the left, controls right. */
function row(label, desc, ...controls) {
  return h('div', { class: 'settings-row' },
    h('div', { class: 'settings-row-text' },
      h('span', { class: 'settings-row-label', text: label }),
      desc ? (typeof desc === 'string' ? h('span', { class: 'settings-row-desc', text: desc }) : desc) : null),
    controls.length ? h('div', { class: 'settings-row-control' }, ...controls) : null);
}

/** A labelled checkbox styled as a switch (settings.css `.toggle`). */
function toggleRow(label, desc, onChange) {
  const input = h('input', { type: 'checkbox', class: 'toggle-input' });
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: 'settings-row settings-row--toggle' },
    h('div', { class: 'settings-row-text' },
      h('span', { class: 'settings-row-label', text: label }),
      desc ? h('span', { class: 'settings-row-desc', text: desc }) : null),
    h('span', { class: 'toggle' }, input, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' }))));
  row.__input = input;
  return row;
}

function setToggle(row, checked) {
  if (row.__input.checked !== checked) row.__input.checked = checked;
}

/** `opt+cmd+e` (the persisted `hotkey_*` pref format) → `⌥⌘E`. */
function hotkeyDisplay(spec) {
  if (!spec) return '(none)';
  const glyphs = { opt: '⌥', cmd: '⌘', ctrl: '⌃', shift: '⇧' };
  const parts = spec.split('+').filter(Boolean);
  const main = parts.pop();
  return parts.map((p) => glyphs[p] || p).join('') + main.toUpperCase();
}

/** KeyboardEvent → `opt+cmd+e` pref format, or `null` with no real key yet
 * (a bare modifier) or no modifier at all (Carbon hotkeys need at least one). */
function hotkeySpecFromEvent(e) {
  const k = keyOf(e); // reuses keymap.mjs's key-name normalisation
  if (!k) return null;
  const bits = k.split('+');
  const main = bits.pop();
  if (main === 'Escape') return { cancel: true };
  const mods = [];
  if (bits.includes('Alt')) mods.push('opt');
  if (bits.includes('Meta')) mods.push('cmd');
  if (bits.includes('Ctrl')) mods.push('ctrl');
  if (bits.includes('Shift')) mods.push('shift');
  if (!mods.length) return { invalid: true };
  return { spec: `${mods.join('+')}+${main.toLowerCase()}` };
}

/** §4.15 hotkey recorder: one 24px field showing the shortcut (or "Record
 * Shortcut"), click to record (focus border while recording), and an
 * inline × to clear. */
function hotkeyRow(label, prefKey, otherPrefKey, run) {
  const value = h('span', { class: 'hotkey-value' });
  const status = h('span', { class: 'settings-row-desc hotkey-status' });
  const rec = h('button', { type: 'button', class: 'hotkey-record' }, value);
  const clear = h('button', {
    type: 'button', class: 'hotkey-clear', 'aria-label': `Clear shortcut for ${label}`, 'data-tip': 'Clear shortcut',
  }, icon('close', 'icon icon--sm'));
  const field = h('span', { class: 'hotkey-field' }, rec, clear);
  let recording = false;
  let current = { show: '', next: '' };
  let shown = '';

  function paint() {
    field.classList.toggle('is-recording', recording);
    field.classList.toggle('is-empty', !shown && !recording);
    setText(value, recording ? 'Type Shortcut…' : (shown || 'Record Shortcut'));
    attr(rec, 'aria-label', recording ? 'Press keys… (esc to cancel)'
      : `Record shortcut for ${label}, currently ${shown || 'none'}`);
    clear.hidden = !shown || recording;
  }
  function stop(commitSpec) {
    recording = false;
    paint();
    if (commitSpec !== undefined) {
      const patch = { show: current.show, next: current.next, [prefKey === 'hotkey_show' ? 'show' : 'next']: commitSpec };
      run('hotkeys.set', patch);
    }
  }
  function onKeydown(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const r = hotkeySpecFromEvent(e);
    if (!r) return; // bare modifier — keep listening
    if (r.cancel) { stop(); return; }
    if (r.invalid) { setText(status, 'Add ⌘, ⌥, ⌃, or ⇧ plus a key'); return; }
    stop(r.spec);
  }
  rec.addEventListener('click', () => {
    if (recording) { stop(); return; }
    recording = true;
    paint();
    setText(status, '');
    rec.focus();
  });
  rec.addEventListener('keydown', onKeydown);
  rec.addEventListener('blur', () => { if (recording) stop(); });
  clear.addEventListener('click', () => {
    const patch = { show: current.show, next: current.next, [prefKey === 'hotkey_show' ? 'show' : 'next']: '' };
    run('hotkeys.set', patch);
  });

  const el = h('div', { class: 'settings-row settings-row--hotkey' },
    h('div', { class: 'settings-row-text' }, h('span', { class: 'settings-row-label', text: label }), status),
    h('div', { class: 'settings-row-control' }, field));
  el.__set = (prefs, native) => {
    current = { show: prefs.hotkey_show, next: prefs.hotkey_next };
    shown = prefs[prefKey] ? hotkeyDisplay(prefs[prefKey]) : '';
    if (!recording) paint();
    if (!native) { setText(status, ''); return; }
    const state = prefKey === 'hotkey_show' ? native.show : native.next;
    if (!recording) {
      setText(status, state === 'conflict' ? 'Conflicts with another app'
        : state === 'invalid' ? 'Not a valid shortcut'
          : state === 'error' ? 'Failed to register'
            : state === 'disabled' ? 'Turned off' : '');
    }
  };
  paint();
  return el;
}

export function createSettingsView({ run, store, api }) {
  let requested = false;
  const themeButtons = ['system', 'light', 'dark'].map((t) => h('button', {
    type: 'button', role: 'radio', 'data-theme': t, text: t[0].toUpperCase() + t.slice(1), onclick: () => run('theme.set', { theme: t }),
  }));
  const themeSeg = h('div', { class: 'segmented segmented--text settings-theme-seg', role: 'radiogroup', 'aria-label': 'Theme' }, ...themeButtons);
  const sessionFont = h('select', {
    class: 'settings-select', 'aria-label': 'Session font', onchange: (e) => run('sessionFont.set', { font: e.target.value }),
  },
  h('option', { value: 'system', text: 'System' }),
  h('option', { value: 'sans', text: 'Helvetica' }),
  h('option', { value: 'mono', text: 'Monospaced' }));
  const sessionFontSize = h('select', {
    class: 'settings-select', 'aria-label': 'Session font size', onchange: (e) => run('sessionFontSize.set', { size: e.target.value }),
  }, ...[12, 13, 14, 15, 16, 18].map((size) => h('option', { value: String(size), text: `${size} px${size === 15 ? ' (Default)' : ''}` })));

  const notifyToggle = toggleRow('Notify when a session is waiting', 'A silent, click-to-focus notification (never a sound).', () => run('notify.toggle'));
  const dockBadgeToggle = toggleRow('Show waiting count on Dock icon', 'Displays a number on the Everwatch app icon. Off by default; notification banners are separate.', () => run('dockBadge.toggle'));
  // Notification permission status + its fix, from the diagnostics check.
  const notifyStatus = h('p', { class: 'settings-row-desc settings-note' });
  const notifyAction = h('div', { class: 'settings-row-control settings-row-action' });
  const notifyRow = h('div', { class: 'settings-row settings-row--sub' },
    h('div', { class: 'settings-row-text' }, notifyStatus), notifyAction);

  const soundToggle = toggleRow('Sound on attention', 'Off by default. Played only by the Everwatch app — the web never plays sound.', () => run('sound.toggle'));

  const hkShow = hotkeyRow('Show Everwatch', 'hotkey_show', 'hotkey_next', run);
  const hkNext = hotkeyRow('Jump to next waiting', 'hotkey_next', 'hotkey_show', run);
  const hotkeyBrowserNote = h('div', { class: 'settings-row settings-row--sub' },
    h('p', { class: 'settings-row-desc settings-note', text: 'Hotkeys need the Everwatch app — not available in browser mode.' }));

  const hintsToggle = toggleRow('Show keyboard hints', '', () => run('hints.toggle'));
  const dollarsToggle = toggleRow('Show dollar amounts', 'Claude monthly limit as $, not just %.', () => run('dollars.toggle'));
  const debugToggle = toggleRow('Show matched rule', 'A debug chip in the preview header naming the heuristic rule.', () => run('debug.toggle'));
  const activityToggle = toggleRow('Show activity strip on sessions', 'A tiny 60-minute busy/waiting strip on each row and tile. Off by default — it stays on the selected session’s preview either way.', () => run('activity.toggle'));

  const clearProjectsBtn = h('button', { type: 'button', class: 'btn btn--small', text: 'Clear Project Names…', onclick: () => run('projects.clear') });

  const importRow = h('div', { class: 'settings-row-control settings-row-action' });
  const importDesc = h('span', { class: 'settings-row-desc' });
  const logsPath = '~/Library/Logs/Everwatch/';
  const logsCopy = copyButton(logsPath, 'Copy Path');
  const dataSection = section('Data',
    h('div', { class: 'settings-row' },
      h('div', { class: 'settings-row-text' }, h('span', { class: 'settings-row-label', text: 'Import from ultrawatch' }), importDesc),
      importRow),
    row('Logs', h('code', { class: 'settings-code', text: logsPath }), logsCopy));

  const version = h('span', { class: 'about-version' });
  const shellVersion = h('span', { class: 'about-shell-version' });
  const link = (href, text) => h('a', {
    class: 'btn btn--small', href, target: '_blank', rel: 'noreferrer noopener',
  }, text, icon('external', 'icon icon--xs'));
  const aboutSection = section('About',
    row('Everwatch', h('span', { class: 'settings-row-desc' }, version, shellVersion)),
    h('div', { class: 'settings-row settings-row--sub about-links' },
      h('div', { class: 'settings-row-action' },
        link(GITHUB_URL, 'GitHub Repo'), link(LICENSE_URL, 'License (MIT)'), link(RELEASES_URL, 'Check for Updates'))),
    row('First-run setup', '',
      h('button', {
        type: 'button', class: 'btn btn--small', text: 'Run Setup Again', onclick: () => run('onboarding.open'),
      })));

  const page = createPage({
    title: 'Settings', width: 'settings', extraClass: 'settings-page', run, backCommand: 'route.back', backLabel: 'Back to Sessions',
  });
  page.col.append(
    section('Appearance',
      row('Theme', '', themeSeg),
      row('Session font', 'Session names in lists and cards.', sessionFont),
      row('Session font size', 'Session names in lists and cards.', sessionFontSize)),
    section('Notifications', notifyToggle, dockBadgeToggle, notifyRow),
    section('Sound', soundToggle),
    section('Hotkeys', hkShow, hkNext, hotkeyBrowserNote),
    section('Display', hintsToggle, dollarsToggle, debugToggle, activityToggle),
    section('Projects', row('Project names', '', clearProjectsBtn)),
    dataSection,
    aboutSection,
  );
  const root = page.el;

  return {
    el: root,
    update(m) {
      if (!requested) {
        requested = true;
        // Notifications/hotkeys status and the ultrawatch-import action all
        // come from Diagnostics; asking once here (like the wizard and the
        // Diagnostics page) is what turns on the `diagnostics` SSE event for
        // the rest of the session (build/wp7-handoff.md).
        requestDiagnosticsOnce(api, store);
      }
      for (const b of themeButtons) attr(b, 'aria-checked', b.dataset.theme === m.prefs.theme ? 'true' : 'false');
      sessionFont.value = m.prefs.session_font;
      sessionFontSize.value = String(m.prefs.session_font_size);
      setToggle(notifyToggle, m.prefs.notify_on_waiting);
      setToggle(dockBadgeToggle, m.prefs.show_dock_badge);
      setToggle(soundToggle, m.prefs.sound_on_attention);
      setToggle(hintsToggle, m.prefs.show_hints);
      setToggle(dollarsToggle, m.prefs.show_dollars);
      setToggle(debugToggle, m.prefs.debug_state);
      setToggle(activityToggle, m.prefs.show_row_activity);

      const shell = m.state.native?.shell;
      const checks = mergeNativeStatus(m.state.diagnostics?.checks, m.state.native, shell);
      const notif = findCheck(checks, 'notifications');
      notifyStatus.replaceChildren(...codeNodes(notif ? notif.detail : ''));
      notifyStatus.hidden = !notif?.detail;
      notifyAction.replaceChildren(...(notif?.action ? [actionButton(notif.action, run)] : []));
      notifyAction.hidden = !notif?.action;
      notifyRow.hidden = notifyStatus.hidden && notifyAction.hidden;

      hkShow.__set(m.prefs, shell ? m.state.native.hotkeys : null);
      hkNext.__set(m.prefs, shell ? m.state.native.hotkeys : null);
      hotkeyBrowserNote.hidden = !!shell;

      const imp = findCheck(checks, 'ultrawatch_import');
      importRow.replaceChildren(...(imp?.action ? [actionButton(imp.action, run)] : []));
      importRow.hidden = !imp?.action;
      importDesc.replaceChildren(...codeNodes(imp?.action ? '' : (imp ? imp.detail : '—')));
      importDesc.hidden = !!imp?.action;

      setText(version, m.state.version || '—');
      setText(shellVersion, shell ? ` · app ${m.state.native.shellVersion || '—'}` : '');
    },
  };
}
