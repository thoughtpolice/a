// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Workflow activity helpers: deterministic jobs, evidence validation, coverage,
 * and FACF transitions. Activities may repeat after a crash, so job IDs and R2
 * objects are immutable and the epoch snapshot deduplicates accepted results.
 * No sleep or event wait lives here: EpochWorkflow owns durable suspension.
 * @module
 */
import type {
  CulpritPlan,
  EpochIdentity,
  EpochPolicy,
  EpochState,
  EpochStatus,
  Job,
  JobResult,
  OrchestraEnvironment,
  QueueJob,
  RunTestsJob,
  TestResult,
  TestState,
} from "../model.ts";
import { FacfSearch } from "../facf/index.ts";
import { indexEpoch } from "../history.ts";
import { getArtifact, putArtifact } from "./artifacts.ts";
import { epochStub } from "./objects.ts";
import { unwrapRpc } from "./rpc.ts";
import { normalizeManifest, TESTS_PER_BATCH } from "./planning.ts";
import {
  classifyObservations,
  flakeRate,
  selectCoverage,
  updateCoverage,
} from "./policy.ts";
import { requireInteger } from "./http.ts";
import { EPOCH_DEADLINE_ERROR, EPOCH_TIMEOUT_MS } from "./scheduling.ts";
import { terminalReport } from "./finalization.ts";

/** Validate bounded user policy and freeze defaults in the epoch's creation record. */
export function parsePolicy(value: unknown): EpochPolicy {
  if (
    value !== undefined &&
    (value === null || Array.isArray(value) || typeof value !== "object")
  ) throw new TypeError("policy must be an object");
  const input = (value ?? {}) as Partial<EpochPolicy>;
  const bounded = (v: unknown, fallback: number, max: number): number => {
    const n = requireInteger(v ?? fallback, "policy limit");
    if (n > max) throw new TypeError(`policy limit exceeds ${max}`);
    return n;
  };
  const confidence = input.confidence ?? 0.9;
  if (!Number.isFinite(confidence) || confidence < 0.5 || confidence >= 1) {
    throw new TypeError("confidence must be in [0.5,1)");
  }
  return {
    max_tests: bounded(input.max_tests, 10_000, 10_000),
    deflake_runs: Math.max(1, bounded(input.deflake_runs, 2, 10)),
    infra_retries: bounded(input.infra_retries, 1, 5),
    culprit_runs: bounded(input.culprit_runs, 12, 64),
    confidence,
  };
}

