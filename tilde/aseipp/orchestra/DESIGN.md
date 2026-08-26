<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Orchestra control-plane design

Orchestra adapts a TAP-style milestone test architecture to celld. The
unit of intake is an immutable atomic monorepo revision, not a user-supplied
build DAG. Buck2 and tdutil already know that graph. Orchestra decides what
coverage is owed, dispatches coarse execution work, records observations, and
decides which additional observations would help explain failures.

This describes the version-4 prototype, which runs on fresh celld state; it
does not claim every production TAP feature, and it does not yet satisfy the
required change-bounded complexity. See [SCALING.md](SCALING.md) for the
replacement architecture and the explicit whole-catalog/history paths that
remain; full head inventories are not part of the planner contract. celld bugs
and platform quirks that matter here are catalogued in the
[celld toolchain notes](../../../buck/toolchains/celld/AGENTS.md).

## Ownership and boundaries

| Component | Authority and responsibility |
| --- | --- |
| `Repository` Durable Object | Revision intake/idempotency, predecessor order, serialized coverage frontier, cross-epoch test evidence. |
| `EpochWorkflow` | Durable reconciliation steps for planning, execution, deflaking, investigation, and publication. |
| `EpochLedger` Durable Object | One epoch's durable inputs, observations, fan-out/checkpoints, completion facts, and alarm-driven terminal publication. |
| `AgentBroker` Durable Object | Pull-agent job inventory, capability matching, leases, fencing, accepted result references, and notification outbox. |
| `EVENTS` Queue | At-least-once Workflow kickoff and result-receipt notifications. |
| Notification Worker / `Notifications` RPC | Creates Workflows, wakes waiting instances with `result` events, and records notification receipts through the API script's private entrypoint. |
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
to HTTP status codes and response bodies. In particular, a new reservation is
201, a duplicate is 200, an empty claim is 204, and a stale lease is 409. It
never forwards arbitrary method names. Internal expected
failures use a plain-data `RpcResult` union; custom Error subclasses are only
local control flow and are converted before transport. Unexpected errors
reject or become an explicitly retryable broker failure. Nullable ledger reads
mean genuine absence, not a storage outage; only absence permits the router's
repository-reservation fallback.

RPC is a transport boundary, not a transaction or delivery guarantee. Each
object keeps serialized read/check/write sections, explicit `storage.sync()`
acknowledgements, generation/lease fences, and durable outboxes. Slow
R2/D1/Queue I/O runs outside lease/snapshot critical sections; fencing is
checked again after artifact reads. Stable job IDs and idempotent operations
make replay safe; there is no blanket RPC retry wrapper. Method payloads are plain data, not stubs or capabilities that could
fail after crossing an isolate boundary. Workflows checkpoint activities,
Queues deliver notifications, and R2 owns evidence bytes.

celld's native DO dispatcher accepts callable instance members, including
`alarm`; it does not apply the service-entrypoint lifecycle visibility filter.
Implementation fields and methods therefore use JavaScript `#private`, not
erased TypeScript `private`. Types are not authorization, and this is a
trusted local prototype. The public HTTP router exposes no internal mutations
or alarm endpoints.

Tests check both sides of the boundary: invalid callers must fail typechecking,
and fake stubs copy arguments at invocation and replies on return. This prevents
shared-reference tests from masking mutations such as `save()` updating its
input generation. Native celld tests cover method dispatch and persistence;
Orchestra's full E2E drives the agent HTTP protocol through these RPCs and
restarts the server. Deploy matching Worker bundles together.

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
   waiting on `result` events while agents make progress. It cannot establish
   coverage ahead of the preceding epoch: inherited evidence and pending work
   must come from a settled frontier, not an arrival-order race.
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
recording authoritative state and publishing notifications. A result
notification wakes the waiting Workflow, which then reads the broker ledger;
the notification is a wake-up, not the evidence:

```text
persist state + pending notification
              |
              v
         send to Queue ----- transient error ----> durable alarm retry
              |
              +--> broker: clear result-notification outbox after acceptance
              |
              +--> consumer: create Workflow / wake it / record receipt --> ack
                                |
                                +--> repository alarm observes Workflow exists
                                              |
                                              v
                                      clear kickoff outbox

Workflow waitForEvent(result, <= 60s) --> read broker ledger --> reconcile evidence
```

A crash after send but before clearing an outbox can duplicate a notification.
A consumer crash can duplicate delivery. Neither should duplicate evidence,
complete a Workflow stage twice, or overwrite a newer lease. The broker clears
its result-notification outbox after Queue acceptance; the accepted result
itself remains in the ledger, and the Workflow's one-minute event timeout reads
it even if a notification is lost.
The repository's kickoff outbox has a stronger condition: it stays pending and
alarmed until the Workflow instance exists, not merely until Queue send succeeds.
Expired or dead-lettered kickoffs can therefore be republished. Alarms retry
pending initialization/publication; reconciliation reads durable facts instead
of making Queue messages the only completion record.

