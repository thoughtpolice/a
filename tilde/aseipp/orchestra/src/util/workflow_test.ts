// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused reconciliation tests for the actual Workflow activity implementation.
 *
 * A minimal immutable artifact store and versioned ledger isolate policy from
 * the full fake runtime. Broker assignments have real deterministic IDs, and
 * injected before/after-save faults exercise activity replay with previously
 * completed jobs. These are not substitutes for the real celld/chaos3 E2E.
 *
 * @module
 */

import type {
  EpochState,
  Job,
  JobResult,
  OrchestraEnvironment,
  PlannedTest,
  QueueJob,
  TargetManifest,
} from "../model.ts";
import { putArtifact } from "./artifacts.ts";
import { STATE_VERSION, TARGET_MANIFEST_VERSION } from "./constants.ts";
import type { CoverageEntry } from "./policy.ts";
import { advanceEpoch, failEpoch, parsePolicy } from "./workflow.ts";
import { EPOCH_DEADLINE_ERROR, EPOCH_TIMEOUT_MS } from "./scheduling.ts";
import { rpcOk, type RpcResult } from "./rpc.ts";
import {
  newFinalization,
  prepareTerminalPublication,
  projectFinalizationBatch,
} from "./finalization.ts";
import type { EpochLedger } from "../epoch_ledger.ts";
import type { AgentBroker, EnqueueReceipt } from "../agent_broker.ts";
import type { Repository } from "../repository.ts";

/** Dependency-free assertion for this deliberately isolated activity fixture. */
function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

/** Compares JSON-safe checkpoints, IDs, and counts. */
function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}

/** Runs an isolated activity test on a deterministic clock, always restoring it. */
async function withClock(
  run: (clock: { now: number }) => Promise<void>,
): Promise<void> {
  const original = Date.now;
  const clock = { now: 1_000_000 };
  Date.now = () => clock.now;
  try {
    await run(clock);
  } finally {
    Date.now = original;
  }
}

/** Creates stable tdutil metadata with valid direct-change provenance. */
function planned(key = "test", changed = false): PlannedTest {
  return {
    id: key,
    test_key: key,
    label: `root//test:${key}`,
    platform: "linux-x86_64",
    rule_type: "rust_test",
    changed,
    selection_depth: changed ? 0 : 1,
    selection_reason: "fixture source change",
    affected_dependency: changed ? null : "root//lib:changed",
  };
}

/** Creates an unchanged-lineage passing baseline for a test. */
function baseline(key = "test", pending = false): CoverageEntry {
  return {
    test_key: key,
    label: `root//test:${key}`,
    platform: "linux-x86_64",
    last_pass: "base",
    last_revision: "base",
    pending,
    flake_passes: 50,
    flake_failures: 0,
  };
}

/** Creates an epoch snapshot independently of Repository intake. */
function initialEpoch(): EpochState {
  return {
    version: STATE_VERSION,
    generation: 0,
    repo: "fixture",
    epoch_id: "e000001",
    workflow_id: "workflow",
    sequence: 1,
    previous_revision: "base",
    revision: "head",
    queue: "default",
    state: "queued",
    policy: parsePolicy(undefined),
    manifest_ref: null,
    manifest_digest: null,
    report_ref: null,
    test_order: [],
    tests: {},
    batch_order: [],
    batches: {},
    processed_jobs: {},
    counts: { expected: 0, completed: 0, pass: 0, fail: 0, infra_failure: 0 },
    coverage: {},
    catalog: {},
    deferred: [],
    inherited: [],
    created_at: Date.now(),
    completed_at: null,
    notifications_received: 0,
  };
}

/** Agent result producer, invoked only when a new logical job is created. */
type AgentResult = (job: Job) => JobResult;

/**
 * Minimal fake boundaries for the real advanceEpoch/failEpoch activities.
 * It does not duplicate scheduling policy: all transitions come from production.
 */
