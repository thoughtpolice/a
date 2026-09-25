// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Where tasks live and how their work runs, server side.
 *
 * The server is stateless and a `tasks/get` may reach any isolate, so each
 * task is a {@link TaskRecord} behind a {@link TaskStore}. Every store runs
 * the same state machine, a {@link TaskCell} per task: it records the task,
 * schedules its body, applies `tasks/update` answers and `tasks/cancel`,
 * expires it after its TTL, and runs the body through a {@link TaskRunner}
 * (the `McpServer`, which knows the tool). A cell asks its storage for a
 * wake-up ("alarm") whenever the body should run, and runs it then.
 *
 * - {@link MemoryTaskStore}: cells in this isolate's memory, woken by
 *   timers. For tests and single-process servers.
 * - {@link durableTaskStore}: one `McpTaskObject` Durable Object per task
 *   (in `@celld/mcp/durable`), named by the task id. The object keeps the
 *   record in its SQLite storage and runs the body from its alarm handler,
 *   so the work outlives the request that created the task and every
 *   isolate reaches the same task by name.
 *
 * A body runs from the top each time it is scheduled, like a multi
 * round-trip handler: when it needs input it ends the run, the task becomes
 * `input_required`, and once `tasks/update` has answered every outstanding
 * request it runs again and finds the answers. Durable Object alarms are
 * delivered at least once, so a body may also run again after a crash; the
 * state it saves (`ctx.save`) survives both.
 *
 * @module
 */

import { McpError } from "./errors.ts";
import { formatIssues, type Issue, toBase64Url } from "./json.ts";
import { compileSchema } from "./jsonschema.ts";
import type { Principal } from "./server.ts";
import {
  type DetailedTask,
  isTerminalStatus,
  type Task,
  type TaskStatus,
} from "./tasks.ts";
import type {
  ClientCapabilities,
  ElicitResult,
  Error as RpcErrorObject,
  Implementation,
  InputRequests,
  InputResponses,
  JSONValue,
} from "./types.ts";
import { check, INPUT_RESPONSE } from "./validate.ts";

/** Everything a store keeps about one task. Plain data: JSON and structured-clone safe. */
export interface TaskRecord {
  readonly version: 1;
  readonly taskId: string;
  /** The subject of the principal that created it; only they may see it. */
  readonly owner: string | null;
  /** That principal, for the body. */
  readonly principal: Principal | null;
  /** The augmented request: `tools/call`. */
  readonly method: string;
  /** The tool's name. */
  readonly name: string;
  /** The tool's arguments as sent (validated); each run parses them again. */
  readonly arguments: Record<string, unknown>;
  /** The creating request's protocol version, capabilities and client info. */
  readonly protocolVersion: string;
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo: Implementation | null;
  status: TaskStatus;
  statusMessage: string | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  lastUpdatedAt: number;
  ttlMs: number | null;
  pollIntervalMs: number;
  /** The input requests the task waits for. */
  outstanding: InputRequests;
  /** Every input key ever asked, to its method: keys are unique over a task's life. */
  asked: Record<string, string>;
  /** Every answer delivered so far. */
  answers: InputResponses;
  /** The body's saved state. */
  state: JSONValue | null;
  /** The result, once completed. */
  result: Record<string, unknown> | null;
  /** The JSON-RPC error, once failed. */
  error: RpcErrorObject | null;
  /** When the body should next run (epoch ms), or null. */
  runAt: number | null;
  /** How many times the body has started. */
  runs: number;
}

/** How a run of a task body ended. */
export type TaskOutcome =
  | {
    readonly type: "completed";
    readonly result: Record<string, unknown>;
    readonly statusMessage?: string;
  }
  | {
    readonly type: "failed";
    readonly error: RpcErrorObject;
    readonly statusMessage?: string;
  }
  | {
    /**
     * The body needs these answers first. With no requests it only yields:
     * it runs again after the task's poll interval.
     */
    readonly type: "input_required";
    readonly requests: InputRequests;
    readonly state: JSONValue | null;
  };

/** What a running body may do to its task. */
export interface TaskRunHooks {
  /** Fires when the task is cancelled or expires. */
  readonly signal: AbortSignal;
  /** Sets the status message (and poll interval) while the body runs. */
  status(message: string | null, pollIntervalMs?: number): Promise<void>;
  /** Saves the body's state, durably, for the next run. */
  save(state: JSONValue | null): Promise<void>;
}

