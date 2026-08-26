<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Change-bounded orchestration

This is the required replacement architecture, **not an implemented property of
the current prototype**. The full `head_targets`/manifest-inventory extension has
been removed from tdutil and Orchestra. It was the wrong contract: deleting one
test must not require transmitting or comparing every test in the repository.
Paging that same inventory every epoch would not fix the underlying cost.

## The invariant

Ordinary revision admission and reconciliation must depend on the change plus a
fixed scheduling quantum, with indexed lookups—not repository size, accumulated
history, or the entire outstanding backlog. Each message, transaction, artifact
chunk, and query has an explicit byte/row/work budget and a durable continuation.
An empty change must not trigger a catalog refresh.

There are three different sizes: the source change, its transitive impact, and
the executions selected by policy. One build-rule change can affect every test.
Returning all affected targets is therefore **not** a worst-case change-bounded
protocol either. A budget applied after constructing that list is too late.

Large impact must be recorded symbolically and processed on demand. If policy
eventually requires a million genuine executions, their total execution work
cannot be made sublinear; accepting the revision and recording coverage debt
must not require enumerating those executions first.

## Changes and coverage debt, not inventory snapshots

An immutable revision interval identifies a durable change/impact handle. Small
explicit changes can carry target-lineage upserts or proven removal records.
Broad or expensive impact instead carries a bounded invalidation obligation:
revision, graph/configuration identity, affected scope or graph query, and a
continuation owned by the graph provider. A global configuration change can
invalidate one graph generation without immediately updating every test row.

Arbitrary reverse-dependency closures are not necessarily directory ranges.
The graph provider must supply incremental/lazy impact queries; Orchestra must
not approximate those closures with package-name guessing. When exact impact
cannot be resolved within budget, coverage is unresolved, not inherited green.

The scheduler expands only enough impact to fill its next fixed batch, freezes
that batch's identity, and checkpoints the continuation before dispatch. It must
not drain a full-repository cursor as a prerequisite for admitting the next
revision. The epoch may close with explicitly recorded coverage debt according
to policy; that is not a claim that every affected test passed.

This needs a future graph-provider contract. **The current tdutil CLI does not
provide these handles or bounded impact queries.** Its affected-only output is
restored unchanged; no new tdutil protocol is being invented in this rollback.

## Deletion needs positive evidence

Absence from the affected-test list is not proof of deletion. Retirement needs
an explicit, revision-qualified removal record, or a successful point-membership
query for a bounded set of candidates at the requested immutable graph revision.
A failed query, missing result stream, or unsupported rule is not a tombstone.
Direct source-file changes alone are insufficient: macros and shared build
rules can add or remove targets in other packages.

As a future incremental first step, validate just the candidates selected for
dispatch and retire those proven absent. Untouched historical records need not
be scanned to discover removals. Read paths must distinguish old observations
from proof that a target still exists and is currently covered. Historical
observations remain immutable after retirement.

The prototype's inventory-based automatic retirement has been removed, not
replaced with a guess. Exact retirement remains unimplemented until it has a
bounded source of evidence; pending deleted targets may still encounter infra
errors, and previously passing deleted targets may still appear as inherited
coverage. This limitation must remain visible.

## Keyed durable records

| Responsibility | Required state/access pattern |
| --- | --- |
| Repository sequencing | Small sequence/frontier metadata; indexed epoch and revision rows, not a map of every historical epoch. |
| Source-change ingestion | Durable interval cursor and idempotent delta receipts; separate applied-change progress from test-success progress. |
| Test coverage | Sharded, keyed target/platform/lineage records; update only touched tests and consult applicable invalidations on demand. |
| Scheduling debt | Indexed ready/age/priority queues plus lazy impact continuations; take a fixed batch, never scan all pending tests. |
| Agent broker | Indexed live-epoch eligibility, ready jobs, lease expiry, and notification outbox. Cancellation fences an epoch without walking its jobs. |
| Epoch publication | Small receipt, counters for observed work, unresolved-debt handles, and references to immutable evidence chunks. No copied catalog or inherited-test array. |

Celld Durable Objects own the sharded authority and cursors. Workflows drive
bounded state transitions, Queues provide delivery hints, R2 holds bounded
immutable evidence chunks, and D1 provides indexed projections. A finalization
cursor must range over that epoch's actual evidence index, not a whole snapshot
first loaded and sliced in memory. Retention is separate, budgeted maintenance.

Coverage lookup and progress reporting must not hide global scans. Cached
counters describe only what was actually counted; unresolved impact may have an
unknown cardinality. Large exact exports are explicit streaming operations, not
normal epoch reports. Invalidation membership itself also needs indexed or
budgeted graph queries; moving an unbounded scan behind an RPC is not a solution.

## What still has to change

Removing inventory is a rollback, not a scalability claim. Current code still:

- Collects base/head graphs in tdutil for changed intervals and materializes an
  affected list that can be repository-sized.
- Stores the repository's catalog, coverage, reservations, and revision map in
  one value; copies the frontier into epochs; scans and serializes these maps
  during policy evaluation and reporting.
- Scans historical broker job order for claims, notification delivery, and
  diagnostics.
- Constructs a whole terminal test map before its checkpointed D1 publication.

Existing 10,000-test and byte limits stop this prototype explicitly; they do not
turn these algorithms into a scalable implementation. Never silently truncate a
plan or call capacity exhaustion complete coverage.

Implementation order: replace aggregate state with keyed/indexed records and
small receipts; add a genuinely bounded graph-impact/point-validation contract;
then drive lazy obligations with Workflows and scheduling budgets. Preserve the
existing lease fences, immutable evidence, alarm-backed recovery, and replay
tests throughout. Regression tests must compare a fixed change against growing
unrelated catalogs/history and assert constant bounded rows/bytes touched, not
only that each page stays below a limit.
