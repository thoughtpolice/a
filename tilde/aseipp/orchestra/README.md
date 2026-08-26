<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Orchestra

Orchestra is a TAP-inspired test control plane for an atomic-commit monorepo,
built on celld 0.5.1. Buck2 owns target determination, the build graph, caching,
and execution. Orchestra owns revision milestones, coverage, bounded test
selection, deflaking, and flake-aware culprit investigations.

The control plane uses Workflows for durable orchestration, Queues for
asynchronous notifications, R2 for content-addressed result artifacts, Durable
Objects for authoritative ledgers and fenced agent leases, and D1 for queryable
history. External Go agents run the repository's real JJ, tdutil, and Buck2
adapters. Fake backends remain available for a wholly local demonstration and
hermetic tests.

This is a breaking prototype redesign: persisted state and the job protocol
are version 4. Use a fresh celld fleet/bucket for this version. There is no
claimed migration of earlier Orchestra state or its in-flight jobs, and old
agents must not run against the new control plane.

Upgrading an existing celld 0.4.1 fleet to 0.5.0 requires stopping **every node**
first; it is not a rolling upgrade. The local commands below use a fresh bucket
and working directory. Do not upgrade a running shared fleet with these commands.

## Architecture

```text
submitter / CLI                  external Orchestra agent
      |                                  |
      | immutable revision               | claim / upload / fenced complete
      v                                  v
+------------------------- celld fleet ---------------------------+
| Orchestra HTTP Worker                                         |
|   |                                                           |
|   +--> Repository DO: revision order and coverage frontier      |
|   |         |                                                 |
|   |         v                                                 |
|   |    EpochWorkflow: adaptive durable reconciliation polling   |
|   |         |                                                 |
|   |         v                                                 |
|   |    EpochLedger DO <------> AgentBroker DO ---- outbox       |
|   |         |                       |                         |
|   +-------> R2 ARTIFACTS             +---- leased Buck jobs     |
|             |                                                 |
|             +---- verified immutable result references         |
|                                                               |
| EVENTS Queue --> notification Worker --> kickoff/receipt RPC   |
|                                                               |
| D1 HISTORY: query projection, not scheduler authority          |
+---------------------------------------------------------------+
```

The server does not own a checkout or launch Buck. Its Workflow coordinates
coarse operations and durable checkpoints; it does not reconstruct Buck's
action graph. Agents are HTTP pull clients with explicit job-kind and platform
capabilities. Celld Queues have no external pull-consumer API, so `AgentBroker`
is still needed for the agent-facing lease protocol. The Queue carries small
control-plane notifications, not the build graph or a second agent job queue.
Queue deliveries create the Workflow and record result-notification receipts.
By default, the Workflow uses adaptive durable sleeps to poll authoritative
broker state: idle waits grow from 1 to 30 seconds and reset after progress.
Result notifications do not wake it directly.
This compatibility workaround avoids a reproduced Workflow event-path lock.

Inside celld, the router, Workflow activities, and notification entrypoint use
native typed RPC to `Repository`, `EpochLedger`, and `AgentBroker`. Method
arguments and results are inferred from those object classes; there are no
internal HTTP paths or caller-selected JSON result casts. The external Go-agent
HTTP/JSON protocol is unchanged. RPC does not replace durable Queue delivery,
lease fencing, or explicit storage acknowledgements.

Per-repository epochs advance a serialized coverage frontier. A later accepted
revision cannot publish a coverage snapshot before its predecessor has settled.
Unchanged, currently passing tests can inherit coverage; affected tests and
previously deferred work require execution. Deferred work is reported as such,
not silently counted as green. Failing tests receive bounded deflaking, and
eligible persistent failures enter a FACF investigation over actual source
commits between passing and failing milestones.

See [DESIGN.md](DESIGN.md) for the step-by-step dataflow, ownership boundaries,
retry invariants, and relationship to the original paper.

## Build and test

