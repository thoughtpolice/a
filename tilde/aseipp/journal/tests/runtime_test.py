# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Drive the packaged journal against a real celld dev supervisor.

Buck provides the pinned CLI and the packaged project. The pure tests decide
whether the rules are right; this one decides whether the service actually
implements them on the runtime: SQLite round-trips, base64 at the edge, real
wall-clock lease expiry, the status map, and durability of both the records and
the lease across a supervisor restart. Each class owns one temporary project,
local database, and loopback port, and each test uses its own log name, so no
two tests share a cell.

LocalRuntime is deliberately the toolchain's own helper from
buck/toolchains/celld/tests/runtime_test.py; the README lists extracting it
into a shared library as a follow-up.
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
import time
import unittest
import urllib.error
import urllib.request


MEBIBYTE = 1024 * 1024


class LocalRuntime:
    """Own exactly one temporary project and celld dev supervisor process."""

    def __init__(self, project):
        self.temporary = tempfile.TemporaryDirectory(prefix="journal-runtime-test-")
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
        return self.request("GET", f"/v1/logs/{name}")

    def post(self, name, operation, payload):
        return self.request("POST", f"/v1/logs/{name}/{operation}", payload)

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


class JournalTestCase(unittest.TestCase):
    """Shared helpers; each test addresses a journal named after itself."""

    def log(self):
        """A distinct, well-formed log name per test method."""
        return self.id().rsplit(".", 1)[-1].replace("_", "-")

    def expect(self, response, status, code=None):
        """Assert one reply's status and code, showing the whole body on failure."""
        self.assertEqual(response[0], status, response)
        if code is not None:
            self.assertEqual(response[1].get("code"), code, response)
        return response[1]

    def acquire(self, name, candidate, ttl_ms=60_000, link_size=None):
        body = {"candidate": candidate, "ttlMs": ttl_ms}
        if link_size is not None:
            body["linkSize"] = link_size
        return self.expect(self.runtime.post(name, "acquire-lease", body), 200)

    def append(self, name, payloads, expected=None, leader="alpha"):
        body = {"leader": leader, "records": [encode(p) for p in payloads]}
        if expected is not None:
            body["expectedNextSeq"] = expected
        return self.runtime.post(name, "append", body)

    def read_all(self, name, **paging):
        """Page the live stream from the trim mark: (seq, term, payload) rows."""
        status = self.expect(self.runtime.status(name), 200)
        position, rows = status["trimmedThrough"] + 1, []
        while position < status["head"]:
            window = self.expect(self.runtime.post(name, "read", {"from": position, **paging}), 200)
            self.assertTrue(window["records"], f"nothing read from {position}")
            rows += [(r["seq"], r["term"], base64.b64decode(r["payload"]))
                     for r in window["records"]]
            position = rows[-1][0] + 1
        return rows


