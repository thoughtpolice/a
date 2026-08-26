// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Private named service entrypoint for the Queue consumer. Queue deliveries
 * create a Workflow once and record durable agent-result delivery receipts.
 * Optional experimental event mode also wakes a waiting Workflow.
 * celld 0.5.0 createBatch() skips retained IDs, but those IDs expire. The epoch
 * ledger guards terminal replays independently of the engine's retention window.
 * Nothing here interprets test evidence or advances coverage. @module
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Notification, OrchestraEnvironment } from "./model.ts";
import { epochStub } from "./util/objects.ts";
import { unwrapRpc } from "./util/rpc.ts";
import { isTerminalEpoch } from "./util/workflow_history.ts";
/** Service RPC exported as the consumer's ORCHESTRA binding. */
export class Notifications extends WorkerEntrypoint<OrchestraEnvironment> {
  /** Ack is safe only once durable kickoff and receipt operations succeed. */
  async deliver(message: Notification): Promise<void> {
    if (
      !message || !["kickoff", "result"].includes(message.kind) ||
      !message.epoch ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(message.epoch.workflow_id)
    ) {
      throw new TypeError("invalid notification");
    }
    const id = message.epoch;
    const stub = epochStub(this.env, id);
    const epoch = await stub.getState();
    if (!epoch) throw new Error("epoch not found");
    if (
      epoch.workflow_id !== id.workflow_id || epoch.repo !== id.repo ||
      epoch.epoch_id !== id.epoch_id
    ) throw new TypeError("notification does not match the epoch identity");
    // Engine history expires independently of domain state. A delayed kickoff
    // must not recreate it, and a late result needs only its durable receipt.
    if (isTerminalEpoch(epoch.state)) {
      unwrapRpc(await stub.recordNotification());
      return;
    }
    if (message.kind === "kickoff") {
      await this.env.EPOCH_RUNS.createBatch([{
        id: id.workflow_id,
        params: id,
      }]);
    }
    // celld can retain a SQLite event cursor across Workflow activities.
    // Default durable polling never appends unused events to that ledger.
    // Event waits still hit intermittent 0.5.1 SQLite locks and remain opt-in.
    // An active Workflow is already reconciling and needs no additional wake.
    if (this.env.WORKFLOW_WAKE_MODE === "events") {
      const instance = await this.env.EPOCH_RUNS.get(id.workflow_id);
      const status = await instance.status();
      if (status.status === "waiting") {
        try {
          await instance.sendEvent({
            type: "result",
            payload: { epoch_id: id.epoch_id },
          });
        } catch (error) {
          // Completion can race delivery. Only terminal status makes this harmless.
          if (
            !["complete", "errored", "terminated"].includes(
              (await instance.status()).status,
            )
          ) throw error;
        }
      }
    }
    unwrapRpc(await stub.recordNotification());
  }
}
