// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Durable lease broker between Workflow policy and external tdutil/Buck agents.
 * Queues carry wake-up notifications, not long-running agent leases. This
 * object keeps a per-job fencing/result ledger and a replayable notification
 * outbox; only immutable R2 references cross its completion boundary.
 *
 * Native Durable Object RPC accepts immutable assignments with enqueue(), reads
 * the authoritative ledger with getJob(), and exposes getState(), claim(),
 * renew(), and complete() to the public HTTP router. cancelEpoch() durably
 * fences terminal epochs before their successors are released. Mutation receipts are
 * structured-cloneable RpcResults, keeping protocol errors independent of the
 * HTTP adapter. Only ledger transitions serialize: R2 reads and Queue sends
 * run outside the lease critical section, then recheck the durable fence. No
 * policy or epoch delivery runs here: EVENTS notifications merely wake the
 * authoritative Workflow.
 * @module
 */
import { DurableObject } from "cloudflare:workers";
import type {
  ArtifactRef,
  EpochIdentity,
  Job,
  JobResult,
  JsonObject,
  OrchestraEnvironment,
  QueueJob,
} from "./model.ts";
import { artifactRef, getArtifact } from "./util/artifacts.ts";
import {
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MIN_LEASE_MS,
  STATE_VERSION,
} from "./util/constants.ts";
import {
  errorMessage,
  requireInteger,
  requireName,
  requireOutcome,
  requireString,
} from "./util/http.ts";
import { persist, Serial } from "./util/objects.ts";
import { normalizeManifest } from "./util/planning.ts";
import { RpcFault, rpcGuard, type RpcResult } from "./util/rpc.ts";

/** Retry wake-up delivery after a crash or transient Queue producer failure. */
const NOTIFICATION_RETRY_MS = 1_000;
/** Only these assignment kinds are understood by the external agent protocol. */
const JOB_KINDS = ["plan_epoch", "run_tests", "plan_culprit"] as const;

/** Agent capabilities and the renewable ownership window requested at claim. */
export interface ClaimRequest {
  agent_id: string;
  lease_ms?: number;
  platforms: string[];
  kinds: Job["kind"][];
}

/** Current-holder identity required by both renewal and completion. */
interface LeaseHolder {
  job_id: string;
  agent_id: string;
  lease_token: number;
}

/** Extend a live holder's lease without changing its fencing token. */
export interface RenewRequest extends LeaseHolder {
  lease_ms?: number;
}

/** Immutable R2 evidence proposed by the current holder of a job. */
export interface CompleteRequest extends LeaseHolder {
  result_ref: ArtifactRef;
}

/** Durable enqueue acknowledgement; exact retries return created: false. */
export interface EnqueueReceipt {
  created: boolean;
  job_id: string;
}

/** A durable epoch fence; retries preserve the same permanent cancellation. */
export interface CancellationReceipt {
  canceled: true;
}

/** A leased assignment plus its current owner, fence, and server expiry. */
export type ClaimedJob = Job & {
  agent_id: string;
  lease_token: number;
  lease_until: number;
  attempts: number;
};

/** Durable extension acknowledgement for exactly one existing ownership fence. */
export interface LeaseReceipt extends LeaseHolder {
  lease_until: number;
}

/** Accepted evidence receipt; exact retries remain safe even after lease expiry. */
export interface CompletionReceipt {
  accepted: true;
  duplicate: boolean;
  job_id: string;
}

/** Bounded queue diagnostics omit assignment bodies and artifact contents. */
export interface BrokerSummary {
  name: string | null;
  counts: {
    pending: number;
    leased: number;
    complete: number;
    canceled: number;
  };
  jobs: Array<
    & Pick<
      QueueJob,
      | "state"
      | "attempts"
      | "agent_id"
      | "lease_token"
      | "lease_until"
      | "result_ref"
      | "completed_at"
      | "notified"
    >
    & { id: string; kind: Job["kind"] }
  >;
}

/** A stale lease or changed immutable assignment is a protocol conflict. */
class BrokerConflict extends RpcFault {
  constructor(message: string) {
    super(409, message);
  }
}

/** One named queue's leased work and completion-notification outbox. */
export class AgentBroker extends DurableObject<OrchestraEnvironment> {
  readonly #serial = new Serial();
  /** Serialize outbox deliveries without excluding claims or heartbeats. */
  readonly #notifications = new Serial();

  /** celld injects the broker's persistent storage and shared runtime bindings. */
  constructor(
    readonly state: DurableObjectState,
    env: OrchestraEnvironment,
  ) {
    super(state, env);
  }

