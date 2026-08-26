// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Translate celld's bounded execution-history lifetime into Orchestra's public
 * view without confusing engine availability with durable epoch/test outcomes.
 * Only a known missing-instance response is recoverable: locks, routing errors,
 * and other storage failures must remain visible to callers. @module
 */
import type {
  EpochState,
  EpochStatus,
  EpochWorkflowView,
  OrchestraEnvironment,
} from "../model.ts";

/** Terminal domain records survive engine expiry and must not restart execution. */
export function isTerminalEpoch(status: EpochStatus): boolean {
  return status === "complete" || status === "failed";
}

/**
 * Read retained engine status, or describe a missing record only when the epoch
 * is queued or terminal. celld 0.5.0 uses this exact error text for missing,
 * expired, and deleted IDs; the toolchain runtime contract test protects that
 * boundary. An absent instance for an active epoch is still an operational error.
 */
export async function workflowHistory(
  env: OrchestraEnvironment,
  epoch: Pick<EpochState, "workflow_id" | "state">,
): Promise<EpochWorkflowView> {
  const identity = {
    workflow_id: epoch.workflow_id,
    epoch_status: epoch.state,
  };
  try {
    const status = await (await env.EPOCH_RUNS.get(epoch.workflow_id)).status();
    return { ...status, ...identity, engine_history: "available" };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "WORKFLOW_ERROR: instance does not exist"
    ) throw error;
    if (epoch.state === "queued") {
      return {
        ...identity,
        engine_history: "not_created",
        status: "queued",
        output: null,
      };
    }
    if (isTerminalEpoch(epoch.state)) {
      return {
        ...identity,
        engine_history: "unavailable",
        status: null,
        output: null,
      };
    }
    throw error;
  }
}
