<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Orchestra control-plane design

Orchestra adapts a TAP-style milestone test architecture to celld 0.5.1. The
unit of intake is an immutable atomic monorepo revision, not a user-supplied
build DAG. Buck2 and tdutil already know that graph. Orchestra decides what
coverage is owed, dispatches coarse execution work, records observations, and
decides which additional observations would help explain failures.

This describes the version-4 prototype, not a claim that earlier Orchestra
state can be migrated in place or that every production TAP feature exists.
It also does not satisfy the required change-bounded complexity yet. See
[SCALING.md](SCALING.md) for the replacement architecture and the explicit
whole-catalog/history paths that remain; full head inventories are not part of
the planner contract.

## Ownership and boundaries

| Component | Authority and responsibility |
| --- | --- |
| `Repository` Durable Object | Revision intake/idempotency, predecessor order, serialized coverage frontier, cross-epoch test evidence. |
| `EpochWorkflow` | Durable reconciliation steps for planning, execution, deflaking, investigation, and publication. |
| `EpochLedger` Durable Object | One epoch's durable inputs, observations, fan-out/checkpoints, completion facts, and alarm-driven terminal publication. |
| `AgentBroker` Durable Object | Pull-agent job inventory, capability matching, leases, fencing, accepted result references, and notification outbox. |
| `EVENTS` Queue | At-least-once Workflow kickoff and result-receipt notifications. |
| Notification Worker / `Notifications` RPC | Creates Workflows and records notification receipts through the API script's private entrypoint; default mode sends no Workflow events. |
| `ARTIFACTS` R2 bucket | Content-addressed immutable JSON plans/results; bytes verified independently of agent claims. |
| `HISTORY` D1 database | Cross-epoch read projection; never the source of lease or coverage authority. |
| Go agent | JJ source cache/workspaces, tdutil adapters, one coarse Buck invocation per batch, and durable result upload. |

One process can host the celld side locally, but agents are separate processes
using the HTTP protocol a later remote runner would use. Celld never shells
out to Buck and never manages a source checkout. The build graph, configured
actions, caches, and any remote execution remain Buck concerns.

The API and Queue consumer are separate scripts. Celld does not expose an
external pull consumer through its Queue binding, so agents pull from the
broker instead. Deploying the notification script first and API script last
keeps the API as the fleet's HTTP entrypoint.

### Typed internal RPC

The three Durable Object classes extend celld's `DurableObject` base and expose
native methods. `DurableObjectNamespace<Repository>`, `<EpochLedger>`, and
`<AgentBroker>` derive caller signatures directly from their implementations;
the notification consumer similarly uses `ServiceBinding<Notifications>`.
Only the reusable runtime projection types live in the celld toolchain. Domain
requests, receipts, epochs, and leases stay in Orchestra's TypeScript modules.

| Object | Internal methods |
| --- | --- |
| `Repository` | `submitEpoch`, `getState`, `finish` |
| `EpochLedger` | `initialize`, `getState`, `save`, `recordNotification`, `finalize` |
| `AgentBroker` | `enqueue`, `getJob`, `getState`, `claim`, `renew`, `complete`, `cancelEpoch` |

The public router validates JSON, invokes typed methods, and maps their results
back to the existing HTTP status codes and response bodies. In particular, a
new reservation is 201, a duplicate is 200, an empty claim is 204, and a stale
lease is 409. It never forwards arbitrary method names. Internal expected
failures use a plain-data `RpcResult` union; custom Error subclasses are only
local control flow and are converted before transport. Unexpected errors still
reject or become an explicitly retryable broker failure. Nullable ledger reads
mean genuine absence, not a storage outage; only absence permits the router's
repository-reservation fallback.

RPC is a transport boundary, not a transaction or delivery guarantee. Each
object retains serialized read/check/write sections, explicit `storage.sync()`
acknowledgements, generation/lease fences, and durable outboxes. Slow R2/D1/Queue
I/O runs outside lease/snapshot critical sections; fencing is checked again after
artifact reads. Stable job IDs
and idempotent operations remain necessary on replay; no blanket RPC retry
wrapper is added. Method payloads are plain data, not stubs or capabilities
that could fail after crossing an isolate boundary. Workflows still checkpoint
activities, Queues still deliver notifications, and R2 still owns evidence bytes.