/** Runs task bodies: the `McpServer`. */
export interface TaskRunner {
  run(record: TaskRecord, hooks: TaskRunHooks): Promise<TaskOutcome>;
  /** Told after a task's observable state changed, to notify listeners. */
  changed?(taskId: string): void | Promise<void>;
}

/** A store's answer: plain data, so it crosses Durable Object RPC intact. */
export type TaskReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcErrorObject };

/** Where a server keeps its tasks. Failures throw `rpc` McpErrors. */
export interface TaskStore {
  /** Stores a new task and schedules its body; resolves once `get` would find it. */
  create(record: TaskRecord): Promise<void>;
  /** The task, if it exists, has not expired and belongs to `owner`; else -32602. */
  get(taskId: string, owner: string | null): Promise<TaskRecord>;
  /** Delivers answers to outstanding input requests; others are ignored. */
  update(
    taskId: string,
    owner: string | null,
    responses: InputResponses,
  ): Promise<void>;
  /** Asks for cancellation; a terminal task is left alone. */
  cancel(taskId: string, owner: string | null): Promise<void>;
  /** Called by the server that owns the store, if the store runs bodies itself. */
  attach?(runner: TaskRunner): void;
}

/** A fresh task id: 144 random bits, base64url. */
export function newTaskId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

/** An RFC 3339 timestamp in UTC with milliseconds, as the spec's examples. */
function timestamp(epochMs: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toString({
    fractionalSecondDigits: 3,
  });
}

/** When a task expires (epoch ms), or null for never. */
export function expiresAt(record: TaskRecord): number | null {
  return record.ttlMs === null ? null : record.createdAt + record.ttlMs;
}

/** The {@link Task} fields of a record, for `CreateTaskResult`. */
export function taskOf(record: TaskRecord): Task {
  const task: Task = {
    taskId: record.taskId,
    status: record.status,
    createdAt: timestamp(record.createdAt),
    lastUpdatedAt: timestamp(record.lastUpdatedAt),
    ttlMs: record.ttlMs,
    pollIntervalMs: record.pollIntervalMs,
  };
  if (record.statusMessage !== null) task.statusMessage = record.statusMessage;
  return task;
}

/** The {@link DetailedTask} of a record, as `tasks/get` and `notifications/tasks` send it. */
export function detailedTaskOf(record: TaskRecord): DetailedTask {
  const task = taskOf(record);
  switch (record.status) {
    case "input_required":
      return {
        ...task,
        status: "input_required",
        inputRequests: record.outstanding,
      };
    case "completed":
      return { ...task, status: "completed", result: record.result ?? {} };
    case "failed":
      return {
        ...task,
        status: "failed",
        error: record.error ?? { code: -32603, message: "Internal error" },
      };
    case "working":
      return { ...task, status: "working" };
    case "cancelled":
      return { ...task, status: "cancelled" };
  }
}

function ok<T>(value: T): TaskReply<T> {
  return { ok: true, value };
}

function fail(message: string, code = -32602): TaskReply<never> {
  return { ok: false, error: { code, message } };
}

/** The value of a reply, or its error thrown as an `rpc` McpError. */
export function unwrap<T>(reply: TaskReply<T>): T {
  if (reply.ok) return reply.value;
  throw McpError.rpc(
    reply.error.code,
    reply.error.message,
    reply.error.data as JSONValue | undefined,
  );
}

/** What a {@link TaskCell} needs from wherever it lives. */
export interface TaskCellStorage {
  /** The record, or null. Synchronous: a cell's read-modify-write never awaits in between. */
  load(): TaskRecord | null;
  save(record: TaskRecord): void;
  /** Deletes the record and any wake-up. */
  remove(): Promise<void>;
  /**
   * Arranges one wake-up (`cell.alarm()`) at `at`, replacing any earlier
   * one; null clears it. `reason` says why; memory storage only wakes to run.
   */
  schedule(at: number | null, reason: "run" | "expire"): Promise<void>;
  /** Waits until the last save is durable. */
  sync(): Promise<void>;
}

const NOT_FOUND = "Task not found";

/** One task's state machine; see the module documentation. */
export class TaskCell {
  readonly #storage: TaskCellStorage;
  readonly #runner: () => TaskRunner;
  readonly #now: () => number;
  #running: AbortController | null = null;

  constructor(
    storage: TaskCellStorage,
    runner: () => TaskRunner,
    now: () => number = () => Date.now(),
  ) {
    this.#storage = storage;
    this.#runner = runner;
    this.#now = now;
  }

