# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The harness's matchers and SSE parser, which every example spec relies on.

A matcher that accepted too much would let every example test pass without
checking anything, so each rule is tested for failing as well as passing.
"""

from email.message import Message
import unittest

from harness import (StepFailure, _response, check, dev_vars_text, extract, lookup, match, parse_sse,
                     request_url, substitute, var_text)


class MatchTest(unittest.TestCase):
    def ok(self, expected, actual):
        self.assertEqual(match(expected, actual), [])

    def bad(self, expected, actual, fragment):
        problems = match(expected, actual)
        self.assertTrue(problems, f"{expected!r} should not match {actual!r}")
        self.assertIn(fragment, "\n".join(problems))

    def test_objects_are_subsets(self):
        self.ok({"a": 1}, {"a": 1, "b": 2})
        self.bad({"a": 1, "c": 3}, {"a": 1}, "$.c: missing")
        self.bad({"a": {"b": 1}}, {"a": {"b": 2}}, "$.a.b: expected 1, got 2")
        self.bad({"a": 1}, [1], "expected an object")

    def test_lists_match_element_by_element_with_equal_length(self):
        self.ok([{"a": 1}, 2], [{"a": 1, "x": 0}, 2])
        self.bad([1, 2], [1, 2, 3], "expected 2 items, got 3")
        self.bad([1, 2], [2, 1], "$[0]: expected 1, got 2")
        self.ok([], [])
        self.bad([], [{"path": "/x"}], "expected 0 items")

    def test_scalars_keep_booleans_apart_from_numbers(self):
        self.ok(1, 1.0)
        self.ok(None, None)
        self.bad(True, 1, "expected true")
        self.bad(0, False, "expected 0")
        self.bad("1", 1, 'expected "1"')
        self.bad(None, {}, "expected null")

    def test_absent_and_any(self):
        self.ok({"a": {"$absent": True}}, {"b": 1})
        self.bad({"a": {"$absent": True}}, {"a": None}, "$.a: expected no key")
        self.ok({"a": {"$any": True}}, {"a": None})
        self.bad({"a": {"$any": True}}, {}, "$.a: missing")

    def test_exact_refuses_extra_keys(self):
        self.ok({"$exact": {"a": [1]}}, {"a": [1]})
        self.bad({"$exact": {"a": 1}}, {"a": 1, "b": 2}, "$: unexpected keys under $exact: b")
        self.bad({"$exact": {"a": {"b": 1}}}, {"a": {"b": 1, "c": 2}}, "$.a: unexpected keys under $exact: c")
        self.bad({"$exact": {"a": [{"b": 1}]}}, {"a": [{"b": 1, "c": 2}]}, "$.a[0]: unexpected keys")
        self.bad({"$exact": [1]}, [1, 2], "expected 1 items, got 2")
        self.bad({"$exact": {"a": 1}}, {"a": True}, "$.a: expected 1, got true")
        self.bad({"$exact": {"a": 1, "b": 2}}, {"a": 1}, "$.b: missing")

    def test_exact_evaluates_nested_operators(self):
        self.ok({"$exact": {"id": {"$regex": "^t"}, "n": {"$gt": 1}}}, {"id": "t1", "n": 2})
        self.bad({"$exact": {"id": {"$regex": "^t"}}}, {"id": "x1"}, "$.id: expected {$regex")
        self.bad({"$exact": {"id": {"$regex": "^t"}}}, {"id": "t1", "x": 0}, "unexpected keys under $exact: x")
        self.ok({"$exact": {"a": {"$any": True}, "b": {"$absent": True}}}, {"a": None})
        self.bad({"$exact": {"a": {"$absent": True}}}, {"a": 1}, "$.a: expected no key")
        self.ok({"$exact": {"list": {"$len": 2}}}, {"list": [1, 2]})

    def test_exact_arguments_of_nested_operators_are_not_exact(self):
        self.ok({"$exact": {"a": {"$contains": {"id": 1}}}}, {"a": [{"id": 1, "x": 2}]})
        self.ok({"$exact": {"a": {"$json": {"b": 1}}}}, {"a": '{"b": 1, "c": 2}'})
        self.bad({"$exact": {"a": {"$json": {"$exact": {"b": 1}}}}}, {"a": '{"b": 1, "c": 2}'},
                 "unexpected keys under $exact: c")

    def test_exact_compares_unknown_dollar_keys_as_data(self):
        self.ok({"$exact": {"$ref": "#/$defs/User"}}, {"$ref": "#/$defs/User"})
        self.bad({"$exact": {"$ref": "#/$defs/User"}}, {"$ref": "#/$defs/Other"}, "expected")
        self.bad({"$exact": {"$ref": "#/a"}}, {"$ref": "#/a", "title": "x"}, "unexpected keys")
        # Outside $exact an unknown operator is still a mistake in the spec.
        self.bad({"$ref": "#/a"}, {"$ref": "#/a"}, "unknown matcher $ref")

    def test_regex_contains_and_len(self):
        self.ok({"$regex": "^ab"}, "abc")
        self.bad({"$regex": "^b"}, "abc", "$regex")
        self.bad({"$regex": "a"}, 1, "$regex")
        self.ok({"$contains": "bc"}, "abcd")
        self.bad({"$contains": "x"}, "abcd", "$contains")
        self.ok({"$contains": {"id": 2}}, [{"id": 1}, {"id": 2, "x": 1}])
        self.bad({"$contains": {"id": 3}}, [{"id": 1}], "$contains")
        self.ok({"$len": 2}, [0, 0])
        self.ok({"$len": 3}, "abc")
        self.bad({"$len": 1}, [], "$len")

    def test_comparisons_need_numbers(self):
        self.ok({"$gt": 1}, 2)
        self.ok({"$gte": 2}, 2)
        self.ok({"$lt": 0.5}, 0.25)
        self.ok({"$lte": 1}, 1)
        self.bad({"$gt": 2}, 2, "$gt")
        self.bad({"$gt": 0}, True, "$gt")
        self.bad({"$lt": 1}, "0", "$lt")

    def test_json_parses_text(self):
        self.ok({"$json": {"a": 1}}, '{"a": 1, "b": 2}')
        self.bad({"$json": {"a": 2}}, '{"a": 1}', "$<json>.a: expected 2")
        self.bad({"$json": {}}, "not json", "expected JSON text")

    def test_not_inverts(self):
        self.ok({"$not": {"$contains": {"a": 1}}}, [{"a": 2}])
        self.bad({"$not": {"$contains": {"a": 1}}}, [{"a": 1}], "$not")
        self.ok({"a": {"$not": 1}}, {"a": 2})

    def test_unknown_operators_fail(self):
        self.bad({"$nope": 1}, 1, "unknown matcher $nope")


class CheckTest(unittest.TestCase):
    def test_status_defaults_to_200(self):
        self.assertEqual(check({}, {"status": 200, "text": ""}), [])
        self.assertIn("status: expected 200, got 500",
                      check({}, {"status": 500, "text": ""}))

    def test_a_json_expectation_needs_a_json_response(self):
        problems = check({"json": {}}, {"status": 200, "text": "plain"})
        self.assertIn("json: the response has none", problems[0])


class ResponseTest(unittest.TestCase):
    def response(self, *headers):
        message = Message()
        for name, value in headers:
            message[name] = value
        return _response(200, message, b'{"ok": true}')

    def test_every_set_cookie_is_kept_in_order(self):
        response = self.response(("Set-Cookie", "a=1; Path=/"), ("Content-Type", "application/json"),
                                 ("Set-Cookie", "b=2; HttpOnly"))
        self.assertEqual(response["cookies"], ["a=1; Path=/", "b=2; HttpOnly"])
        # `headers` keeps the last value, as it always has.
        self.assertEqual(response["headers"]["set-cookie"], "b=2; HttpOnly")
        self.assertEqual(response["json"], {"ok": True})
        self.assertEqual(check({"cookies": [{"$regex": "^a="}, {"$regex": "^b="}]}, response), [])
        self.assertEqual(check({"cookies": {"$contains": {"$regex": "^a=1;"}}}, response), [])
        self.assertIn("cookies: expected 1 items, got 2", check({"cookies": ["a=1; Path=/"]}, response)[0])
        self.assertEqual(lookup(response, "cookies.1"), "b=2; HttpOnly")

    def test_no_set_cookie_is_an_empty_list(self):
        self.assertEqual(self.response(("Content-Type", "text/plain"))["cookies"], [])


def read_dev_vars(text):
    """celld 0.5.1's `.dev.vars` reading, as observed under `celld dev`
    (see `dev_vars_text`): split at the first `=`, trim both sides, drop
    one pair of matching quotes, nothing else; later lines win."""
    out = {}
    for line in text.splitlines():
        if line.strip().startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[name.strip()] = value
    return out


class DevVarsTest(unittest.TestCase):
    VALUES = {
        "JWK": '{"kty":"EC","crv":"P-256","x":"a\\"b","d":"c d"}',
        "QUOTED": '"x"',
        "SINGLE": "'y'",
        "APOSTROPHE": "it's",
        "SPACES": "  padded  ",
        "HASH": "a # not a comment",
        "DOLLAR": "$HOME ${HOME}",
        "BACKSLASH": "a\\nb\\\\",
        "EMPTY": "",
        "UNICODE": "caf\u00e9",
    }

    def test_values_survive_celld_reading_them(self):
        text = dev_vars_text(self.VALUES)
        self.assertEqual(read_dev_vars(text), self.VALUES)
        self.assertIn("JWK='{\"kty\":\"EC\"", text)

    def test_line_breaks_and_bad_names_are_refused(self):
        for bad in ["a\nb", "a\rb"]:
            with self.assertRaises(StepFailure):
                dev_vars_text({"V": bad})
        for name in ["export V", "a-b", "1A", ""]:
            with self.assertRaises(StepFailure):
                dev_vars_text({name: "x"})

    def test_objects_become_compact_json(self):
        self.assertEqual(var_text({"kty": "oct", "k": "AQ"}), '{"kty":"oct","k":"AQ"}')
        self.assertEqual(var_text([1, True]), "[1,true]")
        self.assertEqual(var_text('{"a": 1}'), '{"a": 1}')


class SaveTest(unittest.TestCase):
    RESPONSE = {"status": 200, "headers": {"x-id": "h"},
                "json": {"result": {"taskId": "t1", "list": [{"n": 1}, {"n": 2}]}}}

    def test_lookup_follows_keys_and_indices(self):
        self.assertEqual(lookup(self.RESPONSE, "json.result.taskId"), "t1")
        self.assertEqual(lookup(self.RESPONSE, "json.result.list.1.n"), 2)
        self.assertEqual(lookup(self.RESPONSE, "json.result.list.-1"), {"n": 2})
        self.assertEqual(lookup(self.RESPONSE, "status"), 200)
        self.assertEqual(lookup(self.RESPONSE, "headers.x-id"), "h")
        for path in ("json.result.nope", "json.result.list.2", "json.result.taskId.x", "text"):
            with self.assertRaises(KeyError):
                lookup(self.RESPONSE, path)

    def test_extract_keeps_a_path_or_a_regex_group(self):
        response = {"headers": {"location": "http://127.0.0.1:1/cb?code=abc&state=s"}, "json": {"n": [1, 2]}}
        self.assertEqual(extract(response, "json.n.1"), 2)
        self.assertEqual(extract(response, {"path": "headers.location", "regex": "code=([^&]+)"}), "abc")
        self.assertEqual(extract(response, {"path": "headers.location", "regex": "state=s"}), "state=s")
        with self.assertRaises(KeyError):
            extract(response, {"path": "headers.location", "regex": "token=([^&]+)"})
        with self.assertRaises(KeyError):
            extract(response, {"path": "headers.missing", "regex": "."})

    def test_request_url_is_the_worker_path_or_a_loopback_url(self):
        self.assertEqual(request_url("http://127.0.0.1:9", {"path": "/a"}), "http://127.0.0.1:9/a")
        self.assertEqual(request_url("http://127.0.0.1:9", {}), "http://127.0.0.1:9/")
        self.assertEqual(request_url("o", {"url": "http://127.0.0.1:7/x?y=1"}), "http://127.0.0.1:7/x?y=1")
        self.assertEqual(request_url("o", {"url": "http://api.localhost:7/x"}), "http://api.localhost:7/x")
        for bad in ["https://example.com/", "http://127.0.0.1.evil.test/", "file:///etc/passwd"]:
            with self.assertRaises(StepFailure):
                request_url("o", {"url": bad})

    def test_substitute_whole_values_and_embedded_text(self):
        saved = {"task": "t1", "n": 2, "obj": {"a": 1}}
        self.assertEqual(substitute({"id": "{task}", "k": ["{n}", "x{n}y"], "{task}": "{obj}"}, saved),
                         {"id": "t1", "k": [2, "x2y"], "t1": {"a": 1}})
        self.assertEqual(substitute("/tasks/{task}?n={n}", saved), "/tasks/t1?n=2")
        # Unknown names, and anything without saved values, are left alone.
        self.assertEqual(substitute("{other} {", saved), "{other} {")
        self.assertEqual(substitute({"a": "{task}"}, {}), {"a": "{task}"})
        self.assertEqual(substitute(True, saved), True)


class SseTest(unittest.TestCase):
    def test_events_and_data(self):
        text = 'event: a\ndata: {"x": 1}\n\ndata: two\ndata: lines\n\n: comment\n\ndata: [DONE]\n\n'
        self.assertEqual(parse_sse(text), [
            {"event": "a", "data": {"x": 1}},
            {"event": None, "data": "two\nlines"},
            {"event": None, "data": "[DONE]"},
        ])

    def test_crlf(self):
        self.assertEqual(parse_sse("data: 1\r\n\r\ndata: 2\r\n\r\n"),
                         [{"event": None, "data": 1}, {"event": None, "data": 2}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
