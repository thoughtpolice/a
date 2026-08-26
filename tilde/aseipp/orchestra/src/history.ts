// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * D1-backed historical query projection.
 *
 * Durable Objects remain authoritative for repository, epoch, and queue state.
 * This module projects completed transitions into one relational D1 database so
 * the stateless Worker can answer cross-epoch queries efficiently. Every write
 * is an idempotent upsert, which lets a queue safely retry result delivery.
 *
 * The prototype initializes its schema lazily. A production deployment should
 * move the same schema into numbered `celld d1 migrations` files.
 *
 * @module
 */

import { errorMessage, responseError, responseJson } from "./util/http.ts";
import { ensureHistory } from "./util/history.ts";
import type {
  EpochState,
  HistoryEpochRow,
  OrchestraEnvironment,
  TestState,
} from "./model.ts";

/** Relational read-model schema created for each configured history database. */
/**
 * Inserts or refreshes an epoch summary in the D1 read model.
 *
 * Immutable identity fields are inserted once. Mutable lifecycle state and
 * counters are refreshed on conflict, making repeated initialization safe.
 * Timed-out Workflow callbacks can continue running; a late nonterminal write
 * must not regress a terminal row after its publication journal is complete.
 */
export async function indexEpoch(
  database: D1Database,
  epoch: EpochState,
): Promise<void> {
  await ensureHistory(database);
  await database.prepare(`
    INSERT INTO epochs (
      repo, epoch_id, sequence, previous_revision, revision, queue, state,
      expected, completed, passed, failed, infra_failed, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, epoch_id) DO UPDATE SET
      state = excluded.state,
      expected = excluded.expected,
      completed = excluded.completed,
      passed = excluded.passed,
      failed = excluded.failed,
      infra_failed = excluded.infra_failed,
      completed_at = excluded.completed_at
    WHERE epochs.state NOT IN ('complete', 'failed')
       OR excluded.state IN ('complete', 'failed')
  `).bind(
    epoch.repo,
    epoch.epoch_id,
    epoch.sequence,
    epoch.previous_revision,
    epoch.revision,
    epoch.queue,
    epoch.state,
    epoch.counts.expected,
    epoch.counts.completed,
    epoch.counts.pass,
    epoch.counts.fail,
    epoch.counts.infra_failure,
    epoch.created_at,
    epoch.completed_at,
  ).run();
}

/**
 * Projects one completed test and its updated epoch counters atomically.
 *
 * The D1 batch prevents readers from observing a test result without its epoch
 * aggregate. An incomplete test is ignored because there is nothing to index.
 */
export async function indexResult(
  database: D1Database,
  epoch: EpochState,
  test: TestState,
): Promise<void> {
  if (test.result === null) return;
  await ensureHistory(database);
  await database.batch([
    database.prepare(`
      INSERT INTO test_results (
        repo, epoch_id, test_id, label, outcome, duration_ms,
        attempt, agent_id, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (repo, epoch_id, test_id) DO UPDATE SET
        outcome = excluded.outcome,
        duration_ms = excluded.duration_ms,
        attempt = excluded.attempt,
        agent_id = excluded.agent_id,
        completed_at = excluded.completed_at
    `).bind(
      epoch.repo,
      epoch.epoch_id,
      test.id,
      test.label,
      test.result.outcome,
      test.result.duration_ms,
      test.result.attempt,
      test.result.agent_id,
      test.result.completed_at,
    ),
    database.prepare(`
      UPDATE epochs SET
        state = ?, completed = ?, passed = ?, failed = ?, infra_failed = ?, completed_at = ?
      WHERE repo = ? AND epoch_id = ?
    `).bind(
      epoch.state,
      epoch.counts.completed,
      epoch.counts.pass,
      epoch.counts.fail,
      epoch.counts.infra_failure,
      epoch.completed_at,
      epoch.repo,
      epoch.epoch_id,
    ),
  ]);
}

/**
 * Serves the repository history API from D1.
 *
 * The `limit` query parameter defaults to 100 and is bounded to 1–1000. D1
 * failures become 503 responses so callers can distinguish read-model
 * unavailability from missing scheduler state.
 *
 * @param request Public history request carrying the optional limit.
 * @param env Orchestra bindings containing the history D1 database.
 * @param repo Validated repository whose epochs should be returned.
 */
export async function historyResponse(
  request: Request,
  env: OrchestraEnvironment,
  repo: string,
): Promise<Response> {
  try {
    await ensureHistory(env.HISTORY);
    const rawLimit = new URL(request.url).searchParams.get("limit") ?? "100";
    const parsedLimit = Number(rawLimit);
    if (
      !Number.isSafeInteger(parsedLimit) || parsedLimit < 1 ||
      parsedLimit > 1_000
    ) {
      throw new TypeError("limit must be an integer between 1 and 1000");
    }
    const history = await env.HISTORY.prepare<HistoryEpochRow>(`
      SELECT repo, epoch_id, sequence, previous_revision, revision, queue, state,
             expected, completed, passed, failed, infra_failed, created_at, completed_at
      FROM epochs
      WHERE repo = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).bind(repo, parsedLimit).all();
    return responseJson({ repo, epochs: history.results });
  } catch (error) {
    return responseError(503, "history query failed", errorMessage(error));
  }
}
