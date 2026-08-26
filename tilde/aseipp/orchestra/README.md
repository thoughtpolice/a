<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Orchestra

Orchestra is a TAP-inspired test control plane for an atomic-commit monorepo,
built on celld. Buck2 owns target determination, the build graph, caching,
and execution. Orchestra owns revision milestones, coverage, bounded test
selection, deflaking, and flake-aware culprit investigations.

The control plane uses Workflows for durable orchestration, Queues for
asynchronous notifications, R2 for content-addressed result artifacts, Durable
Objects for authoritative ledgers and fenced agent leases, and D1 for queryable
history. External Go agents run the repository's real JJ, tdutil, and Buck2
adapters. Fake backends remain available for a wholly local demonstration and
hermetic tests.

Persisted state and the job protocol are version 4. Run it against a fresh
celld fleet and bucket with matching agents; Orchestra does not migrate state
or in-flight jobs from any other version. The local commands below use a fresh
bucket and working directory; do not point them at a shared fleet. celld's own
upgrade constraints, bugs, and quirks are catalogued in the
[celld toolchain notes](../../../buck/toolchains/celld/AGENTS.md).

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
|   |    EpochWorkflow: durable reconciliation, woken by results  |
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
provides the agent-facing lease protocol. The Queue carries small
control-plane notifications, not the build graph or a second agent job queue.
Queue deliveries create the Workflow, wake it with a `result` event while it
waits for agents, and record result-notification receipts. Each wait times
out after a minute, so a lost or dead-lettered notification delays the
Workflow's next look at authoritative broker state by at most that much.

Inside celld, the router, Workflow activities, and notification entrypoint use
native typed RPC to `Repository`, `EpochLedger`, and `AgentBroker`. Method
arguments and results are inferred from those object classes; there are no
internal HTTP paths or caller-selected JSON result casts. Only the external
Go-agent protocol is HTTP/JSON. RPC does not replace durable Queue delivery,
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

The suite includes pure FACF/policy tests, Worker integration tests against
the toolchain's runtime fakes, Go adapter and protocol tests, the shared celld
toolchain's declaration and runtime contracts, and the real celld/chaos3 E2E.
The shared [chaos3 local-resource rule](../../../src/chaos3/defs.bzl) provisions
the E2E's ephemeral S3 server through Buck's `LocalResourceInfo`; no manually
started server is required. The E2E owns a unique bucket, deploys both Workers,
and drives the public agent protocol through:

- a hard celld restart while the Workflow waits, then external-agent resumption;
- Queue-to-service notifications, idempotent retries, and platform sharding;
- content-addressed R2 artifacts and the D1 history projection;
- coverage inheritance, deflaking, and a FACF culprit investigation;
- lease renewal during a slow upload, abandoned-lease reclamation, and
  stale-token rejection.

```sh
buck2 test tilde//aseipp/orchestra:e2e-test
buck2 test toolchains//celld/tests:runtime-test
```

The shared [celld toolchain](../../../buck/toolchains/celld/README.md) exposes
the runtime through `:celld`. Its `celld.worker` rule type-checks and bundles
each TypeScript entrypoint, and `:worker-test` is a `celld.test` with
`fake_runtime = True`, which maps `cloudflare:workers` to the toolchain's
constructor fakes. Buck creates deployment metadata through `celld.project`;
there is no Wrangler CLI, npm project, or separately installed esbuild. The
shared [celld.d.ts](../../../buck/toolchains/celld/types/celld.d.ts) contains
runtime primitives, while domain types live in Orchestra's source modules.
Compile-time RPC tests reject misspelled methods, wrong arguments, and
unchecked nullable reads; fake object stubs clone arguments and replies like
the native transport.

## Epoch and Workflow lifecycle

