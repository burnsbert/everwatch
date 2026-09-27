// Minimal DOM helpers. Text is only ever set through textContent / text
// nodes — never innerHTML — so terminal output and labels can't inject
// markup (§3.8).

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, children);
  return el;
}

function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** `<svg class="icon"><use href="#i-name"/></svg>` from the index.html sprite. */
export function icon(name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Set textContent only when it changed (keeps selection/caret stable). */
export function setText(el, text) {
  const t = String(text ?? '');
  if (el.textContent !== t) el.textContent = t;
}

/** Toggle a set of classes from a {name: bool} map. */
export function classes(el, map) {
  for (const [name, on] of Object.entries(map)) el.classList.toggle(name, !!on);
}

export function attr(el, name, value) {
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const v = value === true ? '' : String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
}

/** Replace children with highlight runs (<mark> for hits), via text nodes. */
export function setRuns(el, runs, key) {
  if (el.__runsKey === key) return;
  el.__runsKey = key;
  el.replaceChildren(...runs.map((r) => (r.hit ? h('mark', { text: r.text }) : document.createTextNode(r.text))));
}

/**
 * Keyed reconciliation: make `container`'s children match `items` in order,
 * reusing elements by key. `create(item)` builds, `update(el, item)` patches.
 */
export function reconcile(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of container.children) if (child.__key !== undefined) existing.set(child.__key, child);
  let cursor = container.firstElementChild;
  const keep = new Set();
  for (const item of items) {
    const key = keyOf(item);
    let el = existing.get(key);
    if (!el) {
      el = create(item);
      el.__key = key;
    }
    keep.add(el);
    update(el, item);
    if (el !== cursor) container.insertBefore(el, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const child of [...container.children]) if (!keep.has(child) && child.__key !== undefined) child.remove();
}
