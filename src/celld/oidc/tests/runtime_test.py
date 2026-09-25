# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/oidc inside a real celld dev supervisor.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites decide whether the library's rules
are right; this one decides whether they hold on the runtime: an OpenID
Provider whose records live in @celld/oauth's OAuthRecords Durable Object, a
whole login with DPoP (ID token, UserInfo), a refresh after a supervisor
restart, a logout whose ended session outlives another restart, and a trust
chain resolved through the durable statement cache, refetched when a restart
has rotated the keys behind it. No network is involved: the Worker's relying
party reaches its provider and federation in process.

LocalRuntime is the toolchain's helper from
buck/toolchains/celld/tests/runtime_test.py, as copied by oauth.
"""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="oidc-runtime-test-")
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
            # No inherited proxy or celld setting may apply.
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


class OidcRuntimeTest(unittest.TestCase):
    """The provider, a relying party and a federation on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def get(self, path):
        status, body = self.runtime.request("GET", path)
        self.assertEqual(status, 200, body)
        return body

    def post(self, path, payload):
        status, body = self.runtime.request("POST", path, payload)
        self.assertEqual(status, 200, body)
        return body

    def test_discovery_is_served_over_http(self):
        origin = self.runtime.origin
        metadata = self.get("/op/.well-known/openid-configuration")
        self.assertEqual(metadata["issuer"], origin + "/op")
        self.assertEqual(metadata["userinfo_endpoint"], origin + "/op/userinfo")
        self.assertEqual(metadata["end_session_endpoint"], origin + "/op/end_session")
        self.assertEqual(metadata["id_token_signing_alg_values_supported"], ["ES256"])
        self.assertIn("ES256", metadata["dpop_signing_alg_values_supported"])

    def test_a_dpop_login_with_userinfo(self):
        result = self.get("/login?dpop=1")
        self.assertEqual(result["subject"], "runtime-user")
        self.assertEqual(result["tokenType"], "DPoP")
        self.assertEqual(len(result["sid"]), 32)
        self.assertEqual(result["userinfo"], {
            "email": "runtime@example.com",
            "email_verified": True,
            "sub": "runtime-user",
        })

    def test_an_ended_session_outlives_restarts(self):
        first = self.get("/login?dpop=0")
        self.runtime.restart()
        refreshed = self.post("/refresh", {
            "refreshToken": first["refreshToken"], "claims": first["claims"]})
        self.assertTrue(refreshed["ok"], refreshed)
        self.assertEqual(refreshed["claims"]["sub"], "runtime-user")
        self.assertEqual(refreshed["claims"]["auth_time"], first["claims"]["auth_time"])
        self.assertNotIn("nonce", refreshed["claims"])
        out = self.post("/logout", {"idToken": refreshed["idToken"]})
        self.assertEqual(out["status"], 303, out)
        self.assertEqual(out["location"], "http://127.0.0.1/bye?state=bye")
        self.runtime.restart()
        ended = self.post("/refresh", {
            "refreshToken": refreshed["refreshToken"], "claims": refreshed["claims"]})
        self.assertEqual(ended, {"ok": False, "error": "invalid_grant"})

    def test_a_trust_chain_through_the_durable_cache(self):
        first = self.get("/federation")
        self.assertEqual(first["statements"], 3)
        self.assertEqual(first["metadata"]["openid_relying_party"]["contacts"],
                         ["leaf@example.com", "ta@example.com"])
        again = self.get("/federation")
        self.assertEqual(again["fetches"], 0, again)
        self.runtime.restart()
        rotated = self.get("/federation")
        self.assertEqual(rotated["statements"], 3)
        self.assertGreater(rotated["fetches"], 0, rotated)


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
