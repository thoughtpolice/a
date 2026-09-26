# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Bounded diagnostics and independent teardown for the local browser runner."""

import io
from pathlib import Path
import signal
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import runner


class RedactionTest(unittest.TestCase):
    def test_control_token_and_each_websocket_capability_are_redacted(self):
        token = "private_control_token_12345678901234567890"
        first, second = "a" * 64, "b" * 64
        suffix = "/devtools/browser/12345678-1234-1234-1234-123456789abc"
        diagnostic = (
            f"Authorization: Bearer {token}\n"
            f"ws://127.0.0.1:4000/sessions/{first}{suffix}\n"
            f"wss://localhost/sessions/{second}{suffix}\n"
            f"DELETE /sessions/{first}: {token}\n"
            "unrelated diagnostic remains visible"
        )
        result = runner.redact(diagnostic, token)
        for secret in (token, first, second):
            self.assertNotIn(secret, result)
        self.assertIn("Authorization: Bearer [redacted]", result)
        self.assertEqual(result.count("/sessions/[redacted]"), 3)
        self.assertIn("unrelated diagnostic remains visible", result)

    def test_normal_diagnostics_are_not_destroyed(self):
        text = "HTTP 503: /sessions/not-a-capability; browser exited"
        self.assertEqual(runner.redact(text, "unrelated-private-token"), text)


class ReadTailTest(unittest.TestCase):
    def read(self, contents, limit):
        """Reject an unbounded read even when its result would later be sliced."""
        reads = []
        test = self

        class BoundedFile(io.BytesIO):
            def read(self, size=-1):
                test.assertGreaterEqual(size, 0, "read_tail must bound the read itself")
                test.assertLessEqual(size, limit)
                reads.append(size)
                return super().read(size)

        with patch.object(Path, "open", return_value=BoundedFile(contents)):
            result = runner.read_tail(Path("unused-test-log"), limit)
        self.assertLessEqual(sum(reads), limit)
        return result

    def test_large_log_reads_only_its_bounded_tail(self):
        self.assertEqual(self.read(b"x" * 1_000_000 + b"last diagnosis", 14), "last diagnosis")

    def test_empty_short_and_zero_length_reads(self):
        for contents, limit, expected in (
            (b"", 32, ""), (b"short", 32, "short"), (b"not read", 0, ""),
        ):
            with self.subTest(contents=contents, limit=limit):
                self.assertEqual(self.read(contents, limit), expected)

    def test_cut_multibyte_and_invalid_utf8_are_safely_decoded(self):
        for contents, limit in (("prefix:€end".encode(), 5), (b"bad\xff\xfeutf8", 9)):
            with self.subTest(contents=contents):
                self.assertEqual(self.read(contents, limit), contents[-limit:].decode(errors="replace"))


class CleanupTest(unittest.TestCase):
    def check_cleanup(self, failures):
        driver, builder = object(), object()
        originals = {signal.SIGINT: object(), signal.SIGTERM: object()}
        handlers = dict(originals)
        steps = []

        def set_handler(number, handler):
            previous = handlers[number]
            handlers[number] = handler
            return previous

        def attempt(step):
            steps.append(step)
            self.assertEqual(handlers, {signal.SIGINT: signal.SIG_IGN, signal.SIGTERM: signal.SIG_IGN})
            if step in failures:
                raise failures[step]

        def stop(process, grace):
            self.assertEqual(grace, 5)
            self.assertTrue(process is driver or process is builder)
            attempt("driver" if process is driver else "builder")

        runtime = SimpleNamespace(close=lambda: attempt("runtime"))
        with (
            patch.object(runner, "_stop", side_effect=stop),
            patch.object(runner.signal, "getsignal", side_effect=lambda number: handlers[number]),
            patch.object(runner.signal, "signal", side_effect=set_handler),
        ):
            if failures:
                with self.assertRaises(ExceptionGroup) as caught:
                    runner.cleanup(driver, builder, runtime)
                self.assertEqual(
                    list(caught.exception.exceptions),
                    [failures[step] for step in ("driver", "builder", "runtime") if step in failures],
                )
            else:
                runner.cleanup(driver, builder, runtime)
        self.assertEqual(steps, ["driver", "builder", "runtime"])
        self.assertEqual(handlers, originals, "both original signal handlers must be restored")

    def test_success_stops_every_owned_process_and_restores_signals(self):
        self.check_cleanup({})

    def test_first_stop_failure_does_not_skip_builder_or_runtime(self):
        self.check_cleanup({"driver": TimeoutError("driver did not stop")})

    def test_builder_failure_does_not_skip_runtime(self):
        self.check_cleanup({"builder": ProcessLookupError("builder exited during stop")})

    def test_all_failures_are_preserved_and_signals_restored(self):
        self.check_cleanup({
            "driver": TimeoutError("driver did not stop"),
            "builder": ProcessLookupError("builder process race"),
            "runtime": RuntimeError("container cleanup failed"),
        })


if __name__ == "__main__":
    unittest.main()
