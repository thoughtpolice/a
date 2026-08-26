// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Epoch Durable Object: a replay-safe state/read-model ledger, not a scheduler.
 * The Workflow is its single policy writer. Typed RPC exposes initialization,
 * snapshot reads, compare-and-swap replacement, and notification accounting.
 * Each operation shares one serializer; acknowledgements follow storage.sync().
 * Notification counters merge independently of Workflow snapshot generations.
 * A separate terminal-publication journal/alarm survives exhausted Workflows;
 * external I/O never holds the snapshot serializer or blocks repository reads.
 * @module
 */
import { DurableObject } from "cloudflare:workers";
import type { EpochState, OrchestraEnvironment } from "./model.ts";
import { persist, Serial } from "./util/objects.ts";
import { STATE_VERSION } from "./util/constants.ts";
import { RpcFault, rpcGuard, type RpcResult } from "./util/rpc.ts";
import { unwrapRpc } from "./util/rpc.ts";
import {
  type FinalizationProgress,
  newFinalization,
  prepareTerminalPublication,
  projectFinalizationBatch,
} from "./util/finalization.ts";
import { isTerminalEpoch } from "./util/workflow_history.ts";

/** Retry publication independently of the finite Workflow activity budgets. */
const FINALIZATION_RETRY_MS = 1_000;

/** Durable snapshot boundary for one milestone Workflow. */
export class EpochLedger extends DurableObject<OrchestraEnvironment> {
  /** RPC awaits may interleave; serialize the complete read/check/write cycle. */
  readonly #serial = new Serial();
  /** Coalesce alarm/Workflow publication without blocking ordinary ledger RPC. */
  readonly #publication = new Serial();

  /** Bind the named cell to its durable storage and Orchestra environment. */
  constructor(
    readonly state: DurableObjectState,
    env: OrchestraEnvironment,
  ) {
    super(state, env);
  }

  /**
   * Load the authoritative snapshot, refusing incompatible persisted schemas.
   * Guarded mutations convert conflicts to RpcResult data; raw reads reject with
   * an ordinary Error and do not depend on custom fields surviving transport.
   */
  async #read(guardedMutation = false): Promise<EpochState | null> {
    const current = await this.state.storage.get<EpochState>("epoch");
    if (current && current.version !== STATE_VERSION) {
      const message = "old state; use a fresh celld state directory";
      throw guardedMutation ? new RpcFault(409, message) : new Error(message);
    }
    return current ?? null;
  }

  /** Retain the old object-shaped payload check at the untrusted RPC boundary. */
  #validateSnapshot(input: EpochState): void {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new TypeError("epoch snapshot must be an object");
    }
  }

  /** Read a cloned snapshot, or null while reservation initialization is pending. */
  getState(): Promise<EpochState | null> {
    return this.#serial.run(() => this.#read());
  }

  /**
   * Durably install the reservation once. Replayed kickoff delivery returns the
   * existing ledger without replacing Workflow progress or notification counts.
   */
  initialize(input: EpochState): Promise<EpochState> {
    return this.#serial.run(async () => {
      const current = await this.#read();
      this.#validateSnapshot(input);
      if (current) return current;
      await this.#storeSnapshot(input);
      return input;
    });
  }

  /**
   * Replace the matching Workflow generation and return its new generation.
   * Stale writers receive 409; independent notification increments are merged
   * from the latest stored record rather than overwritten by the caller's copy.
   */
  save(input: EpochState): Promise<RpcResult<{ generation: number }>> {
    return this.#serial.run(() =>
      rpcGuard(async () => {
        const current = await this.#read(true);
        this.#validateSnapshot(input);
        if (!current) throw new RpcFault(404, "ledger route not found");
        if (
          input.generation !== current.generation ||
          input.workflow_id !== current.workflow_id
        ) {
          throw new RpcFault(409, "stale epoch generation");
        }
        if (isTerminalEpoch(current.state)) {
          throw new RpcFault(409, "terminal epoch cannot be replaced");
        }
        input.generation++;
        input.notifications_received = current.notifications_received;
        await this.#storeSnapshot(input);
        return { generation: input.generation };
      })
    );
  }

  /** Arm recovery before atomically writing terminal truth and its obligation. */
  async #storeSnapshot(epoch: EpochState): Promise<void> {
    if (!isTerminalEpoch(epoch.state)) {
      await persist(this.state.storage, "epoch", epoch);
      return;
    }
    await this.state.storage.setAlarm(Date.now() + FINALIZATION_RETRY_MS);
    await this.state.storage.put({ epoch, finalization: newFinalization() });
    await this.state.storage.sync();
  }

  /**
   * Publish one bounded terminal batch; true means the successor was released.
   * A false reply retains the alarm and lets a live Workflow request another
   * batch immediately. Errors also retain recovery, even if engine history is
   * permanently errored, expired, or deleted. Terminal snapshots are immutable;
   * notification accounting can continue without invalidating the cursor.
   */
  finalize(): Promise<boolean> {
    return this.#publication.run(async () => {
      const { epoch, progress } = await this.#serial.run(async () => {
        const epoch = await this.#read();
        if (!epoch || !isTerminalEpoch(epoch.state)) {
          throw new Error("epoch is not terminal");
        }
        const progress = await this.state.storage.get<FinalizationProgress>(
          "finalization",
        ) ?? newFinalization();
        if (!progress.done) {
          await this.state.storage.setAlarm(Date.now() + FINALIZATION_RETRY_MS);
        } else {
          // Also repairs an ambiguous failure after writing the done marker.
          await this.state.storage.deleteAlarm();
        }
        return { epoch, progress };
      });
      if (progress.done) return true;
      const report = await prepareTerminalPublication(this.env, epoch);
      if (!epoch.report_ref) {
        await this.#serial.run(async () => {
          // Publication may fill this append-only reference, never replace the
          // terminal policy/evidence snapshot or concurrent notification counts.
          const current = (await this.#read())!;
          current.report_ref = report;
          await persist(this.state.storage, "epoch", current);
          epoch.report_ref = report;
        });
      }
      const next = await projectFinalizationBatch(this.env, epoch, progress);
      await this.#serial.run(() =>
        persist(this.state.storage, "finalization", next)
      );
      if (next.next_test < Object.keys(epoch.tests).length) return false;
      // Repository.finish reads this ledger: never hold #serial across the RPC.
      unwrapRpc(
        await this.env.REPOSITORY.getByName(epoch.repo).finish(epoch.epoch_id),
      );
      await this.#serial.run(async () => {
        await persist(this.state.storage, "finalization", {
          ...next,
          done: true,
        });
        await this.state.storage.deleteAlarm();
      });
      return true;
    });
  }

  /** Recover terminal publication independently of Queue hints and Workflows. */
  async alarm(): Promise<void> {
    // An alarm may have been armed immediately before a failed terminal write.
    const epoch = await this.getState();
    if (!epoch || !isTerminalEpoch(epoch.state)) return;
    await this.finalize();
  }

  /** Durably count one accepted notification independently of policy generation. */
  recordNotification(): Promise<RpcResult<{ ok: true }>> {
    return this.#serial.run(() =>
      rpcGuard(async () => {
        const current = await this.#read(true);
        if (!current) throw new RpcFault(404, "epoch not found");
        current.notifications_received++;
        await persist(this.state.storage, "epoch", current);
        return { ok: true as const };
      })
    );
  }
}
