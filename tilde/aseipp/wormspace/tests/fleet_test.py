# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Write-once segments on a real celld fleet: healthy, under chaos, and across a crash.

The machinery (chaos3, nodes, supervisor, fleet, diagnostics on failure) is the
journal's `fleet_harness`, pointed at this service's own readiness route. What
lives here is the segment workload:

  - `SegmentClient` is the HTTP API with base64 and proxy bypass handled.
  - `Leader` is the paper's sticky leader: it batch-captures the whole segment
    (one round, one capture row), finds the first unwritten register, and
    writes registers in order under that round. A write whose reply was lost
    (`503`, or no reply at all) is settled by reading the register back: our
    bytes under our round mean it landed, other bytes mean someone else won the
    register, and an unwritten register is written again with the same round.
    No operation table is needed because a register is written at most once.
  - `audit` reads the whole segment back and checks it against every leader's
    ledger, byte for byte and round for round.

The three scenarios each own a fleet:

  1. healthy: allocate, batch-capture, 60 writes, read back, and read back
     again after the node restarts with its local state wiped, so the bucket
     alone carries the segment;
  2. chaos: two leaders alternately steal the capture from each other while
     chaos3 runs a pinned `storage-v1` campaign, with supervised restarts, then
     the audit, and coverage from chaos3's own trace so a campaign that selected
     nothing on the write path cannot pass. A `Tail` reader parks a `listen`
     at every turn and must be released by that turn's writes;
  3. failover: two nodes, SIGKILL the owner mid-workload, the leader retargets
     without re-capturing, and its round must still hold on the other node.

