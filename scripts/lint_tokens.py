#!/usr/bin/env python3
"""Design-token lint (docs/design/VISUAL_SPEC.md §8, per-WP acceptance).

Every stylesheet under everwatch/web/css/ except tokens.css must take its
colors, font sizes, radii and shadows from tokens.css custom properties.
Flagged, after stripping comments:

- a literal hex color (`#abc`, `#aabbcc`, `#aabbccdd`)
- `font-size:` with a literal number, or a `font:` shorthand whose size is
  a literal px value
- `border-radius:` with a literal length
- `box-shadow:` with a literal recipe (anything that isn't `none`, a
  `var(...)` list, or `inherit`/`initial`/`unset`)

Allowed exceptions (the spec's list): 0/1px values, `50%` radii, and the
`#fff` toggle knob.

Also flagged in *every* stylesheet, exempt or not: a `transform` inside an
`:active` rule. Pressed controls darken, they don't shrink (§3.6).

Files not yet migrated are listed in EXEMPT with the work package that
owns them. An exempt file that has become clean fails the lint too, so its
exemption gets removed in the same PR that finished the migration. A file
not in EXEMPT (base.css, and any new stylesheet) is always enforced.

Python 3.9-compatible (the CLT's stock interpreter runs `make lint` too).
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS_DIR = os.path.join(ROOT, 'everwatch', 'web', 'css')

# file -> owner still to migrate it (VISUAL_SPEC.md §8). Empty since WP-B
# migrated chrome.css, sessions.css and reply.css; keep the mechanism for
# any future stylesheet that lands before its migration.
EXEMPT = {
}
SKIP = {'tokens.css'}

_COMMENT = re.compile(r'/\*.*?\*/', re.S)
_HEX = re.compile(r'#([0-9a-fA-F]{3,8})\b')
_DECL = re.compile(r'(?<![\w-])(font-size|font|border(?:-(?:top|bottom)-(?:left|right))?-radius|box-shadow)\s*:\s*([^;{}]+)')
_ACTIVE_TRANSFORM = re.compile(r':active[^{}]*\{[^}]*(?<![\w-])transform\s*:', re.S)
_ALLOWED_HEX = {'fff', 'ffffff'}
_SMALL = re.compile(r'^(0|0px|1px|50%)$')
_SHADOW_OK = re.compile(r'^(none|inherit|initial|unset)$')


def _strip_comments(text):
    # keep newlines so reported line numbers stay right
    return _COMMENT.sub(lambda m: '\n' * m.group(0).count('\n'), text)


def _line_of(text, pos):
    return text.count('\n', 0, pos) + 1


def _bad_value(prop, value):
    v = re.sub(r'\s*!important\s*$', '', value.strip())
    if prop == 'font-size':
        return bool(re.match(r'^[0-9.]', v))
    if prop == 'font':
        return bool(re.search(r'(^|\s)[0-9.]+px\b', v))
    if prop.endswith('radius'):
        parts = [p for p in re.split(r'[\s/]+', v) if p]
        return any(re.match(r'^[0-9.]', p) and not _SMALL.match(p) for p in parts)
    if prop == 'box-shadow':
        if _SHADOW_OK.match(v):
            return False
        # a comma-separated list of var(...) references (e.g. var(--shadow-1), var(--focus-ring))
        items = [i.strip() for i in re.split(r',(?![^(]*\))', v)]
        return not all(re.match(r'^var\(--[\w-]+\)$', i) for i in items)
    return False


def check_literals(text):
    """-> list of (line, message) for literal hex / font-size / radius / shadow."""
    src = _strip_comments(text)
    out = []
    for m in _HEX.finditer(src):
        if m.group(1).lower() not in _ALLOWED_HEX:
            out.append((_line_of(src, m.start()), 'literal color %s' % m.group(0)))
    for m in _DECL.finditer(src):
        prop, value = m.group(1), m.group(2)
        if _bad_value(prop, value):
            out.append((_line_of(src, m.start()), 'literal %s: %s' % (prop, value.strip())))
    return sorted(out)


def check_active_transform(text):
    """-> list of (line, message) for `transform` inside an `:active` rule."""
    src = _strip_comments(text)
    return [(_line_of(src, m.start()), 'transform on :active (press-scale; darken instead)')
            for m in _ACTIVE_TRANSFORM.finditer(src)]


def main(css_dir=CSS_DIR):
    failures = []
    names = sorted(n for n in os.listdir(css_dir) if n.endswith('.css') and n not in SKIP)
    for stale in sorted(set(EXEMPT) - set(names)):
        failures.append('%s: listed in EXEMPT but no longer exists; remove the entry' % stale)
    for name in names:
        with open(os.path.join(css_dir, name), encoding='utf-8') as f:
            text = f.read()
        for line, msg in check_active_transform(text):
            failures.append('%s:%d: %s' % (name, line, msg))
        literals = check_literals(text)
        if name in EXEMPT:
            if not literals:
                failures.append('%s: no literal values left; remove it from EXEMPT in %s'
                                % (name, os.path.relpath(__file__, ROOT)))
            continue
        for line, msg in literals:
            failures.append('%s:%d: %s (use a tokens.css custom property)' % (name, line, msg))
    if failures:
        print('lint_tokens: %d problem(s)' % len(failures))
        for f in failures:
            print('  ' + f)
        return 1
    enforced = [n for n in names if n not in EXEMPT]
    print('lint_tokens: ok (enforced: %s; exempt pending migration: %s)'
          % (', '.join(enforced) or 'none', ', '.join(sorted(EXEMPT)) or 'none'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
