# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""celld reaching S3 only through an HTTP forward proxy.

Where celld is likely to run, the bucket is not directly reachable: egress goes
through a proxy, and the proxy is then part of the storage path's failure
surface. celld's S3 client honours `HTTP_PROXY`, including for loopback
endpoints, so these tests put the harness proxy between the node and chaos3 and
break it in the ways a real one breaks.

The scenarios are the proxy's four states: healthy, bypassed, refusing
connections, and accepting them and answering nothing — the black hole that a
client cannot tell from a slow server. Under all of them the journal must never
acknowledge a record it then loses, which is what `verify` re-reads the whole
stream to check.

`Writer`'s own supervisor restarts the node when a lost bucket makes it fence
itself, waiting a whole lease lifetime first, exactly as a real supervisor
must.
"""

import sys
import threading

from fleet_harness import FleetTestCase, Writer, main, verify

# Seeds for the proxy's own faults and for the chaos3 campaign it is combined
# with. Both appear in every failure message.
PROXY_SEED = 42
CHAOS3_SEED = 42

# A short lease makes an outage bite quickly; the deadline bounds one celld
# operation, so a black hole has to outlast it to be a black hole.
TTL_MS = 3_000
DEADLINE_MS = 5_000


class ProxyEgressTest(FleetTestCase):
    """The proxy is healthy or bypassed: what celld sends, and where."""

    def test_every_s3_request_reaches_the_proxy(self):
        fleet = self.use_fleet(proxy=True, ttl_ms=TTL_MS, deadline_ms=DEADLINE_MS)
        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        self.assertEqual(writer.write(5), 5, writer.summary())

        counters = fleet.proxy.counters()
        self.assertGreater(counters["forwarded"], 0, counters)
        for fault in ["resets", "errors", "delays", "stalled", "refused"]:
            self.assertEqual(counters[fault], 0, f"a healthy proxy {fault}: {counters}")
        lines = fleet.proxy.requests()
        # A forward proxy is addressed in absolute-URI form; origin-form here
        # would mean something else answered.
        self.assertTrue(all(line.split(" ")[1].startswith("http://") for line in lines),
                        lines[:5])
        self.assertTrue(any(line.startswith("PUT ") and "/cells/" in line for line in lines),
                        "no cell write went through the proxy")
        self.assertTrue(any(line.startswith("PUT ") and "/nodes/" in line for line in lines),
                        "no node lease write went through the proxy")
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 5)

    def test_no_proxy_takes_the_bucket_off_the_proxy(self):
        """The same fleet with `NO_PROXY` set must not touch the proxy at all."""
        bypass = {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}
        fleet = self.use_fleet(proxy=True, node_env=bypass, celld_env=bypass,
                               ttl_ms=TTL_MS, deadline_ms=DEADLINE_MS)
        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        self.assertEqual(writer.write(5), 5, writer.summary())
        self.assertEqual(fleet.proxy.counters()["connections"], 0, fleet.proxy.diagnostics())
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 5)


class ProxyOutageTest(FleetTestCase):
    """The proxy stops working while a writer is mid-stream."""

    def outage(self, fleet, mode, seconds):
        """Hold the proxy in `mode` for a window, restoring it from a timer.

        The client workload stays single-threaded: only the switch is on a
        timer, so the writer's retries are the thing under test.
        """
        fleet.proxy.set_mode(mode)
        restore = threading.Timer(seconds, fleet.proxy.set_mode, args=("normal",))
        restore.daemon = True
        restore.start()
        self.addCleanup(restore.cancel)
        return restore

    def run_outage(self, mode, seconds, records=3):
        """Write through an outage window and return the fleet and writer."""
        fleet = self.use_fleet(proxy=True, ttl_ms=TTL_MS, deadline_ms=DEADLINE_MS)
        client = fleet.client(self.log_name())
        # Links of 8: the outage's records fill the first link, and the first
        # append after it opens the second, on a node the outage may have
        # just fenced and restarted.
        writer = Writer(client, "alpha", self.log_name(),
                        supervisor=fleet.supervisor(), budget=180.0, link_size=8)
        writer.start()
        self.assertEqual(writer.write(5), 5, writer.summary())

        self.outage(fleet, mode, seconds)
        self.assertEqual(writer.write(records), records, writer.summary())

        self.assertEqual(writer.write(5), 5, writer.summary())
        self.assertGreater(writer.faults_seen(), 0,
                           f"the {mode} outage was invisible to the client: {writer.summary()}")
        # Every reply the writer counted as landed is in the journal, and the
        # journal holds nothing else. That is the whole safety claim.
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 13, writer.summary())
        return fleet, writer

    def test_a_refusing_proxy_fences_the_node_and_loses_nothing(self):
        """Connections refused outright: the node cannot renew its lease."""
        fleet, writer = self.run_outage("refuse", 2.5 * TTL_MS / 1000.0)
        supervisor = fleet.supervisor()
        self.assertTrue(fleet.node().self_fenced(),
                        f"the node kept running without its bucket: {writer.summary()}")
        self.assertIn(3, supervisor.observed_exits,
                      f"a self-fence must exit 3: {supervisor.diagnostics()}")
        self.assertGreaterEqual(supervisor.restarts, 1, supervisor.diagnostics())
        self.assertEqual(verify(fleet.client(self.log_name()), writer.ledger, writer.sent)[0], 13)

    def test_a_black_hole_proxy_loses_nothing(self):
        """Connections accepted and answered by nobody, for over one deadline."""
        fleet, writer = self.run_outage("stall", 2.0 * DEADLINE_MS / 1000.0)
        self.assertGreater(fleet.proxy.counters()["stalled"], 0, fleet.proxy.diagnostics())
        self.assertEqual(verify(fleet.client(self.log_name()), writer.ledger, writer.sent)[0], 13)


class ProxyAndStorageChaosTest(FleetTestCase):
    """A seeded flaky proxy over a seeded chaos3 campaign, at once."""

    def test_a_flaky_proxy_over_a_chaos_campaign(self):
        fleet = self.use_fleet(
            proxy=True, proxy_seed=PROXY_SEED,
            proxy_plan={"reset": 0.15, "error": 0.10, "delay_ms": (0.10, 200)},
            seed=CHAOS3_SEED, chaos="storage-v1", warmup=30, requests=400, trace=True,
            ttl_ms=10_000, deadline_ms=15_000,
        )
        client = fleet.client(self.log_name())
        # The default link size, not the writer's usual 16: this scenario is
        # about the proxy, and its node restarts and stops through it. Every
        # cell the node owns adds bucket traffic to both, and with ten of them
        # (the journal and nine links) a stop has outlasted celld's 40-second
        # graceful shutdown here. The outage tests above cross links.
        writer = Writer(client, "alpha", self.log_name(),
                        supervisor=fleet.supervisor(), budget=180.0,
                        link_size=None)
        writer.start()
        self.assertEqual(writer.write(120), 120, writer.summary())
        fleet.chaos3.wait_recovered(120, drive=True)

        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 120, writer.summary())
        fleet.node().restart(fresh=True)
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 120, writer.summary())

        proxy = fleet.proxy.counters()
        self.assertGreater(proxy["resets"], 0, f"proxy seed {PROXY_SEED}: {proxy}")
        self.assertGreater(proxy["errors"], 0, f"proxy seed {PROXY_SEED}: {proxy}")
        coverage = fleet.chaos3.coverage()
        self.assertGreater(coverage["errors_before"], 0,
                           f"chaos3 seed {fleet.chaos3.seed()}: {coverage}")


if __name__ == "__main__":
    main(sys.argv)
