// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * The ordered milestone stream and TAP coverage frontier for one monorepo.
 * Epochs execute serially per repository; platform jobs within an epoch can run
 * concurrently. Typed RPC allocates/retrieves milestones and accepts idempotent
 * Workflow finalization. Reservations and a kickoff outbox are durable before
 * Queue send; alarms retry incomplete initialization and kickoff delivery.
 * Failed epochs never advance the successful comparison baseline.
 * @module
 */
import { DurableObject } from "cloudflare:workers";
import type {
  EpochPolicy,
  EpochState,
  OrchestraEnvironment,
  RepositoryState,
} from "./model.ts";
import { DEFAULT_QUEUE, STATE_VERSION } from "./util/constants.ts";
import { digest } from "./util/artifacts.ts";
import { epochStub, persist, Serial } from "./util/objects.ts";
import { requireName, requireString } from "./util/http.ts";
import { RpcFault, rpcGuard, type RpcResult } from "./util/rpc.ts";
import { parsePolicy } from "./util/workflow.ts";

/** Caller-selected milestone inputs; omitted policy fields receive frozen defaults. */
export interface EpochSubmission {
  /** Stable monorepo routing identity, matching this named Repository cell. */
  repo: string;
  /** Atomic commit revision to compare with the last successful milestone. */
  revision: string;
  /** Agent pool used for planning and execution; defaults to the default queue. */
  queue?: string;
  /** Bounded selection, retry, deflaking, and culprit-search policy overrides. */
  policy?: Partial<EpochPolicy>;
}

/** Stable reservation identity returned for new submissions and safe replays. */
export interface EpochSubmissionReceipt {
  /** Monorepo routing identity. */
  repo: string;
  /** Submitted atomic commit revision. */
  revision: string;
  /** Monotonic repository-local milestone identifier. */
  epoch_id: string;
  /** Deterministic celld Workflow identifier for the milestone. */
  workflow_id: string;
  /** True only when this call allocated a new reservation; maps to public HTTP 201. */
  created: boolean;
}

/** Serialized repository allocator; it never executes tests itself. */
export class Repository extends DurableObject<OrchestraEnvironment> {
  /** Covers complete read/check/write sequences across asynchronous RPC calls. */
  readonly #serial = new Serial();

  /** Bind the named cell to its durable stream and Orchestra runtime bindings. */
  constructor(
    readonly state: DurableObjectState,
    env: OrchestraEnvironment,
  ) {
    super(state, env);
  }

