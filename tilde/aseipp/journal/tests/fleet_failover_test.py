# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Two nodes, one journal, and a writer that survives losing the one it is on.

A journal cell has exactly one owner. Killing that owner outright — no
shutdown, no lease release, no chance to hand anything over — is the case the
whole design exists for: the surviving node must take the cell over without the
stream changing, and the writer's *journal* lease must survive it, because the
lease lives in the cell's own SQLite and not in the node that was serving it.

So the writer does not re-acquire after a failover. It keeps its token, points
at the other node, and the term must not move: a new term would mean the
journal thought leadership changed, which nothing here asked for.

The second campaign runs the same failovers with chaos3 injecting faults
underneath, where a takeover has to read a journal out of a bucket that is
answering some of its requests with errors.
"""

import sys
import time

from fleet_harness import FleetTestCase, Writer, main, verify

TTL_MS = 3_000
DEADLINE_MS = 5_000
CHAOS3_SEED = 42


class FleetFailoverTest(FleetTestCase):
    """Kill the node under the writer, twice, in both directions."""

    def failover(self, **settings):
        fleet = self.use_fleet(nodes=2, ttl_ms=TTL_MS, deadline_ms=DEADLINE_MS, **settings)
        first, second = fleet.node(0), fleet.node(1)
        name = self.log_name()
        client = fleet.client(name)
        writer = Writer(client, "alpha", name, budget=180.0)
        writer.start()
        self.assertEqual(writer.write(30), 30, writer.summary())
        term = writer.term

        # A crash, not a shutdown: the dead node never releases anything.
        first.kill()
        started = time.monotonic()
        writer.retarget(second.origin)
        self.assertEqual(writer.write(30), 30, writer.summary())
        takeover = time.monotonic() - started
        self.assertEqual(writer.term, term,
                         f"the journal lease did not survive the takeover: {writer.summary()}")
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 60, writer.summary())

        # Bring the crashed node back with nothing of its own, then take the
        # other one away: the journal has now been served by both, twice.
        first.restart(fresh=True)
        second.kill()
        writer.retarget(first.origin)
        self.assertEqual(writer.write(30), 30, writer.summary())
        self.assertEqual(writer.term, term, writer.summary())
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 90, writer.summary())

        detail = (f"{writer.summary()}; first takeover {takeover:.1f}s; "
                  f"second node exits {second.exits}")
        interrupted = sum(writer.statuses.get(code, 0)
                          for code in [503, "unreachable"])
        # A failover the client never noticed would not be a failover test.
        self.assertGreater(interrupted, 0, detail)
        # 500 is a throw the edge did not classify; a handoff must never be one.
        unexpected = {status: count for status, count in writer.statuses.items()
                      if status not in (200, 409, 503, "unreachable")}
        self.assertEqual(unexpected, {}, detail)
        return fleet, writer, detail

    def test_a_crashed_node_hands_its_cells_over(self):
        """What a client actually sees while the cell changes owner."""
        fleet, writer, detail = self.failover()
        # celld 0.5.1 answers a request for a cell whose owner just died by
        # dialling that owner's peer tunnel and throwing `remote RPC transport
        # failed: ... Connection refused`: a plain Error with no `code`. The
        # edge classifies it by message and answers 503 UNAVAILABLE with a
        # Retry-After, which is what the writer's replays act on. The ledger
        # checked above is the proof that nothing was lost or written twice.
        # The node's own record of those dead-owner dials is its
        # `remote_route_retry` warning; the thrown message itself never reaches
        # the log, because the edge no longer treats it as an internal error.
        self.assertGreater(writer.statuses.get(503, 0), 0,
                           f"no UNAVAILABLE during the handoff: {detail}")
        self.assertIn('event="remote_route_retry"', fleet.node(1).logs(),
                      f"an UNAVAILABLE the peer route does not explain: {detail}")

    def test_a_crashed_node_hands_its_cells_over_under_chaos(self):
        fleet, writer, detail = self.failover(
            seed=CHAOS3_SEED, chaos="storage-v1", warmup=30, requests=300, trace=True)
        report = fleet.chaos3.wait_recovered(180, drive=True)
        self.assertGreater(report["errors_before"], 0,
                           f"chaos3 seed {fleet.chaos3.seed()} coverage {report}; {detail}")
        self.assertGreater(writer.faults_seen(), 0,
                           f"chaos3 seed {fleet.chaos3.seed()} coverage {report}; {detail}")


if __name__ == "__main__":
    main(sys.argv)