A `500 INTERNAL` fails every scenario: `RETRYABLE_STATUSES` excludes it on
purpose, because it means a throw the edge did not classify.
"""

import json
import sys
import threading
import time
import urllib.error
import urllib.request

from celld_fleet import (
    RETRYABLE_STATUSES,
    FleetTestCase,
    Unreachable,
    decode,
    encode,
    main,
    resilient,
)

READY_PATH = "/v1/segments/readiness-probe"
BUCKET = "wormspace"
CHAOS3_SEED = 42


class SegmentClient:
    """The segment HTTP API, with base64 and proxy bypass handled here."""

    def __init__(self, origin, name, timeout=30):
        self.origin = origin
        self.name = name
        self.timeout = timeout
        # Tests set HTTP_PROXY for celld; the client's own loopback traffic
        # must never take it.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def retarget(self, origin):
        self.origin = origin
        return self

    def call(self, operation, body=None, timeout=None):
        """One request. Returns (status, decoded body); raises `Unreachable`."""
        if operation is None:
            url = f"{self.origin}/v1/segments/{self.name}"
            request = urllib.request.Request(url, method="GET")
        else:
            url = f"{self.origin}/v1/segments/{self.name}/{operation}"
            request = urllib.request.Request(
                url, data=json.dumps(body or {}).encode(), method="POST",
                headers={"Content-Type": "application/json"},
            )
        try:
            with self.opener.open(request, timeout=timeout or self.timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                raw = error.read()
            try:
                return error.code, json.loads(raw)
            except ValueError:
                return error.code, {"raw": raw.decode(errors="replace")}
        except Exception as error:  # noqa: BLE001 - URLError, timeout, reset, EOF
            raise Unreachable(f"{operation or 'status'} -> {error!r}") from error

    def status(self):
        return self.call(None)

    def alloc(self, size, metadata, allocator):
        return self.call("alloc", {"size": size, "metadata": encode(metadata),
                                   "allocator": allocator})

    def capture(self, start, end, owner):
        return self.call("capture", {"start": start, "end": end, "owner": owner})

    def write(self, start, values, capture_id):
        return self.call("write", {"start": start, "values": [encode(v) for v in values],
                                   "captureId": capture_id})

    def read(self, start, count=None, max_bytes=None):
        body = {"start": start}
        if count is not None:
            body["count"] = count
        if max_bytes is not None:
            body["maxBytes"] = max_bytes
        return self.call("read", body)

    def trim(self, through):
        return self.call("trim", {"through": through})

    def listen(self, since, timeout_ms):
        # The socket outlives the park by a margin, so a slow answer is not
        # mistaken for a lost one.
        return self.call("listen", {"since": since, "timeoutMs": timeout_ms},
                         timeout=timeout_ms / 1000 + 30)


class Tail:
    """A reader tailing the segment with `listen`, in its own thread.

    It parks from `since` and repeats on a timeout, a 503, or a transport
    error, always from the same `since`, which is the README's contract: a
    parked listen is a hint that an eviction or a move can drop.
    """

    PARK_MS = 5_000

    def __init__(self, origin, name, since, budget=120.0):
        self.client = SegmentClient(origin, name)
        self.since = since
        self.budget = budget
        self.reply = None
        self.error = None
        self.calls = 0
        self.statuses = {}
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        deadline = time.monotonic() + self.budget
        try:
            while time.monotonic() < deadline:
                self.calls += 1
                try:
                    status, body = self.client.listen(self.since, self.PARK_MS)
                except Unreachable:
                    status, body = "unreachable", None
                self.statuses[status] = self.statuses.get(status, 0) + 1
                if status == 200 and body["changed"]:
                    self.reply = body
                    return
                if status not in (200, "unreachable") and status not in RETRYABLE_STATUSES:
                    self.error = f"listen -> {status} {body}"
                    return
                if status != 200:
                    time.sleep(0.25)
            self.error = f"never released in {self.budget}s"
        except Exception as error:  # noqa: BLE001 - reported by `released`
            self.error = repr(error)

    def released(self, seconds=150):
        """The reply that released it, or an AssertionError saying why not."""
        self.thread.join(seconds)
        if self.thread.is_alive():
            raise AssertionError(f"tail from {self.since} still parked; {self.summary()}")
        if self.reply is None:
            raise AssertionError(f"tail from {self.since}: {self.error}; {self.summary()}")
        return self.reply

    def summary(self):
        return f"calls={self.calls} statuses={self.statuses}"


class Leader:
    """A sticky leader over one segment: batch capture, then ordered writes."""

    def __init__(self, client, tag, size, *, supervisor=None, budget=180.0, pause=0.25):
        self.client = client
        self.tag = tag
        self.size = size
        self.supervisor = supervisor
        self.budget = budget
        self.pause = pause
        self.capture_id = None
        # Every round this leader was granted, and every payload it ever sent.
        self.rounds = []
        self.sent = set()
        self.ledger = []
        self.next = None
        self.issued = 0
        self.statuses = {}
        self.proved = 0
        self.stale = 0
        self.lost = 0
        self.attempts = 0

    def _note(self, status):
        self.statuses[status] = self.statuses.get(status, 0) + 1

    def _settle(self, call, *args):
        """Repeat a call that is safe to repeat until it answers for real."""
        deadline = time.monotonic() + self.budget
        while True:
            if self.supervisor is not None:
                self.supervisor.restart_if_dead(ready_timeout=45, tolerant=True)
            self.attempts += 1
            try:
                status, body = call(*args)
            except Unreachable:
                status, body = None, None
            self._note(status if status is not None else "unreachable")
            if status is not None and status not in RETRYABLE_STATUSES:
                return status, body
            if time.monotonic() > deadline:
                raise AssertionError(
                    f"{self.tag}: {getattr(call, '__name__', call)}{args} never settled "
                    f"in {self.budget}s; statuses {self.statuses}; last {status} {body}")
            time.sleep(self.pause)

    def retarget(self, origin):
        """Point at another node after a failover; the round is unchanged."""
        self.client.retarget(origin)
        return self

    def alloc(self, metadata):
        """Allocate, or learn who did. A replay of our own win reads as a loss
        that names us, which is the same answer."""
        status, body = self._settle(self.client.alloc, self.size, metadata, self.tag)
        if status == 200:
            return self.tag
        if status == 409 and body.get("code") == "ALREADY_ALLOCATED":
            return body["allocator"]
        raise AssertionError(f"{self.tag}: alloc -> {status} {body}")

    def take(self):
        """Batch-capture the whole segment and find the first unwritten register.

        Repeating a capture is safe: a lost reply's round is simply dominated by
        the next one, which is also ours.
        """
        status, body = self._settle(self.client.capture, 0, self.size, self.tag)
        if status != 200:
            raise AssertionError(f"{self.tag}: capture -> {status} {body}")
        self.capture_id = body["captureId"]
        self.rounds.append(self.capture_id)
        position = body["start"]
        while position < self.size:
            status, window = self._settle(self.client.read, position, 1000)
            if status != 200:
                raise AssertionError(f"{self.tag}: read {position} -> {status} {window}")
            for register in window["registers"]:
                if register["state"] != "written":
                    self.next = register["offset"]
                    return self
            position = window["registers"][-1]["offset"] + 1
        self.next = self.size
        return self

    def payload(self):
        return f"{self.tag}:{self.issued:05d}".encode()

    def write(self, count):
        """Write `count` registers in order; stops on the first steal or loss."""
        written = 0
        for _ in range(count):
            outcome = self.write_one(self.payload())
            if outcome != "ok":
                return written, outcome
            self.issued += 1
            written += 1
        return written, "ok"

    def _landed(self, offset, payload):
        self.ledger.append((offset, payload, self.capture_id))
        self.next = offset + 1
        return "ok"

    def write_one(self, payload):
        """Land `payload` at `self.next`, or report "stale" or "lost"."""
        offset = self.next
        self.sent.add(payload)
        deadline = time.monotonic() + self.budget
        while True:
            if self.supervisor is not None:
                self.supervisor.restart_if_dead(ready_timeout=45, tolerant=True)
            self.attempts += 1
            try:
                status, body = self.client.write(offset, [payload], self.capture_id)
            except Unreachable:
                status, body = None, None
            self._note(status if status is not None else "unreachable")

            if status == 200:
                return self._landed(offset, payload)
            if status == 409 and body.get("code") == "ALREADY_WRITTEN":
                if body.get("sameValue") is True:
                    self.proved += 1
                    return self._landed(offset, payload)
                self.lost += 1
                return "lost"
            if status == 409 and body.get("code") == "CAPTURE_STALE":
                self.stale += 1
                return "stale"
            if status is None or status in RETRYABLE_STATUSES:
                # Ambiguous: read the register back before deciding anything.
                code, window = self._settle(self.client.read, offset, 1)
                if code != 200:
                    raise AssertionError(f"{self.tag}: read-back {offset} -> {code} {window}")
                register = window["registers"][0]
                if register["state"] == "written":
                    if decode(register["value"]) != payload:
                        self.lost += 1
                        return "lost"
                    if register["round"] != self.capture_id:
                        raise AssertionError(
                            f"{self.tag}: our bytes at {offset} under round "
                            f"{register['round']}, not {self.capture_id}")
                    self.proved += 1
                    return self._landed(offset, payload)
                if time.monotonic() > deadline:
                    raise AssertionError(
                        f"{self.tag}: gave up on register {offset} after {self.budget}s; "
                        f"statuses {self.statuses}; last {status} {body}")
                time.sleep(self.pause)
                continue
            raise AssertionError(f"{self.tag}: write {offset} -> {status} {body}")

    def summary(self):
        return (f"{self.tag}: {len(self.ledger)} registers, next={self.next}, "
                f"round={self.capture_id}, rounds={self.rounds}, attempts={self.attempts}, "
                f"proved={self.proved}, stale={self.stale}, lost={self.lost}, "
                f"statuses={self.statuses}")


def read_segment(client, size):
    """Every live register in the segment, paged. Returns (registers, status)."""
    status, meta = resilient(client.status)
    if status != 200:
        raise AssertionError(f"status -> {status} {meta}")
    position = meta["trimmedThrough"] + 1
    registers = []
    while position < size:
        code, window = resilient(client.read, position, 1000)
        if code != 200:
            raise AssertionError(f"read {position} -> {code} {window}")
        registers.extend(window["registers"])
        position = window["registers"][-1]["offset"] + 1
    return registers, meta


def audit(client, size, leaders):
    """Check the stored segment against every leader's ledger.

    Nothing here trusts the service's bookkeeping beyond reading it back: each
    acknowledged register must hold its bytes under the round that wrote it,
    that round must have been granted to the leader whose ledger holds it, no
    round was granted to two leaders, and no register holds bytes nobody sent.
    Returns the number of written registers.
    """
    registers, meta = read_segment(client, size)
    by_offset = {register["offset"]: register for register in registers}
    if sorted(by_offset) != list(range(meta["trimmedThrough"] + 1, size)):
        raise AssertionError(f"the segment read back with gaps: {sorted(by_offset)[:10]}..")

    owner_of_round = {}
    for leader in leaders:
        for round_ in leader.rounds:
            if round_ in owner_of_round:
                raise AssertionError(
                    f"round {round_} granted to {owner_of_round[round_]} and {leader.tag}")
            owner_of_round[round_] = leader.tag

    acknowledged = {}
    for leader in leaders:
        for offset, payload, round_ in leader.ledger:
            if owner_of_round.get(round_) != leader.tag:
                raise AssertionError(
                    f"{leader.tag} acknowledged register {offset} under round {round_}, "
                    f"which it was never granted")
            if offset in acknowledged:
                raise AssertionError(
                    f"register {offset} acknowledged twice: {acknowledged[offset]} and "
                    f"{(leader.tag, payload, round_)}")
            acknowledged[offset] = (leader.tag, payload, round_)
            register = by_offset.get(offset)
            if register is None or register["state"] != "written":
                raise AssertionError(f"acknowledged register {offset} reads as {register}")
            if decode(register["value"]) != payload or register["round"] != round_:
                raise AssertionError(
                    f"register {offset} holds {decode(register['value'])!r} under round "
                    f"{register['round']}, not {payload!r} under {round_}")

    sent = {payload: leader for leader in leaders for payload in leader.sent}
    written = [register for register in registers if register["state"] == "written"]
    for register in written:
        value = decode(register["value"])
        leader = sent.get(value)
        if leader is None:
            raise AssertionError(f"register {register['offset']} holds {value!r}, which nobody sent")
        if owner_of_round.get(register["round"]) != leader.tag:
            raise AssertionError(
                f"register {register['offset']} holds {leader.tag}'s {value!r} under round "
                f"{register['round']}, which {leader.tag} never held")
    if meta["writtenCount"] != len(written):
        raise AssertionError(f"writtenCount {meta['writtenCount']} but {len(written)} written")
    rounds = [round_ for leader in leaders for round_ in leader.rounds]
    if rounds and meta["nextRound"] <= max(rounds):
        raise AssertionError(f"nextRound {meta['nextRound']} is not past round {max(rounds)}")
    return len(written)


class FleetSegmentTest(FleetTestCase):
    """Three scenarios, each with its own fleet."""

    def open_fleet(self, **settings):
        return self.use_fleet(bucket=BUCKET, ready_path=READY_PATH, **settings)

    def client(self, fleet, index=0):
        return SegmentClient(fleet.node(index).origin, self.log_name())

    def test_a_healthy_fleet_keeps_a_segment_in_the_bucket(self):
        fleet = self.open_fleet(ttl_ms=10_000, deadline_ms=15_000)
        size = 64
        leader = Leader(self.client(fleet), "alpha", size)
        self.assertEqual(leader.alloc(b"\x00healthy\xff"), "alpha")
        leader.take()
        self.assertEqual((leader.capture_id, leader.next), (1, 0))
        self.assertEqual(leader.write(60), (60, "ok"), leader.summary())

        client = self.client(fleet)
        self.assertEqual(audit(client, size, [leader]), 60, leader.summary())
        before = self.expect(client.status(), 200)
        self.assertEqual((before["writtenCount"], before["writes"], before["captures"],
                          before["nextRound"]), (60, 60, 1, 2))
        tail = self.expect(client.read(60), 200)["registers"]
        self.assertEqual([(r["state"], r["round"]) for r in tail], [("captured", 1)] * 4)

        # Nothing local may carry the answer: after this the bucket is the only
        # place the segment exists.
        fleet.node().restart(fresh=True)
        after = self.expect(client.status(), 200)
        for key in ["allocated", "size", "metadata", "allocator", "allocatedMs",
                    "nextRound", "writtenCount", "writes", "captures", "trimmedThrough"]:
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(audit(client, size, [leader]), 60, leader.summary())
        # The round is state too: the leader keeps writing under it.
        self.assertEqual(leader.write(4), (4, "ok"), leader.summary())
        self.assertEqual(audit(client, size, [leader]), 64, leader.summary())

    def test_competing_leaders_under_a_storage_chaos_campaign(self):
        fleet = self.open_fleet(seed=CHAOS3_SEED, chaos="storage-v1", warmup=30, requests=400,
                           trace=True, ttl_ms=10_000, deadline_ms=8_000)
        size, turns, per_turn = 160, 24, 5
        supervisor = fleet.supervisor()
        alpha = Leader(self.client(fleet), "alpha", size, supervisor=supervisor)
        beta = Leader(self.client(fleet), "beta", size, supervisor=supervisor)
        # First allocator wins; the other learns it, which is the paper's
        # leader election idiom.
        self.assertEqual(alpha.alloc(b"leader=alpha"), "alpha")
        self.assertEqual(beta.alloc(b"leader=beta"), "alpha")

        reader = self.client(fleet)
        tails = []
        for turn in range(turns):
            current, other = (alpha, beta) if turn % 2 == 0 else (beta, alpha)
            current.take()
            if other.capture_id is not None:
                # The loser of the steal must be fenced at its very next write.
                other.next = current.next
                self.assertEqual(other.write_one(other.payload()), "stale",
                                 f"{other.summary()}; {current.summary()}")
                other.issued += 1
            # A tail parked before this turn's writes must be released by
            # them: the stale write above moved nothing, so the counter is
            # exactly what the leaders have landed so far.
            since = turn * per_turn
            tail = Tail(reader.origin, reader.name, since)
            self.assertEqual(current.write(per_turn), (per_turn, "ok"),
                             f"{current.summary()}; {other.summary()}")
            reply = tail.released()
            self.assertTrue(since < reply["writes"] <= since + per_turn,
                            f"turn {turn}: {reply}; {tail.summary()}")
            tails.append(tail)

        report = fleet.chaos3.wait_recovered(180, drive=True)
        detail = (f"chaos3 seed {fleet.chaos3.seed()} coverage {report}; {alpha.summary()}; "
                  f"{beta.summary()}; {supervisor.diagnostics()}")
        client = self.client(fleet)
        self.assertEqual(audit(client, size, [alpha, beta]), turns * per_turn, detail)
        self.assertEqual(alpha.stale + beta.stale, turns - 1, detail)
        status = self.expect(client.status(), 200)
        self.assertEqual(status["captures"], 1,
                         f"every whole-segment capture prunes the last; {detail}")
        # Replays and steals count nothing: one per landed register.
        self.assertEqual(status["writes"], turns * per_turn, detail)
        self.assertEqual(len(tails), turns)
        seen = {}
        for tail in tails:
            for status, count in tail.statuses.items():
                seen[status] = seen.get(status, 0) + count
        print(f"[listen] {turns} tails released under chaos; listen statuses {seen}",
              file=sys.stderr, flush=True)

        fleet.node().restart(fresh=True)
        self.assertEqual(audit(client, size, [alpha, beta]), turns * per_turn, detail)

        self.assertGreater(report["errors_before"], 0, detail)
        # The write path itself was attacked, which is the claim the audit is
        # evidence for; celld absorbs most of it, so the client seeing an
        # error is not the measure.
        self.assertGreater(
            fleet.chaos3.trace_actions(boundary="s3.put_object.before", action="Error"),
            0, detail)

    def test_a_round_survives_a_crash_takeover(self):
        fleet = self.open_fleet(nodes=2, ttl_ms=3_000, deadline_ms=5_000)
        first, second = fleet.node(0), fleet.node(1)
        size = 64
        leader = Leader(self.client(fleet, 0), "alpha", size)
        self.assertEqual(leader.alloc(b"failover"), "alpha")
        leader.take()
        round_ = leader.capture_id
        self.assertEqual(leader.write(30), (30, "ok"), leader.summary())

        # A crash, not a shutdown: the dead node never releases anything.
        first.kill()
        started = time.monotonic()
        leader.retarget(second.origin)
        self.assertEqual(leader.write(30), (30, "ok"), leader.summary())
        takeover = time.monotonic() - started
        detail = f"{leader.summary()}; takeover {takeover:.1f}s"
        self.assertEqual(leader.capture_id, round_, detail)
        self.assertEqual(leader.rounds, [round_], "the leader never re-captured")

        client = self.client(fleet, 1)
        self.assertEqual(audit(client, size, [leader]), 60, detail)
        status = self.expect(client.status(), 200)
        self.assertEqual((status["nextRound"], status["captures"]), (round_ + 1, 1), detail)

        interrupted = sum(leader.statuses.get(code, 0) for code in [503, "unreachable"])
        self.assertGreater(interrupted, 0, f"the client never noticed the crash: {detail}")
        unexpected = {code: count for code, count in leader.statuses.items()
                      if code not in (200, 409, 503, "unreachable")}
        self.assertEqual(unexpected, {}, detail)


if __name__ == "__main__":
    main(sys.argv)
