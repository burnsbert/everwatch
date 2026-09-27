"""security.py: Host/Origin/token/content-type/body-size checks
(docs/DESIGN.md §3.5, §3.8). Pure functions, no server needed."""
import unittest

from everwatch import security


class TestCheckHost(unittest.TestCase):
    def test_loopback_ip_with_matching_port_passes(self):
        security.check_host('127.0.0.1:5173', 5173)  # no raise

    def test_localhost_with_matching_port_passes(self):
        security.check_host('localhost:5173', 5173)

    def test_localhost_is_case_insensitive(self):
        security.check_host('LOCALHOST:5173', 5173)

    def test_missing_host_header_is_403(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_host(None, 5173)
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, 'bad_host')

    def test_wrong_port_is_403(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_host('127.0.0.1:9999', 5173)
        self.assertEqual(ctx.exception.status, 403)

    def test_other_hostname_is_403(self):
        with self.assertRaises(security.SecurityError):
            security.check_host('evil.example.com:5173', 5173)

    def test_missing_port_in_header_is_403(self):
        with self.assertRaises(security.SecurityError):
            security.check_host('127.0.0.1', 5173)


class TestCheckOrigin(unittest.TestCase):
    def test_no_origin_header_passes(self):
        security.check_origin(None, 5173)
        security.check_origin('', 5173)

    def test_matching_origin_passes(self):
        security.check_origin('http://127.0.0.1:5173', 5173)
        security.check_origin('http://localhost:5173', 5173)

    def test_matching_origin_with_trailing_slash_passes(self):
        security.check_origin('http://127.0.0.1:5173/', 5173)

    def test_cross_origin_is_403(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_origin('http://evil.example.com', 5173)
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, 'bad_origin')

    def test_wrong_port_origin_is_403(self):
        with self.assertRaises(security.SecurityError):
            security.check_origin('http://127.0.0.1:1', 5173)

    def test_https_origin_is_403(self):
        # the server only ever speaks http on loopback (§3.8).
        with self.assertRaises(security.SecurityError):
            security.check_origin('https://127.0.0.1:5173', 5173)


class TestCheckToken(unittest.TestCase):
    def test_correct_token_passes(self):
        security.check_token('secret', 'secret')

    def test_missing_token_is_401(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_token('secret', '')
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(ctx.exception.code, 'unauthorized')

    def test_none_token_is_401(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_token('secret', None)
        self.assertEqual(ctx.exception.status, 401)

    def test_wrong_token_is_403(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_token('secret', 'nope')
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, 'forbidden')


class TestCheckContentType(unittest.TestCase):
    def test_application_json_passes(self):
        security.check_content_type('application/json')

    def test_application_json_with_charset_passes(self):
        security.check_content_type('application/json; charset=utf-8')

    def test_missing_content_type_is_403(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_content_type(None)
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, 'bad_content_type')

    def test_form_urlencoded_is_403(self):
        with self.assertRaises(security.SecurityError):
            security.check_content_type(
                'application/x-www-form-urlencoded')

    def test_text_plain_is_403(self):
        with self.assertRaises(security.SecurityError):
            security.check_content_type('text/plain')


class TestCheckBodySize(unittest.TestCase):
    def test_none_length_passes(self):
        security.check_body_size(None)

    def test_under_limit_passes(self):
        security.check_body_size(security.MAX_BODY_BYTES)

    def test_over_limit_is_413(self):
        with self.assertRaises(security.SecurityError) as ctx:
            security.check_body_size(security.MAX_BODY_BYTES + 1)
        self.assertEqual(ctx.exception.status, 413)
        self.assertEqual(ctx.exception.code, 'payload_too_large')


if __name__ == '__main__':
    unittest.main()
