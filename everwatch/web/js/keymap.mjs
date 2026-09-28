// The single table of every key binding (§1 parity matrix → command ids).
// The key handler, the hint bar, the help sheet, and (later) the command
// palette all read this table, so they can't drift apart.
//
// Key descriptors: printable keys are their character with Shift folded in
// ('A', '?', '$'); named keys use KeyboardEvent.key names ('ArrowUp',
// 'Enter', 'Escape', 'Space'); modifiers prefix as 'Meta+', 'Ctrl+',
// 'Alt+', 'Shift+' (Shift only for named keys or with Meta/Ctrl).

export const CONTEXTS = Object.freeze(['main', 'grid', 'zoom', 'usage', 'help', 'filter', 'label', 'dialog', 'page', 'palette']);

const MAIN = ['main', 'grid'];

/**
 * Each binding: id (command), keys, contexts, group (help sheet section),
 * label (help/palette text), optional hint (hint-bar word), hintKeys
 * (hint-bar key text), footer:true (one of the status bar's short hint
 * subset, VISUAL_SPEC §4.10 / D2), args (passed to the command),
 * help:false to hide.
 */
export const BINDINGS = Object.freeze([
  // --- Navigate ---
  { id: 'select.up', keys: ['ArrowUp', 'k'], contexts: ['main', 'zoom'], group: 'Navigate', label: 'Move selection up' },
  { id: 'select.down', keys: ['ArrowDown', 'j'], contexts: ['main', 'zoom'], group: 'Navigate', label: 'Move selection down', hint: 'move', hintKeys: '↑↓' },
  { id: 'grid.up', keys: ['ArrowUp', 'k'], contexts: ['grid'], group: 'Navigate', label: 'Move up one row (grid)', help: false },
  { id: 'grid.down', keys: ['ArrowDown', 'j'], contexts: ['grid'], group: 'Navigate', label: 'Move down one row (grid)', hint: 'move', hintKeys: '↑↓←→', help: false },
  { id: 'grid.left', keys: ['ArrowLeft'], contexts: ['grid'], group: 'Navigate', label: 'Move left (grid)', help: false },
  { id: 'grid.right', keys: ['ArrowRight'], contexts: ['grid'], group: 'Navigate', label: 'Move right (grid)', help: false },
  { id: 'session.goto', keys: ['Enter', 'g', 'G', 'Meta+Enter'], contexts: MAIN, group: 'Navigate', label: 'Go to session in iTerm2', hint: 'go to', hintKeys: '⏎', footer: true },
  { id: 'waiting.next', keys: ['a'], contexts: MAIN, group: 'Navigate', label: 'Next waiting session', hint: 'next ◉', footer: true },
  { id: 'filter.focus', keys: ['/', 'Meta+f'], contexts: MAIN, group: 'Navigate', label: 'Filter sessions', hint: 'filter', footer: true },
  { id: 'sort.cycle', keys: ['s', 'S'], contexts: MAIN, group: 'Navigate', label: 'Cycle sort order', hint: 'sort' },
  { id: 'escape.unwind', keys: ['Escape'], contexts: MAIN, group: 'Navigate', label: 'Back: clear filter, then selection' },

  // --- Act ---
  { id: 'label.edit', keys: ['l', 'L'], contexts: MAIN, group: 'Act', label: 'Rename (label) session', hint: 'label' },
  { id: 'tab.new', keys: ['n', 'N'], contexts: MAIN, group: 'Act', label: 'New iTerm2 tab', hint: 'new' },
  { id: 'tab.close', keys: ['x', 'X'], contexts: MAIN, group: 'Act', label: 'Close tab…' },
  { id: 'color.assign', keys: ['1'], contexts: MAIN, group: 'Act', label: 'Color tab → project 1', args: { slot: 1 }, help: false },
  { id: 'color.assign', keys: ['2'], contexts: MAIN, group: 'Act', label: 'Color tab → project 2', args: { slot: 2 }, help: false },
  { id: 'color.assign', keys: ['3'], contexts: MAIN, group: 'Act', label: 'Color tab → project 3', args: { slot: 3 }, help: false },
  { id: 'color.assign', keys: ['4'], contexts: MAIN, group: 'Act', label: 'Color tab → project 4', args: { slot: 4 }, help: false },
  { id: 'color.assign', keys: ['5'], contexts: MAIN, group: 'Act', label: 'Color tab → project 5', args: { slot: 5 }, help: false },
  { id: 'color.clear', keys: ['0'], contexts: MAIN, group: 'Act', label: 'Clear tab color' },
  { id: 'projects.toggle', keys: ['p', 'P'], contexts: ['main'], group: 'Act', label: 'Show/hide projects' },
  { id: 'projects.clear', keys: ['c', 'C'], contexts: ['main'], group: 'Act', label: 'Clear all projects…' },
  { id: 'session.refresh', keys: ['r', 'R', 'Meta+r'], contexts: ['main', 'grid', 'usage'], group: 'Act', label: 'Refresh now', hint: 'refresh' },

  // --- View ---
  { id: 'view.cycle', keys: ['v', 'V'], contexts: MAIN, group: 'View', label: 'Cycle view (split → list → grid)', hint: 'view' },
  { id: 'view.split', keys: ['Meta+1'], contexts: MAIN, group: 'View', label: 'Split view' },
  { id: 'view.list', keys: ['Meta+2'], contexts: MAIN, group: 'View', label: 'List view' },
  { id: 'view.grid', keys: ['Meta+3'], contexts: MAIN, group: 'View', label: 'Grid view' },
  { id: 'zoom.open', keys: ['Space'], contexts: MAIN, group: 'View', label: 'Zoom preview', hint: 'zoom' },
  { id: 'zoom.exit', keys: ['Escape', 'Space'], contexts: ['zoom'], group: 'View', label: 'Leave zoom', hint: 'back', hintKeys: 'esc' },
  { id: 'split.grow', keys: ['>', '.'], contexts: ['main'], group: 'View', label: 'Widen list pane' },
  { id: 'split.shrink', keys: ['<', ','], contexts: ['main'], group: 'View', label: 'Narrow list pane' },
  { id: 'agents.toggle', keys: ['i', 'I'], contexts: MAIN, group: 'View', label: 'AI sessions only / all sessions' },
  { id: 'panes.toggle', keys: ['h', 'H'], contexts: MAIN, group: 'View', label: 'Show/hide secondary split panes' },
  { id: 'grid.toggleAll', keys: ['A'], contexts: ['grid'], group: 'View', label: 'Grid: AI sessions / all sessions', hint: 'all' },
  { id: 'usage.open', keys: ['u', 'U'], contexts: MAIN, group: 'View', label: 'Usage limits', hint: 'usage' },
  { id: 'theme.cycle', keys: ['t', 'T'], contexts: MAIN, group: 'View', label: 'Theme: switch light / dark mode' },
  { id: 'usage.close', keys: ['u', 'U', 'Escape', 'q'], contexts: ['usage'], group: 'View', label: 'Close usage', hint: 'back', hintKeys: 'esc' },
  { id: 'route.back', keys: ['Escape', 'q'], contexts: ['page'], group: 'View', label: 'Back to sessions', help: false, hint: 'back', hintKeys: 'esc' },
  { id: 'help.open', keys: ['?', 'Meta+/'], contexts: MAIN, group: 'View', label: 'Keyboard shortcuts', hint: 'help' },

  // --- System ---
  { id: 'dollars.toggle', keys: ['$'], contexts: ['main', 'grid', 'usage'], group: 'System', label: 'Show/hide dollar amounts' },
  { id: 'sound.toggle', keys: ['b', 'B'], contexts: MAIN, group: 'System', label: 'Sound on attention on/off' },
  // Also bound in the 'palette' context (not just MAIN) so they still work
  // while focus is in the palette's own search input, which main.mjs routes
  // to context 'palette' instead of falling through like other inputs —
  // that lets ⌘K / ⌘⇧F switch modes without ever leaving the input.
  { id: 'palette.open', keys: ['Meta+k', 'Ctrl+k'], contexts: [...MAIN, 'palette'], group: 'System', label: 'Command palette', hint: 'commands', hintKeys: '⌘K', footer: true },
  { id: 'search.screens', keys: ['Meta+Shift+f'], contexts: [...MAIN, 'palette'], group: 'System', label: 'Search screen contents' },
  { id: 'compact.toggle', keys: ['Meta+\\'], contexts: MAIN, group: 'System', label: 'Compact floating window' },
  { id: 'settings.open', keys: ['Meta+,'], contexts: MAIN, group: 'System', label: 'Settings' },
  { id: 'app.quitHint', keys: ['q', 'Q'], contexts: MAIN, group: 'System', label: 'Close overlay (⌘Q quits)' },

  // --- text fields and dialogs (not listed in the help sheet) ---
  { id: 'filter.keep', keys: ['Enter'], contexts: ['filter'], group: 'Filter', label: 'Keep filter', help: false, hint: 'keep', hintKeys: '⏎' },
  { id: 'filter.clear', keys: ['Escape'], contexts: ['filter'], group: 'Filter', label: 'Clear filter', help: false, hint: 'clear', hintKeys: 'esc' },
  { id: 'select.up', keys: ['ArrowUp'], contexts: ['filter'], group: 'Filter', label: 'Move selection up', help: false },
  { id: 'select.down', keys: ['ArrowDown'], contexts: ['filter'], group: 'Filter', label: 'Move selection down', help: false, hint: 'move', hintKeys: '↑↓' },
  { id: 'label.save', keys: ['Enter'], contexts: ['label'], group: 'Label', label: 'Save label', help: false, hint: 'save', hintKeys: '⏎' },
  { id: 'label.cancel', keys: ['Escape'], contexts: ['label'], group: 'Label', label: 'Cancel', help: false, hint: 'cancel', hintKeys: 'esc' },
  { id: 'dialog.confirm', keys: ['y', 'Y'], contexts: ['dialog'], group: 'Dialog', label: 'Confirm', help: false },
  { id: 'dialog.cancel', keys: ['n', 'N', 'Escape'], contexts: ['dialog'], group: 'Dialog', label: 'Cancel', help: false },
]);

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);

