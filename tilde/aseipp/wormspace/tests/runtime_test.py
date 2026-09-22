# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Drive the packaged segment service against a real celld dev supervisor.

Buck provides the pinned CLI and the packaged project. The pure tests decide
whether the rules are right; this one decides whether the service actually
implements them on the runtime: SQLite round-trips of values and capture
ranges, base64 at the edge, the status map, and durability of registers and
rounds across a supervisor restart. Each class owns one temporary project,
local database, and loopback port, and each test uses its own segment name,
so no two tests share a cell.

LocalRuntime is the journal's copy of the toolchain's own helper from
buck/toolchains/celld/tests/runtime_test.py; the journal's README lists
extracting it into a shared library as a follow-up.
"""

import base64
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


MEBIBYTE = 1024 * 1024


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="wormspace-runtime-test-")
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

    def declare_oversized_body(self, path, content_length, timeout=15):
        """Announce a body over the cap, and send none of it.

        The service answers from Content-Length without reading the body, which
        is the whole point of that check; withholding the body is the strongest
        way to show it, and it avoids racing a connection the server closes
        under a sender it never intends to listen to.
        """
        host, port = self.origin.removeprefix("http://").split(":")
        head = (
            f"POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {content_length}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        with socket.create_connection((host, int(port)), timeout=timeout) as connection:
            connection.sendall(head)
            reply = b""
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                reply += chunk
        status = int(reply.split(b" ", 2)[1])
        return status, json.loads(reply.split(b"\r\n\r\n", 1)[1])

    def status(self, name):
        return self.request("GET", f"/v1/segments/{name}")

    def post(self, name, operation, payload):
        return self.request("POST", f"/v1/segments/{name}/{operation}", payload)

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


def encode(payload):
    return base64.b64encode(payload).decode()


def decode(text):
    return base64.b64decode(text)


class SegmentTestCase(unittest.TestCase):
    """Shared helpers; each test addresses a segment named after itself."""

    def segment(self):
        """A distinct, well-formed segment name per test method."""
        return self.id().rsplit(".", 1)[-1].replace("_", "-")

    def expect(self, response, status, code=None):
        """Assert one reply's status and code, showing the whole body on failure."""
        self.assertEqual(response[0], status, response)
        if code is not None:
            self.assertEqual(response[1].get("code"), code, response)
        return response[1]

    def alloc(self, name, size, allocator="alpha", metadata=b"meta"):
        return self.runtime.post(name, "alloc", {
            "size": size, "metadata": encode(metadata), "allocator": allocator})

    def capture(self, name, start, end=None, owner=None):
        body = {"start": start}
        if end is not None:
            body["end"] = end
        if owner is not None:
            body["owner"] = owner
        return self.runtime.post(name, "capture", body)

    def write(self, name, start, values, capture_id):
        return self.runtime.post(name, "write", {
            "start": start, "values": [encode(value) for value in values],
            "captureId": capture_id})

    def read(self, name, start, **options):
        return self.runtime.post(name, "read", {"start": start, **options})


