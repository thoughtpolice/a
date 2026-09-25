// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The library's Durable Objects:
 *
 * - `McpChangeHub`, behind `durableChangeSource`: one {@link ChangeLog}
 *   that every isolate serving `subscriptions/listen` long-polls, and that
 *   any request can publish to. The log lives in memory. Listeners are live
 *   connections, so there is nothing to recover after an eviction: the new
 *   instance starts a new epoch, pollers see a reset, and each listen stream
 *   tells its client that everything it watches may have changed.
 * - `McpTaskObject`, behind `durableTaskStore`: one object per task, named
 *   by the task id. It keeps the task in its SQLite storage and runs the
 *   tool's task body from its alarm, so the work outlives the request that
 *   created it. Subclass it to say which server it runs bodies for.
 * - `McpIdempotencyObject`, behind `durableIdempotencyStore`: one object
 *   per idempotency slot, named by the slot. It keeps the claim (with its
 *   token) and the answer in its SQLite storage, flushed before it
 *   answers, and deletes them from its alarm at the TTL.
 *
 * ```ts
 * export { McpChangeHub, McpIdempotencyObject } from "@celld/mcp/durable";
 * export class McpTasks extends McpTaskObject<Env> {
 *   taskServer() { return build(this.env).server; }
 * }
 * ```
 *
 * ```python
 * celld.project(..., bindings = {
 *     "MCP_CHANGES": "McpChangeHub",
 *     "MCP_IDEMPOTENCY": "McpIdempotencyObject",
 *     "MCP_TASKS": "McpTasks",
 * })
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { nonNegativeMs } from "@celld/core/bounds";
import type { ChangeHubApi } from "./hub.ts";
import type { IdempotencyClaim, IdempotencyObjectApi } from "./idempotency.ts";
import type { McpServer } from "./server.ts";
import {
  TaskCell,
  type TaskObjectApi,
  type TaskRecord,
  type TaskReply,
} from "./task_store.ts";
import type { InputResponses } from "./types.ts";
import {
  type ChangeBatch,
  type ChangeCursor,
  type ChangeEvent,
  ChangeLog,
  isChangeEvent,
} from "./subscriptions.ts";

export type { ChangeHubApi, IdempotencyObjectApi, TaskObjectApi };

/** The longest a poll may wait, below celld's 15 s default operation deadline. */
export const MAX_POLL_MS = 12_000;

/** The change hub Durable Object. */
export class McpChangeHub extends DurableObject implements ChangeHubApi {
  readonly #log = new ChangeLog();

  publish(event: ChangeEvent): number {
    if (!isChangeEvent(event)) {
      throw new TypeError(`not a change event: ${JSON.stringify(event)}`);
    }
    return this.#log.append(event);
  }

  poll(cursor: ChangeCursor | null, waitMs: number): Promise<ChangeBatch> {
    return this.#log.wait(
      cursor,
      Math.max(0, Math.min(Number(waitMs) || 0, MAX_POLL_MS)),
    );
  }
}

/**
 * One task, stored in this object's SQLite database and run from its
 * alarm. `create` writes the record, sets an alarm for now and waits for
 * durability before the server answers with the task handle. The alarm
 * handler runs the tool's task body (built by {@link taskServer}) inside
 * this object, apart from any request; RPCs for `tasks/get`, `tasks/update`
 * and `tasks/cancel` interleave with it. When the body needs input, the
 * task waits; the `tasks/update` that answers the last outstanding request
 * sets the alarm again. Cancelling aborts the body's signal. At the TTL the
 * alarm deletes the task.
 *
 * Alarms are delivered at least once: an alarm that throws, or whose object
 * is evicted mid-run, is retried, and the body then runs again from the top
 * with the state it last saved.
 */
export abstract class McpTaskObject<Env = unknown> extends DurableObject<Env>
  implements TaskObjectApi {
  #cell: TaskCell | null = null;

  /**
   * The server whose tools' task bodies this object runs; build it as the
   * Worker does, from `this.env`. It should be built once and reused.
   */
  abstract taskServer(): McpServer;

  get #task(): TaskCell {
    if (this.#cell !== null) return this.#cell;
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_task (k INTEGER PRIMARY KEY CHECK (k = 0), record TEXT NOT NULL)",
    ).toArray();
    const storage = this.ctx.storage;
    this.#cell = new TaskCell({
      load() {
        const rows = sql.exec("SELECT record FROM mcp_task WHERE k = 0")
          .toArray() as { record: string }[];
        return rows.length === 0 ? null : JSON.parse(rows[0].record);
      },
      save(record) {
        sql.exec(
          "INSERT INTO mcp_task (k, record) VALUES (0, ?) ON CONFLICT (k) DO UPDATE SET record = excluded.record",
          JSON.stringify(record),
        ).toArray();
      },
      async remove() {
        sql.exec("DELETE FROM mcp_task").toArray();
        await storage.deleteAlarm();
        await storage.sync();
      },
      async schedule(at) {
        if (at === null) await storage.deleteAlarm();
        else await storage.setAlarm(at);
      },
      async sync() {
        await storage.sync();
      },
    }, () => this.taskServer().taskRunner);
    return this.#cell;
  }

  create(record: TaskRecord): Promise<TaskReply<null>> {
    return this.#task.create(record);
  }

  get(owner: string): Promise<TaskReply<TaskRecord>> {
    return this.#task.get(owner);
  }

  update(
    owner: string,
    responses: InputResponses,
  ): Promise<TaskReply<null>> {
    return this.#task.update(owner, responses);
  }

  cancel(owner: string): Promise<TaskReply<null>> {
    return this.#task.cancel(owner);
  }

  async alarm(): Promise<void> {
    await this.#task.alarm();
  }
}

/**
 * The largest answer, as JSON text, one slot keeps: SQLite values in a
 * Durable Object are capped at 2 MB. `complete` throws past it, and the
 * server then records a -32603 for the key instead.
 */
export const MAX_IDEMPOTENT_RESULT_BYTES = 1_000_000;

/**
 * One idempotency slot, behind `durableIdempotencyStore`. `claim` reads
 * and writes without awaiting in between, so of any number of concurrent
 * claims exactly one is first, and the claim is flushed (`sync`) before
 * the server may run the call. The slot is deleted by the alarm set for
 * its expiry; a claim after that starts over, with a new token, and
 * `complete` records an answer only under the token of the live claim.
 */
export class McpIdempotencyObject extends DurableObject
  implements IdempotencyObjectApi {
  #ready = false;

  get #sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS mcp_idempotency (k INTEGER PRIMARY KEY CHECK (k = 0), token TEXT NOT NULL, expires_at INTEGER NOT NULL, done INTEGER NOT NULL, result TEXT)",
      ).toArray();
      this.#ready = true;
    }
    return sql;
  }

  async claim(ttlMs: number): Promise<IdempotencyClaim> {
    const ttl = nonNegativeMs(ttlMs, { name: "ttlMs", min: 1 });
    const now = Date.now();
    const rows = this.#sql.exec(
      "SELECT expires_at, done, result FROM mcp_idempotency WHERE k = 0",
    ).toArray() as { expires_at: number; done: number; result: string }[];
    if (rows.length > 0 && rows[0].expires_at > now) {
      return rows[0].done === 1
        ? { first: false, result: JSON.parse(rows[0].result) }
        : { first: false };
    }
    const expiresAt = now + Math.ceil(ttl);
    const token = crypto.randomUUID();
    this.#sql.exec(
      "INSERT INTO mcp_idempotency (k, token, expires_at, done, result) VALUES (0, ?, ?, 0, NULL) ON CONFLICT (k) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, done = 0, result = NULL",
      token,
      expiresAt,
    ).toArray();
    await this.ctx.storage.setAlarm(expiresAt);
    await this.ctx.storage.sync();
    return { first: true, token };
  }

  async complete(token: string, result: unknown): Promise<void> {
    const text = JSON.stringify(result);
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > MAX_IDEMPOTENT_RESULT_BYTES
    ) {
      throw new RangeError(
        `an idempotent answer must be JSON of at most ${MAX_IDEMPOTENT_RESULT_BYTES} bytes`,
      );
    }
    // Only the live claim `token` names is completed: an expired one stays
    // gone, and one that expired and was claimed again belongs to the new
    // claim, whose own answer is the one to keep.
    this.#sql.exec(
      "UPDATE mcp_idempotency SET done = 1, result = ? WHERE k = 0 AND token = ? AND expires_at > ?",
      text,
      String(token),
      Date.now(),
    ).toArray();
    await this.ctx.storage.sync();
  }

  async alarm(): Promise<void> {
    const rows = this.#sql.exec(
      "SELECT expires_at FROM mcp_idempotency WHERE k = 0",
    ).toArray() as { expires_at: number }[];
    if (rows.length > 0 && rows[0].expires_at > Date.now()) {
      await this.ctx.storage.setAlarm(rows[0].expires_at);
      return;
    }
    // deleteAll drops the table too: a claim on this same instance
    // creates it again.
    this.#ready = false;
    await this.ctx.storage.deleteAll();
  }
}