/** KeyboardEvent-like → descriptor string, or null for a bare modifier. */
export function keyOf(e) {
  let k = e.key;
  if (!k || MODIFIER_KEYS.has(k) || k === 'Dead' || k === 'Unidentified') return null;
  if (k === ' ') k = 'Space';
  const mods = [];
  if (e.metaKey) mods.push('Meta');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  const printable = [...k].length === 1;
  if (printable && (e.metaKey || e.ctrlKey)) {
    k = k.toLowerCase();
    if (e.shiftKey) mods.push('Shift');
  } else if (!printable && e.shiftKey) {
    mods.push('Shift');
  }
  return [...mods, k].join('+');
}

const INDEX = new Map();
for (const b of BINDINGS) {
  for (const ctx of b.contexts) {
    for (const key of b.keys) INDEX.set(`${ctx}\u0000${key}`, b);
  }
}

/** Every (context, key) that's bound more than once — must stay empty. */
export function conflicts(bindings = BINDINGS) {
  const seen = new Map();
  const out = [];
  for (const b of bindings) {
    for (const ctx of b.contexts) {
      for (const key of b.keys) {
        const k = `${ctx} ${key}`;
        if (seen.has(k)) out.push(k);
        else seen.set(k, b.id);
      }
    }
  }
  return out;
}

