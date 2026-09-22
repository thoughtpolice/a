# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""WormLog on a real celld fleet: three appenders under chaos and a crash.

The Worker runs the log library; the log's `Sequencer` cell hands out slots and
holds each segment's capture; the appenders write the segments. chaos3 runs a
pinned `storage-v1` campaign under all of it, a supervisor restarts the node
whenever it dies, and once a third of the records are in, the test kills the
node outright (SIGKILL, mid-request) so the appenders see calls whose outcome
they cannot know.

Each appender sends every attempt with its own payload. A 200 acknowledges a
slot. A 503 or no reply at all leaves the attempt's outcome unknown (it may have
landed), so the appender records it as possible and sends the record again as a
new attempt; a 500 fails the run. Once the campaign has recovered, every slot
still pending is filled, and the audit reads the log back:

  - every slot below `next` holds a record or a hole;
  - every acknowledged attempt is at its slot, byte for byte;
  - every record in the log is an attempt somebody sent, appears once, and is
    either acknowledged at that slot or one whose outcome was unknown;

and it reads the log again after the node restarts with its local state wiped,
so the bucket alone carries the log, which must read back identically.
"""

import sys
import threading
import time

from celld_fleet import RETRYABLE_STATUSES, FleetTestCase, Unreachable, main
from layer_client import LogClient, read_log, settled

READY_PATH = "/v1/segments/readiness-probe"
BUCKET = "wormspace"
CHAOS3_SEED = 43
SIZE = 16


class Appender(threading.Thread):
    """Appends `count` records, one attempt at a time, until each is acknowledged."""

    def __init__(self, origin, name, tag, count, guard, budget=240.0):
        super().__init__(daemon=True)
        self.client = LogClient(origin, name)
        self.tag = tag
        self.count = count
        self.guard = guard
        self.budget = budget
        self.sent = set()
        self.maybe = set()
        self.acked = {}
        self.statuses = {}
        self.retook = 0
        self.error = None

    def note(self, status):
        self.statuses[status] = self.statuses.get(status, 0) + 1

    def run(self):
        deadline = time.monotonic() + self.budget
        try:
            for index in range(self.count):
                attempt = 0
                while True:
                    self.guard()
                    payload = f"{self.tag}:{index:03d}:{attempt}".encode()
                    self.sent.add(payload)
                    try:
                        status, body = self.client.append(payload)
                    except Unreachable:
                        status, body = "unreachable", None
                    self.note(status)
                    if status == 200:
                        self.acked[payload] = body["slot"]
                        if body["attempts"] > 1:
                            self.retook += 1
                        break
                    if status != "unreachable" and status not in RETRYABLE_STATUSES:
                        raise AssertionError(f"{self.tag}: append -> {status} {body}")
                    self.maybe.add(payload)
                    attempt += 1
                    if time.monotonic() > deadline:
                        raise AssertionError(
                            f"{self.tag}: record {index} unacknowledged after {self.budget}s")
                    time.sleep(0.25)
        except Exception as error:  # noqa: BLE001 - reported by the test
            self.error = error

    def summary(self):
        return (f"{self.tag}: acked={len(self.acked)} sent={len(self.sent)} "
                f"maybe={len(self.maybe)} retook={self.retook} statuses={self.statuses}")


def audit(client, appenders):
    """Check the log against every appender's ledger; returns (records, holes)."""
    entries, tail = read_log(client)
    slots = [slot for slot, _, _ in entries]
    expected = list(range(tail["trimmedThrough"] + 1, tail["next"]))
    if slots != expected:
        raise AssertionError(f"the log read back with gaps: {slots[:20]}.. of {tail}")
    sent = {payload: appender for appender in appenders for payload in appender.sent}
    maybe = set().union(*(appender.maybe for appender in appenders))
    acked = {}
    for appender in appenders:
        for payload, slot in appender.acked.items():
            if slot in acked.values():
                raise AssertionError(f"slot {slot} acknowledged twice")
            acked[payload] = slot
    found = {}
    holes = 0
    for slot, state, value in entries:
        if state == "hole":
            holes += 1
            continue
        if state != "value":
            raise AssertionError(f"slot {slot} is {state} after the fills")
        if value not in sent:
            raise AssertionError(f"slot {slot} holds {value!r}, which nobody sent")
        if value in found:
            raise AssertionError(f"{value!r} at slots {found[value]} and {slot}")
        found[value] = slot
        if value in acked:
            if acked[value] != slot:
                raise AssertionError(f"{value!r} acknowledged at {acked[value]}, found at {slot}")
        elif value not in maybe:
            raise AssertionError(f"{value!r} at {slot} was never acknowledged nor in doubt")
    for payload, slot in acked.items():
        if found.get(payload) != slot:
            raise AssertionError(f"acknowledged {payload!r} at {slot} reads {found.get(payload)}")
    return entries, holes


