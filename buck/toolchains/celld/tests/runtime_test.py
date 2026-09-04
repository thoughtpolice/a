# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exercise celld's real local runtime, without a fleet or external storage.

Buck provides the pinned CLI and three prepackaged JavaScript projects. Each test
class gets a fresh project, local dev database, and loopback port. The runner
waits for the supervisor's readiness log rather than issuing a Worker request:
the promise-tail regression must receive exactly one public request. Startup,
HTTP calls, log settling, and shutdown have separate bounds; cleanup also runs
on SIGTERM/SIGINT. No Wrangler, images, or application fixtures are involved.
"""

import json
import os
from pathlib import Path
import re
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


MISSING = {"error": {"name": "Error", "message": "WORKFLOW_ERROR: instance does not exist"}}


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="celld-runtime-test-")
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

    def request(self, payload=None, timeout=15):
        """Issue one public request and surface HTTP/network failures with logs."""
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.origin, data=data,
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


class PromiseTailTest(unittest.TestCase):
    """Cross-request async work remains owned after the earlier fetch ends."""

    def test_shared_tail_completes_both_requests(self):
        runtime = LocalRuntime(PROMISE_PROJECT)
        self.addCleanup(runtime.close)
        self.assertEqual(runtime.request(timeout=5), ["done /a", "done /b"])
        runtime.until(lambda: len(re.findall(r"(?:START|END) /[ab]", runtime.logs())) == 4,
                      2, "promise-tail log delivery")
        events = re.findall(r"(?:START|END) /[ab]", runtime.logs())
        self.assertIn(events, [
            ["START /a", "END /a", "START /b", "END /b"],
            ["START /b", "END /b", "START /a", "END /a"],
        ])


class WorkflowTest(unittest.TestCase):
    """Pin real retention/deletion semantics that application fakes must match."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(WORKFLOW_PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def scenario(self, name, mode=None):
        return self.runtime.request({"name": name, "mode": mode})

    def test_missing_get_is_an_error_not_an_instance(self):
        self.assertEqual(self.scenario("missing"), MISSING)

    def test_create_get_and_retained_duplicate_batch(self):
        result = self.scenario("duplicate")
        self.assertEqual(result["status"]["status"], "complete")
        self.assertEqual(result["fetched"], {"id": result["id"], "status": result["status"]})
        self.assertEqual(result["duplicate"], {"error": {
            "name": "Error",
            "message": f'WORKFLOW_ERROR: instance "{result["id"]}" already exists with status "complete"',
        }})
        self.assertEqual(result["batch"], [result["id"] + "-new"])
        self.assertEqual(result["batchStatus"]["output"], {"value": "first"})

    def test_success_and_error_retention_expire_and_allow_recreation(self):
        for mode, status in [("success", "complete"), ("error", "errored")]:
            with self.subTest(mode=mode):
                result = self.scenario("retention", mode)
                self.assertEqual(result["status"]["status"], status)
                self.assertEqual(result["expired"], MISSING)
                self.assertEqual(result["missing"], MISSING)
                self.assertEqual(result["recreated"]["output"], {"value": "replacement"})

    def test_delete_and_stale_handle_recreation(self):
        for mode in ["success", "wait"]:
            with self.subTest(mode=mode):
                result = self.scenario("delete", mode)
                for key in ["missing", "staleStatus", "staleDelete"]:
                    self.assertEqual(result[key], MISSING)
                self.assertEqual(result["reusedHandle"]["output"], {"value": "replacement"})

    def test_delete_batch_preserves_duplicate_positions_and_not_found(self):
        result = self.scenario("delete-batch")
        instance_id = result["id"]
        self.assertEqual(result["result"], {
            "deleted": [{"id": instance_id}, {"id": instance_id}, {"id": instance_id + "-other"}],
            "errors": [{"id": instance_id + "-missing", "code": 10400,
                        "message": "workflows.api.error.instance.not_found"}],
        })
        self.assertEqual(result["first"], MISSING)
        self.assertEqual(result["other"], MISSING)


class RPCTest(unittest.TestCase):
    """Pin native copying, visibility, error envelopes, and SQLite persistence."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(RPC_PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_arguments_and_results_are_independent_structured_clones(self):
        result = self.runtime.request({"scenario": "clone", "name": "clone"})
        original = {"count": 1, "bytes": [3, 4], "map": [["caller", 1]],
                    "date": "2026-01-02T03:04:05.000Z", "typed": True}
        transformed = dict(original, count=2, bytes=[4, 4], map=[["caller", 1], ["callee", 2]])
        self.assertEqual(result, {"original": original, "received": transformed,
                                  "retained": transformed, "absent": None, "voidIsUndefined": True})

    def test_do_and_service_visibility_have_different_runtime_rules(self):
        result = self.runtime.request({"scenario": "visibility", "name": "visibility"})
        self.assertEqual(result["object"]["publicHelper"], {"value": "helper-result"})
        self.assertEqual(result["object"]["ownMethod"], {"value": "own-method"})
        self.assertEqual(result["object"]["alarm"], {"value": "alarm-rpc"})
        self.assertEqual(result["service"]["publicHelper"], {"value": "service-helper"})
        for target, names in [("object", ["helper", "#helper", "field", "ctx", "missing"]),
                              ("service", ["ownMethod", "alarm", "helper", "#helper", "field", "ctx", "missing"])]:
            for name in names:
                with self.subTest(target=target, method=name):
                    failure = result[target][name]
                    self.assertEqual(set(failure), {"error"})
                    self.assertEqual(failure["error"]["name"], "TypeError")
        self.assertIn("reserved method", result["service"]["alarm"]["error"]["message"])

    def test_remote_errors_preserve_data_but_not_custom_class_identity(self):
        result = self.runtime.request({"scenario": "errors", "name": "errors"})
        common = {"remote": True, "isError": True, "isTypeError": False,
                  "isCustom": False, "plainErrorPrototype": True, "hidden": False,
                  "uncloneable": False, "stackStartsWithMessage": True}
        self.assertEqual(result["custom"], dict(
            common, name="ContractError", message="custom rejection", status=409,
            metadata={"expected": 7, "labels": ["fenced", "retry"]},
        ))
        self.assertEqual(result["standard"], dict(
            common, name="TypeError", message="standard rejection", status=422,
            metadata={"field": "count"}, isTypeError=True, plainErrorPrototype=False,
        ))
        # One unclonable own property causes the complete custom-property
        # envelope to fall back to name/message, not partial preservation.
        self.assertEqual(result["uncloneable"], dict(
            common, name="ContractError", message="custom rejection", status=None, metadata=None,
        ))

    def test_acknowledged_rpc_write_survives_supervisor_restart(self):
        value = {"version": 1, "items": ["durable", "record"]}
        self.assertEqual(self.runtime.request({"scenario": "write", "name": "durable", "value": value}),
                         {"value": value})
        self.runtime.restart()
        self.assertEqual(self.runtime.request({"scenario": "read", "name": "durable"}), {"value": value})


def interrupted(signum, _frame):
    """Unwind unittest cleanups before exiting on runner cancellation."""
    raise KeyboardInterrupt(f"received signal {signum}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("usage: runtime_test.py CELLD PROMISE_PROJECT WORKFLOW_PROJECT RPC_PROJECT")
    CELLD, PROMISE_PROJECT, WORKFLOW_PROJECT, RPC_PROJECT = (Path(value).resolve() for value in sys.argv[1:])
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