class JournalProtocolTest(JournalTestCase):
    """The service's externally visible protocol, on the real runtime."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_fresh_log_is_empty_and_unowned(self):
        body = self.expect(self.runtime.status(self.log()), 200)
        self.assertEqual(body["head"], 1)
        self.assertEqual(body["term"], 0)
        self.assertIsNone(body["leader"])
        self.assertEqual(body["deadlineMs"], 0)
        self.assertEqual(body["trimmedThrough"], 0)
        self.assertIsNone(body["snapshot"])
        self.assertGreater(body["databaseSize"], 0)
        self.assertGreater(body["nowMs"], 1_700_000_000_000)

    def test_append_without_a_lease_is_refused(self):
        name = self.log()
        self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(b"x")]}),
            409, "NOT_LEADER",
        )
        self.assertEqual(self.expect(self.runtime.status(name), 200)["head"], 1)

    def test_records_survive_sqlite_and_base64_unchanged(self):
        name = self.log()
        self.acquire(name, "alpha")
        payloads = [b"", b"\x00\xff", bytes(range(256)), "journal ✓".encode()]
        appended = self.expect(
            self.runtime.post(name, "append",
                              {"leader": "alpha", "records": [encode(p) for p in payloads]}),
            200,
        )
        self.assertEqual((appended["firstSeq"], appended["lastSeq"], appended["term"]), (1, 4, 1))

        window = self.expect(self.runtime.post(name, "read", {"from": 1}), 200)
        self.assertEqual(window["head"], 5)
        self.assertEqual([record["seq"] for record in window["records"]], [1, 2, 3, 4])
        self.assertEqual([record["term"] for record in window["records"]], [1, 1, 1, 1])
        self.assertEqual([base64.b64decode(record["payload"]) for record in window["records"]],
                         payloads)

    def test_a_megabyte_record_round_trips(self):
        name = self.log()
        self.acquire(name, "alpha")
        payload = bytes((index * 7) % 256 for index in range(MEBIBYTE))
        self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(payload)]}),
            200,
        )
        window = self.expect(self.runtime.post(name, "read", {"from": 1, "maxBytes": 1}), 200)
        self.assertEqual(len(window["records"]), 1, "a budget below one record still returns it")
        self.assertEqual(base64.b64decode(window["records"][0]["payload"]), payload)

    def test_a_live_lease_is_held_without_disclosing_its_token(self):
        name = self.log()
        granted = self.acquire(name, "alpha")
        refused = self.expect(
            self.runtime.post(name, "acquire-lease", {"candidate": "beta", "ttlMs": 60_000}),
            409, "LEASE_HELD",
        )
        self.assertEqual(refused["term"], granted["term"])
        self.assertGreater(refused["deadlineMs"], refused["nowMs"])
        self.assertNotIn("leader", refused)
        # The operator endpoint is the only reply that names the holder.
        self.assertEqual(self.expect(self.runtime.status(name), 200)["leader"], "alpha")

    def test_an_expired_lease_is_taken_over_and_fences_the_old_leader(self):
        name = self.log()
        self.acquire(name, "alpha", ttl_ms=1_000)
        self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(b"one")]}),
            200,
        )
        time.sleep(1.5)
        taken = self.acquire(name, "beta")
        self.assertEqual(taken["term"], 2)
        self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(b"late")]}),
            409, "NOT_LEADER",
        )
        self.expect(
            self.runtime.post(name, "renew-lease", {"leader": "alpha", "ttlMs": 60_000}),
            409, "NOT_LEADER",
        )
        appended = self.expect(
            self.runtime.post(name, "append", {"leader": "beta", "records": [encode(b"two")]}),
            200,
        )
        self.assertEqual((appended["firstSeq"], appended["term"]), (2, 2))

    def test_a_lapsed_sole_leader_keeps_writing(self):
        name = self.log()
        self.acquire(name, "alpha", ttl_ms=1_000)
        time.sleep(1.5)
        before = self.expect(self.runtime.status(name), 200)
        self.assertLess(before["deadlineMs"], before["nowMs"], "the lease really did lapse")
        self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(b"late")]}),
            200,
        )
        renewed = self.expect(
            self.runtime.post(name, "renew-lease", {"leader": "alpha", "ttlMs": 60_000}),
            200,
        )
        self.assertEqual(renewed["term"], 1, "a renewal after lapsing keeps the term")

    def test_release_hands_the_journal_over_immediately(self):
        name = self.log()
        self.acquire(name, "alpha")
        self.expect(self.runtime.post(name, "release-lease", {"leader": "beta"}),
                    409, "NOT_LEADER")
        self.expect(self.runtime.post(name, "release-lease", {"leader": "alpha"}), 200)
        self.assertIsNone(self.expect(self.runtime.status(name), 200)["leader"])
        self.assertEqual(self.acquire(name, "beta")["term"], 2)
        self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(b"x")]}),
            409, "NOT_LEADER",
        )

    def test_a_replayed_conditional_append_proves_the_original_landed(self):
        name = self.log()
        self.acquire(name, "alpha")
        batch = {"leader": "alpha", "records": [encode(b"a"), encode(b"b")], "expectedNextSeq": 1}
        self.expect(self.runtime.post(name, "append", batch), 200)
        replayed = self.expect(self.runtime.post(name, "append", batch), 409, "SEQ_MISMATCH")
        self.assertEqual(replayed["head"], 3, "head proves the batch landed")
        self.assertEqual(replayed["term"], 1, "an unchanged term makes that proof")
        self.assertEqual(self.expect(self.runtime.status(name), 200)["head"], 3)

    def test_reads_page_through_the_stream(self):
        name = self.log()
        self.acquire(name, "alpha")
        self.expect(
            self.runtime.post(name, "append",
                              {"leader": "alpha", "records": [encode(bytes([n])) for n in range(5)]}),
            200,
        )
        first = self.expect(self.runtime.post(name, "read", {"from": 1, "limit": 2}), 200)
        self.assertEqual([record["seq"] for record in first["records"]], [1, 2])
        resume = first["records"][-1]["seq"] + 1
        second = self.expect(self.runtime.post(name, "read", {"from": resume, "limit": 2}), 200)
        self.assertEqual([record["seq"] for record in second["records"]], [3, 4])

        at_head = self.expect(self.runtime.post(name, "read", {"from": 6}), 200)
        self.assertEqual(at_head["records"], [])
        self.assertEqual(at_head["head"], 6)
        self.expect(self.runtime.post(name, "read", {"from": 7}), 400, "INVALID")

    def test_trimming_follows_the_snapshot_mark(self):
        name = self.log()
        self.acquire(name, "alpha")
        self.expect(
            self.runtime.post(name, "append",
                              {"leader": "alpha", "records": [encode(bytes([n])) for n in range(5)]}),
            200,
        )
        self.expect(self.runtime.post(name, "trim", {"throughSeq": 3}), 409, "SNAPSHOT_STALE")

        marked = self.expect(
            self.runtime.post(name, "record-snapshot", {"throughSeq": 3, "ref": "s3://snap/3"}),
            200,
        )
        self.assertEqual(marked["snapshot"], {"throughSeq": 3, "ref": "s3://snap/3"})
        self.assertEqual(
            self.expect(self.runtime.post(name, "record-snapshot",
                                          {"throughSeq": 3, "ref": "s3://snap/3"}), 200),
            marked, "re-recording the same mark is idempotent",
        )
        self.expect(self.runtime.post(name, "record-snapshot",
                                      {"throughSeq": 2, "ref": "s3://snap/2"}),
                    409, "SNAPSHOT_STALE")
        self.expect(self.runtime.post(name, "record-snapshot",
                                      {"throughSeq": 6, "ref": "s3://snap/6"}),
                    400, "INVALID")

        self.expect(self.runtime.post(name, "trim", {"throughSeq": 4}), 409, "SNAPSHOT_STALE")
        self.assertEqual(
            self.expect(self.runtime.post(name, "trim", {"throughSeq": 3}), 200)["trimmedThrough"],
            3,
        )
        gone = self.expect(self.runtime.post(name, "read", {"from": 1}), 410, "TRIMMED")
        self.assertEqual(gone["trimmedThrough"], 3)
        self.assertEqual(gone["snapshot"], {"throughSeq": 3, "ref": "s3://snap/3"})

        live = self.expect(self.runtime.post(name, "read", {"from": 4}), 200)
        self.assertEqual([record["seq"] for record in live["records"]], [4, 5])
        self.assertEqual(
            self.expect(self.runtime.post(name, "trim", {"throughSeq": 3}), 200)["trimmedThrough"],
            3, "a repeated trim is idempotent",
        )

    def test_malformed_requests_are_refused_at_the_edge(self):
        name = self.log()
        self.acquire(name, "alpha")
        self.expect(self.runtime.status("Not-A-Name"), 400, "INVALID")
        self.expect(self.runtime.status("%2Eorders"), 400, "INVALID")
        self.expect(self.runtime.post(name, "compact", {}), 404, "NOT_FOUND")
        self.expect(self.runtime.request("GET", "/"), 404, "NOT_FOUND")
        self.expect(self.runtime.post(name, "append", {"leader": "alpha", "records": []}),
                    400, "INVALID")
        self.expect(self.runtime.post(name, "append", {"leader": "alpha", "records": ["not!"]}),
                    400, "INVALID")
        self.expect(self.runtime.post(name, "acquire-lease",
                                      {"candidate": "alpha", "ttlMs": 10}), 400, "INVALID")
        self.expect(self.runtime.post(name, "read", {"from": 0}), 400, "INVALID")

    def test_oversized_payloads_are_refused_before_they_are_stored(self):
        name = self.log()
        self.acquire(name, "alpha")
        too_big = self.expect(
            self.runtime.post(name, "append",
                              {"leader": "alpha", "records": [encode(bytes(MEBIBYTE + 1))]}),
            413, "TOO_LARGE",
        )
        self.assertIn("record", too_big["message"])

        body = self.expect(
            self.runtime.declare_oversized_body(f"/v1/logs/{name}/append", 9 * MEBIBYTE),
            413, "TOO_LARGE",
        )
        self.assertIn("body", body["message"], "the body cap is checked before the body")
        self.assertEqual(self.expect(self.runtime.status(name), 200)["head"], 1)


class JournalLinksTest(JournalTestCase):
    """Records in a chain of segment links: sealing, rollover, and trims.

    Every test chooses links of 8 records, the smallest the journal accepts,
    so a handful of appends crosses several links.
    """

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_a_batch_that_does_not_fit_opens_the_next_link(self):
        name = self.log()
        self.expect(self.runtime.post(name, "acquire-lease",
                                      {"candidate": "alpha", "ttlMs": 60_000, "linkSize": 7}),
                    400, "INVALID")
        self.acquire(name, "alpha", link_size=8)
        first = self.expect(self.append(name, [bytes([n]) for n in range(5)], 1), 200)
        self.assertEqual((first["firstSeq"], first["lastSeq"]), (1, 5))
        # Five more do not fit in the three registers left: the link is sealed
        # at five and the whole batch goes to the next one, in one write.
        second = self.expect(self.append(name, [bytes([n]) for n in range(5, 10)], 6), 200)
        self.assertEqual((second["firstSeq"], second["lastSeq"]), (6, 10))
        self.assertEqual(self.read_all(name),
                         [(n + 1, 1, bytes([n])) for n in range(10)])
        # A batch larger than a whole link can never fit.
        self.expect(self.append(name, [b"x"] * 9, 11), 413, "TOO_LARGE")
        self.assertEqual(self.expect(self.runtime.status(name), 200)["head"], 11)

    def test_reads_cross_links_under_their_limits(self):
        name = self.log()
        self.acquire(name, "alpha", link_size=8)
        for batch in range(4):
            self.expect(self.append(name, [bytes([10 * batch + n]) * 10 for n in range(3)]), 200)
        # Links of 8, batches of 3: [1..6] sealed at 6, then [7..12].
        window = self.expect(self.runtime.post(name, "read", {"from": 4, "limit": 6}), 200)
        self.assertEqual([record["seq"] for record in window["records"]], [4, 5, 6, 7, 8, 9])
        budget = self.expect(self.runtime.post(name, "read", {"from": 5, "maxBytes": 25}), 200)
        self.assertEqual([record["seq"] for record in budget["records"]], [5, 6])
        self.assertEqual([seq for seq, _, _ in self.read_all(name, limit=5)], list(range(1, 13)))

    def test_trims_cross_links(self):
        name = self.log()
        self.acquire(name, "alpha", link_size=8)
        for batch in range(5):
            self.expect(self.append(name, [bytes([10 * batch + n]) for n in range(3)]), 200)
        # [1..6], [7..12], [13..15].
        self.expect(self.runtime.post(name, "record-snapshot", {"throughSeq": 14, "ref": "s3://14"}),
                    200)
        self.assertEqual(
            self.expect(self.runtime.post(name, "trim", {"throughSeq": 8}), 200)["trimmedThrough"], 8)
        self.expect(self.runtime.post(name, "read", {"from": 8}), 410, "TRIMMED")
        self.assertEqual([seq for seq, _, _ in self.read_all(name)], list(range(9, 16)))
        self.assertEqual(
            self.expect(self.runtime.post(name, "trim", {"throughSeq": 14}), 200)["trimmedThrough"], 14)
        self.assertEqual(self.read_all(name), [(15, 1, bytes([42]))])
        appended = self.expect(self.append(name, [b"after"], 16), 200)
        self.assertEqual(appended["firstSeq"], 16)

    def test_a_new_term_starts_a_new_link(self):
        name = self.log()
        self.acquire(name, "alpha", ttl_ms=1_000, link_size=8)
        self.expect(self.append(name, [b"a1", b"a2"], 1), 200)
        time.sleep(1.5)
        self.assertEqual(self.acquire(name, "beta")["term"], 2)
        self.expect(self.append(name, [b"b1"], 3, leader="beta"), 200)
        self.assertEqual(self.read_all(name),
                         [(1, 1, b"a1"), (2, 1, b"a2"), (3, 2, b"b1")])


class JournalDurabilityTest(JournalTestCase):
    """Acknowledged state must survive the whole supervisor being replaced."""

    @classmethod
    def setUpClass(cls):
        cls.runtime = LocalRuntime(PROJECT)
        cls.addClassCleanup(cls.runtime.close)

    def test_records_and_lease_survive_a_supervisor_restart(self):
        name = self.log()
        self.acquire(name, "alpha")
        payloads = [b"\x00\xff", b"durable"]
        self.expect(
            self.runtime.post(name, "append",
                              {"leader": "alpha", "records": [encode(p) for p in payloads]}),
            200,
        )
        self.expect(self.runtime.post(name, "record-snapshot",
                                      {"throughSeq": 1, "ref": "s3://snap/1"}), 200)
        self.expect(self.runtime.post(name, "trim", {"throughSeq": 1}), 200)
        before = self.expect(self.runtime.status(name), 200)

        self.runtime.restart()

        after = self.expect(self.runtime.status(name), 200)
        for key in ["head", "term", "leader", "deadlineMs", "trimmedThrough", "snapshot"]:
            self.assertEqual(after[key], before[key], key)

        window = self.expect(self.runtime.post(name, "read", {"from": 2}), 200)
        self.assertEqual([base64.b64decode(record["payload"]) for record in window["records"]],
                         payloads[1:])

        # The lease is state too: its holder keeps writing and its rival does not.
        appended = self.expect(
            self.runtime.post(name, "append", {"leader": "alpha", "records": [encode(b"more")]}),
            200,
        )
        self.assertEqual(appended["term"], 1)
        self.expect(self.runtime.post(name, "acquire-lease",
                                      {"candidate": "beta", "ttlMs": 60_000}), 409, "LEASE_HELD")


    def test_head_is_recovered_from_the_links_after_a_restart(self):
        name = self.log()
        self.acquire(name, "alpha", link_size=8)
        for batch in range(4):
            self.expect(self.append(name, [f"r{batch}.{n}".encode() for n in range(3)],
                                    1 + 3 * batch), 200)
        before = self.read_all(name)

        self.runtime.restart()

        # The head is not stored anywhere: the first call recovers it from the
        # last link, which is what this measures.
        started = time.monotonic()
        status = self.expect(self.runtime.status(name), 200)
        recovery = time.monotonic() - started
        self.assertEqual(status["head"], 13, f"recovered in {recovery * 1000:.0f} ms")
        self.assertEqual(self.read_all(name), before)
        appended = self.expect(self.append(name, [b"next"], 13), 200)
        self.assertEqual((appended["firstSeq"], appended["term"]), (13, 1))

    def test_a_reply_lost_across_a_restart_is_proved_by_the_replay(self):
        name = self.log()
        self.acquire(name, "alpha", link_size=8)
        self.expect(self.append(name, [b"one", b"two", b"three"], 1), 200)
        batch = [b"four", b"five", b"six", b"seven"]
        # The reply is lost: the client never learns this landed, in a new
        # link, and the cell that knew its head is gone before the replay.
        self.append(name, batch, 4)
        self.runtime.restart()
        replayed = self.expect(self.append(name, batch, 4), 409, "SEQ_MISMATCH")
        self.assertEqual((replayed["head"], replayed["term"]), (4 + len(batch), 1),
                         "head === expectedNextSeq + records.length under the same term")
        self.assertEqual([payload for _, _, payload in self.read_all(name)],
                         [b"one", b"two", b"three"] + batch)


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
