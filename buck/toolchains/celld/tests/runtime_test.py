# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exercise celld's real local runtime, without a fleet or external storage.

Buck provides the pinned CLI, five prepackaged JavaScript projects and one
bundled from a library with a wasm module. Each test
class gets a fresh project, local dev database, and loopback port. The runner
waits for the supervisor's readiness log rather than issuing a Worker request:
the promise-tail regression must receive exactly one public request. Startup,
HTTP calls, log settling, and shutdown have separate bounds; cleanup also runs
on SIGTERM/SIGINT. No Wrangler, images, or application fixtures are involved.
"""

import base64
import hashlib
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
import threading
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request


# workerd's text, which celld reuses.
WEBSOCKET_WITHOUT_UPGRADE = ('Worker tried to return a WebSocket in a response to a request '
                             'which did not contain the header "Upgrade: websocket".')

MISSING = {"error": {"name": "Error", "message": "WORKFLOW_ERROR: instance does not exist"}}


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project, dev_vars=None):
        self.temporary = tempfile.TemporaryDirectory(prefix="celld-runtime-test-")
        self.root = Path(self.temporary.name)
        self.log_path = self.root / "celld.log"
        self.process = None
        self.log = None
        try:
            shutil.copytree(project, self.root / "project")
            if dev_vars is not None:
                (self.root / "project" / ".dev.vars").write_text(dev_vars)
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

    def status(self, path, timeout=15):
        """The status and body of one GET, whatever the status."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(self.origin + path, timeout=timeout) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def request(self, payload=None, timeout=15, path="/"):
        """Issue one public request and surface HTTP/network failures with logs."""
        data = None if payload is None else json.dumps(payload).encode()
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