  /** Whether a body is running in this instance. */
  get running(): boolean {
    return this.#running !== null;
  }

  /** Aborts a running body without changing the task (the host is going away). */
  stop(reason: unknown = new Error("the task store closed")): void {
    this.#running?.abort(reason);
  }

  async create(record: TaskRecord): Promise<TaskReply<null>> {
    if (this.#storage.load() !== null) {
      return fail("Task already exists", -32603);
    }
    const stored: TaskRecord = { ...record, runAt: this.#now() };
    this.#storage.save(stored);
    await this.#reschedule(stored);
    await this.#storage.sync();
    return ok(null);
  }

  async get(owner: string | null): Promise<TaskReply<TaskRecord>> {
    return await this.#open(owner, "Failed to retrieve task");
  }

  async update(
    owner: string | null,
    responses: InputResponses,
  ): Promise<TaskReply<null>> {
    const opened = await this.#open(owner, "Failed to update task");
    if (!opened.ok) return opened;
    const record = opened.value;
    if (isTerminalStatus(record.status)) return ok(null);
    const accepted: InputResponses = {};
    for (const [key, response] of Object.entries(responses)) {
      const request = record.outstanding[key];
      // Keys never issued, already answered or superseded are ignored.
      if (request === undefined) continue;
      const issues = check(response, INPUT_RESPONSE[request.method], [
        "inputResponses",
        key,
      ]);
      if (issues.length > 0) {
        return fail(`Invalid input response: ${formatIssues(issues)}`);
      }
      if (
        request.method === "elicitation/create" &&
        request.params.mode !== "url" &&
        (response as ElicitResult).action === "accept"
      ) {
        let schemaIssues: readonly Issue[];
        try {
          schemaIssues = compileSchema(request.params.requestedSchema)
            .validate((response as ElicitResult).content ?? {});
        } catch {
          schemaIssues = [];
        }
        if (schemaIssues.length > 0) {
          return fail(
            `Input response ${key} does not match the requested schema: ${
              formatIssues(schemaIssues)
            }`,
          );
        }
      }
      accepted[key] = response;
    }
    if (Object.keys(accepted).length === 0) return ok(null);
    // Re-read: nothing awaited since the load, but stay explicit.
    const current = this.#storage.load()!;
    const now = this.#now();
    const outstanding = { ...current.outstanding };
    for (const key of Object.keys(accepted)) delete outstanding[key];
    const next: TaskRecord = {
      ...current,
      answers: { ...current.answers, ...accepted },
      outstanding,
      lastUpdatedAt: now,
    };
    if (
      Object.keys(outstanding).length === 0 &&
      next.status === "input_required"
    ) {
      next.status = "working";
      next.statusMessage = null;
      next.runAt = now;
    }
    await this.#commit(next);
    return ok(null);
  }

  async cancel(owner: string | null): Promise<TaskReply<null>> {
    const opened = await this.#open(owner, "Failed to cancel task");
    if (!opened.ok) return opened;
    const record = opened.value;
    if (isTerminalStatus(record.status)) return ok(null);
    this.#running?.abort(new Error("the task was cancelled"));
    await this.#commit({
      ...record,
      status: "cancelled",
      statusMessage: "The client cancelled the task",
      outstanding: {},
      runAt: null,
      lastUpdatedAt: this.#now(),
    });
    return ok(null);
  }

  /** The wake-up: expires the task, or runs its body when due. */
  async alarm(): Promise<void> {
    const record = this.#storage.load();
    if (record === null) return;
    const now = this.#now();
    const expiry = expiresAt(record);
    if (expiry !== null && now >= expiry) {
      await this.#expire(record);
      return;
    }
    if (this.#running !== null) return; // The run reschedules when it ends.
    if (
      record.runAt !== null && record.runAt <= now &&
      !isTerminalStatus(record.status)
    ) {
      await this.#run(record);
      return;
    }
    await this.#reschedule(record);
  }

  /** Deletes the task if it has expired; for sweeps. */
  async sweep(): Promise<boolean> {
    const record = this.#storage.load();
    if (record === null) return true;
    const expiry = expiresAt(record);
    if (expiry === null || this.#now() < expiry) return false;
    await this.#expire(record);
    return true;
  }

  async #expire(record: TaskRecord): Promise<void> {
    this.#running?.abort(new Error("the task expired"));
    await this.#storage.remove();
    await this.#runner().changed?.(record.taskId);
  }

  async #open(
    owner: string | null,
    action: string,
  ): Promise<TaskReply<TaskRecord>> {
    const record = this.#storage.load();
    if (record === null || record.owner !== owner) {
      return fail(`${action}: ${NOT_FOUND}`);
    }
    const expiry = expiresAt(record);
    if (expiry !== null && this.#now() >= expiry) {
      await this.#expire(record);
      return fail(`${action}: Task has expired`);
    }
    return ok(record);
  }

  async #reschedule(record: TaskRecord): Promise<void> {
    const expiry = expiresAt(record);
    const run = isTerminalStatus(record.status) ? null : record.runAt;
    if (run !== null && (expiry === null || run < expiry)) {
      await this.#storage.schedule(run, "run");
    } else {
      await this.#storage.schedule(expiry, "expire");
    }
  }

  async #commit(record: TaskRecord): Promise<void> {
    this.#storage.save(record);
    await this.#reschedule(record);
    await this.#storage.sync();
    await this.#notify(record.taskId);
  }

  async #notify(taskId: string): Promise<void> {
    try {
      await this.#runner().changed?.(taskId);
    } catch {
      // Notifications are best effort; polling still sees the change.
    }
  }

  async #run(record: TaskRecord): Promise<void> {
    const controller = new AbortController();
    this.#running = controller;
    const started = { ...record, runs: record.runs + 1 };
    this.#storage.save(started);
    const live = () => {
      const current = this.#storage.load();
      return current !== null && !isTerminalStatus(current.status) &&
          !controller.signal.aborted
        ? current
        : null;
    };
    const hooks: TaskRunHooks = {
      signal: controller.signal,
      status: async (message, pollIntervalMs) => {
        const current = live();
        if (current === null) return;
        await this.#commit({
          ...current,
          statusMessage: message,
          pollIntervalMs: pollIntervalMs ?? current.pollIntervalMs,
          lastUpdatedAt: this.#now(),
        });
      },
      save: async (state) => {
        const current = live();
        if (current === null) return;
        this.#storage.save({ ...current, state });
        await this.#storage.sync();
      },
    };
    let outcome: TaskOutcome;
    try {
      outcome = await this.#runner().run(started, hooks);
    } catch {
      outcome = {
        type: "failed",
        error: { code: -32603, message: "Internal error" },
      };
    } finally {
      this.#running = null;
    }
    const current = this.#storage.load();
    if (current === null) return; // Expired while running.
    if (isTerminalStatus(current.status)) {
      // Cancelled while running: the outcome is dropped.
      await this.#reschedule(current);
      return;
    }
    const now = this.#now();
    const next: TaskRecord = { ...current, lastUpdatedAt: now, runAt: null };
    switch (outcome.type) {
      case "completed":
        next.status = "completed";
        next.result = outcome.result;
        next.statusMessage = outcome.statusMessage ?? null;
        next.outstanding = {};
        break;
      case "failed":
        next.status = "failed";
        next.error = outcome.error;
        next.statusMessage = outcome.statusMessage ?? outcome.error.message;
        next.outstanding = {};
        break;
      case "input_required": {
        next.state = outcome.state;
        const requests: InputRequests = {};
        const asked = { ...current.asked };
        for (const [key, request] of Object.entries(outcome.requests)) {
          // An answered key is never asked again: the body already has it.
          if (Object.hasOwn(current.answers, key)) continue;
          requests[key] = request;
          asked[key] = request.method;
        }
        next.asked = asked;
        if (Object.keys(requests).length === 0) {
          next.status = "working";
          next.runAt = now + current.pollIntervalMs;
        } else {
          next.status = "input_required";
          next.outstanding = requests;
        }
        break;
      }
    }
    await this.#commit(next);
  }
}

