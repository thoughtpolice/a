<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# journal

A fenced transaction journal service on celld: durable, totally ordered records
behind a deliberately small API.

The shape is Marc Brooker's description of the journal underneath MemoryDB — one
primitive that a database can get durability, replication fan-out, leader
election, reconfiguration safety, and off-box snapshotting from — with that
post's final, safe API: the journal itself enforces the lease, because a writer
can be paused between checking its own lease and reaching the log.

celld supplies the hard part. Each journal is one Durable Object, which has
exactly one active owner with epoch fencing and acknowledges a write only once
it is durable. Two instances of the same journal therefore cannot race. This
service's job is only to fence its _clients_.

The records themselves live in [wormspace](../wormspace/README.md)'s
write-once segments: the journal cell is a small coordinator that keeps the
lease, the marks, and a table of segment links, and every append is exactly one
atomic segment write. See [Records in segment links](#records-in-segment-links).

## API

Every method returns a result object with an `ok` flag and, when `ok` is false,
a `code`. Nothing throws for a domain outcome. The Durable Object RPC methods
and the HTTP routes are the same eight operations:

| Operation                                     | Route                                  |
| --------------------------------------------- | -------------------------------------- |
| `status()`                                    | `GET /v1/logs/{name}`                  |
| `acquireLease({candidate, ttlMs, linkSize?})` | `POST /v1/logs/{name}/acquire-lease`   |
| `renewLease({leader, ttlMs})`                 | `POST /v1/logs/{name}/renew-lease`     |
| `releaseLease({leader})`                      | `POST /v1/logs/{name}/release-lease`   |
| `append({leader, records, expectedNextSeq?})` | `POST /v1/logs/{name}/append`          |
| `read({from, limit?, maxBytes?})`             | `POST /v1/logs/{name}/read`            |
| `recordSnapshot({throughSeq, ref})`           | `POST /v1/logs/{name}/record-snapshot` |
| `trim({throughSeq})`                          | `POST /v1/logs/{name}/trim`            |

Over HTTP the request is the JSON body and record payloads are base64; over RPC
they are `Uint8Array`s. Log names match `^[a-z0-9][a-z0-9._-]{0,127}$`.
`linkSize` is a tuning knob, not part of the protocol: see
[The link size](#the-link-size).

| `code`           | Status | Meaning                                          |
| ---------------- | ------ | ------------------------------------------------ |
| —                | 200    | `ok`                                             |
| `INVALID`        | 400    | Malformed request, or a value out of range       |
| `TOO_LARGE`      | 413    | A record, batch, or body over its cap            |
| `LEASE_HELD`     | 409    | Another candidate holds a live lease             |
| `NOT_LEADER`     | 409    | The token is not the current leader              |
| `SEQ_MISMATCH`   | 409    | `expectedNextSeq` did not match `head`           |
| `TRIMMED`        | 410    | The position was deleted; read the snapshot      |
| `SNAPSHOT_STALE` | 409    | The snapshot mark is already further ahead       |
| `UNAVAILABLE`    | 503    | celld could not reach a cell or prove a write; retry |
| `INTERNAL`       | 500    | A bug                                            |

An unknown route is 404. `UNAVAILABLE` and `INTERNAL` exist only on the HTTP
edge; an RPC caller sees celld's own routing error and thrown exceptions.
`UNAVAILABLE` carries `Retry-After: 1` and covers the celld failures a client
should simply repeat: its routing error (`owner_unreachable`), the plain
"remote RPC transport failed" error a surviving node throws while the cell's
crashed owner is still being dialled, "route RPC …: RestoreFailed" for a cell
whose state could not be restored from the bucket yet, and "route failed:
DurabilityUnproven", a write the fleet could not prove. The last is the
ambiguous case: replay with the same `expectedNextSeq`. The journal cell throws
the same failures of its own segment calls, once its bounded retries are spent,
as an error whose message starts with `journal unavailable: `, and the edge
answers those with `UNAVAILABLE` too (see [Failures](#failures)).

## Leases, terms, and the fencing rule

`acquireLease` succeeds when the journal is unowned, when the caller already
holds it (a renewal, which keeps the term), or when the current holder's
deadline has passed (a takeover, which increments the term). Every record is
stamped with the term that wrote it, so a reader sees leadership changes in the
stream itself.

`append`, `renewLease`, and `releaseLease` are accepted if and only if the token
they carry is the journal's current leader. **They do not check the deadline.**
That is deliberate:

- A leader can be paused — garbage collection, a page fault, the scheduler —
  between checking its lease and reaching the journal. Only a check _inside_ the
  journal can fence it, and that check is the token comparison, serialized
  against every `acquireLease` by the cell's single owner.
- A sole leader whose lease lapsed with nobody taking over may therefore keep
  appending. Total order is intact and no one else can be writing. The instant
  another candidate acquires, the old token is refused. Rejecting the lapsed
  writer instead would buy no safety and would make correctness depend on clock
  quality across a handoff.

A lease is a liveness aid, never a safety mechanism. A leader must still stop
serving its _own_ consistent reads when its view of the lease lapses; the
journal cannot help with that.

Lease replies carry `nowMs`, the journal's clock at decision time. Subtract it
from `deadlineMs` to get a relative remaining duration and apply that to your
own monotonic clock, with a margin. Skew between your clock and the journal's
then never matters.

Conflict replies never echo the leader token: holding it is the capability to
write. Only `status()` reports it, for operators.

## Retrying an append

An append whose reply was lost is replayed with the same `expectedNextSeq`. One
of three things comes back:

- `ok` — it had not landed, and now has.
- `SEQ_MISMATCH` with the same `term` and
  `head === expectedNextSeq +
  records.length` — the original attempt landed.
  Nobody else can write under that term, so this is proof, not a guess.
- `NOT_LEADER` — leadership moved; whether the batch landed is now the new
  leader's problem to discover by reading.

A single fenced writer therefore needs no operation-ID table.

## Snapshots and trimming

`recordSnapshot({throughSeq, ref})` records that the prefix through `throughSeq`
exists somewhere else — `ref` is whatever the snapshotter wants to name it.
`trim({throughSeq})` deletes records at or below `throughSeq`, and refuses
anything the snapshot mark does not already cover.

Both are unfenced. The prefix they describe is immutable, so a snapshot of it is
valid no matter who took it, and a snapshotter should not have to hold the write
lease. Both are idempotent, and neither mark ever moves backwards.

Invariants the service maintains:
`0 <= trimmedThrough <= snapshotThrough <=
head - 1`, and records exist exactly
for `seq` in `(trimmedThrough, head)`. `head` is the sequence the next append
receives; sequences start at 1.

A trim commits its mark first and then trims the segments below it, so a reader
never meets a trimmed register the mark does not cover; segments a crash left
untrimmed in between are trimmed by the next successful `trim` call, which
always sweeps everything below the mark (segment trims are idempotent).

## Limits

Record 1 MiB, batch 4 MiB and 1000 records, read `limit` 1000 (default 100),
read `maxBytes` 4 MiB (default 1 MiB), `ttlMs` in [1000, 300000], tokens and
snapshot references 1..128 characters, HTTP body 8 MiB, `linkSize` in
[8, 65536] (default 4096). A read always returns at least one record when one
exists, even if it alone exceeds `maxBytes`.

**v1 assumes a trusted network.** There is no authentication: anyone who can
reach the service can call `status()` and read the live leader token. Put it
behind something that cares.

## Records in segment links

A journal named `orders` is one `Journal` cell named `orders` plus a chain of
`Segment` cells named `orders.0`, `orders.1`, and so on: wormspace's segment
Durable Object, bundled into this script and bound here as `SEGMENTS`. The
journal's segments are a namespace of the journal deployment, not of the
wormspace one, and no route reaches them: they are the journal cell's storage.
Link `i` holds the records from its `firstSeq` on, one per register from offset
0, so `seq` lives at offset `seq - firstSeq` of the link with the largest
`firstSeq` at or below it.

The journal cell's SQLite keeps only what the decision core reads — the lease
and term, `trimmedThrough`, the snapshot mark, and the link size — and the link
table, one row per link: `(link, first_seq, capture_id, sealed_at, term)`.
Records are never stored there.

What that buys:

- **A sharding unit.** A segment is the unit celld places, moves, and restores,
  so a long journal is many small cells instead of one cell whose SQLite grows
  forever. A failover restores a journal cell of a few rows, and the segments
  holding the records are restored on their own, when first read or written.
- **A replay proof from write-once.** A register is written at most once, all or
  none per batch, so an append whose outcome is unknown can be settled by the
  registers themselves: the journal's `SEQ_MISMATCH` proof now rests on the
  segment refusing to write the same register twice.
- **Coordination logic tested without celld.** Everything between the decision
  core and the segments ([src/log.ts](src/log.ts)) runs over a store interface
  and a segment resolver, so the Deno tests drive it over wormspace's fake
  segments with injected throws, lost replies, and stolen captures.

The design is laid out in [src/links.ts](src/links.ts) and
[src/log.ts](src/log.ts); the rules are these.

### Batches never span links

Every append is one segment `write` of the whole batch at the head's offset,
under the round the journal captured the whole link with, and a write lands all
or none. A batch that does not fit in what is left of the current link _seals_
the link at the offset head reached (`sealed_at`; its remaining registers are
never used, and no sequence is ever assigned to them) and goes to offset 0 of a
new link whose `first_seq` is head. The largest batch (1000 records) fits in an
empty link of the minimum production size, so a batch always fits somewhere.

Opening a link is `alloc` (size, and UTF-8 JSON metadata
`{"log", "index", "firstSeq", "term"}`), a `capture` of the whole link, and one
commit of the new row together with the previous link's seal, with a barrier.
An open interrupted after its allocation finds `ALREADY_ALLOCATED` with its own
metadata next time and continues; an allocation with other metadata (an open
for a head or term that no longer applies, which was therefore never written)
is skipped, and the link takes the next index.

### A link holds one term

A register holds the record's payload and nothing else, and the term is stored
once per link, in its row and its allocation metadata. The first append under a
new term seals the current link, exactly as a batch that does not fit does, and
opens a new one; a link sealed before anything was written in it is empty, and
shares its `first_seq` with the next.

The term cannot go into the register: a record may be a whole mebibyte and a
batch four, which are exactly a segment register's and a segment write's
limits, so there is no room for even a tag byte. Terms change only on a
takeover, so a link per term costs one extra link per takeover.

### Head is a cache

Nothing on the append path writes the journal cell's own SQLite: a commit there
costs the cell a durability barrier, and an append should pay only for its
segment write's. So `head` lives in the cell instance's memory. The first call
after the instance is created (and the first after any failure) recovers it:

1. capture the last link again and persist the new round: from now on, a write
   a previous owner of this cell still had in flight can only fail with
   `CAPTURE_STALE`, so nothing lands behind the recovered head;
2. read the link's `writes` counter with a zero-timeout `listen`, which answers
   only after a durability barrier. The journal writes every link contiguously
   from offset 0, so `head = first_seq + writes`. No links means head 1.

That is two segment calls and one commit, whatever the journal's length.

Everything below head is durable: head moves past a batch only once its write
was acknowledged (acknowledged means durable), a replay found its bytes (a
`sameValue` refusal waits for a barrier), or a `listen` counted it. A read never
goes past head, so, unlike the wormspace layers, it needs no `listen` after a
window, and the known limit their README describes (a read that sees a register
still at its barrier) cannot reach a journal reader. A read takes each link it
crosses with one segment `read` per window.

### Appends, replays, and stolen captures

The decision core decides against the cached head, the batch is placed, and one
write lands it. Then:

- A transient throw is repeated with the same bytes. A repeat refused with
  `ALREADY_WRITTEN`, `sameValue: true`, at the batch's first offset proves the
  thrown attempt landed, all of it: the append succeeded.
- `ALREADY_WRITTEN` otherwise means the cached head was stale: head is recovered
  and the same request is decided again from the top. A client replaying a lost
  append therefore gets exactly the `SEQ_MISMATCH` the
  [retry contract](#retrying-an-append) promises. A batch whose write may have
  landed is never sent to another position.
- `CAPTURE_STALE` means somebody captured the link over the journal: an
  operator, or a previous owner of this cell. The journal captures the whole
  link again, persists the round, and writes once more; a second steal in the
  same call is `UNAVAILABLE`. An operator that captures a journal's link must
  not write registers in it, or head recovery would count them.

### Failures

Segment calls celld reports as safe to repeat are repeated up to five times, as
in the wormspace layers. Past that, the call throws `journal unavailable: …`
(503 at the edge) and drops the cached head, so the next call recovers it. A
segment answer the journal's bookkeeping rules out (a hole below head, an
unexpected refusal) is thrown as a plain error: a 500.

Every method runs on one promise chain per cell instance (wormspace's `Serial`),
so an append that opens a link and writes it never interleaves with another
call at an `await`.

### The link size

`linkSize` on `acquireLease` sets the registers per link, and is honoured only
while the journal has no links yet; after that it is ignored, and the size is
fixed for the journal's life. It must be an integer in [8, 65536]; the default
is 4096. Below 1000 (the largest batch), a batch larger than a link is
`TOO_LARGE`, so sizes that small are for tests that want to cross links cheaply,
and the fleet tests' writer uses 16.

### What an append costs

Measured under `celld dev` on one machine: 200 one-record appends with
`expectedNextSeq` from one client, then 100-record reads, over two runs each.

|                                          | append median | append p90   | read 100     |
| ---------------------------------------- | ------------- | ------------ | ------------ |
| records in the cell's own SQLite, before | 19.8–21.1 ms  | 23.2–24.9 ms | 1.2–1.5 ms   |
| records in 4096-record links, now        | 21.4–21.8 ms  | 24.1–25.1 ms | 1.9–2.8 ms   |
| records in 8-record links                | 21.5 ms       | 127 ms       | 11 ms        |

Both designs pay one durability barrier per append: the journal cell's own
before, the segment's now. The hop from the journal cell to its segment, and
the call queue, cost about a millisecond, which matches what the wormspace
README measures for its layers. Opening a link costs about 100 ms more (the
allocation, the capture, and the row, three barriers), once per link, which is
what the 8-record row's p90 shows. A read pays one segment call per link it
crosses. The first call after a restart recovers head (a capture, a commit, and
a `listen`) in 55–60 ms, where the old cell answered in 3–4 ms.

## Layout

| File                             |                                                           |
| -------------------------------- | --------------------------------------------------------- |
| [src/types.ts](src/types.ts)     | Requests, result unions, limits                           |
| [src/core.ts](src/core.ts)       | Every decision, as pure transitions over one metadata row |
| [src/links.ts](src/links.ts)     | Link arithmetic: positions, sealing, trim plans, metadata |
| [src/log.ts](src/log.ts)         | The coordinator: the core over a store and the segments   |
| [src/http.ts](src/http.ts)       | Routes, base64, the status map, and `retryableCause`      |
| [src/journal.ts](src/journal.ts) | The Durable Object: SQLite around `log.ts`                |
| [src/index.ts](src/index.ts)     | Worker entry point and dispatch; exports `Segment` too    |

The [BUILD](BUILD) file makes the runtime-free modules the celld library
`:lib` (imported as `@journal/core`, `@journal/log`, and so on), and
`:worker` bundles `index.ts` and `journal.ts` over it. From wormspace, the
journal depends on the `:segment` library: `@wormspace/segment` (the `Segment`
class the bundle exports), `@wormspace/segment/serial` (the call queue and
`retryTransient`) and `@wormspace/segment/types`. The tests also use
`@wormspace/testing/fake_segment` and `@wormspace/testing/random`, and assert
with `@celld/assert`. See the
[toolchain README](../../../buck/toolchains/celld/README.md#typescript-units).

Decisions are pure functions because a Deno test cannot import
`cloudflare:workers`, and the fencing and trim rules are what deserve exhaustive
testing. `tests/core_test.ts` pins them case by case, `tests/model_test.ts`
checks the invariants over randomized operation sequences, `tests/http_test.ts`
covers the edge, and `tests/runtime_test.py` runs the real service under
`celld dev`, including across a supervisor restart. The segment side has its
own: `tests/links_test.ts` pins the arithmetic, `tests/log_test.ts` drives the
coordinator over wormspace's fake segments (sealing, rollover, reads and trims
across links, lost replies and the exact `SEQ_MISMATCH` proof, stolen captures,
interrupted opens and trims, and recovering head in a new instance), and
`tests/log_model_test.ts` runs 60 randomized histories of candidates, faults,
outages, operator steals, and restarts, reading the whole stream back after
every step.

```console
$ buck2 test tilde//aseipp/journal/...
$ buck2 run tilde//aseipp/journal:deploy -- --dry-run --json
$ buck2 run tilde//aseipp/journal:dev -- --port 8787   # poke at it by hand
```

`:dev` runs celld against the packaged project directory in `buck-out`; copy it
elsewhere first if you want its local storage to survive a rebuild.

## Fleet tests

`tests/runtime_test.py` runs the service under `celld dev`. The fleet tests run
it the way it will be deployed: `celld` in fleet mode, one deployment, real
node leases, and its bucket served by [chaos3](../../../src/chaos3/README.md) — which is
attacking it while a writer works. A fleet node acknowledges a write only once
it is proved through that bucket, so an object store that refuses requests,
commits a mutation and *then* reports failure, cuts a response body short, or
disappears entirely is the adversary the durability claim is really about.

Each test owns a temporary directory, its own chaos3, its own deployment, and an
ephemeral loopback port per process. Nothing is shared between tests and nothing
leaves loopback.

| Target                 | chaos3 mode                                | What it breaks                                                                              |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `:fleet-basics-test`   | healthy                                   | the control: deploy, the whole API, restart with and without local state, `celld diagnose`   |
| `:fleet-faults-test`   | `--failpoint`, `--fault-seed 42`          | entry errors, committed-then-failed writes, truncated bodies, read errors, 1.5 s delays      |
| `:fleet-chaos-test`    | `--chaos storage-v1`, seeds 42 and 7      | a 600-request campaign under a 150-record writer, audited after the campaign drains          |
| `:fleet-proxy-test`    | healthy, and `--chaos storage-v1` seed 42 | the egress proxy: healthy, bypassed, refusing, black-holing, and seeded-flaky over a campaign |
| `:fleet-failover-test` | healthy, and `--chaos storage-v1` seed 42 | `SIGKILL` on the node serving the cell, twice, in both directions                            |

```console
$ buck2 test tilde//aseipp/journal/...          # everything, in parallel
$ buck2 test tilde//aseipp/journal:fleet-chaos-test
```

**The truncation scenario and the script's size.** A fleet node fetches the
deployed script from the bucket every time it starts, and
`test_truncated_bodies_do_not_corrupt_a_restore` restarts one while chaos3 cuts
response bodies short, so a script of `n` 4 KiB chunks arrives whole with
probability `(1 - p)^n` per request. Bundling the `Segment` class tripled the
script to 63 KB, and at the original one-in-five rate that restart stopped
reaching `ready`; the journal's own invariants held in every run. Two things
changed: the bundle is minified (32 KB, `minify = True` on `deno.bundle`), and
the scenario cuts one body in twenty, which its direct probes still prove
happens and which a restore, reading far more chunks than the script, still
meets. Startup liveness under a lossy store is celld's retry policy, not a
journal property, and the scenario no longer stakes its verdict on it.

The writer asks for 16-record links (8 in the proxy outages), so the scenarios
seal and open links while they are being attacked; the flaky proxy over a chaos
campaign keeps the default size, because every cell a node owns adds bucket
traffic to the stops and restarts that scenario pushes through the proxy, and
ten cells once outlasted celld's 40-second graceful shutdown there. Every scenario ends by reading the whole stream back and
comparing it to what the writer was told: sequences contiguous from `trimmedThrough + 1` to
`head - 1`, every acknowledged record present with identical bytes, nothing in
the journal nobody sent, no payload twice, and terms never decreasing. A chaos
run additionally asserts chaos3's own coverage counters, so a campaign that
selected nothing cannot pass and be mistaken for a result.

The writer in these tests retries only `503 UNAVAILABLE` and connection
failures, replaying an append with the same `expectedNextSeq`. A `500 INTERNAL`
fails the run: celld 0.5.1 reports a failure it cannot resolve — a durability
proof it could not obtain, or a peer tunnel to an owner that just died — by
throwing an error that carries no `code`, and the edge recognises those by
message (`retryableCause` in `src/http.ts`), so a 500 under these tests means a
throw nobody has classified. `tests/fleet_failover_test.py` asserts that a
crash failover is seen as 503s and never as a 500.

### Egress through a proxy

celld's S3 client honours `HTTP_PROXY`/`http_proxy`, including for a loopback
endpoint: every request then arrives at the proxy in absolute-URI form, and a
dead proxy fails the node rather than being bypassed. `NO_PROXY=127.0.0.1`
takes the bucket back off it. `tests/fleet_proxy_test.py` asserts both, and runs
the node behind a proxy that can refuse connections, answer `502`, reset a
connection mid-request, or black-hole one on demand — the last being the case a
node cannot tell apart from a slow bucket. A node that cannot reach its bucket for a whole
lease lifetime self-fences, logs `SELF-FENCE:`, and exits 3; the harness's
`Supervisor` restarts it only after a full lease has passed, as a real
supervisor must.

### Reproducing a failure

Every assertion message carries what a rerun needs: the effective chaos3 fault
seed, the campaign's coverage counters, the proxy seed, plan and counters, the
supervisor's restart and self-fence tally, and the tail of every log. The seeds
are pinned in the scenario files, so the first step is always to run that target
again:

```console
$ buck2 test tilde//aseipp/journal:fleet-chaos-test
```

chaos3 replays the same faults for the same seed and the same admitted operation
sequence. celld's background traffic — lease renewals, the replication ship
loop — interleaves with the workload, so the *order* of admissions can move
between runs; the scenarios therefore assert invariants and coverage rather than
an exact schedule. `--chaos-trace` is on in every campaign, so the chaos3 log in
the failure message names every boundary that was reached, with its request
number and phase.

## Follow-ups

- `waitForRecords({from, timeoutMs})` long-polling, or hibernatable-WebSocket
  tailing, so fan-out is push rather than poll. The last link's segment
  `listen` is most of it already.
- Garbage collection of links a crash left allocated and unused, and of fully
  trimmed segments, which keep their (empty) cells.
- A snapshotter Worker: read the journal, write to an R2 binding,
  `recordSnapshot`, then `trim`.
- `transferLease(newToken, oldToken)` for operator-driven failover,
  authentication on the HTTP edge, and log listing.
- `tests/runtime_test.py` duplicates the toolchain's `LocalRuntime` helper;
  extract it into a shared Python library.
- The fleet tests start celld and chaos3 themselves; a Buck `LocalResourceInfo`
  fixture for a celld fleet would let several scenarios share one deployment.
