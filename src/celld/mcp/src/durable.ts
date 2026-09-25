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
 *
 * ```ts
 * export { McpChangeHub } from "@celld/mcp/durable";
 * export class McpTasks extends McpTaskObject<Env> {
 *   taskServer() { return build(this.env).server; }
 * }
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"MCP_CHANGES": "McpChangeHub", "MCP_TASKS": "McpTasks"})
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import type { ChangeHubApi } from "./hub.ts";
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

export type { ChangeHubApi, TaskObjectApi };

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

  get(owner: string | null): Promise<TaskReply<TaskRecord>> {
    return this.#task.get(owner);
  }

  update(
    owner: string | null,
    responses: InputResponses,
  ): Promise<TaskReply<null>> {
    return this.#task.update(owner, responses);
  }

  cancel(owner: string | null): Promise<TaskReply<null>> {
    return this.#task.cancel(owner);
  }

  async alarm(): Promise<void> {
    await this.#task.alarm();
  }
}