class FleetWormLogTest(FleetTestCase):

    def test_three_appenders_under_chaos_and_a_crash(self):
        fleet = self.use_fleet(bucket=BUCKET, ready_path=READY_PATH, seed=CHAOS3_SEED,
                               chaos="storage-v1", warmup=30, requests=400, trace=True,
                               ttl_ms=5_000, deadline_ms=8_000)
        name = self.log_name()
        origin = fleet.node().origin
        client = LogClient(origin, name)
        self.assertEqual(settled(client.init, SIZE)["size"], SIZE)

        supervisor = fleet.supervisor()
        lock = threading.Lock()

        def guard():
            with lock:
                supervisor.restart_if_dead(ready_timeout=45, tolerant=True)

        started = time.monotonic()
        appenders = [Appender(origin, name, tag, 25, guard) for tag in ["alpha", "beta", "gamma"]]
        for appender in appenders:
            appender.start()
        deadline = time.monotonic() + 200
        while (sum(len(appender.acked) for appender in appenders) < 25
               and time.monotonic() < deadline
               and any(appender.is_alive() for appender in appenders)):
            time.sleep(0.02)
        with lock:
            fleet.node().kill()
        killed = sum(len(appender.acked) for appender in appenders)
        for appender in appenders:
            appender.join(300)
        elapsed = time.monotonic() - started
        summaries = "; ".join(appender.summary() for appender in appenders)
        for appender in appenders:
            self.assertFalse(appender.is_alive(), f"{appender.tag} still running; {summaries}")
            if appender.error is not None:
                raise AssertionError(f"{appender.error}; {summaries}")

        report = fleet.chaos3.wait_recovered(180, drive=True)
        detail = (f"chaos3 seed {fleet.chaos3.seed()} coverage {report}; {summaries}; "
                  f"killed after {killed} acks; {supervisor.diagnostics()}")
        self.assertLess(killed, 75, f"the kill came too late to matter; {detail}")
        self.assertGreater(supervisor.restarts, 0, detail)
        # Close every slot nobody will write: the losers of lost tokens and of
        # refused writes.
        entries, tail = read_log(client)
        pending = [slot for slot, state, _ in entries if state == "pending"]
        for slot in pending:
            settled(client.fill, slot, what=f"fill {slot}")
        records, holes = audit(client, appenders)
        self.assertEqual(sum(len(appender.acked) for appender in appenders), 75, detail)
        self.assertGreaterEqual(len(records), 75, detail)
        self.assertGreater(tail["next"], 4 * SIZE, f"the log crossed segments; {detail}")
        print(f"[wormlog] 75 appends in {elapsed:.1f}s, killed after {killed}, "
              f"next={tail['next']}, {len(pending)} slots filled, {holes} holes; "
              f"{summaries}",
              file=sys.stderr, flush=True)

        fleet.node().restart(fresh=True)
        again, _ = audit(client, appenders)
        self.assertEqual(again, records, f"the bucket-restored log differs; {detail}")

        self.assertGreater(report["errors_before"], 0, detail)
        self.assertGreater(
            fleet.chaos3.trace_actions(boundary="s3.put_object.before", action="Error"),
            0, detail)


if __name__ == "__main__":
    main(sys.argv)