class ActivityHarness {
  /** Production activities receive these interfaces exactly as in celld. */
  readonly env: OrchestraEnvironment;
  /** Immutable broker records, useful for asserting physical assignment count. */
  readonly jobs = new Map<string, QueueJob>();
  /** A single injected ambiguous save failure, consumed by the next save call. */
  saveFault: "before" | "after" | null = null;
  /** Number of repository finish projections observed. */
  finishes = 0;
  /** Persisted state; always cloned across API boundaries. */
  private snapshot: EpochState;
  /** Exact bytes behind R2 references. */
  private readonly artifacts = new Map<string, Uint8Array>();

  /** Composes narrow fake bindings without importing the runtime fake module. */
  constructor(
    epoch: EpochState,
    readonly tests: PlannedTest[],
    readonly agent: AgentResult,
  ) {
    this.snapshot = structuredClone(epoch);
    const bucket = {
      put: (key: string, value: Uint8Array) => {
        if (this.artifacts.has(key)) return Promise.resolve(null);
        this.artifacts.set(key, value.slice());
        return Promise.resolve({});
      },
      get: (key: string) => {
        const value = this.artifacts.get(key);
        return Promise.resolve(
          value
            ? {
              size: value.length,
              arrayBuffer: () => Promise.resolve(value.slice().buffer),
            }
            : null,
        );
      },
    } as unknown as R2Bucket;
    // Deliberately partial fixtures: only the activity's invoked APIs exist.
    // The partial object is typechecked against the actual methods, not a
    // second hand-written protocol. Each handler clones its data boundary.
    const namespace = <T extends object>(
      methods: Partial<DurableObjectStub<T>>,
    ) => ({
      getByName: () => methods as DurableObjectStub<T>,
    });
    const statement = {
      bind: (..._values: unknown[]) => statement,
      run: () => Promise.resolve({}),
    };
    this.env = {
      ARTIFACTS: bucket,
      EPOCH: namespace<EpochLedger>({
        getState: () => Promise.resolve(this.read()),
        save: (epoch) => this.saveSnapshot(structuredClone(epoch)),
        finalize: async () => {
          this.snapshot.report_ref = await prepareTerminalPublication(
            this.env,
            this.read(),
          );
          let progress = newFinalization();
          do {
            progress = await projectFinalizationBatch(
              this.env,
              this.read(),
              progress,
            );
          } while (progress.next_test < Object.keys(this.read().tests).length);
          await this.env.REPOSITORY.getByName(this.read().repo).finish(
            this.read().epoch_id,
          );
          return true;
        },
      }),
      JOB_QUEUE: namespace<AgentBroker>({
        cancelEpoch: () => Promise.resolve(rpcOk({ canceled: true as const })),
        enqueue: (job) => this.enqueue(structuredClone(job)),
        getJob: (id) =>
          Promise.resolve(structuredClone(this.jobs.get(id) ?? null)),
      }),
      REPOSITORY: namespace<Repository>({
        finish: (_epochId) => {
          this.finishes++;
          return Promise.resolve(rpcOk({ ok: true as const }));
        },
      }),
      HISTORY: {
        exec: () => Promise.resolve({ count: 0, duration: 0 }),
        prepare: () => statement,
        batch: () => Promise.resolve([]),
      } as unknown as D1Database,
      EVENTS: {} as Queue,
      EPOCH_RUNS: {} as Workflow,
    };
  }

  /** Returns only a clone of the durable epoch. */
  read(): EpochState {
    return structuredClone(this.snapshot);
  }

  /** Models housekeeping writes arriving between otherwise idle activities. */
  notify(): void {
    this.snapshot.notifications_received++;
    this.snapshot.generation++;
  }

  /** Drives a bounded number of real activity calls to a terminal result. */
  async finish(): Promise<EpochState> {
    for (let round = 0; round < 30; round++) {
      const progress = await advanceEpoch(this.env, this.snapshot);
      if (progress.done) return this.read();
    }
    throw new Error(
      "activity fixture did not converge within 30 reconciliations",
    );
  }

