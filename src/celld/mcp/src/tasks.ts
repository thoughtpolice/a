// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The tasks extension (`io.modelcontextprotocol/tasks`), revision
 * 2026-07-28 of github.com/modelcontextprotocol/ext-tasks: the wire types
 * shared by the server and the client; the runtime checks for them are in
 * `validate.ts`.
 *
 * A server that has negotiated the extension may answer a `tools/call` with
 * a {@link CreateTaskResult} (`resultType: "task"`) instead of the tool's
 * result. The client then polls `tasks/get` until the task is terminal,
 * answers the task's `inputRequests` with `tasks/update`, and may ask for
 * `tasks/cancel`. There is no `tasks/list`: a task id is an unguessable
 * handle, and the server binds each task to the caller that created it.
 *
 * @module
 */

import type {
  InputRequests,
  JSONRPCNotification,
  NotificationParams,
  Result,
} from "./types.ts";

/** The extension's identifier, for `capabilities.extensions`. */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** The request methods that may answer with a task. */
export const TASK_AUGMENTABLE: ReadonlySet<string> = new Set(["tools/call"]);

/** The status of a task. */
export type TaskStatus =
  /** The request is being processed. */
  | "working"
  /** The task waits for the client; see `inputRequests`. */
  | "input_required"
  /** Finished; `result` holds what the request would have returned. */
  | "completed"
  /** A JSON-RPC error ended it; see `error`. */
  | "failed"
  /** Cancelled before it finished. */
  | "cancelled";

/** Whether a status is terminal: it never changes again. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" ||
    status === "cancelled";
}

/** A task's operational metadata. */
export interface Task {
  /** The task identifier. */
  taskId: string;
  /** Current task status. */
  status: TaskStatus;
  /** Human-readable context for the current status; may reach the user or model. */
  statusMessage?: string;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of the last change. */
  lastUpdatedAt: string;
  /** Time to live from creation, in integer milliseconds; null for unlimited. May change. */
  ttlMs: number | null;
  /** Suggested polling interval in integer milliseconds. May change. */
  pollIntervalMs?: number;
}

/** A task in progress. */
export interface WorkingTask extends Task {
  status: "working";
}

/** A task waiting for the client's input. */
export interface InputRequiredTask extends Task {
  status: "input_required";
  /** Every outstanding server-to-client request, keyed by an id unique over the task's life. */
  inputRequests: InputRequests;
}

/** A finished task. */
export interface CompletedTask extends Task {
  status: "completed";
  /** The result of the original request (a `CallToolResult` for `tools/call`). */
  result: { [key: string]: unknown };
}

/** A task that ended with a JSON-RPC error. */
export interface FailedTask extends Task {
  status: "failed";
  /** The JSON-RPC error. */
  error: { code: number; message: string; data?: unknown };
}

/** A cancelled task. */
export interface CancelledTask extends Task {
  status: "cancelled";
}

/** A task with its status-specific fields inlined, as `tasks/get` returns it. */
export type DetailedTask =
  | WorkingTask
  | InputRequiredTask
  | CompletedTask
  | FailedTask
  | CancelledTask;

/** The answer to a request the server chose to run as a task. */
export type CreateTaskResult = Result & Task & { resultType: "task" };

/** The result of `tasks/get`. */
export type GetTaskResult = Result & DetailedTask;

/** Parameters of `notifications/tasks`: the full task, as `tasks/get` would return it. */
export type TaskStatusNotificationParams = NotificationParams & DetailedTask;

/** A task's status changed; sent on `subscriptions/listen` streams that asked for its id. */
export interface TaskStatusNotification extends JSONRPCNotification {
  method: "notifications/tasks";
  params: TaskStatusNotificationParams;
}

/** Checks that a number of milliseconds is an integer >= `min`. */
export function checkMs(
  value: number | null | undefined,
  what: string,
  min = 0,
): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${what} must be an integer >= ${min}`);
  }
}