Terminal publication has its own durable ledger alarm and checkpointed D1
batches: a D1 outage that exhausts Workflow retries does not block the next
epoch, because the alarm resumes publication after recovery. Terminal epochs
also fence outstanding broker work, preventing late claims, renewals, and new
results while preserving retries of already accepted evidence. Slow artifact
reads and Queue sends do not block unrelated lease renewals. See
[DESIGN.md](DESIGN.md#durable-reconciliation-not-exactly-once-delivery) for the
delivery, publication, and budget invariants.

celld expires completed Workflow instances (after 30 days by default). This is
engine history retention, not deletion of Orchestra's epoch ledgers, D1
history, or R2 artifacts. Kickoff uses `createBatch()`, which skips retained
IDs, and checks authoritative epoch state before creating anything: even after
engine expiry or deletion, a late terminal kickoff only records its receipt. A
result receipt reads Workflow status only to wake a waiting instance.
Repository recovery verifies creation with `get()` alone, which already checks
existence.

`GET /v1/repos/REPO/epochs/EPOCH/workflow` reports the independent
`epoch_status` and `workflow_id` alongside engine history:

| `engine_history` | `status` | Meaning |
| --- | --- | --- |
| `available` | Actual celld status | Retained engine history, with its actual output/error. |
| `not_created` | `queued` | A queued epoch has no engine record yet; kickoff recovery remains active. |
| `unavailable` | `null` | A terminal epoch's engine record is absent; expiry and deletion cannot be distinguished. |

Missing history does not fabricate a successful engine outcome or delete test
evidence. A missing engine for an active epoch, SQLite locks, and other runtime
failures return 503. The queued fallback handles only celld's exact
missing-instance error, never unrelated storage failures.

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
the fresh fleet bucket; do not reuse another deployment's state.

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
does not prove deletion, so automatic target retirement is not implemented. It
needs explicit removal evidence or bounded point validation, not a
repository-wide catalog diff. See [the change-bounded redesign](SCALING.md)
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
Idle waiting does not consume the epoch's separate immediate-reconciliation
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
default; a result wakes the Workflow at once, so follow-up jobs usually appear
within seconds). Temporary emptiness during asynchronous Workflow/Queue fan-out
is not success.
`--drain=false` means one completed job, not a continuously running daemon.
Restart a draining agent to fetch newly available commits and process more work.
`demo` additionally watches its epoch rather than inferring completion from an
empty agent queue.

The real agent advertises only supported job kinds and its host platform.
`:local-agent` uses Buck's local-only execution mode. `--buck-mode remote`
passes responsibility to Buck's remote-only mode, but production RE setup and
cross-platform execution have not been configured or validated here. Orchestra
does not implement an RE scheduler. Independent deflake/culprit reruns bypass
cached test results and require local execution; remote-only reruns are rejected until independent
remote observations can be guaranteed. Skipped/omitted Buck results are treated
as infrastructure/non-evidence, not fabricated passing baselines.

## What is implemented, and what is limited?

The prototype has coverage carry-over, bounded selection, deflaking, and a
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
  and broker history scans need the [scaling redesign](SCALING.md).
- Each Workflow allows at most 10,000 immediate follow-up activities, separately
  from idle waits, and has a 24-hour deadline from epoch creation. An idle
  Workflow waits for a `result` event for up to a minute, so a lost
  notification can delay its next reconciliation by that much, plus runtime
  overhead. A separate total-activity safety bound handles clock anomalies or
  event storms. Runtime outages and activity retries can delay observing the
  deadline; it is not a guarantee that remote execution has stopped then.
- The coverage frontier serializes repository epochs for correctness; it is not
  a production multi-repository throughput/sharding design.
- The warm source cache has no cross-process clone lock or garbage collector.
  Give concurrent agents separate caches.
- D1 is a query projection with a prototype-created schema, not a migration or
  reporting platform. Version-4 state requires a fresh deployment.
- FACF assumes independent false failures before a deterministic regression,
  a usable passing baseline, and unchanged test lineage. Test-definition
  changes, missing baselines, infrastructure errors, or exhausted budgets can
  make an investigation inconclusive; they must not manufacture a culprit.

Next deployment work is operational: run a sustained real-repository revision
stream, measure budget/flake-policy behavior, add authenticated agent admission,
and configure Buck's execution infrastructure. Keep those
concerns outside the pure inference library and outside Buck's action graph.