/**
 * The reducer: descriptor + context → `{id, args}` or null. The help sheet
 * closes on any key (P-30); zoom leaves on any unbound key (P-26).
 */
export function resolve(key, context) {
  if (!key) return null;
  const b = INDEX.get(`${context}\u0000${key}`);
  if (b) return { id: b.id, args: b.args || {} };
  if (context === 'help') return { id: 'help.close', args: {} };
  if (context === 'zoom' && !key.startsWith('Meta+')) return { id: 'zoom.exit', args: {} };
  return null;
}

/** Resolve a KeyboardEvent-like directly. */
export function resolveEvent(e, context) {
  return resolve(keyOf(e), context);
}

const KEY_GLYPHS = {
  Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←',
  ArrowRight: '→', Enter: '⏎', Escape: 'esc', Space: 'space', Backspace: '⌫', Tab: '⇥',
};

/** Human-readable key: 'Meta+k' → '⌘K', 'ArrowUp' → '↑', 'Escape' → 'esc'. */
export function displayKey(key) {
  const parts = key === '+' ? ['+'] : key.split('+').map((p) => p || '+');
  const main = parts.pop();
  const mods = parts.map((m) => KEY_GLYPHS[m] || m).join('');
  let m = KEY_GLYPHS[main] || main;
  if (mods && m.length === 1) m = m.toUpperCase();
  return mods + m;
}

