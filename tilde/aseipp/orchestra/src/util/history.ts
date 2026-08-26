// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema-initialization utilities for the D1 history projection.
 *
 * The public history adapter owns projection queries and writes; this support
 * module owns the prototype's lazy schema bootstrap and its per-binding promise
 * cache. Production should replace lazy bootstrap with numbered migrations.
 *
 * @module
 */

/** Relational read-model schema created for each configured history database. */
const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS epochs (
  repo TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  previous_revision TEXT,
  revision TEXT NOT NULL,
  queue TEXT NOT NULL,
  state TEXT NOT NULL,
  expected INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  infra_failed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (repo, epoch_id),
  UNIQUE (repo, revision)
);
CREATE TABLE IF NOT EXISTS test_results (
  repo TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  label TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, epoch_id, test_id),
  FOREIGN KEY (repo, epoch_id) REFERENCES epochs (repo, epoch_id)
);
CREATE INDEX IF NOT EXISTS test_results_outcome
  ON test_results (repo, outcome, completed_at DESC);
`;

/** Per-binding initialization promises, shared by callers in one isolate. */
const historyReady = new WeakMap<D1Database, Promise<D1ExecResult>>();

/**
 * Ensures the history schema exists before a query or projection write.
 *
 * Failed initialization is evicted from the cache so a later delivery can
 * retry after a transient D1 failure.
 */
export async function ensureHistory(database: D1Database): Promise<void> {
  let ready = historyReady.get(database);
  if (ready === undefined) {
    ready = database.exec(HISTORY_SCHEMA);
    historyReady.set(database, ready);
  }
  try {
    await ready;
  } catch (error) {
    historyReady.delete(database);
    throw error;
  }
}