celld 0.5.0's native DO dispatcher accepts callable instance members, including
`alarm`; it does not apply the service-entrypoint lifecycle visibility filter.
Implementation fields and methods therefore use JavaScript `#private`, not
erased TypeScript `private`. Types are not authorization, and this remains a
trusted local prototype. The public HTTP router exposes no internal mutations
or alarm endpoints.

Tests check both sides of the boundary: invalid callers must fail typechecking,
and fake stubs copy arguments at invocation and replies on return. This prevents
shared-reference tests from masking mutations such as `save()` updating its
input generation. Native celld tests cover method dispatch and persistence;
Orchestra's full E2E drives the unchanged agent HTTP protocol through these RPCs
and restarts the server. No persisted schema or agent-protocol version changes
are required by this transport refactor; deploy matching Worker bundles together.

## Play-by-play: from revision to completed epoch

```text
accept revision
    |
    v
wait for predecessor's coverage frontier
    |
    v
plan_epoch --> tdutil manifest in R2
    |
    v
select affected + pending coverage within budget
    |
    +---- untouched current passes ----> inherited coverage (not observations)
    |
    +---- outside budget --------------> deferred coverage (not green)
    |
    v
run_tests --> real Buck outcomes in R2
    |
    v
bounded deflaking / infra handling
    |
    +---- eligible persistent failure --> plan_culprit --> FACF probes
    |
    v
publish epoch facts + advance coverage frontier + project D1
```

1. A submitter supplies an immutable revision. `Repository` assigns an epoch
   sequence and records its predecessor. Resubmitting that revision returns
   the original epoch rather than creating duplicate work.
2. Queue kickoff creates the epoch's Workflow. It reconciles durable state,
   using adaptive durable sleeps while waiting for agent progress. It cannot
   establish coverage
   ahead of the preceding epoch: inherited evidence and pending work must come
   from a settled frontier, not an arrival-order race.
3. A deterministic `plan_epoch` job becomes available to an agent. The real
   planner compares the last completed milestone to this revision with tdutil. It
   returns stable target/platform identities and change provenance. The first
   epoch uses the configured initial base, `root()` by default. Control-plane
   failures do not advance this baseline; completed epochs with product-test
   failures still contribute their honest per-test evidence.
4. The agent encodes its result once and uploads those exact JSON bytes. R2
   returns a small content reference; the agent completes its broker lease with
   that reference. A plan is accepted only after validating the artifact and
   its revision endpoints.
5. Pure policy selects the deterministic union of affected and carried pending
   tests, bounded by the epoch budget. Selected tests are grouped by platform
   into coarse `run_tests` jobs. Buck owns parallelism inside each invocation.
   Deferred tests remain pending in the coverage ledger.
6. Jobs return genuine target-level `pass`, `fail`, or `infra_failure`
   observations. Missing/incomplete Buck result streams are infrastructure
   failures, not passes. The orchestrator, not the executor, decides whether
   another independent run is needed.
7. Deflaking distinguishes consistently passing, consistently failing, mixed
   pass/fail, and all-infrastructure cohorts. Mixed outcomes demonstrate an
   actual pass plus unreliable failure; transport retries do not create new
   observations. `deflake_runs` bounds total genuine milestone executions,
   including the initial run, and only triggers further runs when failures have
   no passing observation. `infra_retries` is a separate additional retry cap.
8. An eligible persistent failure with an unchanged test lineage and passing
   baseline can start a source-backed FACF investigation. Diagnosis is its own
   bounded set of jobs, not a relabeling of the initial failed test.
9. The final epoch records observations, inherited/deferred coverage, and
   investigation conclusions or explicit inability to conclude. Publication
   advances the repository frontier and maintains D1's query projection.
   Completion means orchestration settled, not that every test passed or that
   deferred coverage somehow became green.