```sh
buck2 build tilde//aseipp/orchestra:orchestra \
  tilde//aseipp/orchestra:worker-project \
  tilde//aseipp/orchestra:queue-consumer-project
buck2 test tilde//aseipp/orchestra:tests
```

The suite includes pure FACF/policy tests, Worker integration tests, Go adapter
and protocol tests, shared celld declaration/runtime contracts (including the
promise-tail regression, native RPC, and short-retention Workflow checks), and the real
celld/chaos3 polling E2E. Fake-runtime lifecycle scenarios explicitly cover both
wake modes; their default is polling, matching deployment. A separate event-mode
diagnostic reproduces an intermittent upstream lock and is not in `:tests`. The shared
[chaos3 local-resource rule](../../../src/chaos3/defs.bzl) provisions the
E2E's ephemeral server through Buck's `LocalResourceInfo` and injects its endpoint
and credentials. The test owns a unique bucket, deploys
both Workers, and checks the real client/server/storage boundary; no manually
started S3 server is required.

```sh
buck2 test tilde//aseipp/orchestra:e2e-test
# Opt-in diagnostic: still reproduces a celld 0.5.1 SQLite lock.
buck2 test tilde//aseipp/orchestra:e2e-events-test
buck2 test toolchains//celld/tests:runtime-test
```

The shared [celld toolchain](../../../buck/toolchains/celld/README.md) pins
celld 0.5.1 and exposes the runtime through `:celld`. Its `celld.worker` rule
type-checks and bundles each TypeScript entrypoint, and `:worker-test` is a
`celld.test` with `fake_runtime = True`, which maps `cloudflare:workers` to the
toolchain's constructor fakes. Buck creates deployment metadata through
`celld.project`; there is no Wrangler CLI, npm project, or separately installed
esbuild. The shared [celld.d.ts](../../../buck/toolchains/celld/types/celld.d.ts)
contains runtime primitives, while domain types remain in Orchestra's source
modules. Compile-time RPC tests reject misspelled methods, wrong arguments, and
unchecked nullable reads; fake object stubs clone arguments and replies like the
native transport. The E2E exercises RPC through the unchanged public API across
server restart, lease renewal/reclamation, and FACF completion.

The real tdutil adapter was also smoke-tested against adjacent committed
repository revisions `557513be6f8d…` → `41cc1e207434…`, with no working-copy
changes. It resolved both endpoints exactly and returned a v2 manifest selecting
the actual Orchestra `e2e-test`, `orchestra-test`, and `worker-test` targets.
That checks real planning, not execution of those historical targets.

## celld 0.5.1 Workflow compatibility

