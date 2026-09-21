# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The journal on a real fleet node, with a healthy bucket underneath it.

This is the control for every other fleet scenario: the same deployment, the
same node supervision, and the same invariant checks, with chaos3 injecting
nothing. If these fail, a failure in a chaos scenario says nothing about fault
handling.

The one thing only a fleet can show is what `celld dev` cannot: a node whose
local working directory is wiped still serves the journal, because every
acknowledged write was proved through the bucket before it was acknowledged.
"""

import sys
import time

from fleet_harness import FleetTestCase, Writer, encode, main, verify


class FleetBasicsTest(FleetTestCase):
    """One node, one deployment, no injected faults."""

    @classmethod
    def setUpClass(cls):
        cls.start_fleet(ttl_ms=10_000, deadline_ms=15_000)

    def test_a_deployment_is_adopted_and_the_node_serves(self):
        self.assertIs(self.fleet.deploy_result["dry_run"], False, self.fleet.deploy_result)
        body = self.expect(self.fleet.client(self.log_name()).status(), 200)
        self.assertEqual((body["head"], body["term"], body["leader"]), (1, 0, None))
        self.assertGreater(body["databaseSize"], 0)

    def test_the_whole_api_round_trips_through_the_bucket(self):
        client = self.fleet.client(self.log_name())
        self.expect(client.acquire("alpha", 60_000), 200)
        payloads = [b"", b"\x00\xff", bytes(range(256)), "journal ✓".encode()]
        appended = self.expect(client.append("alpha", payloads, expected=1), 200)
        self.assertEqual((appended["firstSeq"], appended["lastSeq"], appended["term"]), (1, 4, 1))

        window = self.expect(client.read(1), 200)
        self.assertEqual([record["seq"] for record in window["records"]], [1, 2, 3, 4])
        self.assertEqual([encode(payload) for payload in payloads],
                         [record["payload"] for record in window["records"]])

        marked = self.expect(client.snapshot(2, "s3://snap/2"), 200)
        self.assertEqual(marked["snapshot"], {"throughSeq": 2, "ref": "s3://snap/2"})
        self.assertEqual(self.expect(client.trim(2), 200)["trimmedThrough"], 2)
        self.expect(client.read(1), 410, "TRIMMED")
        self.assertEqual([record["seq"] for record in self.expect(client.read(3), 200)["records"]],
                         [3, 4])
        self.assertEqual(verify(client, [(3, payloads[2], 1), (4, payloads[3], 1)])[0], 2)

    def test_state_survives_a_graceful_restart_of_the_same_node(self):
        client = self.fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        writer.write(12)
        self.expect(client.snapshot(4, "s3://snap/4"), 200)
        self.expect(client.trim(4), 200)
        before = self.expect(client.status(), 200)

        self.fleet.node().restart(fresh=False)

        after = self.expect(client.status(), 200)
        for key in ["head", "term", "leader", "deadlineMs", "trimmedThrough", "snapshot"]:
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 8)

    def test_state_is_restored_from_the_bucket_alone(self):
        """Wipe the node's local state: only what the bucket holds can come back."""
        client = self.fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name()).start()
        writer.write(20)
        self.expect(client.snapshot(5, "s3://snap/5"), 200)
        self.expect(client.trim(5), 200)
        before = self.expect(client.status(), 200)

        started = time.monotonic()
        self.fleet.node().restart(fresh=True)
        restored = time.monotonic() - started

        after = self.expect(client.status(), 200)
        for key in ["head", "term", "leader", "deadlineMs", "trimmedThrough", "snapshot"]:
            self.assertEqual(after[key], before[key], f"{key} after a {restored:.1f}s restore")
        count, _ = verify(client, writer.ledger, writer.sent)
        self.assertEqual(count, 15)

        # The lease is state too: the same token still writes, under the same term.
        writer.write(3)
        self.assertEqual(writer.term, before["term"])
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], 18)

    def test_diagnose_reports_every_check_healthy(self):
        code, checks, stderr = self.fleet.diagnose()
        self.assertEqual(code, 0, f"{checks}\n{stderr}")
        self.assertTrue(checks, f"diagnose printed no checks:\n{stderr}")
        unhealthy = [check for check in checks if check.get("verdict") != "ok"]
        self.assertEqual(unhealthy, [], f"{checks}\n{stderr}")


if __name__ == "__main__":
    main(sys.argv)