## Durable reconciliation, not exactly-once delivery

A Workflow step is a durable checkpoint around reconciliation. Its name and
inputs identify the same logical operation on replay. Side effects such as
creating broker jobs have stable identifiers, so a retry observes existing
work rather than creating another logical invocation.

Queue delivery is at least once. Durable Object outboxes bridge the gap between
recording authoritative state and publishing notifications. Workflow progress
uses broker-ledger polling in the default compatibility mode, not Queue event
wake-ups:

```text
persist state + pending notification
              |
              v
         send to Queue ----- transient error ----> durable alarm retry
              |
              +--> broker: clear result-notification outbox after acceptance
              |
              +--> consumer: create Workflow / record result receipt --> ack
                                |
                                +--> repository alarm observes Workflow exists
                                              |
                                              v
                                      clear kickoff outbox

Workflow step.sleep(1..30s) --> read broker ledger --> reconcile evidence
```

A crash after send but before clearing an outbox can duplicate a notification.
A consumer crash can duplicate delivery. Neither should duplicate evidence,
complete a Workflow stage twice, or overwrite a newer lease. The broker clears
its result-notification outbox after Queue acceptance; the accepted result
itself remains available to Workflow polling even if a notification is lost.
The repository's kickoff outbox has a stronger condition: it stays pending and
alarmed until the Workflow instance exists, not merely until Queue send succeeds.
Expired or dead-lettered kickoffs can therefore be republished. Alarms retry
pending initialization/publication; reconciliation reads durable facts instead
of making Queue messages the only completion record.

The consumer first reads the authoritative epoch ledger and validates the
notification identity. A terminal epoch only records the receipt: Workflow IDs
are not permanent deduplication records, since celld expires engine history.
For live epochs, kickoff uses `createBatch()` and only experimental event mode
reads status or sends an event. Polling result receipts require no engine RPC.
Repository recovery confirms existence with `get()`, which already performs a
status transaction in celld; a second `status()` call adds no guarantee.

The public Workflow view separates `epoch_status` from `engine_history`.
Retained engine history preserves celld's actual status/output/error. An absent
record is `not_created` for a queued epoch and `unavailable` for a terminal
epoch; the latter has `status: null`, not an invented successful engine result.
Expiry and explicit deletion produce the same native error and cannot be
distinguished here. A missing active instance or any unrelated storage failure
remains an operational error. The exact missing-instance error is tested against
the pinned runtime, and fake-clock tests exercise expiry, deletion, and replay
in both polling and event modes without waiting 30 days.

After initialization and finalization, repository reservations discard their
copied coverage/catalog snapshots. The epoch ledger owns its historical snapshot;
the repository retains the current frontier rather than another full copy per
reserved epoch.

The configured consumer has bounded retries and a dead-letter queue. These
runtime mechanisms do not establish exactly-once delivery or replace durable
ledgers. Production monitoring/redrive tooling is still needed; a test-sized
deployment is not an operational delivery SLO.

### Terminal publication survives engine failure

A terminal ledger save arms an alarm first, then atomically stores the terminal
snapshot and a publication cursor. Terminal policy snapshots cannot be replaced;
notification counters remain independently writable. `EpochLedger.finalize()`
first installs a durable broker cancellation tombstone, fills any missing R2
report, then upserts the D1
summary and at most 32 test projections per call. Each successful batch advances
the durable cursor before the next batch starts. Only after all projections
succeed does it call the idempotent `Repository.finish()` and mark publication
done. Historical evidence is preserved; cancellation fences unfinished work,
not already accepted results.

Failure recording itself never waits for R2. A report-storage outage therefore
cannot prevent the terminal alarm obligation from being written. The finalizer
may fill a missing report reference but cannot replace terminal test evidence.
D1 upserts reject late nonterminal summaries: an activity that outlives its
Workflow timeout cannot turn a published terminal epoch back into `planning`.