  /** Load the durable stream or its empty initial state; reject old schemas. */
  async #read(): Promise<RepositoryState> {
    const value = await this.state.storage.get<RepositoryState>("repository");
    if (value && value.version !== STATE_VERSION) {
      throw new Error("old repository state; use a fresh celld directory");
    }
    return value ??
      {
        version: STATE_VERSION,
        repo: null,
        next_sequence: 1,
        last_milestone: null,
        epochs: {},
        revisions: {},
        active: null,
        pending: [],
        outbox: null,
        coverage: {},
        catalog: {},
      };
  }
  /** Recover a reserved epoch and send its durable kickoff notification. */
  async #flush(repository: RepositoryState): Promise<void> {
    if (!repository.outbox) return;
    await this.state.storage.setAlarm(Date.now() + 1000);
    const epoch = repository.epochs[repository.outbox];
    await epochStub(this.env, epoch).initialize(epoch);
    await this.env.EVENTS.send({
      kind: "kickoff",
      epoch: {
        repo: epoch.repo,
        epoch_id: epoch.epoch_id,
        workflow_id: epoch.workflow_id,
      },
    });
    // Queue acceptance is not Workflow creation: retain the outbox/alarm until
    // the instance exists. Even an expired/dead-lettered kickoff is recoverable.
    try {
      // celld get() itself checks the durable instance; no second status RPC.
      await this.env.EPOCH_RUNS.get(epoch.workflow_id);
    } catch {
      return;
    }
    repository.outbox = null;
    // The initialized ledger owns this snapshot now. Do not retain a complete
    // historical coverage/catalog copy in every repository reservation.
    epoch.coverage = {};
    epoch.catalog = {};
    await persist(this.state.storage, "repository", repository);
    await this.state.storage.deleteAlarm();
  }
  /** Retry initialization or Queue publication after transient failures/restarts. */
  alarm(): Promise<void> {
    return this.#serial.run(async () => {
      await this.#flush(await this.#read());
    });
  }
  /** Read the ordered milestone summaries and current successful coverage frontier. */
  getState(): Promise<RepositoryState> {
    return this.#serial.run(() => this.#read());
  }

  /**
   * Finalize a terminal active milestone and make the next reservation runnable.
   * A replay is successful without advancing the stream twice. Unknown epochs
   * return 404; nonterminal active epochs return 409. Only successful epochs
   * transfer their coverage/catalog to the next milestone's comparison baseline.
   */
  finish(
    epochId: string,
  ): Promise<RpcResult<{ ok: true } | { duplicate: true }>> {
    return this.#serial.run(() =>
      rpcGuard(async (): Promise<{ ok: true } | { duplicate: true }> => {
        const repository = await this.#read();
        epochId = requireName(epochId, "epoch_id");
        const reserved = repository.epochs[epochId];
        if (!reserved) throw new RpcFault(404, "unknown epoch");
        if (repository.active !== epochId) return { duplicate: true };
        const epoch = await epochStub(this.env, reserved).getState();
        if (!epoch) throw new Error("epoch not found");
        if (epoch.state !== "complete" && epoch.state !== "failed") {
          throw new RpcFault(409, "epoch not terminal");
        }
        // Persist only the small submission summary in the repository stream.
        repository.epochs[epochId] = {
          ...reserved,
          coverage: {},
          catalog: {},
          state: epoch.state,
          counts: epoch.counts,
          completed_at: epoch.completed_at,
          report_ref: epoch.report_ref,
          error: epoch.error,
        };
        if (epoch.state === "complete") {
          repository.coverage = epoch.coverage;
          repository.catalog = epoch.catalog;
        }
        const nextId = repository.pending.shift() ?? null;
        repository.active = nextId;
        repository.outbox = nextId;
        if (nextId) {
          const next = repository.epochs[nextId];
          next.previous_revision = epoch.state === "complete"
            ? epoch.revision
            : epoch.previous_revision;
          next.coverage = repository.coverage;
          next.catalog = repository.catalog;
        }
        if (nextId) await this.state.storage.setAlarm(Date.now() + 1000);
        await persist(this.state.storage, "repository", repository);
        try {
          await this.#flush(repository);
        } catch (error) {
          console.error("kickoff deferred", error);
        }
        return { ok: true };
      })
    );
  }

  /**
   * Reserve a revision once, persisting its ordered identity before publication.
   * Matching resubmissions reuse that reservation; changed queue/policy options
   * return 409. Validation remains at runtime even for statically typed callers.
   */
  submitEpoch(
    input: EpochSubmission,
  ): Promise<RpcResult<EpochSubmissionReceipt>> {
    return this.#serial.run(() =>
      rpcGuard(async () => {
        const repository = await this.#read();
        if (
          input === null || Array.isArray(input) || typeof input !== "object"
        ) {
          throw new TypeError("epoch submission must be an object");
        }
        const repo = requireName(input.repo, "repo");
        const revision = requireString(input.revision, "revision");
        const queue = requireName(input.queue ?? DEFAULT_QUEUE, "queue");
        if (repository.repo && repository.repo !== repo) {
          throw new RpcFault(409, "repository identity conflict");
        }
        const priorId = repository.revisions[revision];
        if (priorId) {
          const prior = repository.epochs[priorId];
          if (
            prior.queue !== queue ||
            (input.policy !== undefined &&
              JSON.stringify(parsePolicy(input.policy)) !==
                JSON.stringify(prior.policy))
          ) {
            throw new RpcFault(
              409,
              "revision was submitted with different options",
            );
          }
          try {
            await this.#flush(repository);
          } catch (error) {
            console.error("kickoff deferred", error);
          }
          return {
            repo,
            revision,
            epoch_id: priorId,
            workflow_id: prior.workflow_id,
            created: false,
          };
        }
        const sequence = repository.next_sequence++;
        const epochId = `e${String(sequence).padStart(6, "0")}`;
        const workflowId = "epoch_" +
          await digest(new TextEncoder().encode(repo + ":" + epochId));
        // Last completed (not merely last submitted) revision is the graph frontier.
        const completed = Object.values(repository.epochs).filter((e) =>
          e.state === "complete"
        ).at(-1);
        const epoch: EpochState = {
          version: STATE_VERSION,
          generation: 0,
          repo,
          epoch_id: epochId,
          workflow_id: workflowId,
          sequence,
          previous_revision: completed?.revision ?? null,
          revision,
          queue,
          state: "queued",
          policy: parsePolicy(input.policy),
          manifest_ref: null,
          manifest_digest: null,
          report_ref: null,
          test_order: [],
          tests: {},
          batch_order: [],
          batches: {},
          processed_jobs: {},
          counts: {
            expected: 0,
            completed: 0,
            pass: 0,
            fail: 0,
            infra_failure: 0,
          },
          coverage: repository.active ? {} : repository.coverage,
          catalog: repository.active ? {} : repository.catalog,
          deferred: [],
          inherited: [],
          created_at: Date.now(),
          completed_at: null,
          notifications_received: 0,
        };
        repository.repo = repo;
        repository.last_milestone = revision;
        repository.revisions[revision] = epochId;
        repository.epochs[epochId] = epoch;
        if (repository.active) repository.pending.push(epochId);
        else {
          repository.active = epochId;
          repository.outbox = epochId;
        }
        await this.state.storage.setAlarm(Date.now() + 1000);
        await persist(this.state.storage, "repository", repository);
        try {
          await this.#flush(repository);
        } catch (error) {
          console.error("kickoff deferred", error);
        }
        return {
          repo,
          revision,
          epoch_id: epochId,
          workflow_id: workflowId,
          created: true,
        };
      })
    );
  }
}
