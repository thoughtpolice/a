# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The journal under chaos3's `storage-v1` adversarial campaign.

A campaign is not a schedule a test can predict. It draws an effect at every
boundary celld reaches — before a handler, after a mutation is already visible,
and part-way through a response body — from one seed. So the test pins the
seed, keeps the client workload strictly sequential, and asserts two separate
things:

  - the journal's externally visible invariants, by reading the whole stream
    back and comparing it to what the writer was told; and
  - fault *coverage*, from chaos3's own counters, so a run in which the campaign
    happened to select nothing cannot pass and look like a result.

The campaign is finite. Its recovery is where the audit belongs: a phase change
does not cancel requests already in flight, so the test waits for chaos3 to
report that every admitted handler has drained before it reads anything back,
and only then wipes the node's local state to make the bucket prove the whole
journal by itself.
"""

import sys

from fleet_harness import FleetTestCase, Writer, main, verify

RECORDS = 150
WARMUP_REQUESTS = 30
CHAOS_REQUESTS = 600


class FleetChaosTest(FleetTestCase):
    """One node, one seed, one campaign, one sequential writer."""

    def campaign(self, seed):
        fleet = self.use_fleet(seed=seed, chaos="storage-v1", warmup=WARMUP_REQUESTS,
                               requests=CHAOS_REQUESTS, trace=True,
                               ttl_ms=10_000, deadline_ms=8_000)
        client = fleet.client(self.log_name())
        writer = Writer(client, "alpha", self.log_name(),
                        supervisor=fleet.supervisor(), budget=180.0)
        writer.start()
        self.assertEqual(writer.write(RECORDS), RECORDS, writer.summary())

        report = fleet.chaos3.wait_recovered(180, drive=True)
        detail = (f"chaos3 seed {fleet.chaos3.seed()} coverage {report}; "
                  f"{writer.summary()}; {fleet.supervisor().diagnostics()}")

        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], RECORDS, detail)
        # Nothing local may carry the answer: after this the bucket is the
        # only place the journal exists.
        fleet.node().restart(fresh=True)
        self.assertEqual(verify(client, writer.ledger, writer.sent)[0], RECORDS, detail)

        self.assertGreater(report["errors_before"], 0, detail)
        self.assertGreater(report["errors_after_commit"], 0, detail)
        self.assertGreater(report["delays"], 0, detail)
        # `truncations` is reported in `detail` rather than asserted: the
        # profile cuts a body with 5% probability and only a restore reads
        # enough of them for that to be reliable, which is what
        # `fleet_faults_test.py` pins with an exact plan instead.

        # Those counters are campaign-wide. This one says the *write* path was
        # attacked, which is the claim the workload is evidence for. It is not
        # the same as the client seeing an error: celld absorbs nearly all of
        # this, and a 150-record run has finished with no reply but `200`
        # while chaos3 had injected dozens of failures underneath it.
        self.assertGreater(
            fleet.chaos3.trace_actions(boundary="s3.put_object.before", action="Error"),
            0, detail)
        return fleet, writer, report

    def test_campaign_seed_42(self):
        self.campaign(42)

    def test_campaign_seed_7(self):
        self.campaign(7)


if __name__ == "__main__":
    main(sys.argv)