  /** Models ledger generation CAS and both ambiguous write-failure boundaries. */
  private saveSnapshot(
    incoming: EpochState,
  ): Promise<RpcResult<{ generation: number }>> {
    return Promise.resolve().then(() => {
      const fault = this.saveFault;
      this.saveFault = null;
      if (fault === "before") throw new Error("injected pre-save failure");
      assert(
        incoming.generation === this.snapshot.generation,
        "stale test generation",
      );
      incoming.generation++;
      this.snapshot = structuredClone(incoming);
      if (fault === "after") throw new Error("injected post-save failure");
      return rpcOk({ generation: incoming.generation });
    });
  }

  /** Creates each assignment once and exposes immutable accepted results. */
  private async enqueue(job: Job): Promise<RpcResult<EnqueueReceipt>> {
    const existing = this.jobs.get(job.id);
    if (existing) {
      equal(existing.job, job);
      return rpcOk({ created: false, job_id: job.id });
    }
    const result: JobResult = job.kind === "plan_epoch"
      ? { kind: "plan_epoch", manifest: this.manifest() }
      : this.agent(job);
    const result_ref = await putArtifact(this.env.ARTIFACTS, result);
    this.jobs.set(job.id, {
      job,
      state: "complete",
      attempts: 1,
      lease_token: 1,
      lease_until: null,
      agent_id: "fixture-agent",
      result_ref,
      completed_at: Date.now(),
      notified: true,
      created_at: Date.now(),
    });
    return rpcOk({ created: true, job_id: job.id });
  }

  /** Supplies an independently versioned target manifest to planning. */
  private manifest(): TargetManifest {
    return {
      version: TARGET_MANIFEST_VERSION,
      digest: "fixture-manifest",
      base_revision: this.snapshot.previous_revision,
      revision: this.snapshot.revision,
      base_commit: "base",
      revision_commit: "head",
      universe: ["root//..."],
      tests: this.tests,
    };
  }
}

/**
 * Hides selected accepted results until a test releases them. The real activity
 * still sees stable broker IDs, renewed leases, and cloned RPC boundaries.
 */
function holdJobs(
  harness: ActivityHarness,
  waiting: (job: Job) => boolean,
): void {
  const broker = harness.env.JOB_QUEUE.getByName("default");
  harness.env.JOB_QUEUE.getByName = () => ({
    ...broker,
    getJob: async (id) => {
      const record = await broker.getJob(id);
      if (!record || !waiting(record.job)) return record;
      return {
        ...record,
        state: "leased",
        lease_until: Date.now() + 30_000,
        result_ref: null,
        completed_at: null,
        notified: false,
      };
    },
  });
}

/** Produces homogeneous coarse test results with one genuine outcome per target. */
function results(
  job: Job,
  outcome: "pass" | "fail" | "infra_failure",
): JobResult {
  assert(job.kind === "run_tests", `expected test job, got ${job.kind}`);
  return {
    kind: "run_tests",
    tests: job.tests.map((test) => ({
      test_id: test.id,
      outcome,
      duration_ms: 1,
    })),
  };
}

Deno.test("Workflow progress distinguishes planning and evidence from idle lease and notification noise", async () => {
  await withClock(async (clock) => {
    const epoch = initialEpoch();
    const deadline = epoch.created_at + EPOCH_TIMEOUT_MS;
    const harness = new ActivityHarness(
      epoch,
      [planned()],
      (job) => results(job, "pass"),
    );
    const waiting = new Set<Job["kind"]>(["plan_epoch", "run_tests"]);
    holdJobs(harness, (job) => waiting.has(job.kind));

    const started = await advanceEpoch(harness.env, epoch);
    equal(started, {
      done: false,
      wait: true,
      state: "planning",
      changed: true,
      observed_at: clock.now,
      deadline_at: deadline,
    });
    for (let poll = 0; poll < 3; poll++) {
      clock.now += 30_000;
      harness.notify();
      const before = harness.read();
      const idle = await advanceEpoch(harness.env, epoch);
      equal(idle, {
        ...started,
        changed: false,
        observed_at: clock.now,
      });
      // A no-op reconciliation does not rewrite the authoritative snapshot.
      equal(harness.read().generation, before.generation);
      equal(
        harness.read().notifications_received,
        before.notifications_received,
      );
    }

    waiting.delete("plan_epoch");
    const plannedProgress = await advanceEpoch(harness.env, epoch);
    equal(plannedProgress.changed, true);
    equal(plannedProgress.wait, false);
    equal(plannedProgress.state, "running");
    equal(plannedProgress.deadline_at, deadline);
    const idle = await advanceEpoch(harness.env, epoch);
    equal(idle.changed, false);
    equal(idle.wait, true);

    waiting.delete("run_tests");
    clock.now++;
    const completed = await advanceEpoch(harness.env, epoch);
    equal(completed.changed, true);
    equal(completed.done, true);
    equal(completed.deadline_at, deadline);
    equal(completed.observed_at, clock.now);
  });
});

