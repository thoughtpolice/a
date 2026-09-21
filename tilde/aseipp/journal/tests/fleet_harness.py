# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The journal's workload over the shared celld fleet harness.

`celld_fleet` (from `tilde//aseipp/wormspace:fleet-harness`) owns chaos3, the
proxy, the nodes, the supervisor, and the fixture; this module adds what is
the journal's alone: `JournalClient`, the `Writer` that implements the README's
append-retry contract and keeps its ledger, and `verify`, the invariants that
ledger implies. `Fleet` and `FleetTestCase` are the shared ones with a journal
client attached.
"""

import base64
import json
import time
import urllib.error
import urllib.request

import celld_fleet
from celld_fleet import (
    RETRYABLE_STATUSES,
    Unreachable,
    decode,
    encode,
    main,
    resilient,
)

__all__ = [
    "Fleet", "FleetTestCase", "JournalClient", "Writer", "decode", "encode",
    "main", "read_all", "resilient", "verify",
]

class JournalClient:
    """The journal's HTTP API, with base64 and proxy bypass handled here."""

    def __init__(self, origin, name, timeout=30):
        self.origin = origin
        self.name = name
        self.timeout = timeout
        # Tests set HTTP_PROXY for celld; the client's own loopback traffic
        # must never take it, or an outage window would black-hole the test.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def retarget(self, origin):
        self.origin = origin
        return self

    def call(self, operation, body=None, timeout=None):
        """One request. Returns (status, decoded body); raises `Unreachable`."""
        if operation is None:
            url = f"{self.origin}/v1/logs/{self.name}"
            request = urllib.request.Request(url, method="GET")
        else:
            url = f"{self.origin}/v1/logs/{self.name}/{operation}"
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

    def acquire(self, candidate, ttl_ms=60_000, link_size=None):
        body = {"candidate": candidate, "ttlMs": ttl_ms}
        if link_size is not None:
            body["linkSize"] = link_size
        return self.call("acquire-lease", body)

    def renew(self, leader, ttl_ms=60_000):
        return self.call("renew-lease", {"leader": leader, "ttlMs": ttl_ms})

    def release(self, leader):
        return self.call("release-lease", {"leader": leader})

    def append(self, leader, payloads, expected=None, timeout=None):
        body = {"leader": leader, "records": [encode(p) for p in payloads]}
        if expected is not None:
            body["expectedNextSeq"] = expected
        return self.call("append", body, timeout=timeout)

    def read(self, from_, limit=None, max_bytes=None):
        body = {"from": from_}
        if limit is not None:
            body["limit"] = limit
        if max_bytes is not None:
            body["maxBytes"] = max_bytes
        return self.call("read", body)

    def snapshot(self, through_seq, ref):
        return self.call("record-snapshot", {"throughSeq": through_seq, "ref": ref})

    def trim(self, through_seq):
        return self.call("trim", {"throughSeq": through_seq})