/** Job identity is a deterministic function of the persisted Workflow phase. */
function base(epoch: EpochState, suffix: string) {
  return {
    version: epoch.version,
    id: `${epoch.repo}:${epoch.epoch_id}:${suffix}`,
    queue: epoch.queue,
    repo: epoch.repo,
    epoch_id: epoch.epoch_id,
    workflow_id: epoch.workflow_id,
    revision: epoch.revision,
  };
}
/** Enqueue once (including retries) and consult the authoritative lease record. */
async function ensureJob(
  env: OrchestraEnvironment,
  job: Job,
): Promise<QueueJob> {
  const broker = env.JOB_QUEUE.getByName(job.queue);
  unwrapRpc(await broker.enqueue(job));
  const record = await broker.getJob(job.id);
  if (!record) throw new Error("enqueued job is missing from the broker");
  return record;
}
/** Persist a state transition without returning the large snapshot from a step. */
async function save(
  env: OrchestraEnvironment,
  epoch: EpochState,
): Promise<void> {
  const result = unwrapRpc(await epochStub(env, epoch).save(epoch));
  epoch.generation = result.generation;
}
/** Translate one accepted job's immutable result into real execution observations. */
async function observations(
  env: OrchestraEnvironment,
  lease: QueueJob,
): Promise<Map<string, TestResult>> {
  if (
    lease.job.kind !== "run_tests" || !lease.result_ref || !lease.completed_at
  ) {
    throw new Error("incomplete execution evidence");
  }
  const result = await getArtifact<JobResult>(env.ARTIFACTS, lease.result_ref);
  const tests = lease.job.tests;
  const values = result.kind === "job_error"
    ? tests.map((test) => ({
      test_id: test.id,
      outcome: "infra_failure" as const,
      duration_ms: 0,
    }))
    : result.kind === "run_tests"
    ? result.tests
    : null;
  if (!values || values.length !== tests.length) {
    throw new TypeError("execution result membership mismatch");
  }
  const expected = new Set(tests.map((test) => test.id));
  const output = new Map<string, TestResult>();
  for (const value of values) {
    if (
      !expected.delete(value.test_id) ||
      !["pass", "fail", "infra_failure"].includes(value.outcome) ||
      !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0
    ) throw new TypeError("invalid test evidence");
    output.set(value.test_id, {
      outcome: value.outcome,
      duration_ms: value.duration_ms,
      attempt: lease.attempts,
      agent_id: lease.agent_id!,
      completed_at: lease.completed_at,
      job_id: lease.job.id,
      revision: lease.job.revision,
    });
  }
  return output;
}
/** Build a single test rerun; result-cache reuse is forbidden in the agent adapter. */
function rerun(
  epoch: EpochState,
  test: TestState,
  purpose: RunTestsJob["purpose"],
  round: number,
  revision = epoch.revision,
): RunTestsJob {
  const id = `${purpose}:${test.id}:${round}`;
  return {
    ...base(epoch, id),
    revision,
    kind: "run_tests",
    manifest_digest: epoch.manifest_digest!,
    batch_id: id,
    platform: test.platform,
    shard: 0,
    purpose,
    round,
    tests: [{ id: test.id, test_key: test.test_key, label: test.label }],
  };
}
/** Count only final milestone cohorts, excluding diagnostic probes. */
function summarize(epoch: EpochState): void {
  epoch.counts = {
    expected: epoch.test_order.length,
    completed: 0,
    pass: 0,
    fail: 0,
    infra_failure: 0,
  };
  for (const test of Object.values(epoch.tests)) {
    if (test.state !== "completed") continue;
    epoch.counts.completed++;
    const outcome = test.classification === "flaky"
      ? "pass"
      : test.classification!;
    epoch.counts[outcome]++;
  }
}
/** Reject incomplete, changed-lineage, or malformed suspect ranges. */
function validateCulpritPlan(
  value: CulpritPlan,
  epoch: EpochState,
  test: TestState,
): void {
  if (
    !value || value.version !== 1 ||
    value.base_revision !== test.baseline?.last_pass ||
    value.revision !== epoch.revision || value.test_key !== test.test_key ||
    !Array.isArray(value.suspects) || !value.suspects.length ||
    value.suspects.length > 128
  ) {
    throw new TypeError("culprit plan does not match the requested interval");
  }
  const seen = new Set<string>();
  for (const suspect of value.suspects) {
    if (
      typeof suspect.revision !== "string" || !suspect.revision ||
      seen.has(suspect.revision) ||
      typeof suspect.affected !== "boolean" ||
      typeof suspect.test_changed !== "boolean"
    ) {
      throw new TypeError("invalid culprit suspect");
    }
    seen.add(suspect.revision);
  }
  // The real adapter resolves endpoints; its final commit may differ from a
  // symbolic submitted revision. Source authenticity remains an agent trust boundary.
}
/** Rebuild FACF from deduplicated evidence, select one probe, or record a finding. */
async function investigate(
  env: OrchestraEnvironment,
  epoch: EpochState,
  test: TestState,
): Promise<boolean> {
  if (test.finding) return true;
  if (!test.baseline?.last_pass || test.changed) {
    test.finding = {
      kind: "inconclusive",
      reason: "no passing baseline in this unchanged test lineage",
    };
    return true;
  }
  if (epoch.policy.culprit_runs === 0) {
    test.finding = {
      kind: "inconclusive",
      reason: "culprit investigation disabled by budget",
    };
    return true;
  }
  test.diagnosis ??= { observations: [], flake_rate: flakeRate(test.baseline) };
  const diagnosis = test.diagnosis;
  if (!diagnosis.suspects) {
    const job: Job = {
      ...base(epoch, "culprit-plan:" + test.id),
      kind: "plan_culprit",
      base_revision: test.baseline.last_pass,
      platform: test.platform,
      tests: [{ id: test.id, test_key: test.test_key, label: test.label }],
    };
    const lease = await ensureJob(env, job);
    if (lease.state !== "complete") return false;
    const result = await getArtifact<JobResult>(
      env.ARTIFACTS,
      lease.result_ref!,
    );
    if (result.kind === "job_error") {
      test.finding = { kind: "inconclusive", reason: result.message };
      return true;
    }
    if (result.kind !== "plan_culprit") {
      throw new TypeError("unexpected culprit plan result");
    }
    validateCulpritPlan(result.plan, epoch, test);
    diagnosis.plan_ref = lease.result_ref!;
    diagnosis.suspects = result.plan.suspects;
    if (diagnosis.suspects.some((suspect) => suspect.test_changed)) {
      test.finding = {
        kind: "inconclusive",
        reason: "test changed inside the candidate interval",
      };
      return true;
    }
  }
  const suspects = diagnosis.suspects;
  // tdutil-unaffected commits cannot introduce this target's deterministic
  // regression. Keep their positions (and potential probe points) in the range.
  const weights = [...suspects.map((suspect) => suspect.affected ? 1 : 0), 1];
  const sum = weights.reduce((a, b) => a + b, 0);
  const search = FacfSearch.withPrior(weights.map((w) => w / sum), {
    flakeRate: diagnosis.flake_rate,
    threshold: epoch.policy.confidence,
  });
  const evidence = [
    ...test.observations.filter((observation) =>
      observation.outcome !== "infra_failure"
    ).map((
      observation,
    ) => ({
      position: suspects.length - 1,
      outcome: observation.outcome as "pass" | "fail",
    })),
    ...diagnosis.observations.filter((observation) =>
      observation.outcome !== "infra_failure"
    ).map((
      observation,
    ) => ({
      position: suspects.findIndex((suspect) =>
        suspect.revision === observation.revision
      ),
      outcome: observation.outcome as "pass" | "fail",
    })),
  ];
  for (const observation of evidence) {
    if (
      observation.position < 0 ||
      !search.recordResult(observation.position, observation.outcome)
    ) {
      test.finding = {
        kind: "inconclusive",
        reason: "observations contradict the FACF noise model",
      };
      return true;
    }
  }
  const result = search.result();
  if (result) {
    test.finding = {
      kind: result.kind,
      reason: "FACF posterior reached configured confidence",
      confidence: result.confidence,
      probabilities: search.probabilities,
      ...(result.kind === "culprit"
        ? { revision: suspects[result.position].revision }
        : {}),
    };
    return true;
  }
  const next = search.nextRuns(1)[0];
  if (
    diagnosis.observations.length >= epoch.policy.culprit_runs ||
    next === undefined
  ) {
    test.finding = {
      kind: "inconclusive",
      reason: next === undefined
        ? "FACF has no informative next probe"
        : "culprit probe budget exhausted",
      probabilities: search.probabilities,
    };
    return true;
  }
  const lease = await ensureJob(
    env,
    rerun(
      epoch,
      test,
      "culprit",
      diagnosis.observations.length,
      suspects[next].revision,
    ),
  );
  if (lease.state !== "complete") return false;
  const results = await observations(env, lease);
  diagnosis.observations.push(results.get(test.id)!);
  epoch.processed_jobs[lease.job.id] = true;
  // Reconcile again before deciding whether a further probe is necessary.
  return false;
}

