# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exact, pinned S3 failure schedules under one fleet node.

Each test owns its own chaos3, because a failpoint plan is fixed for a server's
lifetime, and each pins `--fault-seed 42` so a probabilistic plan replays. The
scenarios are the four shapes an object store fails in, plus the one that is
not a failure at all:

  - an error *before* the mutation, where nothing happened;
  - an error *after the commit*, where the mutation is already visible and the
    caller is told it failed — the ambiguous write;
  - a body that stops short of its own `Content-Length`, where a read looked
    like it worked;
  - an error on the read path, where recovery cannot see what it stored;
  - a delay, where everything works and only the clock notices.

Every test proves the plan actually fired. chaos3 keeps no failpoint counters,
so the proof is a direct S3 request from the test: a counted plan's budget is
spent (the request celld was being failed on now succeeds), or a percentage
plan is still live (the same request fails again, and for `after_commit`, the
object it failed on is there anyway).
"""

import sys
import time

from fleet_harness import FleetTestCase, Writer, main, verify

# One seed for every scenario here: the plans are pinned, so a failure names
# a schedule that replays.
SEED = 42


class FleetFaultsTest(FleetTestCase):
    """One node, TTL 10 s, and one hand-written failure schedule per test."""

    def fleet_with(self, failpoints):
        return self.use_fleet(seed=SEED, failpoints=failpoints,
                              ttl_ms=10_000, deadline_ms=15_000)

    def test_entry_errors_are_absorbed_before_the_journal_sees_them(self):
        """Six `SlowDown`s at the write boundary, from the first S3 call on."""
        fleet = self.fleet_with(["s3.put_object.before=6*return(SlowDown)"])
        # The deployment and the node's own bucket writes are the first six
        # visits; a plain PUT succeeding now is how the test sees them spent.
        self.assertEqual(fleet.chaos3.s3_request("PUT", "budget/put-before", b"spent")[0], 200,
                         "celld never consumed the six-error budget")

        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        self.assertEqual(writer.write(10), 10, writer.summary())
        self.assertLess(writer.max_latency, 15.0, writer.summary())
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 10)
        self.assertFalse(fleet.node().self_fenced(), "a retryable error fenced the node")

    def test_a_committed_write_reported_as_an_error_keeps_the_ledger(self):
        """One PUT in four commits and then answers `InternalError`."""
        fleet = self.fleet_with(["s3.put_object.after_commit=25%return(InternalError)"])
        failed = []
        for index in range(24):
            status, _ = fleet.chaos3.s3_request("PUT", f"ambiguous/{index}", b"committed")
            if status != 200:
                failed.append(index)
        self.assertTrue(failed, "the after-commit plan never fired in 24 writes")
        for index in failed:
            # The point of the boundary: the caller was told it failed, and the
            # object is there. celld has to reconcile exactly this.
            self.assertEqual(fleet.chaos3.s3_request("GET", f"ambiguous/{index}")[1], b"committed",
                             f"ambiguous/{index} answered an error and did not commit")

        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        self.assertEqual(writer.write(30), 30, writer.summary())
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 30, writer.summary())

        fleet.node().restart(fresh=True)
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 30, writer.summary())

    def test_truncated_bodies_do_not_corrupt_a_restore(self):
        """One response body in twenty stops before a chunk it promised.

        The rate is kept low on purpose: it applies to every GET for the whole
        run, including the node's fetch of its own script on the fresh
        restart below, and a script of n chunks survives a fetch with
        probability 0.95^n. The probes below still prove that bodies were
        cut, and a restore reads far more chunks than the script does.
        """
        fleet = self.fleet_with(["s3.get_object.body=5%return(truncate)"])
        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        self.assertEqual(writer.write(20), 20, writer.summary())

        fleet.chaos3.s3_request("PUT", "truncation/probe", b"payload" * 20_000)
        probes = [fleet.chaos3.s3_get_probe("truncation/probe") for _ in range(20)]
        short = [probe for probe in probes if probe[0] == 200 and probe[1] < probe[2]]
        self.assertTrue(short, f"no body was truncated in 20 reads: {probes}")

        # Restoring reads the whole journal back out of the bucket, so this is
        # the path the truncations land on.
        fleet.node().restart(fresh=True)
        count, meta = verify(client, writer.ledger, writer.sent)
        self.assertEqual((count, meta["head"]), (20, 21), writer.summary())

    def test_errors_on_the_read_path_do_not_lose_records(self):
        """One GET in four is refused, including during a restore."""
        fleet = self.fleet_with(["s3.get_object.before=25%return(ServiceUnavailable)"])
        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        self.assertEqual(writer.write(40), 40, writer.summary())
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 40, writer.summary())

        refused = [fleet.chaos3.s3_request("GET", "truncation/absent")[0] for _ in range(24)]
        self.assertIn(503, refused, f"the read plan never fired in 24 reads: {refused}")

        fleet.node().restart(fresh=True)
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 40, writer.summary())

    def test_a_slow_bucket_delays_an_append_without_losing_it(self):
        """One PUT in five takes an extra 1.5 s; a fleet ack waits for it."""
        fleet = self.fleet_with(["s3.put_object.before=20%sleep(1500)"])
        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()

        started = time.monotonic()
        self.assertEqual(writer.write(30), 30, writer.summary())
        elapsed = time.monotonic() - started

        self.assertGreater(writer.max_latency, 1.0,
                           f"no append was slowed by the injected delay: {writer.summary()}")
        self.assertLess(elapsed, 120.0, writer.summary())
        # A slow bucket is not a lost lease: the node must not fence itself.
        self.assertFalse(fleet.node().self_fenced(), fleet.node().diagnostics())
        self.assertIsNone(fleet.node().exit_code(), fleet.node().diagnostics())
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 30, writer.summary())


if __name__ == "__main__":
    main(sys.argv)
