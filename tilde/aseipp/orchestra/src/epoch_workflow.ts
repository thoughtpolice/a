// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * celld Workflow owning one epoch's durable lifecycle. Replayed activities
 * dispatch/collect agent jobs, deflake failures, investigate culprits, publish
 * R2 reports, and advance the repository frontier. Queues deliver kickoff and
 * result receipts; durable sleeps reconcile agent results even if notifications
 * are lost/dead-lettered. Native event waits are experimental: the 0.5.1 E2E
 * still observes intermittent SQLite locks in that mode.
 * @module
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { EpochIdentity, OrchestraEnvironment } from "./model.ts";
import { advanceEpoch, failEpoch } from "./util/workflow.ts";
import { errorMessage } from "./util/http.ts";
import { ReconciliationBudget } from "./util/scheduling.ts";
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
        const pacing = budget.next(progress);
        if (progress.wait) {
          if (
            this.env.WORKFLOW_WAKE_MODE === "events" &&
            (pacing.remaining_ms === null || pacing.remaining_ms >= 1_000)
          ) {
            try {
              await step.waitForEvent("wake-" + round, {
                type: "result",
                timeout: Math.min(60_000, pacing.remaining_ms ?? 60_000),
              });
            } catch {
              /* Timeout is a durable reconciliation tick, not test evidence. */
            }
          } else {
            // celld waitForEvent can leave a native SQLite cursor open
            // across an asynchronous activity. The observed ledger locks are
            // consistent with checkpoint writes staling that read snapshot;
            // the exact interaction is not yet proven. Persisted sleeps avoid
            // the affected runtime path without suppressing storage errors.
            // 0.5.1 event mode still exhibits intermittent SQLite locks;
            // retain polling until that path is reliable upstream.
            // Decisions use the successful activity's recorded observation,
            // never a fresh clock read in replayed Workflow control flow. A
            // runtime outage can delay this wake; the next live activity checks
            // the original deadline before dispatching any further work.
            await step.sleep("poll-" + round, pacing.delay_ms);
          }
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