/** A step returns scheduling metadata, never the manifest/coverage blob. */
export interface Progress {
  /** The ledger has reached terminal truth, including successful replay. */
  done: boolean;
  /** No immediately useful follow-up activity was discovered in this pass. */
  wait: boolean;
  /** Persisted lifecycle state after reconciliation. */
  state: string;
  /** Domain state changed; housekeeping writes and notifications do not count. */
  changed: boolean;
  /** Activity completion time, checkpointed with this successful step result. */
  observed_at: number;
  /** Immutable wall-clock deadline, derived from the epoch's creation record. */
  deadline_at: number;
}
/** Advance one durable Workflow activity; it is safe to repeat after step failure. */
export async function advanceEpoch(
  env: OrchestraEnvironment,
  id: EpochIdentity,
): Promise<Progress> {
  const epoch = await epochStub(env, id).getState();
  if (!epoch) throw new Error("epoch not found");
  const deadline_at = epoch.created_at + EPOCH_TIMEOUT_MS;
  if (epoch.state === "complete" || epoch.state === "failed") {
    await projectAndFinish(env, epoch);
    return {
      done: true,
      wait: false,
      state: epoch.state,
      changed: false,
      observed_at: Date.now(),
      deadline_at,
    };
  }
  if (Date.now() >= deadline_at) {
    throw new Error(EPOCH_DEADLINE_ERROR);
  }
  // Compare this activity's domain mutations before save increments generation
  // or merges concurrent notification receipts. Lease renewals live in the
  // broker, not this snapshot, and must not reset idle-poll backoff either.
  const before = JSON.stringify(epoch);
  let wait = true;
  if (epoch.state === "queued") epoch.state = "planning";
  if (epoch.state === "planning") {
    const lease = await ensureJob(env, {
      ...base(epoch, "plan"),
      kind: "plan_epoch",
      base_revision: epoch.previous_revision,
    });
    if (lease.state === "complete") {
      const result = await getArtifact<JobResult>(
        env.ARTIFACTS,
        lease.result_ref!,
      );
      if (result.kind === "job_error") {
        throw new Error("target determination failed: " + result.message);
      }
      if (result.kind !== "plan_epoch") {
        throw new TypeError("invalid planner result");
      }
      const manifest = normalizeManifest(
        result.manifest,
        epoch.previous_revision,
        epoch.revision,
      );
      epoch.manifest_ref = await putArtifact(env.ARTIFACTS, manifest);
      epoch.manifest_digest = manifest.digest;
      const selection = selectCoverage(
        epoch.coverage,
        manifest.tests,
        epoch.revision,
        epoch.policy.max_tests,
      );
      for (const test of manifest.tests) epoch.catalog[test.test_key] = test;
      if (Object.keys(epoch.catalog).length > 10_000) {
        throw new Error("prototype catalog limit exceeded");
      }
      epoch.deferred = selection.deferred.map((test) => test.test_key);
      epoch.inherited = selection.inherited.map((test) => test.test_key);
      for (const identity of selection.selected) {
        const planned = epoch.catalog[identity.test_key];
        if (!planned) throw new Error("missing deferred test catalog entry");
        const test: TestState = {
          ...planned,
          changed: identity.changed,
          state: "pending",
          result: null,
          observations: [],
          baseline: identity.changed
            ? null
            : epoch.coverage[identity.test_key] ?? null,
        };
        if (
          epoch.tests[test.id] &&
          epoch.tests[test.id].test_key !== test.test_key
        ) {
          throw new TypeError(
            "selected test IDs collide across current and deferred catalog entries",
          );
        }
        epoch.tests[test.id] = test;
        epoch.test_order.push(test.id);
      }
      for (const identity of [...selection.selected, ...selection.deferred]) {
        const prior = epoch.coverage[identity.test_key];
        epoch.coverage[identity.test_key] = {
          test_key: identity.test_key,
          label: identity.label,
          platform: identity.platform,
          last_pass: identity.changed ? null : prior?.last_pass ?? null,
          last_revision: prior?.last_revision ?? null,
          pending: true,
          flake_passes: identity.changed ? 0 : prior?.flake_passes ?? 0,
          flake_failures: identity.changed ? 0 : prior?.flake_failures ?? 0,
        };
      }
      const platforms = new Map<string, string[]>();
      for (const testId of epoch.test_order) {
        const test = epoch.tests[testId];
        const group = platforms.get(test.platform) ?? [];
        group.push(testId);
        platforms.set(test.platform, group);
      }
      for (const [platform, tests] of platforms) {
        for (let offset = 0; offset < tests.length; offset += TESTS_PER_BATCH) {
          const batchId = "b" +
            String(epoch.batch_order.length + 1).padStart(4, "0");
          epoch.batch_order.push(batchId);
          epoch.batches[batchId] = {
            id: batchId,
            job_id: base(epoch, "initial:" + batchId).id,
            platform,
            shard: offset / TESTS_PER_BATCH,
            test_ids: tests.slice(offset, offset + TESTS_PER_BATCH),
            state: "pending",
          };
        }
      }
      epoch.processed_jobs[lease.job.id] = true;
      epoch.state = "running";
      wait = false;
    }
  }
  if (epoch.state === "running") {
    for (const batch of Object.values(epoch.batches)) {
      if (batch.state === "complete") continue;
      const job: RunTestsJob = {
        ...base(epoch, "initial:" + batch.id),
        kind: "run_tests",
        manifest_digest: epoch.manifest_digest!,
        batch_id: batch.id,
        platform: batch.platform,
        shard: batch.shard,
        purpose: "initial",
        round: 0,
        tests: batch.test_ids.map((testId) => {
          const t = epoch.tests[testId];
          return { id: t.id, label: t.label, test_key: t.test_key };
        }),
      };
      const lease = await ensureJob(env, job);
      if (lease.state !== "complete") continue;
      for (const [testId, observation] of await observations(env, lease)) {
        epoch.tests[testId].observations.push(observation);
      }
      batch.state = "complete";
      epoch.processed_jobs[lease.job.id] = true;
      wait = false;
    }
    for (const test of Object.values(epoch.tests)) {
      if (test.state === "completed" || test.observations.length === 0) {
        continue;
      }
      const outcomes = test.observations.map((observation) =>
        observation.outcome
      );
      const genuine = outcomes.filter((outcome) => outcome !== "infra_failure");
      const infra = outcomes.length - genuine.length;
      const classification = classifyObservations(outcomes);
      const needsRepeat = !genuine.includes("pass") &&
        infra <= epoch.policy.infra_retries &&
        (genuine.length === 0 || genuine.length < epoch.policy.deflake_runs);
      if (needsRepeat) {
        const purpose = outcomes.at(-1) === "infra_failure"
          ? "infra_retry"
          : "deflake";
        const lease = await ensureJob(
          env,
          rerun(epoch, test, purpose, test.observations.length),
        );
        if (lease.state !== "complete") continue;
        test.observations.push((await observations(env, lease)).get(test.id)!);
        epoch.processed_jobs[lease.job.id] = true;
        wait = false;
        continue;
      }
      test.classification = classification;
      test.state = "completed";
      // A mixed cohort is flaky/observed-pass, not a fresh synthetic pass.
      test.result = test.observations.find((observation) =>
        observation.outcome === "pass"
      ) ??
        test.observations.find((observation) =>
          observation.outcome === "fail"
        ) ??
        test.observations.at(-1)!;
      epoch.coverage[test.test_key] = updateCoverage(
        test.baseline ?? undefined,
        test,
        epoch.revision,
        outcomes,
      );
      if (
        classification === "fail" && genuine.length < epoch.policy.deflake_runs
      ) {
        test.finding = {
          kind: "inconclusive",
          reason:
            "infrastructure retry budget exhausted before deflaking completed",
        };
      }
      wait = false;
    }
    if (
      Object.values(epoch.tests).every((test) => test.state === "completed")
    ) {
      epoch.state = "analyzing";
      wait = false;
    }
  }
  if (epoch.state === "analyzing") {
    let diagnosed = true;
    for (const test of Object.values(epoch.tests)) {
      if (test.classification !== "fail") continue;
      const before = test.diagnosis?.observations.length ?? 0;
      if (!await investigate(env, epoch, test)) diagnosed = false;
      if ((test.diagnosis?.observations.length ?? 0) > before) wait = false;
    }
    if (diagnosed) {
      epoch.state = "complete";
      epoch.completed_at = Date.now();
    }
  }
  summarize(epoch);
  if (epoch.state === "complete") {
    epoch.report_ref = await putArtifact(env.ARTIFACTS, terminalReport(epoch));
  }
  const changed = JSON.stringify(epoch) !== before;
  // Idle polls need no new authoritative snapshot. Keep repairing D1 below:
  // its previous write may have failed after a successful ledger checkpoint.
  if (changed) await save(env, epoch);
  if (epoch.state === "complete") await projectAndFinish(env, epoch);
  else await indexEpoch(env.HISTORY, epoch);
  return {
    done: epoch.state === "complete",
    wait,
    state: epoch.state,
    changed,
    observed_at: Date.now(),
    deadline_at,
  };
}

