"""everwatch/terminput.py: validation of W-10 "type into a session"
requests -- text caps, control-character rejection, named keys only."""
import unittest

from everwatch import terminput as T


class TestParseSend(unittest.TestCase):
    def test_text_alone(self):  # parity: W-10
        self.assertEqual(T.parse_send({'text': 'run the tests'}),
                         (('text', 'run the tests'),))

    def test_text_then_enter(self):  # parity: W-10
        self.assertEqual(T.parse_send({'text': 'y', 'enter': True}),
                         (('text', 'y'), ('key', 'enter')))

    def test_enter_false_is_just_text(self):
        self.assertEqual(T.parse_send({'text': 'y', 'enter': False}),
                         (('text', 'y'),))

    def test_empty_text_with_enter_is_a_bare_return(self):
        self.assertEqual(T.parse_send({'text': '', 'enter': True}),
                         (('key', 'enter'),))

    def test_empty_text_without_enter_is_rejected(self):
        with self.assertRaises(T.InputError) as ctx:
            T.parse_send({'text': ''})
        self.assertEqual(ctx.exception.code, 'invalid_text')

    def test_every_named_key(self):  # parity: W-10
        for key in T.KEY_BYTES:
            self.assertEqual(T.parse_send({'key': key}), (('key', key),))

    def test_unknown_key_rejected(self):  # parity: W-10
        for key in ('ctrl-d', 'ctrl-z', 'ESC', '\x1b', '', 3, None, ['esc']):
            with self.assertRaises(T.InputError) as ctx:
                T.parse_send({'key': key})
            self.assertEqual(ctx.exception.code, 'invalid_key', key)

    def test_control_characters_in_text_rejected(self):  # parity: W-10
        for bad in ('\x1b[A', 'a\x03', 'line\n', 'cr\r', 'tab\t', '\x00',
                    '\x7f', '\x9b', 'x\x04'):
            with self.assertRaises(T.InputError) as ctx:
                T.parse_send({'text': bad})
            self.assertEqual(ctx.exception.code, 'invalid_text', repr(bad))
            self.assertIn('U+', ctx.exception.detail)

    def test_lone_surrogate_rejected(self):
        with self.assertRaises(T.InputError) as ctx:
            T.parse_send({'text': 'a\ud800b'})
        self.assertEqual(ctx.exception.code, 'invalid_text')

    def test_unicode_and_emoji_allowed(self):
        text = 'café ❯ 🙂‍↔️ “quotes” \\ "; do shell script "x'
        self.assertEqual(T.parse_send({'text': text}), (('text', text),))

    def test_length_cap(self):  # parity: W-10
        ok = 'x' * T.TEXT_MAX_LEN
        self.assertEqual(T.parse_send({'text': ok}), (('text', ok),))
        with self.assertRaises(T.InputError) as ctx:
            T.parse_send({'text': ok + 'x'})
        self.assertEqual(ctx.exception.code, 'text_too_long')

    def test_exactly_one_of_text_or_key(self):
        for body in ({}, {'text': 'a', 'key': 'esc'}, {'enter': True}):
            with self.assertRaises(T.InputError) as ctx:
                T.parse_send(body)
            self.assertEqual(ctx.exception.code, 'invalid_input', body)

    def test_enter_with_key_rejected(self):
        with self.assertRaises(T.InputError):
            T.parse_send({'key': 'esc', 'enter': True})

    def test_wrong_types_rejected(self):
        for body, code in (({'text': 5}, 'invalid_text'),
                           ({'text': 'a', 'enter': 'yes'}, 'invalid_input'),
                           ({'text': 'a', 'enter': 1}, 'invalid_input'),
                           ('text', 'invalid_input'),
                           (['text'], 'invalid_input')):
            with self.assertRaises(T.InputError) as ctx:
                T.parse_send(body)
            self.assertEqual(ctx.exception.code, code, body)

    def test_unknown_fields_rejected(self):
        with self.assertRaises(T.InputError) as ctx:
            T.parse_send({'text': 'a', 'raw': '\x1b'})
        self.assertEqual(ctx.exception.code, 'invalid_input')
        self.assertIn('raw', ctx.exception.detail)

    def test_error_str(self):
        self.assertEqual(str(T.InputError('x', 'y')), 'x: y')
        self.assertEqual(str(T.InputError('x')), 'x')


class TestExpectedHash(unittest.TestCase):
    def test_optional_screen_hash(self):  # parity: W-10
        self.assertIsNone(T.expected_hash({'text': '1'}))
        self.assertIsNone(T.expected_hash('nope'))
        self.assertEqual(T.expected_hash({'text': '1', 'expect_hash': 42}), 42)
        self.assertEqual(T.parse_send({'text': '1', 'expect_hash': 42}),
                         (('text', '1'),))
        for bad in (True, -1, '42', 4.2):
            with self.assertRaises(T.InputError):
                T.expected_hash({'expect_hash': bad})


class TestWrites(unittest.TestCase):
    def test_key_bytes(self):  # parity: W-10
        self.assertEqual(T.KEY_BYTES['esc'], '\x1b')
        self.assertEqual(T.KEY_BYTES['ctrl-c'], '\x03')
        self.assertEqual(T.KEY_BYTES['enter'], '\r')
        self.assertEqual(T.KEY_BYTES['up'], '\x1b[A')
        self.assertEqual(T.KEY_BYTES['shift-tab'], '\x1b[Z')
        self.assertNotIn('ctrl-d', T.KEY_BYTES)

    def test_items_to_writes(self):
        self.assertEqual(T.items_to_writes((('text', 'hi'), ('key', 'enter'))),
                         ('hi', '\r'))
        self.assertEqual(T.items_to_writes((('key', 'down'),)), ('\x1b[B',))

    def test_bad_char(self):
        self.assertIsNone(T.bad_char('plain ❯ text'))
        self.assertEqual(T.bad_char('a\x1bb'), '\x1b')


if __name__ == '__main__':
    unittest.main()