Deno.test("Workflow FACF plan arrival and probe observations are semantic progress even without a phase change", async () => {
  await withClock(async () => {
    const epoch = initialEpoch();
    epoch.coverage.test = baseline();
    const harness = new ActivityHarness(epoch, [planned()], (job) => {
      if (job.kind === "plan_culprit") {
        return {
          kind: "plan_culprit",
          plan: {
            version: 1,
            base_revision: "base",
            revision: "head",
            test_key: "test",
            suspects: [
              { revision: "first", affected: true, test_changed: false },
              { revision: "head", affected: true, test_changed: false },
            ],
          },
        };
      }
      return results(job, job.revision === "head" ? "fail" : "pass");
    });
    let holdPlan = true;
    let holdProbe = true;
    holdJobs(harness, (job) =>
      (holdPlan && job.kind === "plan_culprit") ||
      (holdProbe && job.kind === "run_tests" && job.purpose === "culprit"));
    await advanceEpoch(harness.env, epoch);
    const analyzing = await advanceEpoch(harness.env, epoch);
    equal(analyzing.state, "analyzing");
    equal(analyzing.changed, true);
    const idle = await advanceEpoch(harness.env, epoch);
    equal(idle.changed, false);
    equal(idle.wait, true);

    holdPlan = false;
    const plan = await advanceEpoch(harness.env, epoch);
    equal(plan.state, "analyzing");
    equal(plan.changed, true);
    equal(plan.wait, true);
    assert(harness.read().tests.test.diagnosis?.suspects);
    equal((await advanceEpoch(harness.env, epoch)).changed, false);

    holdProbe = false;
    const probe = await advanceEpoch(harness.env, epoch);
    equal(probe.state, "analyzing");
    equal(probe.changed, true);
    equal(probe.wait, false);
    equal(harness.read().tests.test.diagnosis?.observations.length, 1);
    const finding = await advanceEpoch(harness.env, epoch);
    equal(finding.changed, true);
    equal(finding.done, true);
    equal(harness.read().tests.test.finding?.kind, "culprit");
    equal(finding.deadline_at, epoch.created_at + EPOCH_TIMEOUT_MS);
  });
});

Deno.test("Workflow deadline is inclusive and rejects work without creating jobs or changing the ledger", async () => {
  await withClock(async (clock) => {
    for (
      const state of ["queued", "planning", "running", "analyzing"] as const
    ) {
      const epoch = initialEpoch();
      epoch.state = state;
      epoch.created_at = clock.now - EPOCH_TIMEOUT_MS;
      const harness = new ActivityHarness(epoch, [], () => {
        throw new Error("expired epoch must not request work");
      });
      const error = await advanceEpoch(harness.env, epoch).then(
        () => null,
        (reason: unknown) => reason,
      );
      assert(error instanceof Error);
      equal(error.message, EPOCH_DEADLINE_ERROR);
      equal(harness.jobs.size, 0);
      equal(harness.read(), epoch);
      equal(harness.finishes, 0);
    }
  });
});

Deno.test("Workflow admits work immediately before its stable creation-time deadline", async () => {
  await withClock(async (clock) => {
    const epoch = initialEpoch();
    epoch.created_at = clock.now - EPOCH_TIMEOUT_MS + 1;
    const harness = new ActivityHarness(epoch, [], () => {
      throw new Error("empty manifest requires no execution");
    });
    holdJobs(harness, () => true);
    const progress = await advanceEpoch(harness.env, epoch);
    equal(progress.done, false);
    equal(progress.changed, true);
    equal(progress.deadline_at, clock.now + 1);
    equal(harness.jobs.size, 1);
    clock.now++;
    const error = await advanceEpoch(harness.env, epoch).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert(error instanceof Error);
    equal(error.message, EPOCH_DEADLINE_ERROR);
  });
});