/**
 * Help the ledger drain its independently recoverable terminal outbox. Each RPC
 * checkpoints a bounded batch, so an activity timeout resumes publication rather
 * than starting over. The ledger alarm also runs if every Workflow retry fails.
 */
async function projectAndFinish(
  env: OrchestraEnvironment,
  epoch: EpochState,
): Promise<void> {
  while (
    !await epochStub(env, epoch).finalize()
  ) { /* Durable batch checkpoint. */ }
}
/** Record an exhausted/permanent control-plane error and release the next milestone safely. */
export async function failEpoch(
  env: OrchestraEnvironment,
  id: EpochIdentity,
  message: string,
): Promise<EpochStatus> {
  const epoch = await epochStub(env, id).getState();
  if (!epoch) throw new Error("epoch not found");
  // Projection or Queue publication can fail after successful finalization; do
  // not turn a completed run into a failed one during a retry of those effects.
  if (epoch.state !== "complete" && epoch.state !== "failed") {
    epoch.state = "failed";
    epoch.error = message;
    epoch.completed_at = Date.now();
    // Persist the terminal obligation even while R2 is unavailable. The ledger
    // fences outstanding work and fills the report before releasing a successor.
    epoch.report_ref = null;
    await save(env, epoch);
  }
  await projectAndFinish(env, epoch);
  return epoch.state;
}