/** Options for {@link MemoryTaskStore}. */
export interface MemoryTaskStoreOptions {
  /** Milliseconds since the epoch; for tests. */
  readonly now?: () => number;
}

interface MemorySlot {
  readonly cell: TaskCell;
  record: TaskRecord | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Tasks in this isolate's memory, run by timers in this isolate. Tasks do
 * not survive a restart and are not visible to other isolates; use
 * `durableTaskStore` for a deployment. Expired tasks are dropped when next
 * touched, and swept on each create.
 */
export class MemoryTaskStore implements TaskStore {
  readonly #slots = new Map<string, MemorySlot>();
  readonly #now: () => number;
  #runner: TaskRunner | null = null;

  constructor(options: MemoryTaskStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  attach(runner: TaskRunner): void {
    if (this.#runner !== null && this.#runner !== runner) {
      throw new Error("a MemoryTaskStore serves one server");
    }
    this.#runner = runner;
  }

  /** Tasks held, expired or not. */
  get size(): number {
    return this.#slots.size;
  }

  /** Whether any task body is running; for tests. */
  get busy(): boolean {
    return [...this.#slots.values()].some((slot) => slot.cell.running);
  }

  #slot(taskId: string): MemorySlot {
    const existing = this.#slots.get(taskId);
    if (existing !== undefined) return existing;
    const runner = () => {
      if (this.#runner === null) {
        throw new Error("the MemoryTaskStore is not attached to a server");
      }
      return this.#runner;
    };
    const slot: MemorySlot = {
      record: null,
      timer: undefined,
      cell: new TaskCell(
        {
          load: () =>
            slot.record === null ? null : structuredClone(slot.record),
          save: (record) => {
            slot.record = structuredClone(record);
          },
          remove: () => {
            clearTimeout(slot.timer);
            slot.record = null;
            this.#slots.delete(taskId);
            return Promise.resolve();
          },
          schedule: (at, reason) => {
            clearTimeout(slot.timer);
            slot.timer = undefined;
            if (at !== null && reason === "run") {
              slot.timer = setTimeout(() => {
                slot.timer = undefined;
                void slot.cell.alarm();
              }, Math.max(0, at - this.#now()));
            }
            return Promise.resolve();
          },
          sync: () => Promise.resolve(),
        },
        runner,
        this.#now,
      ),
    };
    this.#slots.set(taskId, slot);
    return slot;
  }

  async create(record: TaskRecord): Promise<void> {
    if (this.#runner === null) {
      throw new Error("the MemoryTaskStore is not attached to a server");
    }
    for (const slot of [...this.#slots.values()]) await slot.cell.sweep();
    unwrap(await this.#slot(record.taskId).cell.create(record));
  }

  async get(taskId: string, owner: string | null): Promise<TaskRecord> {
    return unwrap(await this.#existing(taskId, "retrieve").get(owner));
  }

  async update(
    taskId: string,
    owner: string | null,
    responses: InputResponses,
  ): Promise<void> {
    unwrap(await this.#existing(taskId, "update").update(owner, responses));
  }

  async cancel(taskId: string, owner: string | null): Promise<void> {
    unwrap(await this.#existing(taskId, "cancel").cancel(owner));
  }

  #existing(taskId: string, action: string): TaskCell {
    const slot = this.#slots.get(taskId);
    if (slot === undefined) {
      throw McpError.invalidParams(`Failed to ${action} task: ${NOT_FOUND}`);
    }
    return slot.cell;
  }

  /** Cancels timers and aborts running bodies; the tasks are dropped. */
  close(): void {
    for (const slot of this.#slots.values()) {
      clearTimeout(slot.timer);
      slot.cell.stop();
    }
    this.#slots.clear();
  }
}

/** The RPC surface of `McpTaskObject`, one object per task. */
export interface TaskObjectApi {
  create(record: TaskRecord): Promise<TaskReply<null>>;
  get(owner: string | null): Promise<TaskReply<TaskRecord>>;
  update(
    owner: string | null,
    responses: InputResponses,
  ): Promise<TaskReply<null>>;
  cancel(owner: string | null): Promise<TaskReply<null>>;
}

/**
 * A {@link TaskStore} over the `McpTaskObject` namespace (see
 * `@celld/mcp/durable`): each task is the object named by its id, which
 * stores it and runs its body from an alarm.
 *
 * ```ts
 * interface Env { MCP_TASKS: DurableObjectNamespace<TaskObjectApi> }
 * const server = new McpServer({ info, tasks: { store: durableTaskStore(env.MCP_TASKS) } });
 * ```
 */
export function durableTaskStore(
  namespace: DurableObjectNamespace<TaskObjectApi>,
): TaskStore {
  const stub = (taskId: string) =>
    namespace.getByName(taskId) as unknown as TaskObjectApi;
  return {
    async create(record) {
      unwrap(await stub(record.taskId).create(record));
    },
    async get(taskId, owner) {
      return unwrap(await stub(taskId).get(owner));
    },
    async update(taskId, owner, responses) {
      unwrap(await stub(taskId).update(owner, responses));
    },
    async cancel(taskId, owner) {
      unwrap(await stub(taskId).cancel(owner));
    },
  };
}
