# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The restart that makes celld declare a bounded loss, against the journal.

Two nodes with stable `CELLD_NODE` ids. A writer appends continuously to a
journal owned by one of them; both nodes are killed outright, the owner first.
The owner is restarted alone and the follower stays down past the witness grace
(max(3 x TTL, 20 s)). Then a new writer appends, the follower comes back with
its original disk, and the stream is compared with everything the writers were
told: every acknowledged record must read back with identical bytes.

With celld's default `fleet` durability a write is acknowledged once the
follower has it, so this sequence loses the acknowledged tail and new appends
reuse its seqs (celld #244/#245; see buck/toolchains/celld/AGENTS.md). The
journal cannot detect that, so its fleets run with `CELLD_DURABILITY=bucket`,
the harness default, under which nothing is acknowledged before the bucket has
it. This test guards that choice. It prints what happened on the way: whether
celld declared a loss, what `status` said, what a continuing writer's
`expectedNextSeq` got back, and which sequences hold other bytes.
"""

import json
import re
import sys
import threading
import time

from fleet_harness import FleetTestCase, JournalClient, Writer, main, read_all, resilient, verify

TTL_MS = 3_000
DEADLINE_MS = 5_000
# celld's member grace for declaring loss: max(3 x TTL, 20 s).
GRACE_S = max(3 * TTL_MS / 1000.0, 20.0)
# Acknowledged appends after the warm-up, before both nodes die.
TAIL = 200


def report(**fields):
    print("BOUNDED-LOSS " + json.dumps(fields, sort_keys=True, default=str),
          file=sys.stderr, flush=True)


def batch_files(node):
    """The `.batch` files under a node's `peerlog/`, relative to its root."""
    return sorted(str(path.relative_to(node.root))
                  for path in node.root.rglob("*.batch") if "peerlog" in path.parts)


class TailWriter(threading.Thread):
    """Appends one record at a time until told to stop or a call fails.

    Unlike `Writer` it never retries: the nodes are about to be killed under
    it, and only replies that came back 200 count as acknowledged.
    """

    def __init__(self, origin, name, leader, head, term):
        super().__init__(daemon=True)
        self.client = JournalClient(origin, name, timeout=5)
        self.leader = leader
        self.head = head
        self.term = term
        self.ledger = []
        self.sent = []
        self.stop = threading.Event()
        self.ended = None

    def run(self):
        issued = 0
        while not self.stop.is_set():
            payload = f"tail:{issued:05d}".encode()
            issued += 1
            try:
                status, body = self.client.append(self.leader, [payload], self.head)
            except Exception as error:  # noqa: BLE001 - the node died under us
                self.ended = repr(error)
                return
            if status != 200:
                self.ended = f"{status} {body}"
                return
            self.ledger.append((body["firstSeq"], payload, body["term"]))
            self.sent.append(payload)
            self.head = body["lastSeq"] + 1


class FleetBoundedLossTest(FleetTestCase):

    def test_the_owner_restarted_alone_past_the_grace_loses_nothing(self):
        fleet = self.use_fleet(nodes=2, ttl_ms=TTL_MS, deadline_ms=DEADLINE_MS)
        name = self.log_name()
        client = fleet.client(name)
        # A short lease, so a new writer can take over once the old one is gone.
        writer = Writer(client, "alpha", "before", budget=60.0).start(ttl_ms=5_000)
        self.assertEqual(writer.write(20), 20, writer.summary())

        owners = [node for node in fleet.nodes
                  if any(path.name.startswith("Segment:") for path in node.root.iterdir())]
        self.assertEqual(len(owners), 1, [list(node.root.iterdir()) for node in fleet.nodes])
        owner = owners[0]
        follower = next(node for node in fleet.nodes if node is not owner)
        client.retarget(owner.origin)

        tail = TailWriter(owner.origin, name, "alpha", writer.head, writer.term)
        tail_started = time.monotonic()
        tail.start()
        deadline = time.monotonic() + 30
        while len(tail.ledger) < TAIL and time.monotonic() < deadline and tail.is_alive():
            time.sleep(0.05)
        # SIGKILL both, owner first: every acknowledged write is on the
        # follower's disk, and the follower cannot start a takeover before the
        # owner's node lease (3 s) has expired.
        owner.kill()
        killed_at = time.monotonic()
        tail_ms = (killed_at - tail_started) * 1000 / max(len(tail.ledger), 1)
        follower.kill()
        tail.stop.set()
        tail.join(10)
        acked = writer.ledger + tail.ledger
        acked_head = acked[-1][0] + 1
        follower_batches = batch_files(follower)
        report(stage="killed", ms_per_append=round(tail_ms, 1),
               owner=owner.name, follower=follower.name,
               acked=len(acked), acked_head=acked_head, tail_acked=len(tail.ledger),
               tail_ended=tail.ended, follower_batch_files=len(follower_batches),
               follower_batches=follower_batches[-6:])

        # The owner alone, with its own disk and id. Started inside the grace,
        # it refuses to install its lease ("1 member(s) undecided") and exits
        # 1; a supervisor starts it again, which is what this loop does, until
        # the follower's node lease has been dead for longer than the grace.
        refusals = []
        while True:
            try:
                owner.restart(fresh=False, ready_timeout=180)
                break
            except AssertionError as error:
                if owner.running() or time.monotonic() - killed_at > TTL_MS / 1000 + 4 * GRACE_S:
                    raise
                refusals.append(round(time.monotonic() - killed_at, 1))
                time.sleep(2)
        ready_after = time.monotonic() - killed_at
        report(stage="owner-started", refused_at_s=refusals, ready_after_s=round(ready_after, 1))
        status, body = resilient(client.status, budget=180)
        self.assertEqual(status, 200, body)
        owner_log = owner.logs()
        declared = [line for line in owner_log.splitlines() if "declared bounded loss" in line]
        # celld writes the loss record beside the dead session's log record,
        # `log/<dead>.e<epoch>.loss.json`: the one trace of it outside the logs.
        records_seen = {}
        for line in declared:
            found = re.search(r'dead="([^"]+)" epoch=(\d+)', line)
            if found:
                key = f"log/{found.group(1)}.e{found.group(2)}.loss.json"
                code, raw = fleet.chaos3.s3_request("GET", key)
                records_seen[key] = (code, raw.decode(errors="replace")[:400])
        report(stage="owner-alone", ready_after_s=round(ready_after, 1), grace_s=GRACE_S,
               status=body, declared_loss_lines=declared[-3:], loss_records=records_seen)

        # A writer that kept its own head, following the retry contract.
        probe = client.append("alpha", [b"probe-never-lands?"], expected=acked_head)
        report(stage="continuing-writer-probe", expected=acked_head, reply=probe)
        probe_ledger, probe_sent = [], []
        if probe[0] == 200:
            probe_ledger = [(probe[1]["firstSeq"], b"probe-never-lands?", probe[1]["term"])]
            probe_sent = [b"probe-never-lands?"]

        # A new writer incarnation, as the issue's client: a fresh token, head
        # from `status`, then more appends than the loss.
        lost = acked_head - body["head"]
        # alpha's lease must lapse first, or beta gets LEASE_HELD.
        time.sleep(max(0.0, (body["deadlineMs"] - body["nowMs"]) / 1000.0 + 0.5))
        after = Writer(client, "beta", "after", budget=60.0).start(ttl_ms=60_000)
        written = after.write(max(lost, 0) + 10)
        report(stage="new-writer", start_head=body["head"], term=after.term,
               written=written, summary=after.summary())

        # The follower comes back as itself, with its original disk.
        before_rejoin = batch_files(follower)
        follower.restart(fresh=False, ready_timeout=180)
        time.sleep(5)
        after_rejoin = batch_files(follower)
        follower_log = follower.logs().rsplit("\n=== start ", 1)[-1]
        mentions = [line for line in follower_log.splitlines()
                    if "loss" in line or "peerlog" in line or "orphan" in line]
        report(stage="follower-rejoined", batch_files_before=len(before_rejoin),
               batch_files_after=len(after_rejoin), log_mentions=mentions[-10:])

        records, meta = read_all(client)
        now = {seq: payload for seq, payload, _ in records}
        replaced = [(seq, payload.decode(), now[seq].decode())
                    for seq, payload, _ in acked if seq in now and now[seq] != payload]
        missing = [seq for seq, _, _ in acked if seq not in now]
        audit = None
        try:
            verify(client, acked + probe_ledger + after.ledger,
                   writer.sent + tail.sent + probe_sent + after.sent)
        except AssertionError as error:
            audit = str(error).splitlines()[0]
        report(stage="audit", head=meta["head"], term=meta["term"],
               replaced=len(replaced), replaced_sample=replaced[:5], missing=len(missing),
               verify=audit or "passed")

        self.assertEqual(
            (replaced, missing), ([], []),
            f"acknowledged records were replaced or lost: {len(replaced)} replaced "
            f"(e.g. {replaced[:3]}), {len(missing)} missing; loss declared: "
            f"{bool(declared)}; continuing writer saw {probe}; audit: {audit}")


if __name__ == "__main__":
    main(sys.argv)