The 2026-09-20 release check upgrades the toolchain to official 0.5.1 binaries.
The unchanged event-mode E2E still fails after restart recovery and FACF
attribution: a Workflow status read returns HTTP 503,
`storage.transaction: database is locked`. Polling remains the deployment
default. The separate promise-tail runtime regression passes. See the
[0.5.1 evidence and tagged-source review](DESIGN.md#celld-051-revalidation-2026-09-20).
The complete default polling flow and all 78 selected Orchestra/deployment
checks pass on 0.5.1; the event diagnostic failed both in a combined run and
when repeated on its own.

The 2026-09-15 upgrade check passes the complete local flow on the official
0.5.0 release in the default **polling** mode: planning, a hard restart at
a durable Workflow wait, resumed agent execution, result/Queue reconciliation,
R2 evidence verification, D1 history, coverage inheritance, deflaking, and FACF.
The polling E2E remains enabled in `:tests`; no test uses a patched celld binary.

The deployed `WORKFLOW_WAKE_MODE` Worker binding defaults to `"poll"`.
Workflows suspend through `step.sleep()` with adaptive 1-to-30-second waits,
then reconcile persisted job results. Queues still supply real kickoff and
result-receipt delivery through the private `Notifications` entrypoint; no default
`sendEvent`/`waitForEvent` path is used.

An expanded celld 0.4.0-backed FACF E2E previously reproduced `storage.put: database is locked`
when using Workflow events. Source inspection of both 0.4.0 and 0.4.1 found an
early return from `transaction.kv.list()` in event consumption and a synchronous
list iterator without `return()` cleanup. The cursor lifetime is a concrete source concern;
the exact interaction with separate checkpoint writes is still an inference,
not a fully established explanation of every observed lock. See
[the source-backed compatibility note](DESIGN.md#celld-040041-event-path-workaround).

`WORKFLOW_WAKE_MODE="events"` is exposed by `:worker-project-events` and the
explicit `:e2e-events-test` diagnostic. Its first 0.5.0 run passed, but a repeat
in the combined suite failed after FACF attribution while reading Workflow
status: HTTP 503, `storage.transaction: database is locked`. The early-return
cursor pattern still appears in the source; the exact cause of this lock is
not established. Event mode remains experimental and its diagnostic is excluded
from `:tests`, without retries that hide the error. `:deploy` retains polling.
See the [revalidation evidence](DESIGN.md#celld-050-revalidation-2026-09-15).
Orchestra does not patch celld's source.

The 2026-09-06 upgrade check found an additional compatibility failure: the
0.4.1 E2E times out reading the first epoch after planning, before the restart
checkpoint, in both polling and event modes. The same polling-mode harness and
Worker artifacts pass the full E2E on 0.4.0. Neither 0.4.1 run logged the earlier
SQLite lock error, so those timeouts did not establish that same cause. The
0.4.1 E2E remained enabled and failing until this upgrade.

That timeout was reduced to a [toolchain runtime regression](../../../buck/toolchains/celld/tests/BUILD):
one Durable Object and two timers, with no Workflow or application storage
calls. It also fails on 0.4.0. The **unchanged** program passes on 0.5.0 in about
270 ms; the same runner still times out on 0.4.1. The 0.5.0 source carries
native-operation owner IDs through cross-request continuations instead of
discarding the next request's work with its predecessor. The generic regression
now lives in the toolchain rather than an application repro directory.
Orchestra keeps its original promise-tail serializer: no arbitrary
`waitUntil` keepalive or application workaround is necessary.

Terminal publication now has its own durable ledger alarm and checkpointed D1
batches. A D1 outage that exhausts Workflow retries no longer permanently blocks
the next epoch: the alarm resumes publication after recovery. Terminal epochs
also fence outstanding broker work, preventing late claims, renewals, and new
results while preserving retries of already accepted evidence. Slow artifact
reads and Queue sends no longer block unrelated lease renewals.

Completed Workflow instances now expire after 30 days by default. This is
engine history retention, not deletion of Orchestra's epoch ledgers, D1 history,
or R2 artifacts. The control plane uses `createBatch()` to skip retained IDs,
and checks authoritative epoch state before creating anything: even after
engine expiry/deletion, an old terminal kickoff only records its receipt.
Polling-mode result receipts do not read Workflow status. Repository recovery
uses `get()` alone to verify creation; celld already checks existence there.

`GET /v1/repos/REPO/epochs/EPOCH/workflow` reports the independent
`epoch_status` and `workflow_id` alongside engine history:

| `engine_history` | `status` | Meaning |
| --- | --- | --- |
| `available` | Actual celld status | Retained engine history, with its actual output/error. |
| `not_created` | `queued` | A queued epoch has no engine record yet; kickoff recovery remains active. |
| `unavailable` | `null` | A terminal epoch's engine record is absent; expiry and deletion cannot be distinguished. |

Missing history does not fabricate a successful engine outcome or delete test
evidence. A missing engine for an active epoch, SQLite locks, and other runtime
failures still return 503. The queued fallback only handles celld's exact
missing-instance error; it no longer hides unrelated storage failures.

## Run the wholly local flow

Everything below can run on one machine: chaos3, celld, the external agent, JJ,
tdutil, and Buck. Bind these unauthenticated prototype services to loopback.

In terminal 1, create a fresh in-memory fleet bucket:

```sh
buck2 run root//src/chaos3:chaos3 -- \
  --listen 127.0.0.1:9000 \
  --bucket orchestra-v4-dev
```

In terminal 2, deploy and start celld:

```sh
export AWS_ACCESS_KEY_ID=chaos3
export AWS_SECRET_ACCESS_KEY=chaos3
export CELLD_WATCH="$(mktemp -d /tmp/orchestra-v4-node.XXXXXX)"

buck2 run tilde//aseipp/orchestra:deploy -- \
  --bucket s3://orchestra-v4-dev \
  --endpoint http://127.0.0.1:9000 \
  --region us-east-1

buck2 run tilde//aseipp/orchestra:serve -- \
  --bucket s3://orchestra-v4-dev \
  --endpoint http://127.0.0.1:9000 \
  --region us-east-1 \
  --listen 127.0.0.1:8080
```

`:deploy` deliberately deploys the notification consumer first and the
Orchestra API second. Each celld deployment changes the fleet's primary HTTP
script, so deploying the API last preserves the public router while celld
cohosts its Queue consumer. Do not deploy only `worker-project` or reverse
this order. The rule forwards the supplied celld flags to both deployments.
`CELLD_WATCH` gives this run a fresh local celld working directory as well as
the fresh fleet bucket; do not point it at the earlier prototype's state.

In terminal 3, exercise the real control plane with fake planning/execution:

```sh
buck2 run tilde//aseipp/orchestra:orchestra -- \
  demo --repo demo --revision fake-0001 --retry-completions

buck2 run tilde//aseipp/orchestra:orchestra -- \
  show --repo demo --epoch e000001

buck2 run tilde//aseipp/orchestra:orchestra -- queue
curl http://127.0.0.1:8080/v1/repos/demo/history
```

`demo` submits the same revision twice to exercise intake idempotency, runs an
agent, and waits for that epoch's terminal state. `--retry-completions` repeats
artifact uploads and fenced completion calls. Fake execution outcomes are
deterministic fixtures, not proof of the real repository's test health.

Stopping chaos3 discards deployments, durable state, and R2 artifacts stored in
that fleet. See [chaos3's documentation](../../../src/chaos3/README.md) for its scope and
S3 compatibility. For persistence, use a supported durable celld fleet storage
backend instead. Celld's readiness path is `/.well-known/celld/health`.

## Per-epoch policy

The HTTP intake accepts a `policy` object alongside `revision` and `queue`.
Policy is saved with the epoch so retries/replays use the same settings:

| Field | Default | Meaning |
| --- | --- | --- |
| `max_tests` | 10000 | Maximum selected test identities; the remainder stays deferred. |
| `deflake_runs` | 2 | Total genuine milestone executions, including the initial run, when failures have no passing observation. |
| `infra_retries` | 1 | Additional infrastructure retries, counted separately from deflaking. |
| `culprit_runs` | 12 | Additional diagnostic test-execution budget per investigation. |
| `confidence` | 0.9 | FACF posterior threshold; conditional on its noise assumptions. |

For example, submit a budgeted milestone directly:

```sh
curl -X POST http://127.0.0.1:8080/v1/repos/local-repo/epochs \
  -H 'Content-Type: application/json' \
  -d '{"revision":"HEAD_COMMIT","queue":"default","policy":{"max_tests":32,"deflake_runs":3,"infra_retries":1,"culprit_runs":12,"confidence":0.95}}'
```

Replace `HEAD_COMMIT` with an immutable source commit for the real agent. A
completed epoch can contain failures, infra-blocked tests, or deferred coverage;
inspect those fields and findings rather than interpreting completion as green.

## Use this repository's JJ, tdutil, and Buck2

`:tdutil-plan` inspects a real revision interval without involving celld:

```sh
buck2 run tilde//aseipp/orchestra:tdutil-plan -- \
  --base BASE_COMMIT \
  --revision HEAD_COMMIT
```

The supplied target scopes determination to
`depot-tilde//aseipp/orchestra/...`. Other deployments can instantiate the same
rule with a broader monorepo universe. The adapter invokes
`tdutil --format json --ignore-working-copy`, verifies immutable endpoint
resolutions, identifies Buck test rules, and retains selection depth, reason,
and direct-change provenance. Test keys identify target/platform pairs across
epochs; direct test changes reset their evidence lineage.

The adapter consumes only affected targets; it never requires or carries a head
inventory. Empty selections serialize as `[]`. Absence from an affected list
does not prove deletion, so automatic target retirement is not currently
implemented. It needs explicit removal evidence or bounded point validation,
not a repository-wide catalog diff. See [the change-bounded redesign](SCALING.md)
for that contract and the remaining whole-catalog/history costs in the prototype.

The first epoch has no predecessor, so the real planner compares `root()` to
the submitted revision by default. `--initial-base` can override that initial
planning policy. Subsequent epochs use the last successfully completed milestone
as their comparison frontier; a control-plane-failed epoch does not advance it.
For source-backed operation, submit full immutable commit IDs resolvable in
the agent's repository, not moving bookmarks or uncommitted working-copy state.

Use `:tdutil-agent` for real planning with fake test execution, or
`:local-agent` for both real adapters:

```sh
buck2 run tilde//aseipp/orchestra:orchestra -- \
  seed --repo local-repo --revision HEAD_COMMIT

buck2 run tilde//aseipp/orchestra:local-agent -- \
  --queue default --agent local-buck \
  --source-url /path/to/monorepo \
  --source-cache /tmp/orchestra-source-cache
```

Replace the source path with this repository's local path or its remote URL.
Choose a dedicated cache directory, not your development checkout. The first
agent invocation clones using JJ; subsequent invocations fetch and reuse the
warm clone. The anchor working copy is never moved to execute a job:

```text
source remote/path
        |
        | JJ clone once, fetch on later agent starts
        v
source-cache/repository       stable anchor + reusable repository objects
        |
        +--> temporary head workspace --> tdutil + temporary base workspace
        |
        +--> temporary revision workspace --> buck2 test @targets
        |
        +--> linear culprit interval --> adjacent-commit tdutil comparisons
```

Temporary workspaces are forgotten/removed after use; the source cache remains.
The same `--source-url`, `--source-cache`, `--source-remote`, and
`--source-timeout` flags work on the standalone `plan` and `execute` commands.

Agent leases renew automatically while planning, executing, and uploading R2
evidence. `--lease` is a renewable ownership window (1 second to 5 minutes),
not the job's execution timeout. The CLI defaults to 5 minutes. For example,
`--lease 30s --planner-timeout 10m --buck-timeout 30m` allows bounded work to
outlive its initial lease while the agent remains in contact with the broker.
Idle polling does not consume the epoch's separate immediate-reconciliation
budget. The 24-hour epoch deadline starts at submission, including time waiting
for an earlier repository epoch; renewing an agent lease does not extend it.

Only the live holder's job/agent/token tuple can renew via
`POST /v1/queues/QUEUE/renew`; renewal never changes the token or resurrects an
expired/completed lease. Reclamation increments the fence. The agent cancels
its job when ownership is lost or cannot be confirmed before its conservative
local deadline, and does not turn that cancellation into test evidence. Local
command cancellation does not guarantee that all Buck remote actions have
stopped: stale-result rejection remains the authoritative safety boundary.

Without managed source, the executor requires the current JJ checkout to match
the requested revision exactly. Standalone execution is available through:

```sh
buck2 run tilde//aseipp/orchestra:buck-execute -- \
  --revision @ \
  depot-tilde//aseipp/orchestra:orchestra-test
```

An agent drains until the queue stays empty for `--idle-grace` (one minute by
default, allowing the Workflow's maximum 30-second polling gap); temporary
emptiness during asynchronous Workflow/Queue fan-out is not immediate success.
`--drain=false` means one completed job, not a continuously running daemon.
Restart a draining agent to fetch newly available commits and process more work.
`demo` additionally watches its epoch rather than inferring completion from an
empty agent queue.

The real agent advertises only supported job kinds and its host platform.
`:local-agent` uses Buck's local-only execution mode. `--buck-mode remote`
passes responsibility to Buck's remote-only mode, but production RE setup and
cross-platform execution have not been configured or validated here. Orchestra
does not implement an RE scheduler.
Independent deflake/culprit reruns bypass cached test results and currently
require local execution; remote-only reruns are rejected until independent
remote observations can be guaranteed. Skipped/omitted Buck results are treated
as infrastructure/non-evidence, not fabricated passing baselines.

## What is implemented, and what is still limited?

The prototype now has coverage carry-over, bounded selection, deflaking, and a
Rust-derived FACF engine. It also has the source-backed investigation adapter:
a passing-to-failing interval contains actual commits, not invented epoch IDs.
The scan is limited to 128 commits in one complete single-parent chain; merge
histories, unresolved endpoints, and oversized ranges fail closed. Adjacent
tdutil comparisons identify relevant suspects and direct test changes.

The FACF port comes from JJ change `zrqw`, commit
`f28b0530f45979e1eed4be25c9a694fef98cbcbf`, in
`src/qq/qq-cli/commands/hunt/facf/`. Its Bayesian update, weighting, and
termination behavior are tested independently from orchestration. Log-space
updates improve numerical stability; invalid inputs and impossible observations
are surfaced explicitly. It is a restricted noise model, not a general
explanation for arbitrary flaky regressions. See [the design](DESIGN.md#facf-and-the-paper).

Remaining boundaries are deliberate:

- No authentication, tenant isolation, admission quotas, or production security
  model; use trusted code and loopback/private test infrastructure.
- No production fleet management, configured-target platform expansion, or
  validated Buck RE deployment. A planner selects one configured platform.
- Lease renewal allows bounded jobs to outlive one ownership window, but does
  not promise exactly-once execution or continued operation through arbitrary
  outages. Duplicate execution can happen after expiry; stale results cannot
  overwrite an accepted completion.
- R2 artifacts hold bounded JSON plans/results, not an unrestricted log and
  binary-artifact service. Retention/garbage collection is not implemented.
  Agent subprocess diagnostics are capped during capture at 64 KiB per stream;
  raw tdutil JSON has a separate 64 MiB hard limit and fails explicitly on
  overflow. Buck's separate test-result stream remains authoritative.
- The prototype caps the known test catalog at 10,000 identities and each JSON
  artifact at 8 MiB. Larger repositories need partitioned catalogs/reports.
  These limits are guardrails, not a change-proportional algorithm: the current
  tdutil graph collection, eager affected list, aggregate coverage snapshots,
  and broker history scans still need the [scaling redesign](SCALING.md).
- Each Workflow allows at most 10,000 immediate follow-up activities, separately
  from idle polling, and has a 24-hour deadline from epoch creation. Idle waits
  back off through 1, 2, 4, 8, 16, and 30 seconds; useful progress resets them.
  A result arriving after a long idle can therefore wait up to 30 seconds for
  its next reconciliation, plus runtime overhead. A separate total-activity
  safety bound handles clock anomalies or event storms. Runtime outages and
  activity retries can delay observing the deadline; it is not a guarantee
  that remote execution has stopped at that instant.
- The coverage frontier serializes repository epochs for correctness; it is not
  a production multi-repository throughput/sharding design.
- The warm source cache has no cross-process clone lock or garbage collector.
  Give concurrent agents separate caches.
- D1 is a query projection with a prototype-created schema, not a migration or
  reporting platform. State/protocol v4 requires a fresh deployment state.
- FACF assumes independent false failures before a deterministic regression,
  a usable passing baseline, and unchanged test lineage. Test-definition
  changes, missing baselines, infrastructure errors, or exhausted budgets can
  make an investigation inconclusive; they must not manufacture a culprit.

Next deployment work is operational: run a sustained real-repository revision
stream, measure budget/flake-policy behavior, add authenticated agent admission,
and configure Buck's execution infrastructure. Keep those
concerns outside the pure inference library and outside Buck's action graph.