Deno.test("Workflow terminal replay preserves truth after the deadline and observes post-projection time", async () => {
  await withClock(async (clock) => {
    for (const state of ["complete", "failed"] as const) {
      const epoch = initialEpoch();
      epoch.state = state;
      epoch.created_at = clock.now - EPOCH_TIMEOUT_MS - 1;
      epoch.completed_at = epoch.created_at + 100;
      const harness = new ActivityHarness(epoch, [], () => {
        throw new Error("terminal epoch must not request work");
      });
      const repository = harness.env.REPOSITORY.getByName(epoch.repo);
      harness.env.REPOSITORY.getByName = () => ({
        ...repository,
        finish: async (id) => {
          const result = await repository.finish(id);
          clock.now += 23;
          return result;
        },
      });
      const progress = await advanceEpoch(harness.env, epoch);
      equal(progress, {
        done: true,
        wait: false,
        state,
        changed: false,
        observed_at: clock.now,
        deadline_at: epoch.created_at + EPOCH_TIMEOUT_MS,
      });
      // Recovery may fill an absent report, but cannot rewrite terminal facts.
      assert(harness.read().report_ref !== null);
      equal({ ...harness.read(), report_ref: epoch.report_ref }, epoch);
      equal(harness.finishes, 1);
      equal(harness.jobs.size, 0);
    }
  });
});

Deno.test("Workflow activity replay before/after save does not duplicate execution evidence", async () => {
  for (const fault of ["before", "after"] as const) {
    const harness = new ActivityHarness(
      initialEpoch(),
      [planned()],
      (job) => results(job, "fail"),
    );
    harness.saveFault = fault;
    let failed = false;
    try {
      await advanceEpoch(harness.env, harness.read());
    } catch {
      failed = true;
    }
    assert(failed);
    const epoch = await harness.finish();
    equal(epoch.tests.test.observations.length, 2);
    equal(
      new Set(epoch.tests.test.observations.map((result) => result.job_id))
        .size,
      2,
    );
    equal(harness.jobs.size, 3); // One plan, initial run, and independent deflake run.
    equal(epoch.tests.test.classification, "fail");
    equal(epoch.tests.test.finding?.kind, "inconclusive");
    equal(epoch.coverage.test.flake_failures, 2);
    await advanceEpoch(harness.env, epoch);
    equal(harness.read().tests.test.observations.length, 2);
  }
});

Deno.test("Workflow rejects a missing acknowledged broker assignment without saving progress", async () => {
  const harness = new ActivityHarness(
    initialEpoch(),
    [planned()],
    (job) => results(job, "pass"),
  );
  const before = harness.read();
  const broker = harness.env.JOB_QUEUE.getByName("default");
  harness.env.JOB_QUEUE.getByName = () => ({
    ...broker,
    getJob: () => Promise.resolve(null),
  });
  const error = await advanceEpoch(harness.env, before).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert(error instanceof Error);
  equal(error.message, "enqueued job is missing from the broker");
  equal(harness.read(), before);
});

Deno.test("Workflow throttling persists invalidation and does not green deferred changed tests", async () => {
  const epoch = initialEpoch();
  epoch.policy.max_tests = 0;
  epoch.coverage.test = baseline();
  epoch.coverage.untouched = baseline("untouched");
  const harness = new ActivityHarness(epoch, [planned("test", true)], () => {
    throw new Error("no execution expected");
  });
  const complete = await harness.finish();
  equal(complete.deferred, ["test"]);
  equal(complete.inherited, ["untouched"]);
  equal(complete.counts.expected, 0);
  equal(complete.coverage.test.last_pass, null);
  equal(complete.coverage.test.flake_passes, 0);
  equal(complete.coverage.test.pending, true);
});

