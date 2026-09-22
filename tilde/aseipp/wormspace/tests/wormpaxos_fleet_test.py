# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""WormPaxos on a real celld fleet: two replicas under chaos, and a crash.

Two nodes share one bucket on chaos3, which runs a pinned `storage-v1` campaign.
Replica `a` is reached through node `a` and replica `b` through node `b`, and
both propose at once, so every proposal by the replica that does not lead
steals the segment from the one that does. Halfway through, node `b` is killed
outright (SIGKILL: no shutdown, no lease release); `b`'s client moves to the
surviving node, and `b` must carry on from its durable state once its cell's
lease has expired and the survivor has restored it from the bucket.

Every attempt carries its own value. A 200 acknowledges an address; a 503 or
no reply leaves the attempt's outcome unknown, and the proposer sends the
command again as a new attempt; a 500 fails the run. The audit reads the chain
straight from the segment routes and checks:

  - every acknowledged attempt is at the address it was acknowledged at;
  - every value in the chain was sent, appears once, and is acknowledged or
    was in doubt;
  - once both replicas have learned, each has applied exactly the written
    prefix, and both tables equal the replay of that prefix.
"""

import random
import sys
import threading
import time

from celld_fleet import RETRYABLE_STATUSES, FleetTestCase, Unreachable, main
from layer_client import ReplicaClient, read_chain, replay, settled

READY_PATH = "/v1/segments/readiness-probe"
BUCKET = "wormspace"
CHAOS3_SEED = 44
SIZE = 16
KEYS = [f"k{index}" for index in range(5)]


class Proposer(threading.Thread):
    """Proposes `count` commands, one attempt at a time, until each is acknowledged."""

    def __init__(self, client, count, guard, seed, budget=300.0):
        super().__init__(daemon=True)
        self.client = client
        self.tag = client.replica
        self.count = count
        self.guard = guard
        self.random = random.Random(seed)
        self.budget = budget
        self.sent = set()
        self.maybe = set()
        self.acked = {}
        self.statuses = {}
        self.terms = []
        self.acked_at = []
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
                    value = f"{self.tag}:{index:03d}:{attempt}"
                    command = {"op": "set", "key": KEYS[index % len(KEYS)], "value": value}
                    self.sent.add(value)
                    try:
                        status, body = self.client.propose(command)
                    except Unreachable:
                        status, body = "unreachable", None
                    self.note(status)
                    if status == 200:
                        self.acked[value] = body["address"]
                        self.terms.append(body["term"])
                        self.acked_at.append(time.monotonic())
                        break
                    if status != "unreachable" and status not in RETRYABLE_STATUSES:
                        raise AssertionError(f"{self.tag}: propose -> {status} {body}")
                    self.maybe.add(value)
                    attempt += 1
                    if time.monotonic() > deadline:
                        raise AssertionError(
                            f"{self.tag}: command {index} unacknowledged after {self.budget}s")
                    time.sleep(0.25)
                time.sleep(self.random.uniform(0, 0.2))
        except Exception as error:  # noqa: BLE001 - reported by the test
            self.error = error

    def summary(self):
        steals = sum(1 for left, right in zip(self.terms, self.terms[1:]) if left != right)
        return (f"{self.tag}: acked={len(self.acked)} sent={len(self.sent)} "
                f"maybe={len(self.maybe)} term changes={steals} statuses={self.statuses}")


class FleetWormPaxosTest(FleetTestCase):

    def test_two_replicas_under_chaos_and_a_crash(self):
        fleet = self.use_fleet(bucket=BUCKET, ready_path=READY_PATH, nodes=2,
                               seed=CHAOS3_SEED, chaos="storage-v1", warmup=30,
                               requests=400, trace=True, ttl_ms=5_000, deadline_ms=8_000)
        first, second = fleet.node(0), fleet.node(1)
        group = self.log_name()
        alpha = ReplicaClient(first.origin, group, "a")
        beta = ReplicaClient(second.origin, group, "b")
        for client in [alpha, beta]:
            self.assertEqual(settled(client.init, SIZE)["preferredSize"], SIZE)

        supervisors = [fleet.supervisor(index=0), fleet.supervisor(index=1)]
        lock = threading.Lock()
        killed = threading.Event()

        def guard():
            with lock:
                supervisors[0].restart_if_dead(ready_timeout=45, tolerant=True)
                if not killed.is_set():
                    supervisors[1].restart_if_dead(ready_timeout=45, tolerant=True)

        per = 20
        proposers = [Proposer(alpha, per, guard, 1), Proposer(beta, per, guard, 2)]
        started = time.monotonic()
        for proposer in proposers:
            proposer.start()
        deadline = time.monotonic() + 200
        while len(proposers[1].acked) < per // 2 and time.monotonic() < deadline:
            if not proposers[1].is_alive():
                break
            time.sleep(0.05)
        before_kill = settled(beta.state)
        with lock:
            killed.set()
            second.kill()
            beta.retarget(first.origin)
        killed_at = time.monotonic()
        acked_before = len(proposers[1].acked)

        for proposer in proposers:
            proposer.join(360)
        summaries = "; ".join(proposer.summary() for proposer in proposers)
        for proposer in proposers:
            self.assertFalse(proposer.is_alive(), f"{proposer.tag} still running; {summaries}")
            if proposer.error is not None:
                raise AssertionError(f"{proposer.error}; {summaries}")
        elapsed = time.monotonic() - started
        after = [at for at in proposers[1].acked_at if at > killed_at]
        takeover = after[0] - killed_at if after else None

        report = fleet.chaos3.wait_recovered(180, drive=True)
        detail = (f"chaos3 seed {fleet.chaos3.seed()} coverage {report}; {summaries}; "
                  f"takeover {takeover}; {supervisors[0].diagnostics()}")
        self.assertLess(acked_before, per, f"the kill came too late to matter; {detail}")
        self.assertIsNotNone(takeover, f"b never proposed after the kill; {detail}")

        learned = [settled(client.learn) for client in [alpha, beta]]
        chain = read_chain(alpha, group, SIZE)
        written = chain.index("pending") if "pending" in chain else len(chain)
        prefix = chain[:written]
        # Nobody writes past a register it has not settled, so nothing is
        # written beyond the first pending one.
        self.assertEqual(set(chain[written:]), {"pending"} if written < len(chain) else set(),
                         detail)
        for result in learned:
            self.assertEqual(result["applied"], written, f"{learned}; {detail}")

        sent = set().union(*(proposer.sent for proposer in proposers))
        maybe = set().union(*(proposer.maybe for proposer in proposers))
        acked = {}
        for proposer in proposers:
            for value, address in proposer.acked.items():
                self.assertNotIn(address, acked.values(), f"address {address} twice; {detail}")
                acked[value] = address
        found = {}
        for address, command in enumerate(prefix):
            self.assertIsInstance(command, dict, f"address {address}: {command}; {detail}")
            if command["op"] == "noop":
                continue
            value = command["value"]
            self.assertIn(value, sent, f"address {address}: {command}; {detail}")
            self.assertNotIn(value, found, f"{value} at {found.get(value)} and {address}")
            found[value] = address
            if value not in acked:
                self.assertIn(value, maybe, f"{value} at {address} unacknowledged; {detail}")
        for value, address in acked.items():
            self.assertEqual(found.get(value), address, f"acknowledged {value}; {detail}")
        self.assertEqual(len(acked), 2 * per, detail)

        expected = replay(prefix)
        for client in [alpha, beta]:
            table = {key: settled(client.get, key)["value"] for key in KEYS}
            self.assertEqual(table, {key: expected.get(key) for key in KEYS},
                             f"{client.replica}'s table; {detail}")
        state = settled(beta.state)
        self.assertGreaterEqual(state["applied"], before_kill["applied"], detail)
        noops = sum(1 for command in prefix if command["op"] == "noop")
        print(f"[wormpaxos] {2 * per} proposals in {elapsed:.1f}s over {written} addresses "
              f"({noops} noop fills), b's first ack {takeover:.1f}s after the kill; "
              f"{summaries}", file=sys.stderr, flush=True)

        self.assertGreater(report["errors_before"], 0, detail)
        self.assertGreater(
            fleet.chaos3.trace_actions(boundary="s3.put_object.before", action="Error"),
            0, detail)


if __name__ == "__main__":
    main(sys.argv)
