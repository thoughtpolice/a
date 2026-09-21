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

Faults and a loaded host can cost the *surviving* node its own lease, and
celld's answer to that is to fence itself and exit 3; a real deployment's
supervisor waits a lease and starts it again. So the node the writer is on
is always supervised, as in the chaos and proxy scenarios, while the node the
test kills is left to the test. A death is only acceptable when a lost bucket
explains it (a fence, or a restart refused while the bucket is still gone):
anything else a supervisor sees fails the test.
"""

import sys
import threading
import time

from fleet_harness import FleetTestCase, Writer, main, verify

TTL_MS = 3_000
DEADLINE_MS = 5_000
CHAOS3_SEED = 42


class FleetFailoverTest(FleetTestCase):
    """Kill the node under the writer, twice, in both directions."""

    def failover(self, after_kill=None, **settings):
        fleet = self.use_fleet(nodes=2, ttl_ms=TTL_MS, deadline_ms=DEADLINE_MS, **settings)
        first, second = fleet.node(0), fleet.node(1)
        watch = {node.name: fleet.supervisor(node) for node in (first, second)}
        name = self.log_name()
        client = fleet.client(name)
        writer = Writer(client, "alpha", name, budget=180.0, supervisor=watch[first.name])
        writer.start()
        self.assertEqual(writer.write(30), 30, writer.summary())
        term = writer.term

        # A crash, not a shutdown: the dead node never releases anything. The
        # writer moves to the survivor and its supervisor; nothing restarts
        # the node killed here but the test.
        writer.retarget(second.origin, watch[second.name])
        first.kill()
        if after_kill is not None:
            after_kill(fleet)
        started = time.monotonic()
        self.assertEqual(writer.write(30), 30, writer.summary())
        takeover = time.monotonic() - started
        self.assertEqual(writer.term, term,
                         f"the journal lease did not survive the takeover: {writer.summary()}")
        self.assertEqual(verify(client, writer.ledger, writer.sent, supervisor=watch[second.name])[0],
                         60, writer.summary())

        # Bring the crashed node back with nothing of its own, then take the
        # other one away: the journal has now been served by both, twice.
        self.revive(first, watch[first.name])
        writer.retarget(first.origin, watch[first.name])
        second.kill()
        self.assertEqual(writer.write(30), 30, writer.summary())
        self.assertEqual(writer.term, term, writer.summary())
        self.assertEqual(verify(client, writer.ledger, writer.sent, supervisor=watch[first.name])[0],
                         90, writer.summary())

        supervised = "; ".join(supervisor.diagnostics() for supervisor in watch.values())
        detail = (f"{writer.summary()}; first takeover {takeover:.1f}s; "
                  f"second node exits {second.exits}; {supervised}")
        for supervisor in watch.values():
            self.assertEqual(supervisor.unexplained_exits(), [],
                             f"a node died of something a lost bucket does not explain: {detail}")
        interrupted = sum(writer.statuses.get(code, 0)
                          for code in [503, "unreachable"])
        # A failover the client never noticed would not be a failover test.
        self.assertGreater(interrupted, 0, detail)
        # 500 is a throw the edge did not classify; a handoff must never be one.
        unexpected = {status: count for status, count in writer.statuses.items()
                      if status not in (200, 409, 503, "unreachable")}
        self.assertEqual(unexpected, {}, detail)
        return fleet, writer, detail

    def revive(self, node, supervisor):
        """Restart a killed node from nothing but the bucket.

        Under faults its first bucket writes can fail and fence it before it
        serves; the supervisor then waits a lease and starts it again.
        """
        try:
            node.restart(fresh=True)
        except AssertionError:
            if node.running():
                raise
            supervisor.ensure_ready()

    def test_a_crashed_node_hands_its_cells_over(self):
        """What a client actually sees while the cell changes owner."""
        fleet, writer, detail = self.failover()
        # celld answers a request for a cell whose owner just died by
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

    def test_the_survivor_fences_during_the_takeover_and_comes_back(self):
        """The flake this suite once had, on purpose.

        Right after the kill, the bucket goes away for longer than a lease:
        the survivor cannot renew its own and fences itself, exit 3, in the
        middle of taking the dead node's cells over. Its supervisor waits a
        lease and restarts it, and the writer carries on under the same term.
        Without the supervisor the writer sees nothing but refused
        connections until its budget runs out.
        """
        outage = 2.5 * TTL_MS / 1000.0

        def cut_the_bucket(fleet):
            fleet.proxy.set_mode("refuse")
            restore = threading.Timer(outage, fleet.proxy.set_mode, args=("normal",))
            restore.daemon = True
            restore.start()
            self.addCleanup(restore.cancel)

        fleet, writer, detail = self.failover(after_kill=cut_the_bucket, proxy=True)
        survivor = fleet.supervisor(fleet.node(1))
        self.assertGreaterEqual(survivor.fenced, 1, f"the survivor never fenced: {detail}")
        self.assertGreaterEqual(survivor.restarts, 1, f"nothing restarted the survivor: {detail}")


if __name__ == "__main__":
    main(sys.argv)
