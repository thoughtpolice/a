# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/api/jev inside a real celld dev supervisor against a fake TypeSafe.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites decide whether the library's rules
are right; this one decides whether they hold on the runtime: real fetch with
AbortSignal timeouts, the JevRateLimiter Durable Object over RPC (pacing,
retry-after throttling, token charging, limits surviving a supervisor
restart), and the KV answer cache. A small HTTP server in this process stands
in for api.typesafe.ai; no network or API key is involved.

LocalRuntime is the toolchain's helper from
buck/toolchains/celld/tests/runtime_test.py, as copied by wormspace and the
journal.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


INPUT_TOKENS = 1234


class FakeTypeSafe:
    """Answer POST /v1/systemone the way the API reference describes.

    The request's `state` picks a scenario: "busy:<id>" answers 429 with
    retry-after 1 the first time an id is seen, "wrong" answers a question
    that was not asked, "hang" waits 3 s before answering, and anything else
    answers. Every request is recorded.
    """

    def __init__(self):
        self.requests = []
        self.seen = set()
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, headers=()):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                for name, value in headers:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
                with fake.lock:
                    fake.requests.append({
                        "path": self.path,
                        "authorization": self.headers.get("authorization"),
                        "user-agent": self.headers.get("user-agent"),
                        "body": body,
                    })
                    first = body["state"] not in fake.seen
                    fake.seen.add(body["state"])
                if self.path != "/v1/systemone":
                    return self.reply(404, {"detail": "not found"})
                if self.headers.get("authorization") != "Bearer test-key":
                    return self.reply(401, {"detail": "invalid api key"})
                state = body["state"]
                if state == "hang":
                    time.sleep(3)
                    try:
                        return self.reply(504, {"detail": "too late"})
                    except OSError:
                        return None  # The client gave up and closed the socket.
                if state.startswith("busy:") and first:
                    return self.reply(429, {"detail": "rate limited"}, [("retry-after", "1")])
                answers = {qid: answer(question) for qid, question in body["questions"].items()}
                if state == "wrong":
                    answers["extra"] = {"type": "noul", "noul": 0.5}
                self.reply(200, {
                    "model": "jev-1.13.0",
                    "answers": answers,
                    "usage": {"input_tokens": INPUT_TOKENS, "output_tokens": 20},
                }, [("x-typesafe-request-id", f"req-{len(fake.requests)}")])

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def count(self, state):
        with self.lock:
            return sum(1 for request in self.requests if request["body"]["state"] == state)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def answer(question):
    kind = question["type"]
    if kind == "noul":
        return {"type": "noul", "noul": 0.8}
    if kind == "choice":
        options = list(question["criteria"])
        if len(options) == 1:
            return {"type": "choice", "choice": options[0],
                    "probabilities": {options[0]: 1.0}, "confidence": 1.0}
        # The second option wins, so a decoder that assumed the first would show.
        rest = 0.2 / (len(options) - 1)
        return {
            "type": "choice",
            "choice": options[1],
            "probabilities": {option: 0.8 if index == 1 else rest
                              for index, option in enumerate(options)},
            "confidence": 0.7,
        }
    levels = question["criteria"]
    return {
        "type": "score",
        "score": 1.0,
        "legend": {str(index): level for index, level in enumerate(levels)},
        "probabilities": {str(index): (1.0 if index == 1 else 0.0)
                          for index in range(len(levels))},
        "confidence": 0.9,
    }


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="jev-runtime-test-")
        self.root = Path(self.temporary.name)
        self.log_path = self.root / "celld.log"
        self.process = None
        self.log = None
        try:
            shutil.copytree(project, self.root / "project")
            # dev rejects port 0. Reserving then releasing a kernel-selected
            # port leaves a small bind race, reported by the bounded startup.
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            self.origin = f"http://127.0.0.1:{port}"
            # The Worker's fetch must reach the fake server on loopback
            # directly, so no inherited proxy may apply.
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CELLD_", "AWS_", "S3_"))
                   and key.lower() not in ("http_proxy", "https_proxy", "all_proxy")
                   and key != "RUST_LOG"}
            env["NO_COLOR"] = "1"
            self.log = self.log_path.open("w")
            self.command = [str(CELLD), "dev", str(self.root / "project"), "--host", "127.0.0.1",
                            "--port", str(port), "--logs", "--no-watch"]
            self.environment = env
            self.start()
        except BaseException:
            self.close()
            raise

    def logs(self):
        """Read diagnostics without draining a pipe or blocking the child."""
        return self.log_path.read_text(errors="replace")

    def start(self):
        """Start/restart the same project and ignore any earlier readiness log."""
        offset = len(self.logs())
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.DEVNULL, stdout=self.log,
            stderr=subprocess.STDOUT, env=self.environment,
        )
        self.until(lambda: "ready  " + self.origin in self.logs()[offset:], 40, "startup")

    def until(self, condition, seconds, phase):
        """Bound polling independently and include runtime logs on failure."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f"celld exited during {phase}:\n{self.logs()}")
            if condition():
                return
            time.sleep(0.02)
        raise AssertionError(f"celld timed out during {phase}:\n{self.logs()}")

    def request(self, method, path, payload=None, timeout=30):
        """Issue one request, returning its status even when it is a rejection."""
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            self.origin + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        # Ignore any inherited HTTP proxy for isolated loopback traffic.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                body = error.read()
            try:
                return error.code, json.loads(body)
            except ValueError:
                return error.code, body.decode(errors="replace")
        except (OSError, urllib.error.URLError) as error:
            raise AssertionError(f"request failed: {error}\n{self.logs()}") from error

    def stop(self):
        """Stop only our supervisor; celld owns and reaps its child node."""
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                # Upstream graceful shutdown is bounded at 35 seconds.
                self.process.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                raise AssertionError(f"celld did not stop gracefully:\n{self.logs()}")

    def restart(self):
        """Replace the supervisor while retaining its project, data, and port."""
        self.stop()
        self.start()

    def close(self):
        """Bound shutdown and remove only the temporary project owned by this test."""
        try:
            self.stop()
        finally:
            if self.log is not None:
                self.log.close()
            self.temporary.cleanup()


class JevRuntimeTest(unittest.TestCase):
    """The client, limiter and cache on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.fake = FakeTypeSafe()
        cls.addClassCleanup(cls.fake.close)
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def limiter(self):
        """A limiter object of this test's own, so tests share no bucket."""
        return self.id().rsplit(".", 1)[-1].replace("_", "-")

    def ask(self, state, model=None, limiter=None, timeout_ms=None):
        query = f"?base={self.fake.origin}&limiter={limiter or self.limiter()}"
        if timeout_ms is not None:
            query += f"&timeout={timeout_ms}"
        payload = {"state": state}
        if model is not None:
            payload["model"] = model
        status, body = self.runtime.request("POST", "/ask" + query, payload)
        self.assertEqual(status, 200, body)
        return body

    def limits(self, limiter, changes=None):
        path = f"/limits?limiter={limiter}"
        if changes is None:
            status, body = self.runtime.request("GET", path)
        else:
            status, body = self.runtime.request("POST", path, changes)
        self.assertEqual(status, 200, body)
        return body

    def test_an_ask_decodes_typed_answers_over_real_fetch(self):
        outcome = self.ask("ok")
        self.assertTrue(outcome["ok"], outcome)
        result = outcome["result"]
        self.assertEqual(result["model"], "jev-1.13.0")
        self.assertEqual(outcome["summary"],
                         {"team": "technical", "urgent": 0.8, "mood": "Frustrated"})
        self.assertEqual(result["usage"], {"input_tokens": INPUT_TOKENS, "output_tokens": 20})
        meta = result["meta"]
        self.assertEqual((meta["requestedModel"], meta["attempts"], meta["cache"]),
                         ("jev-latest", 1, "bypass"))
        self.assertTrue(meta["requestId"].startswith("req-"), meta)
        sent = [r for r in self.fake.requests if r["body"]["state"] == "ok"][-1]
        self.assertEqual(sent["path"], "/v1/systemone")
        self.assertEqual(sent["authorization"], "Bearer test-key")
        self.assertEqual(sent["user-agent"], "celld-jev/0.1.0")
        self.assertEqual(sent["body"]["questions"]["team"]["criteria"],
                         {"billing": "Payments, invoicing, refunds",
                          "technical": "Bugs, outages, integrations", "sales": None})

    def test_a_429_is_retried_after_its_retry_after_and_throttles_the_fleet(self):
        name = self.limiter()
        started = time.monotonic()
        outcome = self.ask("busy:throttle", limiter=name)
        elapsed = time.monotonic() - started
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(outcome["result"]["meta"]["attempts"], 2)
        self.assertEqual(self.fake.count("busy:throttle"), 2)
        self.assertGreaterEqual(elapsed, 0.9)
        # The server's retry-after reached the shared Durable Object.
        self.assertGreater(self.limits(name)["blockedUntil"], 0)

    def test_an_answer_to_an_unasked_question_is_a_decode_error(self):
        outcome = self.ask("wrong")
        self.assertFalse(outcome["ok"], outcome)
        error = outcome["error"]
        self.assertEqual((error["kind"], error["status"], error["retryable"], error["attempts"]),
                         ("decode", 200, False, 1))
        self.assertEqual(error["issues"],
                         [{"code": "unrecognized_keys",
                           "keys": ["extra"],
                           "path": ["answers", "extra"],
                           "message": "answers a question that was not asked"}])

    def test_a_hung_server_times_out_each_attempt(self):
        started = time.monotonic()
        outcome = self.ask("hang", timeout_ms=300)
        elapsed = time.monotonic() - started
        self.assertFalse(outcome["ok"], outcome)
        error = outcome["error"]
        self.assertEqual((error["kind"], error["attempts"], error["retryable"]),
                         ("timeout", 3, True))
        self.assertIn("within 300 ms", error["message"])
        self.assertEqual(self.fake.count("hang"), 3)
        # Three 300 ms attempts and two short backoffs, not three 3 s waits.
        self.assertLess(elapsed, 2.5)

    def test_pinned_requests_are_cached_in_kv_and_aliases_are_not(self):
        first = self.ask("cache me", model="jev-1.13.0")
        second = self.ask("cache me", model="jev-1.13.0")
        self.assertEqual(first["result"]["meta"]["cache"], "miss")
        self.assertEqual(second["result"]["meta"]["cache"], "hit")
        self.assertEqual(second["result"]["answers"], first["result"]["answers"])
        self.assertEqual(self.fake.count("cache me"), 1)
        self.ask("alias", model="jev-latest")
        self.assertEqual(self.ask("alias", model="jev-latest")["result"]["meta"]["cache"],
                         "bypass")
        self.assertEqual(self.fake.count("alias"), 2)

    def test_the_durable_limiter_paces_requests_and_charges_usage(self):
        name = self.limiter()
        limits = self.limits(name, {"requestsPerMinute": 60, "requestBurst": 1,
                                    "tokensPerSecond": 1, "tokenBurst": 100000})
        self.assertEqual(limits, {"requestsPerMinute": 60, "requestBurst": 1,
                                  "tokensPerSecond": 1, "tokenBurst": 100000})
        started = time.monotonic()
        self.assertTrue(self.ask("paced", limiter=name)["ok"])
        self.assertTrue(self.ask("paced", limiter=name)["ok"])
        # One request a second: the second waited for the bucket to refill.
        self.assertGreaterEqual(time.monotonic() - started, 0.9)
        tokens = self.limits(name)["tokens"]
        self.assertLessEqual(tokens, 100000 - 2 * INPUT_TOKENS + 30)
        self.assertGreaterEqual(tokens, 100000 - 2 * INPUT_TOKENS)

    def test_configured_limits_survive_a_supervisor_restart(self):
        name = self.limiter()
        self.limits(name, {"requestsPerMinute": 30, "tokenBurst": 5000})
        self.runtime.restart()
        snapshot = self.limits(name)
        self.assertEqual(snapshot["limits"],
                         {"requestsPerMinute": 30, "requestBurst": 20,
                          "tokensPerSecond": 250000, "tokenBurst": 5000})
        # The bucket itself is soft state and restarts full.
        self.assertEqual(snapshot["tokens"], 5000)


def interrupted(signum, _frame):
    """Unwind unittest cleanups before exiting on runner cancellation."""
    raise KeyboardInterrupt(f"received signal {signum}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: runtime_test.py CELLD PROJECT")
    CELLD, PROJECT = (Path(value).resolve() for value in sys.argv[1:])
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
