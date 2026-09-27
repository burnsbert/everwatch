#!/usr/bin/env python3
"""No-sound lint (docs/DESIGN.md §5.2, hard rule #1: "No sound, ever, in
dev or tests.").

Fails if any Python/JS/Swift source in the repo contains a sound-making
call outside the allowlist below. Checked patterns: `NSSound`,
`AudioServicesPlay`, `NSBeep`, `beep(`, `afplay`, `say `, `AudioContext`,
`new Audio`, `<audio`, `curses.beep`, `sound name`, `UNNotificationSound`,
and a literal `\\x07` (BEL / OSC terminator) or `\\a` escape.

Allowlist (whole files, matched by path relative to the repo root — a
file-level allowlist, not a line-level one, since each of these files
exists *because* it legitimately needs one of the patterns above):

- `shell/Sources/Core/SoundPolicy.swift` — the gate that decides
  *whether* to play a sound (`pref && !EVERWATCH_NO_SOUND`); it
  references sound APIs by name in comments/tests but never calls them
  (WP6; doesn't exist yet in WP1).
- `shell/Sources/App/SystemSoundPlayer.swift` — the single
  `NSSound.beep()` call site in the whole repo (WP6; doesn't exist yet).
- `everwatch/engine/itermcolor.py` — `\\x07` there is the OSC 6 tab-color
  escape sequence's string terminator, not a bell (P-60).
- `tests/py/test_itermcolor_api.py` — asserts on that same OSC 6
  terminator byte-for-byte (P-60).
- `scripts/lint_nosound.py` — this file, since the patterns above are
  necessarily present here as strings.

Unhandled-key beeps (shell/Sources only). AppKit's default
`-[NSResponder noResponderFor:]` beeps for `keyDown:`, and WKWebView
re-sends every key the page leaves unhandled, so a stock window that
hosts a web view beeps on every unbound key. The responders that end
Everwatch's chains override it (`shell/Sources/App/SilentResponders.swift`,
`shell/Sources/Core/UnhandledEventPolicy.swift`). Flagged outside that
file: a bare `NSWindow(` / `NSPanel(`, a class subclassing `NSWindow` /
`NSPanel` / `NSApplication` directly, and `NSApplication.shared` (the
first `.shared` access picks the application class; main.swift uses
`SilentApplication.shared`). Flagged anywhere in Swift: a
`super.noResponder(` call, which would run the beeping default.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_SUFFIXES = ('.py', '.js', '.mjs', '.swift')
SKIP_DIR_NAMES = {'.git', 'node_modules', 'build', 'dist', '__pycache__',
                  'docs'}

ALLOWLIST = {
    'shell/Sources/Core/SoundPolicy.swift',
    'shell/Sources/App/SystemSoundPlayer.swift',
    'everwatch/engine/itermcolor.py',
    'tests/py/test_itermcolor_api.py',
    'scripts/lint_nosound.py',
}

PATTERNS = [
    (re.compile(r'\bNSSound\b'), 'NSSound'),
    (re.compile(r'\bAudioServicesPlay\w*'), 'AudioServicesPlay*'),
    (re.compile(r'\bNSBeep\b'), 'NSBeep'),
    (re.compile(r'\bbeep\s*\('), 'beep('),
    (re.compile(r'\bafplay\b'), 'afplay'),
    (re.compile(r'\bsay\s+["\']'), 'say '),
    (re.compile(r'\bAudioContext\b'), 'AudioContext'),
    (re.compile(r'\bnew\s+Audio\b'), 'new Audio'),
    (re.compile(r'<audio\b'), '<audio'),
    (re.compile(r'\bcurses\.beep\b'), 'curses.beep'),
    (re.compile(r'\bsound\s+name\b'), 'sound name'),
    (re.compile(r'\bUNNotificationSound\b'), 'UNNotificationSound'),
    (re.compile(r'\\x07'), r'\x07 (BEL) literal'),
    (re.compile(r'(?<!\\)\\a(?![a-zA-Z0-9_])'), r'\a (BEL) escape'),
]

SILENT_RESPONDERS = 'shell/Sources/App/SilentResponders.swift'

# Applied to .swift files under shell/Sources/, except SILENT_RESPONDERS.
SHELL_SWIFT_PATTERNS = [
    (re.compile(r'\b(NSWindow|NSPanel)\s*\('),
     'bare NSWindow/NSPanel (use SilentWindow/SilentPanel: unhandled keys beep)'),
    (re.compile(r'\bclass\s+\w+\s*:\s*(NSWindow|NSPanel|NSApplication)\b'),
     'NSWindow/NSPanel/NSApplication subclass outside SilentResponders.swift'),
    (re.compile(r'\bNSApplication\.shared\b'),
     'NSApplication.shared (main.swift must create SilentApplication.shared)'),
]

# Applied to every .swift file.
SWIFT_PATTERNS = [
    (re.compile(r'\bsuper\.noResponder\s*\('),
     'super.noResponder( (AppKit default beeps on keyDown:)'),
]


def patterns_for(rel):
    patterns = list(PATTERNS)
    if rel.endswith('.swift'):
        patterns += SWIFT_PATTERNS
        if rel.startswith('shell/Sources/') and rel != SILENT_RESPONDERS:
            patterns += SHELL_SWIFT_PATTERNS
    return patterns


def iter_source_files(root=ROOT):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES
                       and not d.startswith('.')]
        for name in filenames:
            if name.endswith(SOURCE_SUFFIXES):
                yield os.path.join(dirpath, name)


def check_file(path, root=ROOT):
    rel = os.path.relpath(path, root)
    if rel in ALLOWLIST:
        return []
    violations = []
    patterns = patterns_for(rel.replace(os.sep, '/'))
    with open(path, encoding='utf-8', errors='replace') as f:
        for lineno, line in enumerate(f, 1):
            for pattern, label in patterns:
                if pattern.search(line):
                    violations.append((rel, lineno, label, line.strip()))
    return violations


def main():
    all_violations = []
    for path in iter_source_files():
        all_violations.extend(check_file(path))

    if all_violations:
        print(f'lint_nosound: {len(all_violations)} sound-making call(s) '
             'found outside the allowlist:')
        for rel, lineno, label, text in all_violations:
            print(f'  {rel}:{lineno}: {label} -- {text}')
        print('\nIf this is a legitimate new sound site, it belongs only '
             'in shell/Sources/App/SystemSoundPlayer.swift, gated by '
             'shell/Sources/Core/SoundPolicy.swift, per docs/DESIGN.md §0 '
             'rule 1 and §5.2.')
        return 1

    print(f'lint_nosound: OK ({len(ALLOWLIST)} file(s) allowlisted, '
         'no other sound-making calls found)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