Deno.test("Workflow pending carry-over becomes execution with unchanged lineage metadata", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline("test", true);
  epoch.catalog.test = planned("test", true);
  const harness = new ActivityHarness(epoch, [], (job) => results(job, "pass"));
  const complete = await harness.finish();
  equal(complete.tests.test.changed, false);
  equal(complete.tests.test.baseline?.last_pass, "base");
  equal(complete.coverage.test.last_pass, "head");
  equal(complete.coverage.test.flake_passes, 51);
});

Deno.test("Workflow fails closed when current and carried test IDs would overwrite each other", async () => {
  const epoch = initialEpoch();
  epoch.coverage.old = baseline("old", true);
  epoch.catalog.old = { ...planned("old"), id: "shared" };
  const harness = new ActivityHarness(
    epoch,
    [{ ...planned("new"), id: "shared" }],
    (job) => results(job, "pass"),
  );
  let message = "";
  try {
    await advanceEpoch(harness.env, harness.read());
  } catch (error) {
    message = String(error);
  }
  assert(message.includes("IDs collide"), message);
  equal(harness.read().generation, 0);
  equal(harness.jobs.size, 1);
});

Deno.test("Workflow mixed milestone outcomes establish a real pass without diagnostic evidence", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline();
  const harness = new ActivityHarness(
    epoch,
    [planned()],
    (job) =>
      results(
        job,
        job.kind === "run_tests" && job.purpose === "initial" ? "fail" : "pass",
      ),
  );
  const complete = await harness.finish();
  equal(complete.tests.test.classification, "flaky");
  equal(complete.tests.test.observations.length, 2);
  equal(complete.tests.test.result?.outcome, "pass");
  equal(complete.tests.test.diagnosis, undefined);
  equal(complete.coverage.test.last_pass, "head");
  equal(complete.counts, {
    expected: 1,
    completed: 1,
    pass: 1,
    fail: 0,
    infra_failure: 0,
  });
});

Deno.test("Workflow separate infra cap prevents fabricated pass or premature FACF", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline();
  const harness = new ActivityHarness(
    epoch,
    [planned()],
    (job) =>
      results(
        job,
        job.kind === "run_tests" && job.purpose === "initial"
          ? "fail"
          : "infra_failure",
      ),
  );
  const complete = await harness.finish();
  equal(complete.tests.test.observations.length, 3);
  equal(complete.tests.test.finding?.kind, "inconclusive");
  assert(
    complete.tests.test.finding!.reason.includes("infrastructure retry budget"),
  );
  equal(complete.tests.test.diagnosis, undefined);
  equal(complete.coverage.test.last_pass, "base");
  equal(complete.coverage.test.flake_failures, 1);
});

Deno.test("Workflow all-infra cohorts preserve pending coverage and no genuine counts", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline();
  const harness = new ActivityHarness(
    epoch,
    [planned()],
    (job) => results(job, "infra_failure"),
  );
  const complete = await harness.finish();
  equal(complete.tests.test.observations.length, 2);
  equal(complete.tests.test.classification, "infra_failure");
  equal(complete.coverage.test.pending, true);
  equal(complete.coverage.test.flake_passes, 50);
  equal(complete.coverage.test.flake_failures, 0);
});

Deno.test("Workflow FACF uses actual ordered suspects and keeps probes out of milestone counts", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline();
  const harness = new ActivityHarness(epoch, [planned()], (job) => {
    if (job.kind === "plan_culprit") {
      return {
        kind: "plan_culprit",
        plan: {
          version: 1,
          base_revision: "base",
          revision: "head",
          test_key: "test",
          suspects: [
            { revision: "first", affected: true, test_changed: false },
            { revision: "unrelated", affected: false, test_changed: false },
            { revision: "head", affected: true, test_changed: false },
          ],
        },
      };
    }
    return results(job, job.revision === "head" ? "fail" : "pass");
  });
  const complete = await harness.finish();
  equal(complete.tests.test.finding?.kind, "culprit");
  equal(complete.tests.test.finding?.revision, "head");
  equal(complete.tests.test.finding?.probabilities?.[1], 0);
  equal(complete.tests.test.observations.length, 2);
  assert(complete.tests.test.diagnosis!.observations.length > 0);
  equal(complete.tests.test.diagnosis?.flake_rate, 0.01);
  equal(complete.coverage.test.flake_failures, 2);
  equal(complete.counts.completed, 1);
});

