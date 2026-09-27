# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run @celld/sec/cedar's stores and SQL filters inside a real celld dev supervisor.

Buck provides the pinned CLI and the packaged test project
(tests/runtime/worker.ts). The Deno suites check the library against the
real cedar-wasm module; this one checks what needs the runtime: the module
served to a Worker as a compiled sibling, the policy and entity stores on a
Durable Object's SQLite (validate-on-write, links, version conflicts,
recursive ancestor loads), the SQL compiled from partial evaluation against
Cedar's own per-row decisions, and writes surviving a supervisor restart.
No network is involved.

LocalRuntime is the toolchain's helper from
buck/toolchains/celld/tests/runtime_test.py.
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
        self.temporary = tempfile.TemporaryDirectory(prefix="cedar-runtime-test-")
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
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CELLD_", "AWS_", "S3_")) and key != "RUST_LOG"}
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

    def request(self, path="/", payload=None, timeout=60):
        """Issue one public request and surface HTTP/network failures with logs."""
        data = b"{}" if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.origin + path, data=data,
                                         headers={"Content-Type": "application/json"})
        # Ignore any inherited HTTP proxy for isolated loopback traffic.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise AssertionError(f"HTTP {error.code}: {error.read().decode()}\n{self.logs()}") from error
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


class StoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def suite(self, name, object_name=None):
        path = "/" + name + ("?object=" + object_name if object_name else "")
        result = self.runtime.request(path)
        self.maxDiff = None
        self.assertEqual(result, {"ok": True, "failures": []}, "\n".join(result.get("failures", [])))

    def test_policy_store(self):
        self.suite("policy-store")

    def test_entity_store(self):
        self.suite("entity-store")

    def test_query_matches_cedar_row_by_row(self):
        self.suite("query")

    def test_query_errs_where_cedar_errs(self):
        self.suite("errors")

    def test_writes_survive_a_restart(self):
        self.suite("durable-write", "durable")
        self.runtime.restart()
        self.suite("durable-read", "durable")


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
