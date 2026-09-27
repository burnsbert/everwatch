"""Validation for "type into a session" requests (docs/DESIGN.md W-10).

`POST /api/sessions/{uid}/send` accepts exactly one of:

    {"text": "run the tests", "enter": true}   # literal text, then Return
    {"key": "esc"}                              # one named key

and `parse_send(body)` turns that into a tuple of `(kind, value)` items
-- `('text', str)` or `('key', name)` -- or raises `InputError`. The
items stay semantic (not bytes) so each DataSource decides how to
deliver them: RealSource maps keys through `KEY_BYTES` and hands every
chunk to osascript as an argv item (never AppleScript source); the demo
source acts on the key names.

Security rules (everything here is pure and unit-tested):
- literal text is capped at TEXT_MAX_LEN characters and may not contain
  any control character (Unicode category Cc: C0, DEL, C1) or a lone
  surrogate (Cs) -- so a request can never smuggle ESC sequences,
  ^C, ^D, or a newline/CR of its own; the only way to send those is a
  named key from KEY_BYTES;
- only the keys in KEY_BYTES exist (no ^D, no ^Z, no raw escape);
- unknown fields and wrong types are rejected rather than ignored.

Optional `"expect_hash": <screen_hash>` (the UI's quick replies always
send it; docs/DESIGN.md §2 on why): the engine re-reads the session right
before typing and refuses if its screen no longer hashes to that value,
so an answer can't land on a prompt the user never saw.
"""
import unicodedata

TEXT_MAX_LEN = 2000

#: Named keys -> the bytes a terminal sends for them (xterm conventions;
#: arrows in normal-cursor-key mode, which Claude Code, Codex, and shells
#: all accept).
KEY_BYTES = {
    'enter': '\r',
    'esc': '\x1b',
    'tab': '\t',
    'shift-tab': '\x1b[Z',
    'backspace': '\x7f',
    'up': '\x1b[A',
    'down': '\x1b[B',
    'right': '\x1b[C',
    'left': '\x1b[D',
    'ctrl-c': '\x03',
}

_FIELDS = frozenset(('text', 'enter', 'key', 'expect_hash'))


class InputError(ValueError):
    def __init__(self, code, detail=''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = detail


def bad_char(text):
    """The first forbidden character in `text` (a control character or a
    lone surrogate), or None."""
    for ch in text:
        if unicodedata.category(ch) in ('Cc', 'Cs'):
            return ch
    return None


def parse_send(body):
    """Validate a send request body -> tuple of (kind, value) items."""
    if not isinstance(body, dict):
        raise InputError('invalid_input', 'body must be an object')
    unknown = sorted(set(body) - _FIELDS)
    if unknown:
        raise InputError('invalid_input',
                         'unknown field(s): ' + ', '.join(unknown))
    has_text = 'text' in body
    has_key = 'key' in body
    if has_text == has_key:
        raise InputError('invalid_input', 'send exactly one of text or key')
    if has_key:
        if 'enter' in body:
            raise InputError('invalid_input', 'enter only applies to text')
        key = body['key']
        if not isinstance(key, str) or key not in KEY_BYTES:
            raise InputError('invalid_key', str(key)[:40])
        return (('key', key),)
    text = body['text']
    enter = body.get('enter', False)
    if not isinstance(text, str):
        raise InputError('invalid_text', 'text must be a string')
    if not isinstance(enter, bool):
        raise InputError('invalid_input', 'enter must be true or false')
    if len(text) > TEXT_MAX_LEN:
        raise InputError('text_too_long',
                         f'{len(text)} > {TEXT_MAX_LEN} characters')
    ch = bad_char(text)
    if ch is not None:
        raise InputError('invalid_text',
                         f'control character U+{ord(ch):04X} not allowed; '
                         'use a named key')
    if not text and not enter:
        raise InputError('invalid_text', 'empty text')
    items = (('text', text),) if text else ()
    if enter:
        items += (('key', 'enter'),)
    return items


def expected_hash(body):
    """The optional `expect_hash` of a (dict) send body -> int | None."""
    value = body.get('expect_hash') if isinstance(body, dict) else None
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise InputError('invalid_input', 'expect_hash must be a screen_hash')
    return value


def items_to_writes(items):
    """Items -> the literal strings a terminal receives, in order. A
    Return that follows text is its own write (see iterm.SEND_SCRIPT for
    why it's delivered separately)."""
    return tuple(value if kind == 'text' else KEY_BYTES[value]
                 for kind, value in items)