class WebSocketClient:
    """The RFC 6455 client side, as much as these tests need: text frames
    only, every frame in one piece. The standard library has none."""

    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, origin, path, timeout=15):
        host, port = origin.removeprefix("http://").split(":")
        self.socket = socket.create_connection((host, int(port)), timeout=timeout)
        self.buffer = b""
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall((
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode())
        while b"\r\n\r\n" not in self.buffer:
            self.buffer += self.read_some()
        head, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            raise AssertionError(f"upgrade refused: {head!r}")
        accept = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        headers = {name.strip().lower(): value.strip()
                   for name, _, value in (line.partition(":") for line in lines[1:])}
        if headers.get("sec-websocket-accept") != accept:
            raise AssertionError(f"bad Sec-WebSocket-Accept: {head!r}")

    def read_some(self):
        chunk = self.socket.recv(65536)
        if not chunk:
            raise AssertionError("WebSocket connection closed")
        return chunk

    def read_exactly(self, count):
        while len(self.buffer) < count:
            self.buffer += self.read_some()
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def send(self, text, opcode=0x1):
        payload = text.encode()
        mask = os.urandom(4)
        if len(payload) < 126:
            header = bytes([0x80 | opcode, 0x80 | len(payload)])
        else:
            header = bytes([0x80 | opcode, 0x80 | 126]) + len(payload).to_bytes(2, "big")
        self.socket.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def receive(self):
        """The next text frame; a close frame is an error."""
        first, second = self.read_exactly(2)
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(self.read_exactly(2), "big")
        elif length == 127:
            length = int.from_bytes(self.read_exactly(8), "big")
        payload = self.read_exactly(length)
        if first & 0x0F != 0x1:
            raise AssertionError(f"unexpected frame opcode {first & 0x0F}: {payload!r}")
        return payload.decode()

    def close(self):
        try:
            self.send("", opcode=0x8)
        except OSError:
            pass
        self.socket.close()


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


class ReleaseTest(unittest.TestCase):
    """Pin the behavior that the shared declarations encode."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(RELEASE_PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def scenario(self, name):
        return self.runtime.request({"scenario": name})

    def test_transaction_sync_takes_no_argument_and_nests_through_the_root(self):
        self.assertEqual(self.scenario("transactions"), {"callbackArguments": 0, "rows": ["outer"]})

    def test_invalid_utf8_text_decodes_with_replacement_characters(self):
        self.assertEqual(self.scenario("invalid-text"), "\ufffda")

    def test_facet_starts_from_a_ctx_exports_class(self):
        self.assertEqual(self.scenario("facet"), {"value": [1, 2]})

    def test_facet_ids_keep_their_kind_and_name_and_classes_take_props(self):
        release_id = self.scenario("facet-startup")["value"]["inherited"]["text"]
        self.assertEqual(self.scenario("facet-startup"), {"value": {
            "inherited": {"kind": "object", "text": release_id, "name": "release", "props": {}},
            "named": {"kind": "object", "text": unittest.mock.ANY, "name": "child", "props": {}},
            "string": {"kind": "string", "text": "literal", "name": None, "props": {}},
            "props": {"kind": "object", "text": release_id, "name": "release",
                      "props": {"tag": "startup"}},
            "noOptions": "TypeError",
            "nullOptions": None,
            "scalarProps": "TypeError",
        }})

    def test_an_unfinished_kv_list_iterator_does_not_block_writes(self):
        self.assertEqual(self.scenario("kv-list"), {
            "afterLeak": "ok",
            "first": "list/a",
            "rest": ["list/after=after", "list/b=B"],
            "invalidated": "kv.list() iterator was invalidated because a new call to "
                           "kv.list() was started. Only one kv.list() iterator can exist at a time.",
        })

    def test_disposing_a_named_load_releases_it_for_every_stub(self):
        self.assertEqual(self.scenario("loader-lifetime"), {"value": {
            "loads": 2, "counts": ["1", "2", "1"], "stale": True,
        }})

    def test_ctx_exports_holds_default_entrypoints_namespaces_and_classes(self):
        self.assertEqual(self.scenario("exports"), {
            "keys": ["Child", "Named", "Root", "default"],
            "fetched": "loopback POST",
            "named": "pong",
        })

    def test_worker_code_needs_a_date_and_wrapped_wasm(self):
        result = self.scenario("loader")
        self.assertEqual(result["wrapped"], {"value": "true"})
        self.assertEqual(result["undated"], {"error": {
            "name": "Error", "message": "Invalid compatibility date: undefined"}})
        self.assertEqual(result["bare"]["error"]["name"], "TypeError")
        self.assertIn("exactly one of", result["bare"]["error"]["message"])

    def test_self_is_the_global_scope_in_every_isolate(self):
        # #247: `self` was undefined in all three.
        self.assertEqual(self.scenario("self"), {"worker": True, "object": True, "loaded": "true"})

    def test_a_loaded_plain_class_starts_a_facet(self):
        # #248 refused it with "no DO class Plain".
        self.assertEqual(self.scenario("plain-facet"), {"value": "plain"})

    def test_a_loaded_worker_fetch_honors_the_callers_signal(self):
        # #257 answered after five seconds, past the 100 ms timeout.
        self.assertEqual(self.scenario("loader-signal"), {"value": {
            "timedOut": "TimeoutError",
            "early": True,
            "aborted": {"error": {"name": "Error", "message": "caller gave up"}},
        }})

    def test_a_websocket_response_needs_an_upgrade_request(self):
        # Before 0.6.2 both answered 101. A stub's caller sees a plain Error
        # that names the TypeError.
        message = WEBSOCKET_WITHOUT_UPGRADE
        self.assertEqual(self.scenario("websocket-without-upgrade"), {"error": {
            "name": "Error", "message": f"TypeError: {message}"}})
        self.assertEqual(self.runtime.status("/websocket"), (500, f"Worker failed: TypeError: {message}"))

    def test_ed25519_and_x25519(self):
        self.assertEqual(self.scenario("curves"), {"value": {
            "signatureBytes": 64, "rawPublicBytes": 32, "verified": True,
            "verifiedAsNode": True, "x25519Agrees": True,
        }})


class DevVarsTest(unittest.TestCase):
    """What `celld dev` makes of a `.dev.vars` file (AGENTS.md has the gaps)."""

    DEV_VARS = (
        "PLAIN=one\n"
        "export EXPORTED=two\n"
        'ESCAPED="a\\"b"\n'
        "COMMENT=value # not a comment\n"
        "DOLLAR=$HOME\n"
        "MULTI='first\n"
        "second'\n"
    )

    def test_export_and_multi_line_values_but_no_escapes(self):
        runtime = LocalRuntime(RELEASE_PROJECT, dev_vars=self.DEV_VARS)
        self.addCleanup(runtime.close)
        self.assertEqual(runtime.status("/vars"), (200, json.dumps({
            "COMMENT": "value # not a comment",
            "DOLLAR": "$HOME",
            "ESCAPED": 'a\\"b',
            "EXPORTED": "two",
            "MULTI": "first\nsecond",
            "PLAIN": "one",
        }, separators=(",", ":"))))


class WebSocketTest(unittest.TestCase):
    """Hibernatable sockets keep send order and run handlers concurrently."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(WEBSOCKET_PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def connect(self, room):
        client = WebSocketClient(self.runtime.origin, f"/?room={room}")
        self.addCleanup(client.close)
        return client

    def test_message_frames_keep_send_order_with_rpc_frames(self):
        # #236 put up to 39 of every 200 frames out of order.
        client = self.connect("order")
        count = 500
        failures = []

        def broadcast():
            try:
                for _ in range(count):
                    self.runtime.request(path="/broadcast?room=order")
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=broadcast)
        thread.start()
        for _ in range(count):
            client.send("tick")
        frames = [json.loads(client.receive()) for _ in range(2 * count)]
        thread.join(timeout=60)
        self.assertEqual(failures, [])
        self.assertEqual({frame["source"] for frame in frames}, {"message", "rpc"})
        late = [(a, b) for a, b in zip(frames, frames[1:]) if b["n"] < a["n"]]
        self.assertEqual(late, [], f"{len(late)} frames arrived out of send order")
        self.assertEqual([frame["n"] for frame in frames], list(range(1, 2 * count + 1)))

    def test_a_message_runs_while_an_earlier_handler_waits(self):
        # #242 ran `release` only after `hold` gave up.
        client = self.connect("concurrent")
        client.send("hold")
        self.assertEqual(client.receive(), "holding")
        client.send("release")
        self.assertEqual([client.receive(), client.receive()], ["releasing", "released"])

    def test_a_facet_accepts_and_dials_websockets(self):
        # #252: neither worked.
        client = WebSocketClient(self.runtime.origin, "/facet?room=facet")
        self.addCleanup(client.close)
        client.send("hello")
        self.assertEqual(client.receive(), "facet hello")
        self.assertEqual(self.runtime.request(path="/facet-dial?room=facet"), "echo dialed")


class WasmTest(unittest.TestCase):
    """A library's wasm module reaches the Worker as a compiled module: the
    project carries the file beside the bundle, which imports it by name."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(WASM_PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_the_bundle_imports_its_sibling_module(self):
        self.assertEqual(self.runtime.request(), {"compiled": True, "sum": 42})


def interrupted(signum, _frame):
    """Unwind unittest cleanups before exiting on runner cancellation."""
    raise KeyboardInterrupt(f"received signal {signum}")


if __name__ == "__main__":
    if len(sys.argv) != 8:
        raise SystemExit("usage: runtime_test.py CELLD PROMISE_PROJECT WORKFLOW_PROJECT RPC_PROJECT "
                         "RELEASE_PROJECT WEBSOCKET_PROJECT WASM_PROJECT")
    (CELLD, PROMISE_PROJECT, WORKFLOW_PROJECT, RPC_PROJECT, RELEASE_PROJECT, WEBSOCKET_PROJECT,
     WASM_PROJECT) = (Path(value).resolve() for value in sys.argv[1:])
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    unittest.main(argv=[sys.argv[0]], verbosity=2)