The live Workflow helps drain these batches, but its finite retry budget is not
the only recovery mechanism. If D1 remains unavailable until the engine errors,
the ledger alarm retains the publication obligation and resumes after recovery,
without restarting the engine or resubmitting a revision. A crash after a D1
write or repository release may replay the corresponding idempotent operation.
The alarm stops only after completion is durably acknowledged. Publication uses
a separate serializer, so D1 waits do not block ledger reads, notifications, or
the `Repository.finish()` callback into the ledger.

The public epoch can therefore be terminal while D1 publication and successor
release are pending, and engine status can remain `errored` after alarm recovery.
These are distinct facts, not conflicting test outcomes. Existing pre-upgrade
terminal records are not automatically scanned to install new recovery alarms.

### Polling, progress, and epoch budgets

Polling is idle waiting, not failed work or test evidence. Its durable sleeps
back off through 1, 2, 4, 8, 16, and 30 seconds without consuming the separate
10,000-activity budget for immediate, no-wait reconciliation passes. The delay
resets after a domain-state change, such as collecting an observation or
advancing a stage. Ledger generation bumps, notification receipts, and agent
lease renewals do not count as that progress. This permits healthy long-running
jobs to keep renewing without a former roughly 2.8-hour idle-poll activity cap.
Unchanged polls no longer rewrite the authoritative epoch snapshot. They still
repair the D1 summary, since an earlier projection may have failed after a
successful ledger checkpoint.
After a long idle, an accepted result may take up to 30 seconds to reach its
next reconciliation, plus runtime overhead; the Queue still records its durable
receipt without waking a polling Workflow.

The draining agent's default idle grace is one minute, longer than the maximum
30-second polling interval, so an ordinary post-completion scheduling gap does
not make it exit before follow-up work appears. Explicit `--idle-grace` values
remain respected; very short values can intentionally exit during fan-out.

The wall-clock deadline remains `epoch.created_at + 24 hours`: time queued
behind the repository's predecessor counts, and neither a later agent claim nor
lease renewal resets it. An active epoch fails when reconciliation observes the
deadline, including at exact equality. Replaying an already terminal epoch
still repairs its projection/publication rather than turning success into a
timeout. Idle waits are capped by the remaining deadline; experimental event
waits also respect that cap, using a durable sleep for a subsecond remainder.

The activity checkpoints its completion time, immutable deadline, and semantic
progress together with its result. Scheduling derives only from those saved
values and replayed counters, never a new wall-clock read outside an activity.
Older checkpoints without scheduling metadata retain one-second waits until a
new activity supplies it; existing reconciliation and wait names are unchanged.
A separate total-activity safety guard reserves room for 10,000 immediate
passes plus a full 24 hours of minimum-duration polls (and a final deadline
check). It bounds clock anomalies and event storms without treating ordinary
idle waiting as progress-budget exhaustion.

These are control-plane budgets, not a real-time execution watchdog. Activity
retries, a runtime outage, or resuming a previously checkpointed wait can delay
the next deadline observation. Epoch timeout does not guarantee termination of
every agent process or Buck remote action. Fenced broker completion and the
agent's independently renewed ownership window remain separate guarantees.
This scheduling change does not fix celld's event-path locking issue or change
the default polling mode.

### Renewable agent ownership

Broker leases are generation-fenced. A completion identifies the job, agent,
and lease token. Expiry may permit another agent to execute the job, but a
stale holder cannot replace the accepted result. Repeating the same accepted
completion is idempotent; a different artifact is not silently accepted as the
same completion. There is no claim of exactly-once physical test execution.

`POST /v1/queues/QUEUE/renew` accepts `job_id`, `agent_id`, `lease_token`, and
`lease_ms` (the same 1-second to 5-minute duration range as claim). Under the
broker's existing serializer, only a matching, unexpired `leased` record can
renew. The new expiry is the later of the existing expiry and `now + lease_ms`;
the token and attempt count are unchanged. The updated record is durable before
the response returns its job/agent/token identity and `lease_until`. Expired,
foreign, superseded, or completed leases receive a conflict, never resurrection.