class SegmentProtocolTest(SegmentTestCase):
    """The service's externally visible protocol, on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_a_fresh_segment_is_unallocated(self):
        body = self.expect(self.runtime.status(self.segment()), 200)
        self.assertEqual(
            {key: body[key] for key in ["allocated", "size", "metadata", "allocator",
                                        "allocatedMs", "nextRound", "writtenCount",
                                        "writes", "captures", "trimmedThrough"]},
            {"allocated": False, "size": 0, "metadata": None, "allocator": None,
             "allocatedMs": 0, "nextRound": 1, "writtenCount": 0, "writes": 0,
             "captures": 0, "trimmedThrough": -1})
        self.assertGreater(body["databaseSize"], 0)

    def test_the_first_allocator_wins_and_the_second_learns_it(self):
        name = self.segment()
        metadata = b"\x00chain:next=seg-2\xff"
        won = self.expect(self.alloc(name, 16, "alpha", metadata), 200)
        self.assertEqual(won["size"], 16)
        self.assertGreater(won["allocatedMs"], 1_700_000_000_000)
        lost = self.expect(self.alloc(name, 64, "beta", b"other"), 409, "ALREADY_ALLOCATED")
        self.assertEqual((lost["size"], lost["allocator"], lost["allocatedMs"]),
                         (16, "alpha", won["allocatedMs"]))
        self.assertEqual(decode(lost["metadata"]), metadata)
        status = self.expect(self.runtime.status(name), 200)
        self.assertEqual((status["allocated"], status["size"], status["allocator"]),
                         (True, 16, "alpha"))
        self.assertEqual(decode(status["metadata"]), metadata)

    def test_empty_metadata_reads_back_as_empty(self):
        name = self.segment()
        self.expect(self.alloc(name, 2, metadata=b""), 200)
        self.assertEqual(self.expect(self.runtime.status(name), 200)["metadata"], "")
        lost = self.expect(self.alloc(name, 2, "beta"), 409, "ALREADY_ALLOCATED")
        self.assertEqual(lost["metadata"], "")

    def test_capture_batch_write_and_read_round_trip(self):
        name = self.segment()
        self.expect(self.alloc(name, 8), 200)
        captured = self.expect(self.capture(name, 0, 8, owner="alpha"), 200)
        self.assertEqual((captured["captureId"], captured["start"], captured["end"],
                          captured["alreadyWritten"]), (1, 0, 8, 0))
        values = [b"", b"\x00\xff", bytes(range(256)), "wormspace ✓".encode()]
        written = self.expect(self.write(name, 0, values, captured["captureId"]), 200)
        self.assertEqual((written["start"], written["end"]), (0, 4))

        big = bytes((index * 7) % 256 for index in range(MEBIBYTE))
        self.expect(self.write(name, 5, [big], captured["captureId"]), 200)

        window = self.expect(self.read(name, 0, count=8, maxBytes=4 * MEBIBYTE), 200)
        self.assertEqual((window["size"], window["trimmedThrough"]), (8, -1))
        registers = window["registers"]
        self.assertEqual([register["offset"] for register in registers], list(range(8)))
        self.assertEqual([register["state"] for register in registers],
                         ["written"] * 4 + ["captured", "written", "captured", "captured"])
        self.assertEqual({register["round"] for register in registers}, {1})
        self.assertEqual([decode(register["value"]) for register in registers[:4]], values)
        self.assertNotIn("value", registers[4], "a hole carries no value")
        self.assertEqual(decode(registers[5]["value"]), big)

        # A budget below one value still returns it, and holes are free.
        first = self.expect(self.read(name, 5, maxBytes=1), 200)["registers"]
        self.assertEqual([register["offset"] for register in first], [5, 6, 7])
        self.assertEqual(decode(first[0]["value"]), big)
        short = self.expect(self.read(name, 3, maxBytes=100), 200)["registers"]
        self.assertEqual([register["offset"] for register in short], [3, 4],
                         "the megabyte at 5 does not fit a 100-byte budget")

        status = self.expect(self.runtime.status(name), 200)
        self.assertEqual((status["writtenCount"], status["writes"], status["nextRound"],
                          status["captures"]), (5, 5, 2, 1))

    def test_a_stolen_capture_fences_the_old_writer(self):
        name = self.segment()
        self.expect(self.alloc(name, 8), 200)
        mine = self.expect(self.capture(name, 0, 8, owner="alpha"), 200)["captureId"]
        self.expect(self.write(name, 0, [b"alpha-0"], mine), 200)
        theirs = self.expect(self.capture(name, 0, 8, owner="beta"), 200)
        self.assertGreater(theirs["captureId"], mine)
        self.assertEqual(theirs["alreadyWritten"], 1)

        stale = self.expect(self.write(name, 1, [b"alpha-1"], mine), 409, "CAPTURE_STALE")
        self.assertEqual((stale["offset"], stale["round"], stale["captureId"]),
                         (1, theirs["captureId"], mine))
        self.expect(self.write(name, 1, [b"beta-1"], theirs["captureId"]), 200)
        registers = self.expect(self.read(name, 0, count=2), 200)["registers"]
        self.assertEqual([(register["round"], decode(register["value"])) for register in registers],
                         [(mine, b"alpha-0"), (theirs["captureId"], b"beta-1")])
        # The dominated capture row was pruned: one row per whole-segment capture.
        self.assertEqual(self.expect(self.runtime.status(name), 200)["captures"], 1)

    def test_a_replay_learns_whether_its_write_landed(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        round_ = self.expect(self.capture(name, 0, 4), 200)["captureId"]
        self.expect(self.write(name, 2, [b"\x00once\xff"], round_), 200)
        same = self.expect(self.write(name, 2, [b"\x00once\xff"], round_),
                           409, "ALREADY_WRITTEN")
        self.assertEqual((same["offset"], same["sameValue"]), (2, True))
        other = self.expect(self.write(name, 2, [b"\x00twice\xff"], round_),
                            409, "ALREADY_WRITTEN")
        self.assertEqual((other["offset"], other["sameValue"]), (2, False))
        # A batch that reaches the written register is refused whole.
        self.expect(self.write(name, 1, [b"one", b"two"], round_), 409, "ALREADY_WRITTEN")
        self.assertEqual(self.expect(self.read(name, 1, count=1), 200)["registers"][0]["state"],
                         "captured")
        self.assertEqual(self.expect(self.runtime.status(name), 200)["writtenCount"], 1)

    def test_an_unsafe_write_needs_a_register_nobody_captured(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        self.expect(self.write(name, 0, [b"unsafe"], 0), 200)
        round_ = self.expect(self.capture(name, 1), 200)["captureId"]
        refused = self.expect(self.write(name, 1, [b"unsafe"], 0), 409, "CAPTURE_STALE")
        self.assertEqual((refused["offset"], refused["round"], refused["captureId"]),
                         (1, round_, 0))
        register = self.expect(self.read(name, 0, count=1), 200)["registers"][0]
        self.assertEqual((register["state"], register["round"], decode(register["value"])),
                         ("written", 0, b"unsafe"))

    def test_trim_deletes_a_prefix_and_clips_captures(self):
        name = self.segment()
        self.expect(self.alloc(name, 10), 200)
        round_ = self.expect(self.capture(name, 0, 10), 200)["captureId"]
        self.expect(self.write(name, 0, [bytes([n]) for n in range(6)], round_), 200)
        trimmed = self.expect(self.runtime.post(name, "trim", {"through": 3}), 200)
        self.assertEqual(trimmed, {"ok": True, "trimmedThrough": 3, "deleted": 4})
        gone = self.expect(self.read(name, 2), 410, "TRIMMED")
        self.assertEqual(gone["trimmedThrough"], 3)
        self.expect(self.write(name, 3, [b"x"], round_), 410, "TRIMMED")
        self.expect(self.capture(name, 0, 4), 410, "TRIMMED")
        clipped = self.expect(self.capture(name, 1, 8), 200)
        self.assertEqual((clipped["start"], clipped["end"], clipped["alreadyWritten"]), (4, 8, 2))
        live = self.expect(self.read(name, 4, count=3), 200)["registers"]
        self.assertEqual([register["state"] for register in live], ["written", "written", "captured"])
        self.assertEqual(self.expect(self.runtime.post(name, "trim", {"through": 1}), 200),
                         {"ok": True, "trimmedThrough": 3, "deleted": 0},
                         "trim never moves backwards")
        self.expect(self.runtime.post(name, "trim", {"through": 10}), 400, "OUT_OF_RANGE")
        status = self.expect(self.runtime.status(name), 200)
        self.assertEqual((status["writtenCount"], status["writes"]), (2, 6),
                         "a trim never lowers the writes counter")

    def test_malformed_requests_are_refused_at_the_edge(self):
        name = self.segment()
        self.expect(self.runtime.status("Not-A-Name"), 400, "INVALID")
        self.expect(self.runtime.status("%2Eseg"), 400, "INVALID")
        self.expect(self.runtime.post(name, "watch", {}), 404, "NOT_FOUND")
        self.expect(self.runtime.request("GET", f"/v1/segments/{name}/listen"),
                    404, "NOT_FOUND")
        self.expect(self.runtime.post(name, "constructor", {}), 404, "NOT_FOUND")
        self.expect(self.runtime.request("GET", "/"), 404, "NOT_FOUND")
        self.expect(self.capture(name, 0), 409, "UNALLOCATED")
        self.expect(self.write(name, 0, [b"x"], 0), 409, "UNALLOCATED")
        self.expect(self.read(name, 0), 409, "UNALLOCATED")
        self.expect(self.runtime.post(name, "trim", {"through": 0}), 409, "UNALLOCATED")
        self.expect(self.alloc(name, 0), 400, "INVALID")
        self.expect(self.runtime.post(name, "alloc", {"size": 4, "metadata": "not!"}),
                    400, "INVALID")
        self.expect(self.alloc(name, 4), 200)
        self.expect(self.capture(name, 4), 400, "OUT_OF_RANGE")
        self.expect(self.capture(name, 2, 5), 400, "OUT_OF_RANGE")
        self.expect(self.write(name, 3, [b"a", b"b"], 0), 400, "OUT_OF_RANGE")
        self.expect(self.read(name, 4), 400, "OUT_OF_RANGE")
        self.expect(self.write(name, 0, [], 0), 400, "INVALID")
        self.expect(self.runtime.post(name, "write", {"start": 0, "values": ["not!"],
                                                      "captureId": 0}), 400, "INVALID")
        self.expect(self.write(name, 0, [b"x"], 99), 400, "INVALID")
        self.expect(self.read(name, 0, count=0), 400, "INVALID")

    def test_oversized_payloads_are_refused_before_they_are_stored(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        too_big = self.expect(self.write(name, 0, [bytes(MEBIBYTE + 1)], 0), 413, "TOO_LARGE")
        self.assertIn("value", too_big["message"])
        self.expect(self.alloc(self.segment() + "-meta", 4, metadata=bytes(64 * 1024 + 1)),
                    413, "TOO_LARGE")
        body = self.expect(
            self.runtime.declare_oversized_body(f"/v1/segments/{name}/write", 9 * MEBIBYTE),
            413, "TOO_LARGE",
        )
        self.assertIn("body", body["message"], "the body cap is checked before the body")
        self.assertEqual(self.expect(self.runtime.status(name), 200)["writtenCount"], 0)


class SegmentDurabilityTest(SegmentTestCase):
    """Acknowledged state must survive the whole supervisor being replaced."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_registers_and_rounds_survive_a_supervisor_restart(self):
        name = self.segment()
        self.expect(self.alloc(name, 12, "alpha", b"\x00\xff"), 200)
        old = self.expect(self.capture(name, 0, 12, owner="alpha"), 200)["captureId"]
        self.expect(self.write(name, 0, [b"\x00\xff", b"a1", b"a2"], old), 200)
        new = self.expect(self.capture(name, 0, 12, owner="beta"), 200)["captureId"]
        self.expect(self.write(name, 3, [b"b3"], new), 200)
        self.expect(self.write(name, 11, [b"late"], 0), 409, "CAPTURE_STALE")
        self.expect(self.runtime.post(name, "trim", {"through": 1}), 200)
        before = self.expect(self.runtime.status(name), 200)
        window = self.expect(self.read(name, 2, count=10), 200)

        self.runtime.restart()

        after = self.expect(self.runtime.status(name), 200)
        for key in ["allocated", "size", "metadata", "allocator", "allocatedMs", "nextRound",
                    "writtenCount", "writes", "captures", "trimmedThrough"]:
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after["writes"], 4)
        self.assertEqual(self.expect(self.read(name, 2, count=10), 200), window)

        # Rounds are state too: the thief's capture still holds, the old one
        # is still stale, and the next round continues where it stopped.
        self.expect(self.write(name, 4, [b"a4"], old), 409, "CAPTURE_STALE")
        self.expect(self.write(name, 4, [b"b4"], new), 200)
        self.assertEqual(self.expect(self.capture(name, 5), 200)["captureId"], new + 1)
        replay = self.expect(self.write(name, 3, [b"b3"], new), 409, "ALREADY_WRITTEN")
        self.assertIs(replay["sameValue"], True)