class Writer:
    """A single fenced writer following the README's append-retry contract.

    One record per append, `expectedNextSeq` always set, and a replay that
    comes back `SEQ_MISMATCH` with the same term and `head == expected + 1` is
    proof the original landed — not a guess, because nobody else can write
    under that term. Everything retryable is retried with the *same* expected
    sequence, which is what makes an ambiguous write safe.
    """

    RETRYABLE = RETRYABLE_STATUSES

    # Links of 16 records: every scenario's writer seals and opens links as
    # it goes, so rollover happens under the faults, the chaos campaigns,
    # the proxy outages, and the failovers, not only in a quiet test. The
    # journal honours it only on a journal with no links yet.
    LINK_SIZE = 16

    def __init__(self, client, leader, tag, *, budget=90.0, supervisor=None,
                 pause=0.25, link_size=LINK_SIZE):
        self.client = client
        self.leader = leader
        self.tag = tag
        self.link_size = link_size
        self.budget = budget
        self.supervisor = supervisor
        self.pause = pause
        self.head = None
        self.term = None
        self.ledger = []
        self.sent = []
        # Payloads number across the writer's whole life, not per call: a test
        # that writes in several bursts must still produce a record nobody
        # else wrote, so "no payload twice" stays a real check.
        self.issued = 0
        self.statuses = {}
        self.proved = 0
        self.not_leader = None
        self.attempts = 0
        self.max_latency = 0.0

    def _note(self, status):
        self.statuses[status] = self.statuses.get(status, 0) + 1

    def start(self, ttl_ms=60_000):
        """Acquire the lease and learn the journal's head and term.

        Acquiring is repeated through `resilient` because the storage under
        the node can fail this call too, and a repeat by the same candidate is
        a renewal: it cannot take a term from anyone. It carries the writer's
        link size, which a journal that already has links ignores.
        """
        status, body = resilient(self.client.acquire, self.leader, ttl_ms,
                                 self.link_size)
        if status != 200:
            raise AssertionError(f"{self.tag}: acquire-lease -> {status} {body}")
        self.term = body["term"]
        status, body = resilient(self.client.status)
        if status != 200:
            raise AssertionError(f"{self.tag}: status -> {status} {body}")
        self.head = body["head"]
        return self

    def retarget(self, origin):
        """Point at another node after a failover; the token is unchanged."""
        self.client.retarget(origin)
        return self

    def payload(self):
        return f"{self.tag}:{self.issued:05d}".encode()

    def write(self, count):
        """Append `count` records, retrying everything the contract allows.

        Returns the number written; stops early and records `NOT_LEADER` if the
        lease moved, which the caller decides how to judge.
        """
        written = 0
        for _ in range(count):
            if not self.append_one(self.payload()):
                break
            self.issued += 1
            written += 1
        return written

    def append_one(self, payload):
        """Land exactly one record at `self.head`, or report leadership loss."""
        expected = self.head
        deadline = time.monotonic() + self.budget
        while True:
            if self.supervisor is not None:
                self.supervisor.restart_if_dead(ready_timeout=45, tolerant=True)
            self.attempts += 1
            started = time.monotonic()
            try:
                status, body = self.client.append(self.leader, [payload], expected)
            except Unreachable:
                self._note("unreachable")
                status, body = None, None
            self.max_latency = max(self.max_latency, time.monotonic() - started)
            if status is not None:
                self._note(status)

            if status == 200:
                assert body["firstSeq"] == expected, (body, expected)
                self.term = body["term"]
                self.ledger.append((body["firstSeq"], payload, body["term"]))
                self.sent.append(payload)
                self.head = body["lastSeq"] + 1
                return True
            if status == 409 and body.get("code") == "SEQ_MISMATCH":
                if body.get("term") == self.term and body.get("head") == expected + 1:
                    # The lost reply's append had landed. Proof, not a guess.
                    self.proved += 1
                    self.ledger.append((expected, payload, self.term))
                    self.sent.append(payload)
                    self.head = expected + 1
                    return True
                raise AssertionError(
                    f"{self.tag}: unexplained SEQ_MISMATCH at expected={expected} "
                    f"term={self.term}: {body}")
            if status == 409 and body.get("code") == "NOT_LEADER":
                self.not_leader = body
                return False
            if status is None or status in self.RETRYABLE:
                if time.monotonic() > deadline:
                    raise AssertionError(
                        f"{self.tag}: gave up on seq {expected} after {self.budget}s; "
                        f"statuses {self.statuses}; last {status} {body}")
                time.sleep(self.pause)
                continue
            raise AssertionError(f"{self.tag}: append -> {status} {body}")

    def summary(self):
        return (f"{self.tag}: {len(self.ledger)} records, head={self.head}, "
                f"term={self.term}, attempts={self.attempts}, proved={self.proved}, "
                f"statuses={self.statuses}, max_latency={self.max_latency:.2f}s"
                + (f", stopped on {self.not_leader}" if self.not_leader else ""))

    def faults_seen(self):
        """How many replies were not an immediate success."""
        return sum(count for status, count in self.statuses.items() if status != 200)


def read_all(client, limit=200):
    """Page the whole live journal, honouring a trim mark. Returns (records, status)."""
    status, body = resilient(client.status)
    if status != 200:
        raise AssertionError(f"status -> {status} {body}")
    position = body["trimmedThrough"] + 1
    head = body["head"]
    records = []
    while position < head:
        code, window = resilient(client.read, position, limit=limit)
        if code == 410 and window.get("code") == "TRIMMED":
            position = window["trimmedThrough"] + 1
            continue
        if code != 200:
            raise AssertionError(f"read from {position} -> {code} {window}")
        if not window["records"]:
            raise AssertionError(f"read from {position} returned nothing below head {head}")
        for record in window["records"]:
            records.append((record["seq"], decode(record["payload"]), record["term"]))
        position = records[-1][0] + 1
    return records, body


def verify(client, ledger, sent=None):
    """Check every externally visible invariant the workload implies.

    Nothing here trusts the service's own bookkeeping: the stream is read back
    and compared against what the writer was told, byte for byte.
    """
    records, meta = read_all(client)
    trimmed = meta["trimmedThrough"]
    head = meta["head"]
    seqs = [seq for seq, _, _ in records]
    expected = list(range(trimmed + 1, head))
    if seqs != expected:
        raise AssertionError(
            f"journal is not contiguous: got {seqs[:8]}..{seqs[-8:]} "
            f"expected {trimmed + 1}..{head - 1}")

    payloads = {seq: payload for seq, payload, _ in records}
    terms = [term for _, _, term in records]
    if any(later < earlier for earlier, later in zip(terms, terms[1:])):
        raise AssertionError(f"terms decrease along the stream: {terms}")

    for seq, payload, term in ledger:
        if seq <= trimmed:
            continue
        if seq not in payloads:
            raise AssertionError(
                f"acknowledged record {seq} ({payload!r}) is missing; "
                f"journal holds {trimmed + 1}..{head - 1}")
        if payloads[seq] != payload:
            raise AssertionError(
                f"record {seq} reads back as {payloads[seq]!r}, not {payload!r}")

    if sent is not None:
        allowed = set(sent)
        seen = set()
        for seq, payload, _ in records:
            if payload not in allowed:
                raise AssertionError(f"record {seq} holds {payload!r}, which nobody sent")
            if payload in seen:
                raise AssertionError(f"record {seq} duplicates payload {payload!r}")
            seen.add(payload)
    return len(records), meta


class Fleet(celld_fleet.Fleet):
    """The shared fixture, plus a journal client on any node."""

    def client(self, name, index=0, timeout=30):
        return JournalClient(self.nodes[index].origin, name, timeout=timeout)


class FleetTestCase(celld_fleet.FleetTestCase):
    fleet_class = Fleet