Terminal publication also installs a repository/epoch-scoped cancellation
tombstone. Pending work becomes unclaimable, active holders cannot renew or
complete, and delayed enqueues cannot resurrect canceled work. An exact retry of
an already accepted result remains idempotent. Broker diagnostics distinguish
`canceled` assignments from pending or completed work. Artifact validation and
notification sends do not hold the lease serializer: a slow completion cannot
prevent unrelated agents from renewing, and the current fence/deadline is
re-read immediately before acceptance.

The agent renews during planning, execution, and artifact upload. A separate
watchdog bounds ownership with the agent's local monotonic clock: each confirmed
window begins at the corresponding HTTP request's start, not its response time
or a comparison between machines' wall clocks. A delayed acknowledgement cannot
grant extra execution time. Transient transport/server failures can be retried
only inside the already-confirmed window; a fencing conflict or invalid response
cancels ownership immediately. Once ownership is lost, no job-error artifact or
completion is deliberately published for that attempt.

Renewal and completion are coordinated so an accepted completion cannot be
followed by a heartbeat conflict mistaken for job failure. Completion itself
must fit the remaining confirmed window. A timeout can leave its acknowledgement
ambiguous, but the broker's accepted result and idempotency rules remain final.
An orphaned R2 upload is possible; artifact garbage collection is a separate
concern. Cancellation stops the local execution context, not a shared Buck
daemon, and is not a guarantee that every remote action has stopped.

The protocol is an additive extension of existing version-4 lease records; it
does not change their persisted schema or fence identity. New agents require
the matching server route and claim metadata. Unit tests exercise renewal,
expiry, failure, and completion races. The real celld/chaos3 E2E holds an agent's
artifact upload beyond its initial lease while observing accepted heartbeats,
then verifies reclamation and stale-token rejection for an abandoned claim.

## celld 0.4.0/0.4.1 event-path workaround

The expanded celld 0.4.0-backed FACF E2E reproduced `storage.put: database is locked`
when the Workflow consumed result events. The default Worker string binding
became `WORKFLOW_WAKE_MODE="poll"`: pending activities suspended with
`step.sleep(..., "1 second")` and reconciled the broker ledger again. The current
polling schedule is adaptive, as described above. The Queue
consumer still performs actual kickoff and result-receipt RPCs, but does not
call `sendEvent` in this mode. This is durable Workflow polling, not a busy
JavaScript timer loop or a return to Durable Object scheduling.

The celld 0.4.1 source contained the cursor-lifetime concern found in 0.4.0:

- [`crates/celld/js/harness.js`: `SyncKvListIterator`](https://github.com/denoland/celld/blob/v0.4.1/crates/celld/js/harness.js#L1512)
  implements `next()` but no iterator `return()` cleanup.
- [The same harness's `waitForEvent` consumption loop](https://github.com/denoland/celld/blob/v0.4.1/crates/celld/js/harness.js#L8635)
  returns early after taking a matching entry from `transaction.kv.list()`.
- [`crates/celld/storage.rs`: synchronous list cursors](https://github.com/denoland/celld/blob/v0.4.1/crates/celld/storage.rs#L3684)
  retain the prepared SQLite statement until cursor cleanup; exhaustion removes
  it and dropping the cursor finalizes the statement.
- [Transaction completion](https://github.com/denoland/celld/blob/v0.4.1/crates/celld/storage.rs#L3082)
  also does not close those cursors on commit or rollback.

The early-return path therefore does not exhaust or explicitly close that
iterator. A retained read cursor and an apparent stale snapshot interacting
with a separate checkpoint writer are a plausible explanation for the observed
locking, but the complete checkpoint-interaction mechanism has not been proven
by this review. It remains a working hypothesis, not a confirmed upstream diagnosis.

The 2026-09-06 release check retained this workaround and upgraded the shared
toolchain to 0.4.1. All 45 non-E2E Orchestra test results and all four toolchain
tests passed. However, both the default polling E2E and a temporary event-mode
E2E timed out reading the first epoch after the planning agent completed, before
the restart checkpoint. Neither run reported `database is locked`. A control
run using the same harness, Worker artifacts, and chaos3 server with the 0.4.0
binary passed the complete polling/restart/FACF E2E. This is a version-dependent
compatibility failure requiring separate diagnosis, not proof of the old
SQLite-lock mechanism. The 0.4.1 pin was retained at that time, without disabling
the test or claiming a passing local flow.

Subsequent reduction isolated a cross-request native-operation lifetime bug,
now covered by the [toolchain runtime regression](../../../buck/toolchains/celld/tests/BUILD):
the promise-tail serializer can start the next request's native operation in
the finishing request's microtask checkpoint, so celld adopts and then discards
it with the wrong request. One object and two 100 ms timers reproduce the
failure, including on 0.4.0 and with output gating disabled, matching the
Orchestra `storage.sync()` stall. This is separate from the event-cursor issue above.

### celld 0.5.0 revalidation (2026-09-15)

The shared toolchain now pins the unmodified official 0.5.0 release. The
unchanged promise-tail program returns both responses in approximately 270 ms;
the same runner against 0.4.1 still times out. Source inspection confirms the
new native-operation owner IDs, continuation attribution, and `adopt()` handoff
back to the originating event. The minimal regression is part of `:tests`.

The full local E2E now passes in the default polling mode. It exercises a
hard restart at a durable Workflow wait, external-agent resumption, Queue
receipts, R2 artifacts, D1 history, coverage inheritance, deflaking, and FACF.
The new `:e2e-events-test` uses the exact same harness and assertions as
`:e2e-test`, changing only the packaged `WORKFLOW_WAKE_MODE` binding.

The first event-mode run passed (build `b7fe32ad-697f-4767-a002-e7fe588d0d23`),
but the combined suite (build `81979c2a-7567-4a3d-a745-ece9f85545a9`) passed
158 checks and failed the event diagnostic. After restart recovery, R2/history
checks, and successful FACF attribution, `wait for history Workflow completion`
received HTTP 503 with `storage.transaction: database is locked`.
A standalone repeat (build `f8b7d5df-4467-4035-bb8b-e107c512bc2e`)
failed at the same assertion with the same error, without the rest of the suite.
`Workflow.get()` and `status()` each call `__wfStatus()`, which enters
`transactionSync()`; even a status read can start `BEGIN IMMEDIATE` because it
may expire retained instances. The error prefix covers both pending-write
flush and transaction control, so it does not identify the precise failing
SQLite operation. The early-return KV cursor pattern described above remains
in the source, but these logs do not prove it caused this particular lock.

Polling remains the deployment default and part of `:tests`. Events remain
experimental; `:e2e-events-test` is an explicit diagnostic outside that suite.
Its storage errors are not suppressed or retried into a passing result. No upstream
celld files or pinned binaries are modified, and no artificial `waitUntil`
lifetime extension has been added to Orchestra's serializer.

After the lifecycle cleanup removed unnecessary notification status calls, the
same event diagnostic passed again (build `95a01e2a-22a4-4db4-9e15-faa8a29ed27e`).
That single run does not establish a fix for the intermittent native lock; the
runtime and default polling policy are unchanged.

Upgrading a persistent 0.4.1 fleet is a stopped-fleet operation because 0.5.0
changes alarm-discovery storage. Preserve both the bucket and node data;
follow the [toolchain upgrade notes](../../../buck/toolchains/celld/README.md#upgrading-from-041).
The E2Es use fresh private buckets and do not claim to test a persisted-fleet
migration. Workflow's default 30-day terminal retention is independent of
Orchestra's epoch, D1, and R2 record lifetimes.

### celld 0.5.1 revalidation (2026-09-20)

The toolchain pins the unmodified official 0.5.1 binaries and release-asset
SHA-256 checksums for all three supported host platforms. The local celld
checkout still declared 0.5.0 during this check, so source verification used
the published `v0.5.1` tag instead of assuming the checkout matched the release.

The unchanged `:e2e-events-test` reproduced the lock twice:

- Build `02651eb8-340b-4e1a-af14-da6debaca320`: failed after 39.1 seconds.
- Standalone repeat `452205f2-0e20-455f-8d95-f35761cb2055`: failed after
  41.5 seconds, without the toolchain runtime tests running alongside it.

Both completed restart recovery, Queue/R2/D1 checks, and successful FACF
attribution before `wait for history Workflow completion` failed with HTTP
503 and `storage.transaction: database is locked`. The runner preserves each
failure's node data and logs; these runs used
`/tmp/orchestra-celld-e2e-3201977428` and
`/tmp/orchestra-celld-e2e-1588153862`. The diagnostic fails on the error rather
than retrying it into success:

```console
buck2 test tilde//aseipp/orchestra:e2e-events-test
```

The tagged source retains the same concrete cursor-lifetime concern:

- [`SyncKvListIterator`](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/js/harness.js#L1482)
  has `next()` but no iterator `return()` cleanup.
- [`waitForEvent` consumption](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/js/harness.js#L9663)
  returns early from the synchronous KV iterator after consuming an event.
- [`__wfStatus`](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/js/harness.js#L9785)
  still enters a storage transaction even for status reads.
- [`transaction_control`](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/storage.rs#L3465)
  uses `BEGIN IMMEDIATE` and does not close synchronous list cursors at commit
  or rollback; [iteration](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/storage.rs#L4154)
  removes them on exhaustion or error.

These source facts support the existing cursor-lifetime hypothesis; the two
black-box failures establish that the event-path symptom remains, not that the
complete SQLite/checkpoint causal chain has been proven. The independent
promise-tail, native-RPC, and Workflow-lifecycle runtime tests pass on 0.5.1.
The default polling E2E also passes in 46.5 seconds; build
`dca1a77a-d5ea-4857-8389-5e212946676d` passes all 78 selected Orchestra and
deployment checks with no failures.
A separate minimal `celld dev` experiment completed four event-then-sleep
Workflows and four sleep-only controls with repeated status reads; it did not
reproduce the fleet E2E failure and was not added as a purported regression.
Keep polling as the default, and keep event mode an explicit diagnostic outside
`:tests`. No upstream source/binary is patched and no application workaround is
removed.

## R2 artifact boundary

The agent uploads JSON to the API's artifact endpoint. The server hashes the
exact body bytes with SHA-256 and stores them at `sha256/<digest>.json` in
`ARTIFACTS`. The returned reference carries the key, digest, and byte size.
The agent verifies all three against the payload it actually sent.

The lease completion carries `result_ref`, not a large inline manifest or test
result. Consumers verify reference shape, byte length, digest, JSON structure,
and operation-specific identities before interpreting an artifact. Whitespace
and key ordering are part of the hash: equal parsed objects with different
encodings are different artifacts. This outer integrity check is separate from
the normalized tdutil manifest's own semantic digest.

R2 provides the bulk-data boundary; it does not make JSON trusted or replace
protocol validation. Limits bound artifact size and accepted result shape.
Unreferenced uploads can remain after failed/stale jobs; retention and garbage
collection are not implemented. Raw Buck logs and arbitrary binary build
outputs are not yet an artifact product.

## Coverage and observation semantics

Each stable target/platform identity tracks a passing baseline, latest observed
revision, pending coverage, and real pass/fail counts for the current lineage.
A test can retain an old passing baseline while currently failing; that
baseline is useful for diagnosis but is not current green coverage.

- An affected/new test invalidates prior coverage before selection. A test
  definition change also invalidates its prior baseline and counters.
- Deferred or infra-blocked work is eligible at later epochs. Deterministic key
  ordering keeps selection reproducible, but is not a production fairness
  policy for an endlessly growing backlog.
- Inherited green requires an untouched, non-pending record whose
  `last_revision` equals its non-null `last_pass`. It adds no observations.
- tdutil returns affected targets, not a head inventory. Absence from that list
  never implies deletion. Exact automatic retirement is currently unresolved;
  it requires bounded positive removal/membership evidence, as described in
  [the change-bounded design](SCALING.md#deletion-needs-positive-evidence).
- A genuine pass establishes a baseline at that revision, including a mixed
  cohort. Only failures retain an earlier baseline without making the current
  revision green. Empty/all-infra cohorts remain pending.
- Noise estimation uses a Beta(1,99) prior clamped to `[0.01, 0.5]`. It measures
  observed failure frequency, not proven intrinsic flakiness. FACF freezes the
  pre-investigation estimate instead of changing its assumptions in response
  to the failures it is trying to explain.

The policy is pure TypeScript in `src/util/policy.ts`. The durable caller owns
invalidation, serialization, deduplication, and persistence; a selection plan
alone does not update the repository frontier.

## FACF and the paper

The architecture is inspired by Henderson et al.,
["Flake Aware Culprit Finding"](https://storage.googleapis.com/gweb-research2023-media/pubtools/6969.pdf):
milestones summarize a sampled revision stream, while extra test runs help
separate flaky failures from regressions. A milestone is not necessarily one
source commit. An investigation must consider commits between passing and
failing milestones, not merely bisect epoch IDs.

The pure TypeScript engine is ported from this repository's Rust FACF library
at JJ revision `zrqw`, commit `f28b0530f45979e1eed4be25c9a694fef98cbcbf`, in
`src/qq/qq-cli/commands/hunt/facf/{distribution,search,tests}.rs`. The public
module is `src/facf/index.ts`. It preserves the Rust Bayes updates, Equation 13
weighting heuristic, prefer-prior selection, inclusive confidence threshold,
and last-index tie-breaking. This is a port of that implementation, not a
claim to reproduce all Google TAP behavior.

Intentional differences are documented in code: camelCase APIs, validated
finite inputs, defensive snapshots, observable zero-likelihood evidence, and
log-space updates that retain tiny hypotheses after long failure streaks.
Tests reproduce the Rust scenarios and add replay, malformed-input, and
numerical-underflow regressions.

The model has one hypothesis per ordered suspect plus a final no-culprit
hypothesis. A PASS rules out a deterministic regression at or before that test
position. A FAIL is weaker evidence because it might be a random false failure.
The configured flake rate stays fixed throughout an investigation.

The real `plan_culprit` agent adapter:

1. Resolves passing and failing endpoints to full immutable JJ commit IDs.
2. Enumerates a complete oldest-first, single-parent interval, excluding the
   base and including the failing head. It caps this at 128 commits and rejects
   merges, ambiguous ancestry, malformed histories, and larger ranges rather
   than silently omitting suspects.
3. Runs tdutil on each adjacent pair under one overall planning timeout. It
   records changes affecting this test and changes to the test itself. Test
   definition changes invalidate the unchanged-lineage assumption.
4. Returns a versioned artifact so the Workflow can map FACF positions to actual
   commits and dispatch real `run_tests` jobs at those revisions.

Only independent actual pass/fail observations update the posterior.
Infrastructure errors, skipped/missing results, inherited coverage, and duplicate
completion deliveries are not evidence. Zero-likelihood evidence signals model
mismatch. Missing baselines, changed lineage, unavailable source ranges,
exhausted budgets, or unusable evidence can leave diagnosis inconclusive.
The real adapter also bypasses test-result caching for independent reruns and
requires local execution for them. Reusing a cached failure would not be a new
observation; remote action deduplication must be addressed before enabling
remote-only deflaking or diagnostic probes.

The model assumes independent random false failures before one deterministic
regression and no false passes at/after it. It does not model correlated
outages, multiple regressions/fixes in one interval, or arbitrary intermittent
regressions. Confidence is conditional on those assumptions, not a guarantee
that blaming a commit is correct.

## Compatibility and next deployment work

Durable state and the agent protocol are version 4. Deploy against fresh celld
state and use the matching agent; old data and outstanding leases are not
automatically migrated. New bindings do not retroactively change old records.

This is a single-machine-capable control plane, not a hosted CI service.
Authentication, tenant isolation, cache coordination, retention,
operational redrive, schema migration, and production throughput/fairness remain
deployment work. Buck remote-only flags are a seam, not a completed RE service.