class SegmentListenTest(SegmentTestCase):
    """`listen` on the real runtime: parked requests, releases, and timeouts.

    Latencies are printed to stderr, which is where the README's numbers come
    from.
    """

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def listen(self, name, since, timeout_ms=None):
        body = {"since": since}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self.runtime.post(name, "listen", body)

    def park(self, name, since, timeout_ms):
        """Start a listen in a thread; returns (thread, box) where box gets the
        reply and the monotonic time it arrived."""
        box = {}

        def run():
            try:
                box["reply"] = self.listen(name, since, timeout_ms)
            except BaseException as error:  # noqa: BLE001 - reported by the caller
                box["error"] = error
            box["at"] = time.monotonic()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, box

    def settled(self, thread, box, seconds):
        thread.join(seconds)
        self.assertFalse(thread.is_alive(), f"the listener did not return in {seconds}s")
        if "error" in box:
            raise box["error"]
        return box["reply"]

    def note(self, text):
        print(f"[listen] {self.segment()}: {text}", file=sys.stderr, flush=True)

    def test_a_parked_listener_is_released_by_a_write(self):
        name = self.segment()
        self.expect(self.alloc(name, 8), 200)
        round_ = self.expect(self.capture(name, 0, 8), 200)["captureId"]
        self.expect(self.write(name, 0, [b"zero"], round_), 200)
        since = self.expect(self.runtime.status(name), 200)["writes"]
        self.assertEqual(since, 1)

        thread, box = self.park(name, since, 20_000)
        # Long enough that the listener is parked in the cell, not in flight.
        time.sleep(1.0)
        self.assertTrue(thread.is_alive(), f"the listener answered early: {box}")
        # Neither a capture nor a refused write moves the counter.
        self.expect(self.capture(name, 4, 8), 200)
        self.expect(self.write(name, 0, [b"again"], round_), 409, "ALREADY_WRITTEN")
        time.sleep(0.3)
        self.assertTrue(thread.is_alive(), f"a non-write released the listener: {box}")

        round_ = self.expect(self.capture(name, 0, 8), 200)["captureId"]
        self.expect(self.write(name, 1, [b"one", b"two"], round_), 200)
        written = time.monotonic()
        reply = self.expect(self.settled(thread, box, 5), 200)
        self.assertEqual(reply, {"ok": True, "writes": 3, "changed": True})
        latency = box["at"] - written
        self.note(f"released {latency * 1000:.1f} ms after the write's reply")
        self.assertLess(latency, 2.0)
        # The loop a reader runs: listen from the new value, then read.
        registers = self.expect(self.read(name, 0, count=3), 200)["registers"]
        self.assertEqual([decode(register["value"]) for register in registers],
                         [b"zero", b"one", b"two"])

    def test_many_listeners_are_released_by_one_write(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        parked = [self.park(name, 0, 20_000) for _ in range(8)]
        ahead = self.park(name, 5, 1_500)
        time.sleep(1.0)
        self.expect(self.write(name, 0, [b"x"], 0), 200)
        for thread, box in parked:
            self.assertEqual(self.expect(self.settled(thread, box, 5), 200),
                             {"ok": True, "writes": 1, "changed": True})
        # A listener ahead of the counter waits for a later write, and its
        # timeout hands it the real value.
        self.assertEqual(self.expect(self.settled(*ahead, 5), 200),
                         {"ok": True, "writes": 1, "changed": False})

    def test_a_listener_with_nothing_to_see_times_out(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        self.expect(self.write(name, 0, [b"x"], 0), 200)
        started = time.monotonic()
        reply = self.expect(self.listen(name, 1, 1_000), 200)
        waited = time.monotonic() - started
        self.assertEqual(reply, {"ok": True, "writes": 1, "changed": False})
        self.note(f"a 1000 ms listen returned after {waited * 1000:.0f} ms")
        self.assertGreaterEqual(waited, 0.95)
        self.assertLess(waited, 3.0)

    def test_listen_answers_at_once_when_the_caller_is_behind(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        self.expect(self.write(name, 0, [b"a", b"b"], 0), 200)
        for since in [0, 1]:
            started = time.monotonic()
            reply = self.expect(self.listen(name, since, 20_000), 200)
            self.assertEqual(reply, {"ok": True, "writes": 2, "changed": True})
            self.assertLess(time.monotonic() - started, 2.0)
        # A zero timeout is a poll.
        self.assertEqual(self.expect(self.listen(name, 2, 0), 200),
                         {"ok": True, "writes": 2, "changed": False})

    def test_listen_requests_are_validated(self):
        name = self.segment()
        self.expect(self.listen(name, 0), 409, "UNALLOCATED")
        self.expect(self.alloc(name, 4), 200)
        self.expect(self.runtime.post(name, "listen", {}), 400, "INVALID")
        self.expect(self.listen(name, -1), 400, "INVALID")
        self.expect(self.listen(name, 0.5), 400, "INVALID")
        self.expect(self.listen(name, 0, 25_001), 400, "INVALID")
        self.expect(self.listen(name, 0, -1), 400, "INVALID")
        self.expect(self.runtime.post(name, "listen", []), 400, "INVALID")

    def test_a_park_at_the_cap_hits_no_runtime_limit(self):
        name = self.segment()
        self.expect(self.alloc(name, 4), 200)
        started = time.monotonic()
        reply = self.expect(self.listen(name, 0, 25_000), 200)
        waited = time.monotonic() - started
        self.assertEqual(reply, {"ok": True, "writes": 0, "changed": False})
        self.note(f"a 25000 ms listen returned after {waited * 1000:.0f} ms")
        self.assertGreaterEqual(waited, 24.9)
        self.assertLess(waited, 28.0)
        # The cell is still there and answers.
        self.expect(self.write(name, 0, [b"late"], 0), 200)
        self.assertEqual(self.expect(self.listen(name, 0, 0), 200)["writes"], 1)


class LayerTestCase(SegmentTestCase):
    """Helpers for the WormLog and WormPaxos routes."""

    def log(self, name, operation, body=None):
        return self.runtime.request("POST", f"/v1/wormlog/{name}/{operation}", body or {})

    def append(self, name, value):
        return self.log(name, "append", {"value": encode(value)})

    def entries(self, name, start, count=100):
        body = self.expect(self.log(name, "read", {"from": start, "count": count}), 200)
        return [(entry["slot"], entry["state"],
                 decode(entry["value"]) if "value" in entry else None)
                for entry in body["entries"]]

    def replica(self, group, replica, operation, body=None):
        return self.runtime.request(
            "POST", f"/v1/wormpaxos/{group}/{replica}/{operation}", body or {})

    def propose(self, group, replica, command):
        return self.replica(group, replica, "propose", {"command": command})

    def lookup(self, group, replica, key):
        return self.expect(self.replica(group, replica, "get", {"key": key}), 200)["value"]

    def note(self, text):
        print(f"[layers] {self.segment()}: {text}", file=sys.stderr, flush=True)

    def timed(self, call):
        started = time.monotonic()
        response = call()
        return response, (time.monotonic() - started) * 1000


def median(values):
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


class WormLogRuntimeTest(LayerTestCase):
    """WormLog's HTTP surface: the Worker, the Sequencer cell, and segments."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_appends_cross_a_segment_boundary_and_read_back(self):
        name = self.segment()
        self.assertEqual(self.expect(self.log(name, "init", {"size": 4}), 200)["size"], 4)
        values = [bytes([index, 0, 255]) + f"record {index}".encode() for index in range(10)]
        latencies = []
        for index, value in enumerate(values):
            response, elapsed = self.timed(lambda value=value: self.append(name, value))
            self.assertEqual(self.expect(response, 200),
                             {"ok": True, "slot": index, "attempts": 1})
            latencies.append(elapsed)
        # The first append of each segment allocates and captures it.
        steady = [ms for index, ms in enumerate(latencies) if index % 4 != 0]
        self.note(f"append median {median(steady):.1f} ms within a segment, "
                  f"{median([latencies[0], latencies[4], latencies[8]]):.1f} ms opening one")
        self.assertEqual(self.entries(name, 0, 10),
                         [(slot, "value", value) for slot, value in enumerate(values)])
        self.assertEqual(self.entries(name, 3, 3),
                         [(slot, "value", values[slot]) for slot in (3, 4, 5)])
        tail = self.expect(self.log(name, "tail"), 200)
        self.assertEqual(tail, {"ok": True, "log": name, "size": 4, "next": 10,
                                "trimmedThrough": -1})
        for index in range(3):
            status = self.expect(self.runtime.status(f"{name}.{index}"), 200)
            self.assertEqual((status["allocated"], status["size"], status["allocator"],
                              status["captures"]), (True, 4, f"sequencer:{name}", 1))
        self.assertFalse(self.expect(self.runtime.status(f"{name}.3"), 200)["allocated"])
        # The size is fixed now.
        self.expect(self.log(name, "init", {"size": 8}), 409, "CONFLICT")

    def test_a_stolen_segment_leaves_a_slot_that_fill_closes(self):
        name = self.segment()
        self.expect(self.log(name, "init", {"size": 4}), 200)
        for value in [b"zero", b"one"]:
            self.expect(self.append(name, value), 200)
        # An operator steals the segment from the sequencer: the next append
        # is refused under the old round, recaptures, and lands one later.
        self.expect(self.capture(f"{name}.0", 0, 4, owner="operator"), 200)
        self.assertEqual(self.expect(self.append(name, b"three"), 200),
                         {"ok": True, "slot": 3, "attempts": 2})
        self.assertEqual([state for _, state, _ in self.entries(name, 0)],
                         ["value", "value", "pending", "value"])
        self.assertEqual(self.expect(self.log(name, "fill", {"slot": 2}), 200),
                         {"ok": True, "slot": 2, "hole": True})
        self.assertEqual(self.expect(self.log(name, "fill", {"slot": 3}), 200),
                         {"ok": True, "slot": 3, "hole": False})
        self.expect(self.log(name, "fill", {"slot": 4}), 400, "INVALID")
        self.assertEqual(self.entries(name, 0),
                         [(0, "value", b"zero"), (1, "value", b"one"), (2, "hole", None),
                          (3, "value", b"three")])
        trimmed = self.expect(self.log(name, "trim", {"through": 1}), 200)
        self.assertEqual(trimmed["trimmedThrough"], 1)
        gone = self.expect(self.log(name, "read", {"from": 1}), 410, "TRIMMED")
        self.assertEqual(gone["trimmedThrough"], 1)
        self.assertEqual([slot for slot, _, _ in self.entries(name, 2)], [2, 3])
        self.expect(self.log(name, "trim", {"through": 4}), 400, "INVALID")

    def test_listen_is_released_by_an_append(self):
        name = self.segment()
        self.expect(self.log(name, "init", {"size": 4}), 200)
        self.expect(self.append(name, b"a"), 200)
        box = {}

        def park():
            box["reply"] = self.log(name, "listen", {"from": 1, "since": 1, "timeoutMs": 20_000})
            box["at"] = time.monotonic()

        thread = threading.Thread(target=park, daemon=True)
        thread.start()
        time.sleep(1.0)
        self.assertTrue(thread.is_alive(), f"the listener answered early: {box}")
        self.expect(self.append(name, b"b"), 200)
        appended = time.monotonic()
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.expect(box["reply"], 200),
                         {"ok": True, "index": 0, "writes": 2, "changed": True})
        self.assertLess(box["at"] - appended, 2.0)
        self.expect(self.log(name, "listen", {"from": 4, "since": 0, "timeoutMs": 0}),
                    409, "UNALLOCATED")

    def test_malformed_log_requests_are_refused(self):
        name = self.segment()
        self.expect(self.runtime.request("GET", f"/v1/wormlog/{name}/tail"), 404, "NOT_FOUND")
        self.expect(self.log(name, "next"), 404, "NOT_FOUND")
        self.expect(self.log("Bad-Name", "tail"), 400, "INVALID")
        self.expect(self.log(name, "append", {}), 400, "INVALID")
        self.expect(self.log(name, "append", {"value": "not!"}), 400, "INVALID")
        self.expect(self.log(name, "init", {"size": 0}), 400, "INVALID")
        self.expect(self.log(name, "read", {"from": -1}), 400, "INVALID")
        self.expect(self.runtime.request("POST", f"/v1/wormlog/{name}/read", []), 400, "INVALID")
        self.expect(self.append(name, bytes(MEBIBYTE)), 413, "TOO_LARGE")
        # Nothing above issued a slot.
        self.assertEqual(self.expect(self.log(name, "tail"), 200)["next"], 0)


class WormPaxosRuntimeTest(LayerTestCase):
    """WormPaxos's HTTP surface: Replica cells calling segments themselves."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_two_replicas_converge_across_steals_and_a_boundary(self):
        group = self.segment()
        for replica in ["a", "b"]:
            self.expect(self.replica(group, replica, "init", {"size": 4}), 200)
        addresses = []
        plan = [("a", "x", "1"), ("a", "y", "2"), ("b", "x", "3"), ("a", "z", "4"),
                ("b", "y", "5"), ("b", "w", "6")]
        for replica, key, value in plan:
            reply = self.expect(
                self.propose(group, replica, {"op": "set", "key": key, "value": value}), 200)
            addresses.append((reply["address"], reply["term"]))
        self.assertEqual([address for address, _ in addresses], list(range(6)))
        # a leads link 0 in round 1, b steals it in round 2 and a in round 3;
        # then b finds link 0 full and takes link 1, whose rounds start over.
        self.assertEqual([term for _, term in addresses], [1, 1, 2, 3, 1, 1])
        self.expect(self.propose(group, "a", {"op": "del", "key": "w"}), 200)
        for replica in ["a", "b"]:
            learned = self.expect(self.replica(group, replica, "learn"), 200)
            self.assertEqual((learned["applied"], learned["blocked"]), (7, 7))
        for key, value in [("x", "3"), ("y", "5"), ("z", "4"), ("w", None)]:
            self.assertEqual(self.lookup(group, "a", key), value, key)
            self.assertEqual(self.lookup(group, "b", key), value, key)
        state = self.expect(self.replica(group, "a", "state"), 200)
        self.assertEqual((state["applied"], state["size"], state["leader"]),
                         (7, 4, {"index": 1, "captureId": 2, "tail": 3}))
        self.assertEqual(self.expect(self.replica(group, "b", "state"), 200)["leader"], None)

    def test_a_sticky_leader_proposes_in_one_write(self):
        group = self.segment()
        self.expect(self.propose(group, "a", {"op": "noop"}), 200)
        latencies = []
        for index in range(10):
            response, elapsed = self.timed(lambda index=index: self.propose(
                group, "a", {"op": "set", "key": "k", "value": str(index)}))
            self.assertEqual(self.expect(response, 200)["term"], 1)
            latencies.append(elapsed)
        status = self.expect(self.runtime.status(f"{group}.0"), 200)
        self.assertEqual((status["captures"], status["nextRound"], status["writes"]), (1, 2, 11))
        self.note(f"sticky propose median {median(latencies):.1f} ms "
                  f"(Worker -> Replica -> Segment write, two barriers)")
        # Neither of these commits anything, so the difference is the extra
        # hop: Worker -> Replica -> Segment read, against Worker -> Segment.
        hop, direct = [], []
        for _ in range(10):
            response, elapsed = self.timed(lambda: self.replica(group, "a", "learn"))
            self.assertEqual(self.expect(response, 200)["learned"], 0)
            hop.append(elapsed)
            response, elapsed = self.timed(lambda: self.read(f"{group}.0", 11, count=1000))
            self.expect(response, 200)
            direct.append(elapsed)
        self.note(f"learn at the tail {median(hop):.1f} ms (Worker -> Replica -> Segment "
                  f"read), a direct segment read {median(direct):.1f} ms")
        _, takeover = self.timed(lambda: self.expect(self.propose(
            group, "b", {"op": "set", "key": "k", "value": "b"}), 200))
        self.note(f"a takeover by a replica that had learned nothing: {takeover:.1f} ms")
        self.assertEqual(self.lookup(group, "b", "k"), "b")

    def test_malformed_replica_requests_are_refused(self):
        group = self.segment()
        self.expect(self.propose(group, "a", {"op": "put"}), 400, "INVALID")
        self.expect(self.replica(group, "a", "propose", {}), 400, "INVALID")
        self.expect(self.propose(group, "a", {"op": "set", "key": "k", "value": "x" * MEBIBYTE}),
                    413, "TOO_LARGE")
        self.expect(self.replica(group, "a", "get", {"key": ""}), 400, "INVALID")
        self.expect(self.replica(group, "A", "state"), 400, "INVALID")
        self.expect(self.replica(group, "a", "lookup"), 404, "NOT_FOUND")
        self.expect(self.runtime.request("GET", f"/v1/wormpaxos/{group}/a/state"),
                    404, "NOT_FOUND")
        self.assertIsNone(self.lookup(group, "a", "missing"))
        state = self.expect(self.replica(group, "a", "state"), 200)
        self.assertEqual((state["applied"], state["size"], state["leader"]), (0, None, None))
        # The body cannot redirect a call to another replica's cell.
        state = self.expect(self.replica(group, "a", "state",
                                         {"smr": "other", "replica": "b"}), 200)
        self.assertEqual((state["smr"], state["replica"]), (group, "a"))


class LayerDurabilityTest(LayerTestCase):
    """The sequencer and the replicas are cells: a restart loses nothing."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_the_sequencer_and_a_replica_survive_a_supervisor_restart(self):
        name = self.segment()
        group = name + "-g"
        self.expect(self.log(name, "init", {"size": 4}), 200)
        for index in range(5):
            self.expect(self.append(name, f"r{index}".encode()), 200)
        for index in range(3):
            self.expect(self.propose(group, "a", {"op": "set", "key": "k", "value": str(index)}),
                        200)
        before = self.expect(self.replica(group, "a", "state"), 200)

        self.runtime.restart()

        self.assertEqual(self.expect(self.append(name, b"r5"), 200),
                         {"ok": True, "slot": 5, "attempts": 1})
        self.assertEqual([value for _, _, value in self.entries(name, 0)],
                         [f"r{index}".encode() for index in range(6)])
        self.assertEqual(self.expect(self.replica(group, "a", "state"), 200), before)
        self.assertEqual(self.lookup(group, "a", "k"), "2")
        # Leadership is state too: the next proposal is still round 1.
        reply = self.expect(self.propose(group, "a", {"op": "set", "key": "k", "value": "3"}),
                            200)
        self.assertEqual((reply["address"], reply["term"]), (3, 1))
        self.assertEqual(self.expect(self.runtime.status(f"{group}.0"), 200)["nextRound"], 2)


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