  /** Persist an immutable assignment once; changed retries conflict. */
  enqueue(job: Job): Promise<RpcResult<EnqueueReceipt>> {
    return this.#serial.run(() =>
      rpcGuard(() => this.#enqueue(job), "broker temporarily unavailable")
    );
  }

  /** Permanently fence all unfinished work for one repository-scoped epoch. */
  cancelEpoch(id: EpochIdentity): Promise<RpcResult<CancellationReceipt>> {
    return this.#serial.run(() =>
      rpcGuard(async () => {
        requireName(id.repo, "repo");
        requireName(id.epoch_id, "epoch_id");
        requireName(id.workflow_id, "workflow_id");
        // The tombstone also fences assignments racing with cancellation that
        // have not been enqueued yet. Re-put and sync on retries: a previous
        // write may have succeeded locally while its durable sync failed.
        await persist(this.state.storage, this.#cancellationKey(id), true);
        return { canceled: true as const };
      }, "broker temporarily unavailable")
    );
  }

  /** Read the full authoritative assignment/lease ledger for Workflow polling. */
  getJob(id: string): Promise<QueueJob | null> {
    return this.#serial.run(async () =>
      await this.#readJob(requireString(id, "id")) ?? null
    );
  }

  /** Read bounded diagnostics with the same retryable outage contract as writes. */
  getState(): Promise<RpcResult<BrokerSummary>> {
    return this.#serial.run(() =>
      rpcGuard(() => this.#summary(), "broker temporarily unavailable")
    );
  }

  /** Lease compatible work, or return null when none is currently available. */
  claim(input: ClaimRequest): Promise<RpcResult<ClaimedJob | null>> {
    return this.#serial.run(() =>
      rpcGuard(() => this.#claim(input), "broker temporarily unavailable")
    );
  }

  /** Renew only the matching live holder and acknowledge after durable sync. */
  renew(input: RenewRequest): Promise<RpcResult<LeaseReceipt>> {
    return this.#serial.run(() =>
      rpcGuard(() => this.#renew(input), "broker temporarily unavailable")
    );
  }

  /** Verify immutable evidence and durably accept it before notifying the Queue. */
  complete(input: CompleteRequest): Promise<RpcResult<CompletionReceipt>> {
    return rpcGuard(
      () => this.#complete(input),
      "broker temporarily unavailable",
    );
  }

  /** Replay accepted completions whose Queue notification is not durable yet. */
  alarm(): Promise<void> {
    return this.#notifications.run(() => this.#flushNotifications());
  }

  /** Epoch numbers are local to a repository, not globally unique queue keys. */
  #cancellationKey(id: EpochIdentity): string {
    return `canceled:${id.repo}:${id.epoch_id}`;
  }

  /** Read the permanent fence independently of individual assignment existence. */
  async #isCanceled(id: EpochIdentity): Promise<boolean> {
    return await this.state.storage.get<boolean>(this.#cancellationKey(id)) ===
      true;
  }

  /** Load a job, rejecting incompatible persisted schemas rather than guessing. */
  async #readJob(id: string): Promise<QueueJob | undefined> {
    const record = await this.state.storage.get<QueueJob>(`job:${id}`);
    if (record && record.job.version !== STATE_VERSION) {
      throw new BrokerConflict(
        "old queue state; use a fresh celld state directory",
      );
    }
    if (
      record && record.state !== "complete" &&
      await this.#isCanceled(record.job)
    ) {
      // A single durable epoch tombstone atomically cancels an arbitrary number
      // of jobs; no partially rewritten job list can become claimable again.
      record.state = "canceled";
      record.lease_until = null;
    }
    return record;
  }

  /** Atomically persist both a new assignment and its deterministic scan order. */
  async #enqueue(input: Job): Promise<EnqueueReceipt> {
    const job = this.#validateJob(input as unknown as JsonObject);
    if (await this.#isCanceled(job)) {
      throw new BrokerConflict("job epoch is canceled");
    }
    const existing = await this.#readJob(job.id);
    if (existing) {
      if (JSON.stringify(existing.job) !== JSON.stringify(job)) {
        throw new BrokerConflict("job id already has a different assignment");
      }
      await this.state.storage.sync();
      return { created: false, job_id: job.id };
    }
    const name = await this.state.storage.get<string>("name");
    if (name !== undefined && name !== job.queue) {
      throw new BrokerConflict("assignment names a different queue");
    }
    const order = await this.state.storage.get<string[]>("order") ?? [];
    const record: QueueJob = {
      job,
      state: "pending",
      attempts: 0,
      lease_token: null,
      lease_until: null,
      agent_id: null,
      result_ref: null,
      completed_at: null,
      notified: false,
      created_at: Date.now(),
    };
    await this.state.storage.put<unknown>({
      [`job:${job.id}`]: record,
      order: [...order, job.id],
      name: job.queue,
    });
    await this.state.storage.sync();
    return { created: true, job_id: job.id };
  }

  /** Lease only compatible work; expired leases receive a strictly newer fence. */
  async #claim(input: ClaimRequest): Promise<ClaimedJob | null> {
    const agent = requireName(input.agent_id, "agent_id");
    const lease = this.#leaseDuration(input.lease_ms);
    const platforms = this.#capabilities(input.platforms, "platforms");
    const kinds = this.#capabilities(input.kinds, "kinds");
    if (kinds.some((kind) => !JOB_KINDS.includes(kind as Job["kind"]))) {
      throw new TypeError("unsupported job kind capability");
    }
    const order = await this.state.storage.get<string[]>("order") ?? [];
    const now = Date.now();
    for (const id of order) {
      const record = await this.#readJob(id);
      if (
        !record || record.state === "complete" || record.state === "canceled" ||
        (record.state === "leased" && record.lease_until !== null &&
          record.lease_until > now)
      ) continue;
      if (
        !kinds.includes(record.job.kind) ||
        (record.job.kind !== "plan_epoch" &&
          !platforms.includes(record.job.platform))
      ) continue;
      record.attempts = requireInteger(record.attempts + 1, "attempts", 1);
      record.state = "leased";
      record.agent_id = agent;
      record.lease_token = record.attempts;
      record.lease_until = now + lease;
      await persist(this.state.storage, `job:${id}`, record);
      return {
        ...record.job,
        lease_token: record.lease_token,
        lease_until: record.lease_until,
        attempts: record.attempts,
        agent_id: agent,
      };
    }
    return null;
  }

  /** Bound each claim/renewal, not the total lifetime of a healthy agent's job. */
  #leaseDuration(value: unknown): number {
    const lease = value === undefined
      ? DEFAULT_LEASE_MS
      : requireInteger(value, "lease_ms", MIN_LEASE_MS);
    if (lease > MAX_LEASE_MS) {
      throw new TypeError(`lease_ms must be at most ${MAX_LEASE_MS}`);
    }
    return lease;
  }

  /** Extend only the current live fence; retries never shorten an existing lease. */
  async #renew(input: RenewRequest): Promise<LeaseReceipt> {
    const id = requireString(input.job_id, "job_id");
    const agent = requireName(input.agent_id, "agent_id");
    const token = requireInteger(input.lease_token, "lease_token", 1);
    const duration = this.#leaseDuration(input.lease_ms);
    const record = await this.#readJob(id);
    if (!record) throw new BrokerConflict("job does not exist");
    if (record.agent_id !== agent || record.lease_token !== token) {
      throw new BrokerConflict("stale or foreign job lease");
    }
    const now = Date.now();
    if (
      record.state !== "leased" || record.lease_until === null ||
      record.lease_until <= now
    ) {
      throw new BrokerConflict("job lease is not live");
    }
    record.lease_until = Math.max(record.lease_until, now + duration);
    await persist(this.state.storage, `job:${id}`, record);
    return {
      job_id: id,
      agent_id: agent,
      lease_token: token,
      lease_until: record.lease_until,
    };
  }

  /** Accept verified evidence exactly once, then replay the notification outbox. */
  async #complete(input: CompleteRequest): Promise<CompletionReceipt> {
    const id = requireString(input.job_id, "job_id");
    const agent = requireName(input.agent_id, "agent_id");
    const token = requireInteger(input.lease_token, "lease_token", 1);
    const ref = artifactRef(input.result_ref);
    const holder = { job_id: id, agent_id: agent, lease_token: token };
    const before = await this.#serial.run(() =>
      this.#completionRecord(holder, ref)
    );
    let receipt: CompletionReceipt;
    if (before.state === "complete") {
      receipt = { accepted: true, duplicate: true, job_id: id };
    } else {
      let result: unknown;
      try {
        // No queue-wide lease lock may span remote reads. The holder (including
        // this same agent) can renew while R2 is slow, and cancellation/reclaim
        // can proceed. Never use the pre-read ledger snapshot to accept evidence.
        result = await getArtifact(this.env.ARTIFACTS, ref);
      } catch (error) {
        if (/artifact (size|integrity) mismatch/.test(errorMessage(error))) {
          throw new TypeError(errorMessage(error));
        }
        throw error;
      }
      receipt = await this.#serial.run(async () => {
        const record = await this.#completionRecord(holder, ref);
        if (record.state === "complete") {
          return { accepted: true, duplicate: true, job_id: id };
        }
        this.#validateResult(record.job, result);
        record.state = "complete";
        record.result_ref = ref;
        record.completed_at = Date.now();
        record.notified = false;
        // Arm first: a crash after the ledger write but before send must still
        // wake the outbox. An early alarm with no accepted result is harmless.
        await this.state.storage.setAlarm(Date.now() + NOTIFICATION_RETRY_MS);
        await persist(this.state.storage, `job:${id}`, record);
        return { accepted: true, duplicate: false, job_id: id };
      });
    }
    await this.#notifications.run(() => this.#flushNotifications());
    return receipt;
  }

  /** Re-read the live ownership fence both before and after remote evidence I/O. */
  async #completionRecord(
    holder: LeaseHolder,
    ref: ArtifactRef,
  ): Promise<QueueJob> {
    const { job_id: id, agent_id: agent, lease_token: token } = holder;
    const record = await this.#readJob(id);
    if (!record) throw new BrokerConflict("job does not exist");
    if (record.agent_id !== agent || record.lease_token !== token) {
      throw new BrokerConflict("stale or foreign job lease");
    }
    if (record.state === "complete") {
      if (
        !record.result_ref || record.result_ref.key !== ref.key ||
        record.result_ref.sha256 !== ref.sha256 ||
        record.result_ref.size !== ref.size
      ) {
        throw new BrokerConflict(
          "completed job has a different result artifact",
        );
      }
      // Preserve exact receipts even after an epoch fence or lease expiry. The
      // evidence was already accepted; cancellation must not rewrite history.
      await this.state.storage.sync();
      return record;
    }
    if (
      record.state !== "leased" || record.lease_until === null ||
      record.lease_until <= Date.now()
    ) {
      throw new BrokerConflict("job lease expired");
    }
    return record;
  }

  /** Durable at-least-once delivery; duplicate notifications are safe hints. */
  async #flushNotifications(): Promise<void> {
    const order = await this.#serial.run(async () => {
      await this.state.storage.setAlarm(Date.now() + NOTIFICATION_RETRY_MS);
      await this.state.storage.sync();
      return await this.state.storage.get<string[]>("order") ?? [];
    });
    for (const id of order) {
      const record = await this.#serial.run(() => this.#readJob(id));
      if (!record || record.state !== "complete" || record.notified) continue;
      await this.env.EVENTS.send({
        kind: "result",
        epoch: {
          repo: record.job.repo,
          epoch_id: record.job.epoch_id,
          workflow_id: record.job.workflow_id,
        },
      });
      await this.#serial.run(async () => {
        // Re-read before changing the ledger after an outbound await. Accepted
        // evidence is immutable, while other requests may have run meanwhile.
        const current = await this.#readJob(id);
        if (current?.state === "complete" && !current.notified) {
          current.notified = true;
          await persist(this.state.storage, `job:${id}`, current);
        }
      });
    }
    await this.#serial.run(async () => {
      // A completion for a newly enqueued job may have arrived during delivery.
      // Never clear its only durable wake-up based on the old order snapshot.
      const current = await this.state.storage.get<string[]>("order") ?? [];
      for (const id of current) {
        const record = await this.#readJob(id);
        if (record?.state === "complete" && !record.notified) return;
      }
      await this.state.storage.deleteAlarm();
      await this.state.storage.sync();
    });
  }

  /** Expose bounded per-job metadata without copying manifests or test blobs. */
  async #summary(): Promise<BrokerSummary> {
    const order = await this.state.storage.get<string[]>("order") ?? [];
    const counts = { pending: 0, leased: 0, complete: 0, canceled: 0 };
    const jobs: BrokerSummary["jobs"] = [];
    const now = Date.now();
    for (const id of order) {
      const record = await this.#readJob(id);
      if (!record) continue;
      const effective =
        record.state === "leased" && (record.lease_until ?? 0) <= now
          ? "pending"
          : record.state;
      counts[effective]++;
      jobs.push({
        id,
        kind: record.job.kind,
        state: effective,
        attempts: record.attempts,
        agent_id: record.agent_id,
        lease_token: record.lease_token,
        lease_until: record.lease_until,
        result_ref: record.result_ref,
        completed_at: record.completed_at,
        notified: record.notified,
      });
    }
    return {
      name: await this.state.storage.get<string>("name") ?? null,
      counts,
      jobs,
    };
  }

  /** Capability lists are explicit, finite, and duplicate-free. */
  #capabilities(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 64) {
      throw new TypeError(`${field} must contain 1 to 64 capabilities`);
    }
    const values = value.map((entry) => requireString(entry, field));
    if (new Set(values).size !== values.length) {
      throw new TypeError(`${field} contains duplicate capabilities`);
    }
    return values;
  }

  /** Reject malformed internal jobs before any immutable assignment is stored. */
  #validateJob(input: JsonObject): Job {
    if (
      input.version !== STATE_VERSION ||
      !JOB_KINDS.includes(input.kind as Job["kind"])
    ) throw new TypeError("unsupported job version or kind");
    for (const key of ["id", "revision"]) requireString(input[key], key);
    for (const key of ["repo", "epoch_id", "workflow_id", "queue"]) {
      requireName(input[key], key);
    }
    if (input.kind === "plan_epoch") {
      if (input.base_revision !== null) {
        requireString(input.base_revision, "base_revision");
      }
    } else {
      requireString(input.platform, "platform");
      if (
        !Array.isArray(input.tests) || !input.tests.length ||
        input.tests.length > 10_000
      ) throw new TypeError("job tests must be a nonempty bounded array");
      const ids = new Set<string>();
      const keys = new Set<string>();
      for (const test of input.tests) {
        if (!test || typeof test !== "object" || Array.isArray(test)) {
          throw new TypeError("job test must be an object");
        }
        const id = requireName(test.id, "test.id");
        const key = requireString(test.test_key, "test.test_key");
        requireString(test.label, "test.label");
        if (ids.has(id) || keys.has(key)) {
          throw new TypeError("job contains duplicate tests");
        }
        ids.add(id);
        keys.add(key);
      }
      if (input.kind === "plan_culprit") {
        requireString(input.base_revision, "base_revision");
        if (
          input.tests.length !== 1 || input.base_revision === input.revision
        ) {
          throw new TypeError(
            "culprit job requires one test and distinct endpoints",
          );
        }
      } else {
        requireString(input.manifest_digest, "manifest_digest");
        requireString(input.batch_id, "batch_id");
        requireInteger(input.shard, "shard");
        requireInteger(input.round, "round");
        if (
          !["initial", "deflake", "culprit", "infra_retry"].includes(
            input.purpose as string,
          )
        ) throw new TypeError("invalid test job purpose");
      }
    }
    return input as unknown as Job;
  }

  /** Evidence must match the leased assignment before it becomes authoritative. */
  #validateResult(job: Job, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("job result must be an object");
    }
    const result = value as JobResult;
    if (result.kind === "job_error") {
      if (
        typeof result.message !== "string" || !result.message.length ||
        result.message.length > 4096
      ) throw new TypeError("job_error requires a bounded diagnostic");
      return;
    }
    if (result.kind !== job.kind) {
      throw new TypeError("result kind does not match the leased job");
    }
    if (result.kind === "plan_epoch" && job.kind === "plan_epoch") {
      normalizeManifest(result.manifest, job.base_revision, job.revision);
    } else if (result.kind === "run_tests" && job.kind === "run_tests") {
      if (
        !Array.isArray(result.tests) || result.tests.length !== job.tests.length
      ) throw new TypeError("test result must cover exactly the leased tests");
      const remaining = new Set(job.tests.map((test) => test.id));
      for (const test of result.tests) {
        if (!test || !remaining.delete(test.test_id)) {
          throw new TypeError(
            "test result contains a duplicate or unleased test",
          );
        }
        requireOutcome(test.outcome);
        requireInteger(test.duration_ms, "duration_ms");
      }
      if (remaining.size) {
        throw new TypeError("test result omitted leased tests");
      }
    } else if (result.kind === "plan_culprit" && job.kind === "plan_culprit") {
      const plan = result.plan;
      if (
        !plan || plan.version !== 1 ||
        plan.base_revision !== job.base_revision ||
        plan.revision !== job.revision ||
        plan.test_key !== job.tests[0].test_key ||
        !Array.isArray(plan.suspects) || !plan.suspects.length ||
        plan.suspects.length > 128
      ) {
        throw new TypeError("culprit plan does not match the leased interval");
      }
      const seen = new Set<string>([plan.base_revision]);
      for (const suspect of plan.suspects) {
        if (!suspect) throw new TypeError("invalid culprit suspect");
        requireString(suspect.revision, "suspect.revision");
        if (
          seen.has(suspect.revision) || typeof suspect.affected !== "boolean" ||
          typeof suspect.test_changed !== "boolean" ||
          (suspect.test_changed && !suspect.affected)
        ) throw new TypeError("invalid or duplicate culprit suspect");
        seen.add(suspect.revision);
      }
      if (plan.suspects.at(-1)?.revision !== job.revision) {
        throw new TypeError(
          "culprit interval must include the failing revision last",
        );
      }
    }
  }
}