Deno.test("Workflow FACF refuses test-definition changes inside a suspect interval", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline();
  const harness = new ActivityHarness(
    epoch,
    [planned()],
    (job) =>
      job.kind === "plan_culprit"
        ? {
          kind: "plan_culprit",
          plan: {
            version: 1,
            base_revision: "base",
            revision: "head",
            test_key: "test",
            suspects: [
              { revision: "head", affected: true, test_changed: true },
            ],
          },
        }
        : results(job, "fail"),
  );
  const complete = await harness.finish();
  equal(complete.tests.test.finding?.kind, "inconclusive");
  assert(complete.tests.test.finding!.reason.includes("test changed"));
  equal(complete.tests.test.diagnosis?.observations.length, 0);
});

Deno.test("Workflow diagnostic probe replay preserves one observation per accepted job", async () => {
  for (const fault of ["before", "after"] as const) {
    const epoch = initialEpoch();
    epoch.coverage.test = baseline();
    const harness = new ActivityHarness(
      epoch,
      [planned()],
      (job) =>
        job.kind === "plan_culprit"
          ? {
            kind: "plan_culprit",
            plan: {
              version: 1,
              base_revision: "base",
              revision: "head",
              test_key: "test",
              suspects: [
                { revision: "first", affected: true, test_changed: false },
                { revision: "head", affected: true, test_changed: false },
              ],
            },
          }
          : results(job, job.revision === "head" ? "fail" : "pass"),
    );
    // First activity persists the initial+deflake cohort. The second creates
    // the plan/probe before its ambiguous save; replay must reuse those IDs.
    await advanceEpoch(harness.env, harness.read());
    harness.saveFault = fault;
    let failed = false;
    try {
      await advanceEpoch(harness.env, harness.read());
    } catch {
      failed = true;
    }
    assert(failed);
    const complete = await harness.finish();
    equal(complete.tests.test.finding?.revision, "head");
    equal(complete.tests.test.diagnosis?.observations.length, 1);
    equal(
      [...harness.jobs.values()].filter((lease) =>
        lease.job.kind === "run_tests" && lease.job.purpose === "culprit"
      ).length,
      1,
    );
    equal(complete.tests.test.observations.length, 2);
  }
});

Deno.test("Workflow tdutil-unaffected interval keeps only the no-culprit hypothesis", async () => {
  const epoch = initialEpoch();
  epoch.coverage.test = baseline();
  const harness = new ActivityHarness(
    epoch,
    [planned()],
    (job) =>
      job.kind === "plan_culprit"
        ? {
          kind: "plan_culprit",
          plan: {
            version: 1,
            base_revision: "base",
            revision: "head",
            test_key: "test",
            suspects: [
              { revision: "head", affected: false, test_changed: false },
            ],
          },
        }
        : results(job, "fail"),
  );
  const complete = await harness.finish();
  equal(complete.tests.test.finding?.kind, "no_culprit");
  equal(complete.tests.test.finding?.probabilities, [0, 1]);
  equal(complete.tests.test.diagnosis?.observations.length, 0);
});

Deno.test("Workflow failure handling preserves an already complete ledger's terminal truth", async () => {
  const harness = new ActivityHarness(
    initialEpoch(),
    [planned()],
    (job) => results(job, "pass"),
  );
  const complete = await harness.finish();
  equal(
    await failEpoch(harness.env, complete, "projection retry exhausted"),
    "complete",
  );
  equal(harness.read().state, "complete");
  equal(harness.read().error, undefined);
  const failed = new ActivityHarness(
    initialEpoch(),
    [],
    (job) => results(job, "pass"),
  );
  equal(
    await failEpoch(
      failed.env,
      failed.read(),
      "permanent control-plane failure",
    ),
    "failed",
  );
  equal(failed.read().state, "failed");
});