The consumer first reads the authoritative epoch ledger and validates the
notification identity. A terminal epoch only records the receipt: Workflow IDs
are not permanent deduplication records, since celld expires engine history
(30 days after completion by default). For live epochs, kickoff uses
`createBatch()`, and every delivery reads the instance's status to send a
`result` event when it is waiting; a running instance is already reconciling
and needs no wake. Repository recovery confirms existence with `get()`, which
already performs a status transaction in celld; a second `status()` call adds
no guarantee.

The public Workflow view separates `epoch_status` from `engine_history`.
Retained engine history preserves celld's actual status/output/error. An absent
record is `not_created` for a queued epoch and `unavailable` for a terminal
epoch; the latter has `status: null`, not an invented successful engine result.
Expiry and explicit deletion produce the same native error and cannot be
distinguished here. A missing active instance or any unrelated storage failure
remains an operational error. The exact missing-instance error is tested against
the real runtime, and fake-clock tests exercise expiry, deletion, and replay
without waiting 30 days.

After initialization and finalization, repository reservations discard their
copied coverage/catalog snapshots. The epoch ledger owns its historical snapshot;
the repository retains the current frontier rather than another full copy per
reserved epoch.

The configured consumer has bounded retries and a dead-letter queue. These
runtime mechanisms do not establish exactly-once delivery or replace durable
ledgers. Production monitoring/redrive tooling is not implemented; a test-sized
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
These are distinct facts, not conflicting test outcomes.

### Waiting, progress, and epoch budgets

Waiting is idle time, not failed work or test evidence. A waiting Workflow
suspends on `step.waitForEvent("wake-N", { type: "result" })` for at most a
minute, without consuming the separate 10,000-activity budget for immediate,
no-wait reconciliation passes. A result notification ends the wait at once;
a timeout is a durable reconciliation tick that covers a lost or dead-lettered
notification. Healthy long-running jobs can therefore keep renewing until the
epoch deadline. Unchanged reconciliations do not rewrite the
authoritative epoch snapshot. They do repair the D1 summary, since an earlier
projection may have failed after a successful ledger checkpoint.

The draining agent's default idle grace is one minute. A result wakes the
Workflow at once, so follow-up work usually appears within seconds and an
ordinary post-completion scheduling gap does not make the agent exit. Explicit
`--idle-grace` values are respected; very short values can intentionally
exit during fan-out.

The wall-clock deadline is `epoch.created_at + 24 hours`: time queued
behind the repository's predecessor counts, and neither a later agent claim nor
lease renewal resets it. An active epoch fails when reconciliation observes the
deadline, including at exact equality. Replaying an already terminal epoch
repairs its projection/publication rather than turning success into a
timeout. Event waits are capped by the remaining deadline; celld rejects event
timeouts under a second, so a subsecond remainder is a durable sleep instead.

The activity checkpoints its completion time and immutable deadline together
with its result. Scheduling derives only from those saved values and replayed
counters, never a new wall-clock read outside an activity. A checkpoint with
missing or malformed scheduling metadata, or a deadline that differs from an
earlier checkpoint's, fails the epoch closed. A separate total-activity safety
guard reserves room for 10,000 immediate passes plus a wake every second for a
full 24 hours (and a final deadline check). It bounds clock anomalies and event
storms without treating ordinary idle waiting as progress-budget exhaustion.

These are control-plane budgets, not a real-time execution watchdog. Activity
retries, a runtime outage, or resuming a previously checkpointed wait can delay
the next deadline observation. Epoch timeout does not guarantee termination of
every agent process or Buck remote action. Fenced broker completion and the
agent's independently renewed ownership window remain separate guarantees.

### Renewable agent ownership

Broker leases are generation-fenced. A completion identifies the job, agent,
and lease token. Expiry may permit another agent to execute the job, but a
stale holder cannot replace the accepted result. Repeating the same accepted
completion is idempotent; a different artifact is not silently accepted as the
same completion. There is no claim of exactly-once physical test execution.

`POST /v1/queues/QUEUE/renew` accepts `job_id`, `agent_id`, `lease_token`, and
`lease_ms` (the same 1-second to 5-minute duration range as claim). Under the
broker's serializer, only a matching, unexpired `leased` record can
renew. The new expiry is the later of the current expiry and `now + lease_ms`;
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

Unit tests exercise renewal, expiry, failure, and completion races. The real
celld/chaos3 E2E holds an agent's artifact upload beyond its initial lease
while observing accepted heartbeats, then verifies reclamation and stale-token
rejection for an abandoned claim.

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
outputs are not an artifact product.

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
  never implies deletion. Exact automatic retirement is unresolved;
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

## State versioning and next deployment work

Durable state and the agent protocol are version 4: every Durable Object
refuses persisted records and jobs of any other version. Deploy against fresh
celld state and use the matching agent; nothing migrates other versions' data
or outstanding leases. The E2E uses a
fresh private bucket and does not test a persisted-fleet migration.

This is a single-machine-capable control plane, not a hosted CI service.
Authentication, tenant isolation, cache coordination, retention,
operational redrive, schema migration, and production throughput/fairness remain
deployment work. Buck remote-only flags are a seam, not a completed RE service.
