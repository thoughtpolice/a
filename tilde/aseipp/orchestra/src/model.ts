// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestra's versioned domain and agent wire protocol. Runtime primitives live
 * in the celld toolchain; these records describe milestones, evidence, coverage,
 * and leases. Workflow parameters/events carry identities, not large documents.
 * @module
 */
import type { CoverageEntry } from "./util/policy.ts";
import type { AgentBroker } from "./agent_broker.ts";
import type { EpochLedger } from "./epoch_ledger.ts";
import type { Repository } from "./repository.ts";

/** Validated JSON object at HTTP boundaries. */
export type JsonObject = Record<string, unknown>;
/** Real executions distinguish infrastructure from test failures. */
export type Outcome = "pass" | "fail" | "infra_failure";
/** Complete means accounted for, not necessarily green. */
export type EpochStatus =
  | "queued"
  | "planning"
  | "running"
  | "analyzing"
  | "complete"
  | "failed";
/** Content address of the exact UTF-8 JSON bytes stored in R2. */
export interface ArtifactRef {
  key: string;
  sha256: string;
  size: number;
}
/** Tiny identity used for Workflow parameters and Queue notifications. */
export interface EpochIdentity {
  repo: string;
  epoch_id: string;
  workflow_id: string;
}
/**
 * Public Workflow view, separate from authoritative epoch/test status. Engine
 * history can expire or be deleted while the epoch and its evidence remain.
 */
export type EpochWorkflowView =
  & {
    /** Stable engine instance identity, even when its history is unavailable. */
    workflow_id: string;
    /** Orchestra's durable lifecycle; "complete" means accounted for, not green. */
    epoch_status: EpochStatus;
  }
  & (
    | (WorkflowInstanceStatusResult & {
      /** celld still retains the engine instance and its actual status. */
      engine_history: "available";
    })
    | {
      /** A queued epoch has no engine instance yet; kickoff recovery remains active. */
      engine_history: "not_created";
      status: "queued";
      output: null;
    }
    | {
      /** A terminal epoch outlived its engine record; expiry and deletion look alike. */
      engine_history: "unavailable";
      /** No engine outcome is inferred from the independently persisted epoch. */
      status: null;
      output: null;
    }
  );
