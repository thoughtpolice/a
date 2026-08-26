// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Resumable publication of terminal epoch truth into the historical read model.
 *
 * EpochLedger owns the durable cursor and alarm. Preparation fences obsolete
 * agent work and fills any missing report, then publication projects a bounded
 * batch of tests; the ledger checkpoints its cursor before releasing the
 * repository's successor. Repeated D1 writes and
 * cancellation are idempotent, including an ambiguous checkpoint failure.
 * @module
 */
import { indexEpoch, indexResult } from "../history.ts";
import type {
  ArtifactRef,
  EpochState,
  OrchestraEnvironment,
} from "../model.ts";
import { unwrapRpc } from "./rpc.ts";
import { putArtifact } from "./artifacts.ts";

/** Independent of Workflow history and notification/epoch generation counters. */
export interface FinalizationProgress {
  /** The epoch summary was successfully projected into D1. */
  indexed: boolean;
  /** Next entry in the immutable terminal snapshot's test list to publish. */
  next_test: number;
  /** D1 publication and idempotent repository release have both succeeded. */
  done: boolean;
}

/** Bound one RPC/alarm's publication work, not the total epoch size. */
export const FINALIZATION_BATCH_SIZE = 32;

/** New terminal obligations start at the beginning, never inferred from D1. */
export function newFinalization(): FinalizationProgress {
  return { indexed: false, next_test: 0, done: false };
}

/** Immutable report content shared by normal completion and alarm recovery. */
export function terminalReport(epoch: EpochState): unknown {
  return epoch.state === "failed"
    ? { repo: epoch.repo, epoch_id: epoch.epoch_id, error: epoch.error }
    : {
      version: epoch.version,
      repo: epoch.repo,
      epoch_id: epoch.epoch_id,
      revision: epoch.revision,
      manifest_ref: epoch.manifest_ref,
      counts: epoch.counts,
      policy: epoch.policy,
      tests: epoch.tests,
      coverage: epoch.coverage,
      deferred: epoch.deferred,
      inherited: epoch.inherited,
    };
}

/**
 * Fence obsolete work before any external projection/report can block recovery.
 * Failure recording does not depend on R2: a missing report is filled after the
 * terminal snapshot and alarm are durable. The caller persists the reference.
 */
export async function prepareTerminalPublication(
  env: OrchestraEnvironment,
  epoch: EpochState,
): Promise<ArtifactRef> {
  unwrapRpc(
    await env.JOB_QUEUE.getByName(epoch.queue).cancelEpoch({
      repo: epoch.repo,
      epoch_id: epoch.epoch_id,
      workflow_id: epoch.workflow_id,
    }),
  );
  return epoch.report_ref ??
    await putArtifact(env.ARTIFACTS, terminalReport(epoch));
}

/**
 * Project one prepared batch; persist the returned cursor before release.
 * No marker advances until every write in the batch succeeds. Partial batches
 * replay safely because D1 rows are upserts keyed by immutable epoch/test IDs.
 */
export async function projectFinalizationBatch(
  env: OrchestraEnvironment,
  epoch: EpochState,
  current: FinalizationProgress,
): Promise<FinalizationProgress> {
  if (!current.indexed) await indexEpoch(env.HISTORY, epoch);
  const tests = Object.values(epoch.tests);
  const next = Math.min(
    tests.length,
    current.next_test + FINALIZATION_BATCH_SIZE,
  );
  for (let index = current.next_test; index < next; index++) {
    await indexResult(env.HISTORY, epoch, tests[index]);
  }
  return { indexed: true, next_test: next, done: false };
}
