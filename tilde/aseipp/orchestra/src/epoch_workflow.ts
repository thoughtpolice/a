// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * celld Workflow owning one epoch's durable lifecycle. Replayed activities
 * dispatch/collect agent jobs, deflake failures, investigate culprits, publish
 * R2 reports, and advance the repository frontier. Queues deliver kickoff and
 * result receipts, and a result wakes the waiting Workflow with an event. Each
 * wait times out after a minute, so agent results are reconciled even if a
 * notification is lost or dead-lettered.
 * @module
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { EpochIdentity, OrchestraEnvironment } from "./model.ts";
import { advanceEpoch, failEpoch } from "./util/workflow.ts";
import { errorMessage } from "./util/http.ts";
import {
  MIN_EVENT_TIMEOUT_MS,
  ReconciliationBudget,
  WAKE_TIMEOUT_MS,
} from "./util/scheduling.ts";
/** One persisted instance per repository milestone, created with createBatch. */
export class EpochWorkflow
  extends WorkflowEntrypoint<OrchestraEnvironment, EpochIdentity> {
  /** Return only small terminal metadata; full evidence is in the R2 report. */
  async run(
    event: WorkflowEvent<EpochIdentity>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const id = event.payload;
    const budget = new ReconciliationBudget();
    try {
      for (let round = 0;; round++) {
        const progress = await step.do("reconcile-" + round, {
          retries: { limit: 5, delay: "1 second", backoff: "exponential" },
          timeout: "5 minutes",
        }, () => advanceEpoch(this.env, id));
        if (progress.done) return { ...id, state: progress.state };
        // Decisions use the successful activity's recorded observation, never
        // a fresh clock read in replayed Workflow control flow. A runtime
        // outage can delay a wake; the next live activity checks the original
        // deadline before dispatching any further work.
        const remaining = budget.next(progress);
        if (!progress.wait) continue;
        if (remaining < MIN_EVENT_TIMEOUT_MS) {
          await step.sleep("deadline-" + round, remaining);
          continue;
        }
        try {
          await step.waitForEvent("wake-" + round, {
            type: "result",
            timeout: Math.min(WAKE_TIMEOUT_MS, remaining),
          });
        } catch {
          /* Timeout is a durable reconciliation tick, not test evidence. */
        }
      }
    } catch (error) {
      const state = await step.do(
        "record-failure",
        () => failEpoch(this.env, id, errorMessage(error)),
      );
      return state === "complete"
        ? { ...id, state }
        : { ...id, state, error: errorMessage(error) };
    }
  }
}
