# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/oauth inside a real celld dev supervisor.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites decide whether the library's rules
are right; this one decides whether they hold on the runtime: the OAuthRecords
Durable Object's SQLite statements and RPC, WebCrypto ES256 for access tokens
and DPoP proofs, a whole authorization with and without DPoP (nonces at both
servers), DPoP replay caught by the durable replay store, and refresh token
rotation and reuse detection surviving a supervisor restart. No network is
involved: the Worker's client reaches its servers in process.

LocalRuntime is the toolchain's helper from
buck/toolchains/celld/tests/runtime_test.py, as copied by jev.
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
        self.temporary = tempfile.TemporaryDirectory(prefix="oauth-runtime-test-")
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


class OAuthRuntimeTest(unittest.TestCase):
    """The authorization server, resource server and client on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def get(self, path):
        status, body = self.runtime.request("GET", path)
        self.assertEqual(status, 200, body)
        return body

    def test_metadata_is_served_over_http(self):
        origin = self.runtime.origin
        metadata = self.get("/.well-known/oauth-authorization-server/as")
        self.assertEqual(metadata["issuer"], origin + "/as")
        self.assertEqual(metadata["code_challenge_methods_supported"], ["S256"])
        self.assertIn("ES256", metadata["dpop_signing_alg_values_supported"])
        resource = self.get("/.well-known/oauth-protected-resource/api")
        self.assertEqual(resource["resource"], origin + "/api")
        self.assertEqual(resource["authorization_servers"], [origin + "/as"])
        jwks = self.get("/as/jwks")
        self.assertEqual([key["kty"] for key in jwks["keys"]], ["EC"])
        self.assertNotIn("d", jwks["keys"][0])

    def test_the_record_object_is_atomic_and_expires_records(self):
        result = self.get("/records")
        self.assertTrue(result["created"])
        self.assertFalse(result["again"])
        self.assertEqual(result["record"]["value"], {"n": 1})
        self.assertEqual(result["record"]["version"], 1)
        self.assertFalse(result["stale"])
        self.assertTrue(result["swapped"])
        self.assertEqual(result["after"]["value"], {"n": 4})
        self.assertEqual(result["after"]["version"], 2)
        self.assertIsNone(result["expired"])

    def test_a_bearer_authorization_end_to_end(self):
        result = self.get("/flow?dpop=0")
        self.assertEqual(result["status"], 200, result)
        self.assertEqual(result["tokenType"], "Bearer")
        self.assertEqual(result["principal"]["subject"], "runtime-user")
        self.assertEqual(result["principal"]["tokenType"], "Bearer")

    def test_a_dpop_authorization_end_to_end(self):
        result = self.get("/flow?dpop=1")
        self.assertEqual(result["status"], 200, result)
        self.assertEqual(result["tokenType"], "DPoP")
        self.assertEqual(result["principal"]["tokenType"], "DPoP")
        self.assertEqual(len(result["principal"]["cnf"]["jkt"]), 43)

    def test_a_replayed_proof_is_refused(self):
        result = self.get("/replay")
        self.assertEqual(result["first"], 200, result)
        self.assertEqual(result["second"], 401, result)
        self.assertIn('error="invalid_dpop_proof"', result["secondError"])

    def test_refresh_rotation_and_reuse_detection_survive_a_restart(self):
        first = self.get("/flow?dpop=0")["refreshToken"]
        self.runtime.restart()
        status, rotated = self.runtime.request("POST", "/refresh", {"refreshToken": first})
        self.assertEqual(status, 200, rotated)
        self.assertTrue(rotated["ok"], rotated)
        second = rotated["refreshToken"]
        self.assertNotEqual(second, first)
        status, reused = self.runtime.request("POST", "/refresh", {"refreshToken": first})
        self.assertEqual(reused, {"ok": False, "error": "invalid_grant"})
        # Reuse revoked the family, including the token the client holds now.
        status, revoked = self.runtime.request("POST", "/refresh", {"refreshToken": second})
        self.assertEqual(revoked, {"ok": False, "error": "invalid_grant"})


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
