// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Every failure the library reports, as one class hierarchy with a `kind`
 * discriminant and a plain-data form.
 *
 * Durable Object RPC and Workflow steps keep only an Error's name and message,
 * so code that crosses those boundaries should carry {@link ExeErrorData}
 * (from `error.toJSON()` or {@link outcome}) and rebuild the class on the
 * other side with {@link exeErrorFromData} when it wants one.
 *
 * Two properties matter to callers that manage VMs:
 *
 * - `retryable`: the failure is transient, so trying again later may work.
 * - `ambiguous`: the command may have run even though no answer came back
 *   (a timeout, a dropped connection, a 5xx). A retried `new` or `cp` could
 *   then act twice, which is why the client never retries mutating commands
 *   and why the fleet code re-lists VMs after an ambiguous failure.
 *
 * @module
 */

import { formatIssues, type Issue, type JsonValue } from "./json.ts";

/** What went wrong, from the caller's point of view. */
export type ExeErrorKind =
  /** 400: empty body or a command line the lobby could not parse. */
  | "bad_request"
  /** 401: the token is malformed, expired, unknown or badly signed. */
  | "authentication"
  /** 403: the token's `cmds` does not allow the command. */
  | "permission"
  /** 404: no such command. */
  | "not_found"
  /** 405: not a POST. */
  | "method_not_allowed"
  /** 413: the body is over 64 KiB. */
  | "too_large"
  /** 422: the command ran and failed; `detail` holds its message. */
  | "command_failed"
  /** 429: over the per-SSH-key rate limit. */
  | "rate_limited"
  /** 504: the command ran longer than the server's 30 seconds. */
  | "command_timeout"
  /** 500 and any other 5xx. */
  | "server"
  /** Any other non-2xx status. */
  | "http"
  /** No HTTP response: DNS, TLS, reset, or a body cut short. */
  | "connection"
  /** An attempt, or the retry budget, ran out of time on the client. */
  | "timeout"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** A 2xx response did not have the documented shape; `issues` has paths. */
  | "decode"
  /** The request was refused before sending; `issues` has the paths. */
  | "invalid_request";

/** The kinds that come from an HTTP status. */
export type ApiErrorKind =
  | "bad_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "method_not_allowed"
  | "too_large"
  | "command_failed"
  | "rate_limited"
  | "command_timeout"
  | "server"
  | "http";

/**
 * A failure as plain data: structured-clone and JSON safe, for RPC results,
 * Workflow step outputs, queues and logs. Absent facts are `null`.
 */
export interface ExeErrorData {
  readonly kind: ExeErrorKind;
  readonly message: string;
  /** HTTP status, when there was a response. */
  readonly status: number | null;
  /** The server's requested wait, from `retry-after`. */
  readonly retryAfterMs: number | null;
  /** The lobby command line that was sent (secrets are not redacted). */
  readonly command: string | null;
  /** The error body: parsed JSON, or text (truncated to 4 KiB). */
  readonly body: JsonValue | null;
  /** The human-readable message from the body, when one could be found. */
  readonly detail: string | null;
  /** Located problems for `invalid_request` and `decode`. */
  readonly issues: readonly Issue[];
  /** HTTP attempts made before giving up. */
  readonly attempts: number;
  /** Whether the failure is transient, so a later retry may succeed. */
  readonly retryable: boolean;
  /** Whether the command may have run despite the failure. */
  readonly ambiguous: boolean;
}

/** Fields an {@link ExeError} is built from; missing ones default to null. */
export interface ExeErrorInit {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
  readonly command?: string | null;
  readonly body?: JsonValue | null;
  readonly detail?: string | null;
  readonly issues?: readonly Issue[];
  readonly attempts?: number;
  readonly ambiguous?: boolean;
  readonly cause?: unknown;
}

const TRANSIENT: ReadonlySet<ExeErrorKind> = new Set([
  "rate_limited",
  "command_timeout",
  "server",
  "connection",
  "timeout",
]);

/** Whether a kind of failure is transient. */
export function isTransient(kind: ExeErrorKind): boolean {
  return TRANSIENT.has(kind);
}

/**
 * Whether a failure of this kind leaves it unknown if the command ran: the
 * request may have reached the lobby and executed before the answer was
 * lost. 4xx answers are definite (429 and 401 are refused before running;
 * 422 means it ran and failed).
 */
export function isAmbiguousKind(kind: ExeErrorKind): boolean {
  return kind === "connection" || kind === "timeout" ||
    kind === "command_timeout" || kind === "server";
}

/** Base class of every error the library throws. Narrow on `kind`. */
export class ExeError extends Error {
  readonly kind: ExeErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly command: string | null;
  readonly body: JsonValue | null;
  readonly detail: string | null;
  readonly issues: readonly Issue[];
  /** HTTP attempts made; the client fills this in when it gives up. */
  attempts: number;
  /** Whether the command may have run; see the module notes. */
  readonly ambiguous: boolean;