/** Notifications are hints; persisted ledgers are authoritative. */
export type Notification = { kind: "kickoff" | "result"; epoch: EpochIdentity };
/** Bindings owned by the API/Workflow script. */
export interface OrchestraEnvironment {
  REPOSITORY: Pick<DurableObjectNamespace<Repository>, "getByName">;
  EPOCH: Pick<DurableObjectNamespace<EpochLedger>, "getByName">;
  JOB_QUEUE: Pick<DurableObjectNamespace<AgentBroker>, "getByName">;
  HISTORY: D1Database;
  ARTIFACTS: R2Bucket;
  EVENTS: Queue<Notification>;
  EPOCH_RUNS: Workflow<EpochIdentity>;
  /** Polling is the default; experimental events still hit celld 0.5.1 SQLite locks. */
  WORKFLOW_WAKE_MODE?: "poll" | "events";
}
/** Bounded policy saved with each milestone for deterministic replay. */
export interface EpochPolicy {
  max_tests: number;
  deflake_runs: number;
  infra_retries: number;
  culprit_runs: number;
  confidence: number;
}
/** tdutil-selected test identity and graph-change explanation. */
export interface PlannedTest {
  id: string;
  test_key: string;
  label: string;
  rule_type: string;
  platform: string;
  changed: boolean;
  selection_depth: number;
  selection_reason: string;
  affected_dependency: string | null;
}
/** Immutable target-determination output produced by the repository's tdutil. */
export interface TargetManifest {
  version: number;
  digest: string;
  base_revision: string | null;
  revision: string;
  base_commit: string;
  revision_commit: string;
  universe: string[];
  tests: PlannedTest[];
}
/** One genuine result, fenced by its accepted job lease. */
export interface TestResult {
  outcome: Outcome;
  duration_ms: number;
  attempt: number;
  agent_id: string;
  completed_at: number;
  job_id?: string;
  revision?: string;
}
/** A reported culprit is a posterior claim, never an inferred execution. */
export interface Finding {
  kind: "culprit" | "no_culprit" | "inconclusive";
  reason: string;
  revision?: string;
  confidence?: number;
  probabilities?: number[];
}
/** Current-milestone results plus separate diagnostic evidence. */
export interface TestState extends PlannedTest {
  state: "pending" | "completed";
  result: TestResult | null;
  observations: TestResult[];
  classification?: "pass" | "flaky" | "fail" | "infra_failure";
  baseline: CoverageEntry | null;
  finding?: Finding;
  diagnosis?: {
    plan_ref?: ArtifactRef;
    suspects?: CulpritSuspect[];
    observations: TestResult[];
    flake_rate: number;
  };
}
/** A deterministic, homogeneous Buck invocation; repeats get distinct IDs. */
export interface TestBatchState {
  id: string;
  job_id: string;
  platform: string;
  shard: number;
  test_ids: string[];
  state: "pending" | "complete";
}
/** Counts describe milestone executions, not diagnostic probe totals. */
export interface EpochCounts {
  expected: number;
  completed: number;
  pass: number;
  fail: number;
  infra_failure: number;
}
/** Epoch ledger, also returned by the public status API. */
export interface EpochState extends EpochIdentity {
  version: number;
  generation: number;
  sequence: number;
  previous_revision: string | null;
  revision: string;
  queue: string;
  state: EpochStatus;
  policy: EpochPolicy;
  manifest_ref: ArtifactRef | null;
  manifest_digest: string | null;
  report_ref: ArtifactRef | null;
  test_order: string[];
  tests: Record<string, TestState>;
  batch_order: string[];
  batches: Record<string, TestBatchState>;
  processed_jobs: Record<string, true>;
  counts: EpochCounts;
  coverage: Record<string, CoverageEntry>;
  catalog: Record<string, PlannedTest>;
  deferred: string[];
  inherited: string[];
  created_at: number;
  completed_at: number | null;
  notifications_received: number;
  error?: string;
}
/** Ordered milestones and coverage frontier. One epoch runs per repo at a time. */
export interface RepositoryState {
  version: number;
  repo: string | null;
  next_sequence: number;
  last_milestone: string | null;
  epochs: Record<string, EpochState>;
  revisions: Record<string, string>;
  active: string | null;
  pending: string[];
  outbox: string | null;
  coverage: Record<string, CoverageEntry>;
  catalog: Record<string, PlannedTest>;
}
/** Common identity for every external agent assignment. */
export interface JobBase extends EpochIdentity {
  version: number;
  id: string;
  queue: string;
  revision: string;
}
/** Plan changed tests between adjacent selected milestones. */
export interface PlanEpochJob extends JobBase {
  kind: "plan_epoch";
  base_revision: string | null;
}
/** One target, suitable for an at-file passed to Buck2. */
export interface JobTest {
  id: string;
  test_key: string;
  label: string;
}
/** Buck owns the build graph and execution backend. */
export interface RunTestsJob extends JobBase {
  kind: "run_tests";
  manifest_digest: string;
  batch_id: string;
  platform: string;
  shard: number;
  tests: JobTest[];
  purpose: "initial" | "deflake" | "culprit" | "infra_retry";
  round: number;
}
/** Enumerate actual linear commits and per-commit target changes. */
export interface PlanCulpritJob extends JobBase {
  kind: "plan_culprit";
  base_revision: string;
  platform: string;
  tests: JobTest[];
}
/** Each entry is an actual JJ commit, not just a submitted milestone. */
export interface CulpritSuspect {
  revision: string;
  affected: boolean;
  test_changed: boolean;
}
/** Last-pass (exclusive), first-fail (inclusive) interval. */
export interface CulpritPlan {
  version: number;
  base_revision: string;
  revision: string;
  test_key: string;
  suspects: CulpritSuspect[];
}
/** Every job is handled by the same lease protocol. */
export type Job = PlanEpochJob | RunTestsJob | PlanCulpritJob;
/** Uploaded result body; completion messages carry only its ArtifactRef. */
export type JobResult =
  | { kind: "plan_epoch"; manifest: TargetManifest }
  | {
    kind: "run_tests";
    tests: { test_id: string; outcome: Outcome; duration_ms: number }[];
  }
  | { kind: "plan_culprit"; plan: CulpritPlan }
  | { kind: "job_error"; message: string };
/**
 * Agent lease and accepted immutable result identity. Reads derive "canceled"
 * from the broker's durable epoch fence; accepted results remain "complete".
 */
export interface QueueJob {
  job: Job;
  state: "pending" | "leased" | "complete" | "canceled";
  attempts: number;
  lease_token: number | null;
  lease_until: number | null;
  agent_id: string | null;
  result_ref: ArtifactRef | null;
  completed_at: number | null;
  notified: boolean;
  created_at: number;
}
/** D1 is a rebuildable projection, not scheduler state. */
export interface HistoryEpochRow extends D1Row {
  repo: string;
  epoch_id: string;
  sequence: number;
  state: string;
}