/** Keys worth showing: drops a case twin ('G' when 'g' is listed). */
export function displayKeys(keys) {
  const out = [];
  for (const k of keys) {
    if ([...k].length === 1 && k !== k.toLowerCase() && keys.includes(k.toLowerCase())) continue;
    out.push(displayKey(k));
  }
  return out;
}

/** Help sheet model: `[{group, items:[{id, label, keys:[…]}]}]` (P-30). */
export function helpSections(bindings = BINDINGS) {
  const order = ['Navigate', 'Act', 'View', 'System'];
  const groups = new Map(order.map((g) => [g, []]));
  const seen = new Set();
  for (const b of bindings) {
    if (b.help === false || !groups.has(b.group)) continue;
    const dedupe = `${b.id}|${b.label}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    groups.get(b.group).push({ id: b.id, label: b.label, keys: displayKeys(b.keys) });
  }
  // grid arrows collapse into one row after "Move selection down"
  const nav = groups.get('Navigate');
  const down = nav.findIndex((i) => i.id === 'select.down') + 1;
  if (down > 0) nav.splice(down, 0, { id: 'grid.move', label: 'Move around the grid', keys: ['↑↓←→'] });
  // the five digit bindings collapse into one row, right after "Close tab…"
  const act = groups.get('Act');
  const at = act.findIndex((i) => i.id === 'tab.close') + 1;
  act.splice(at, 0, { id: 'color.assign', label: 'Color tab → project 1–5', keys: ['1–5'] });
  return order.map((group) => ({ group, items: groups.get(group) }));
}

/**
 * Command palette model (W-3): every command a user could reasonably want
 * to invoke by name — the same `help: false` rule as the help sheet (drops
 * context-only field bindings and the grid arrow-key duplicates), except
 * `color.assign`'s five digit bindings: the help sheet collapses those
 * into one cosmetic "1–5" row, but the palette lists them individually
 * (each is a distinct, directly runnable action). Deduped by id+label,
 * flattened (no grouping). Each entry: `{id, label, group,
 * keys: displayKeys(...), args}`.
 */
export function paletteCommands(bindings = BINDINGS) {
  const seen = new Set();
  const out = [];
  for (const b of bindings) {
    if (b.help === false && b.id !== 'color.assign') continue;
    const dedupe = `${b.id}|${b.label}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ id: b.id, label: b.label, group: b.group, keys: displayKeys(b.keys), args: b.args || {} });
  }
  return out;
}

/** Context hint bar model: `[{keys, label}]` in table order (P-32). */
export function hintsFor(context, bindings = BINDINGS) {
  const out = [];
  const seen = new Set();
  for (const b of bindings) {
    if (!b.hint || !b.contexts.includes(context) || seen.has(b.hint)) continue;
    seen.add(b.hint);
    out.push({ keys: b.hintKeys || displayKeys(b.keys)[0], label: b.hint });
  }
  return out;
}

/** The status bar's short hint subset (§4.10, D2): the `footer: true`
 * bindings for this context, or — in contexts with none flagged (filter,
 * label, zoom, pages) — their first `max` context hints. The full list is
 * the help sheet. */
export function footerHintsFor(context, bindings = BINDINGS, max = 4) {
  const flagged = bindings.filter((b) => b.footer);
  const all = hintsFor(context, bindings);
  const picked = hintsFor(context, flagged);
  return (picked.length ? picked : all).slice(0, max);
}

/** First display key for a command id, for tooltips (`Refresh (r)`). */
export function shortcutFor(id, context = 'main', bindings = BINDINGS) {
  const b = bindings.find((x) => x.id === id && x.contexts.includes(context));
  return b ? displayKeys(b.keys)[0] : '';
}