  constructor(kind: ExeErrorKind, message: string, init: ExeErrorInit = {}) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "ExeError";
    this.kind = kind;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.command = init.command ?? null;
    this.body = init.body ?? null;
    this.detail = init.detail ?? null;
    this.issues = init.issues ?? [];
    this.attempts = init.attempts ?? 0;
    this.ambiguous = init.ambiguous ?? false;
  }

  /** Whether the failure is transient, so a later retry may succeed. */
  get retryable(): boolean {
    return isTransient(this.kind);
  }

  /** The plain-data form, which survives RPC; `JSON.stringify` uses it too. */
  toJSON(): ExeErrorData {
    return {
      kind: this.kind,
      message: this.message,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      command: this.command,
      body: this.body,
      detail: this.detail,
      issues: this.issues.map((issue) => ({
        path: [...issue.path],
        message: issue.message,
      })),
      attempts: this.attempts,
      retryable: this.retryable,
      ambiguous: this.ambiguous,
    };
  }
}

/** A non-2xx response. */
export class ExeApiError extends ExeError {
  declare readonly kind: ApiErrorKind;
  declare readonly status: number;

  constructor(
    kind: ApiErrorKind,
    message: string,
    init: ExeErrorInit & { readonly status: number },
  ) {
    super(kind, message, init);
    this.name = "ExeApiError";
  }
}

/** The request was refused before sending. */
export class ExeInvalidRequestError extends ExeError {
  declare readonly kind: "invalid_request";

  constructor(issues: readonly Issue[], init: ExeErrorInit = {}) {
    super("invalid_request", `invalid request: ${formatIssues(issues)}`, {
      ...init,
      issues,
    });
    this.name = "ExeInvalidRequestError";
  }
}

/** A 2xx response without the documented shape. */
export class ExeDecodeError extends ExeError {
  declare readonly kind: "decode";

  constructor(issues: readonly Issue[], init: ExeErrorInit = {}) {
    super("decode", `unexpected response: ${formatIssues(issues)}`, {
      ...init,
      issues,
    });
    this.name = "ExeDecodeError";
  }
}

/** No HTTP response arrived, or its body was cut short. */
export class ExeConnectionError extends ExeError {
  declare readonly kind: "connection";

  constructor(message: string, init: ExeErrorInit = {}) {
    super("connection", message, { ambiguous: true, ...init });
    this.name = "ExeConnectionError";
  }
}

/** An attempt, or the retry budget, ran out of time on the client. */
export class ExeTimeoutError extends ExeError {
  declare readonly kind: "timeout";

  constructor(message: string, init: ExeErrorInit = {}) {
    super("timeout", message, init);
    this.name = "ExeTimeoutError";
  }
}

/** The caller aborted. Never retried. */
export class ExeAbortError extends ExeError {
  declare readonly kind: "aborted";

  constructor(message = "the request was aborted", init: ExeErrorInit = {}) {
    super("aborted", message, init);
    this.name = "ExeAbortError";
  }
}

/** The classes, as a union that narrows on `kind`. */
export type AnyExeError =
  | ExeApiError
  | ExeInvalidRequestError
  | ExeDecodeError
  | ExeConnectionError
  | ExeTimeoutError
  | ExeAbortError;

/** True for any error this library throws. */
export function isExeError(value: unknown): value is AnyExeError {
  return value instanceof ExeError;
}

/** The error kind for an HTTP status, as the HTTPS API docs list them. */
export function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "authentication";
    case 403:
      return "permission";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 413:
      return "too_large";
    case 422:
      return "command_failed";
    case 429:
      return "rate_limited";
    case 504:
      return "command_timeout";
  }
  return status >= 500 && status <= 599 ? "server" : "http";
}

/** Rebuilds the error class from its plain-data form. */
export function exeErrorFromData(data: ExeErrorData): AnyExeError {
  const init: ExeErrorInit = {
    status: data.status,
    retryAfterMs: data.retryAfterMs,
    command: data.command,
    body: data.body,
    detail: data.detail,
    issues: data.issues,
    attempts: data.attempts,
    ambiguous: data.ambiguous,
  };
  let error: AnyExeError;
  switch (data.kind) {
    case "invalid_request":
      error = new ExeInvalidRequestError(data.issues, init);
      break;
    case "decode":
      error = new ExeDecodeError(data.issues, init);
      break;
    case "connection":
      error = new ExeConnectionError(data.message, init);
      break;
    case "timeout":
      error = new ExeTimeoutError(data.message, init);
      break;
    case "aborted":
      error = new ExeAbortError(data.message, init);
      break;
    default:
      error = new ExeApiError(data.kind, data.message, {
        ...init,
        status: data.status ?? 0,
      });
  }
  error.message = data.message;
  return error;
}

/** A result as plain data: a value, or a failure's plain-data form. */
export type ExeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExeErrorData };

/**
 * Awaits `promise` and returns its value or its {@link ExeError} as plain
 * data, for results that cross Durable Object RPC or Workflow steps. Errors
 * that are not ExeErrors (bugs) still throw.
 *
 * ```ts
 * const listed = await outcome(client.ls());
 * if (listed.ok) listed.value.vms;
 * ```
 */
export async function outcome<T>(
  promise: Promise<T> | (() => Promise<T>),
): Promise<ExeOutcome<T>> {
  try {
    return {
      ok: true,
      value: await (typeof promise === "function" ? promise() : promise),
    };
  } catch (error) {
    if (error instanceof ExeError) return { ok: false, error: error.toJSON() };
    throw error;
  }
}
