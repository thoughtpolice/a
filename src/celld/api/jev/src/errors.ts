// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Every failure the client reports, as one class hierarchy with a `kind`
 * discriminant and a plain-data form.
 *
 * Durable Object RPC and Workflow steps keep only an Error's name and message,
 * so code that crosses those boundaries should carry {@link JevErrorData}
 * (from `error.toJSON()` or `client.tryAsk`) and rebuild the class on the
 * other side with {@link jevErrorFromData} when it wants one.
 *
 * @module
 */

import { formatPath, type Issue } from "@celld/sieve";
import type { JsonValue } from "./json.ts";

export type { Issue } from "@celld/sieve";

/** Issues as one line for an error message: `path: message; ...`. */
function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => {
    const where = formatPath(issue.path);
    return where === "" ? issue.message : `${where}: ${issue.message}`;
  }).join("; ");
}

/** What went wrong, from the caller's point of view. */
export type JevErrorKind =
  /** 400: the server refused the request's form. */
  | "bad_request"
  /** 401: missing or invalid API key. */
  | "authentication"
  /** 403: the key may not do this. */
  | "permission"
  /** 404: no such endpoint or model. */
  | "not_found"
  /** 422: the server's validation failed; `issues` has its detail. */
  | "validation"
  /** 429: over the account's rate limit. */
  | "rate_limited"
  /** 529: TypeSafe is overloaded. */
  | "overloaded"
  /** Any other 5xx. */
  | "server"
  /** Any other non-2xx status. */
  | "http"
  /** No HTTP response: DNS, TLS, reset, or a body cut short. */
  | "connection"
  /**
   * An attempt ran out of time, or the retry budget did (including while the
   * limiter was holding the request back).
   */
  | "timeout"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** A 2xx response did not match what was asked; `issues` has the paths. */
  | "decode"
  /** The request was refused before sending; `issues` has the paths. */
  | "invalid_request";

/** The kinds that come from an HTTP status. */
export type ApiErrorKind =
  | "bad_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "overloaded"
  | "server"
  | "http";

/**
 * A failure as plain data: structured-clone and JSON safe, for RPC results,
 * Workflow step outputs, queues and logs. Absent facts are `null`.
 */
export interface JevErrorData {
  readonly kind: JevErrorKind;
  readonly message: string;
  /** HTTP status, when there was a response. */
  readonly status: number | null;
  /** The server's requested wait, from `retry-after-ms` or `retry-after`. */
  readonly retryAfterMs: number | null;
  /** The response's `x-typesafe-request-id`, for support requests. */
  readonly requestId: string | null;
  /** The error response body: parsed JSON, or text (truncated to 4 KiB). */
  readonly body: JsonValue | null;
  /**
   * Located problems for `invalid_request`, `decode` and `validation`, as
   * sieve issues. A 422's detail comes back as `custom` issues.
   */
  readonly issues: readonly Issue[];
  /** HTTP attempts made before giving up. */
  readonly attempts: number;
  /** Whether the failure is transient, so a later retry may succeed. */
  readonly retryable: boolean;
}

/** Fields a {@link JevError} is built from; missing ones default to null. */
export interface JevErrorInit {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
  readonly requestId?: string | null;
  readonly body?: JsonValue | null;
  readonly issues?: readonly Issue[];
  readonly attempts?: number;
  readonly cause?: unknown;
}

const TRANSIENT: ReadonlySet<JevErrorKind> = new Set([
  "rate_limited",
  "overloaded",
  "server",
  "connection",
  "timeout",
]);

/** Whether a kind of failure is transient; 408 counts too. */
export function isTransient(
  kind: JevErrorKind,
  status: number | null,
): boolean {
  return TRANSIENT.has(kind) || status === 408;
}

/** Base class of every error the library throws. Narrow on `kind`. */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  readonly body: JsonValue | null;
  readonly issues: readonly Issue[];
  /** HTTP attempts made; the client fills this in when it gives up. */
  attempts: number;

  constructor(kind: JevErrorKind, message: string, init: JevErrorInit = {}) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "JevError";
    this.kind = kind;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.requestId = init.requestId ?? null;
    this.body = init.body ?? null;
    this.issues = init.issues ?? [];
    this.attempts = init.attempts ?? 0;
  }

  /** Whether the failure is transient, so a later retry may succeed. */
  get retryable(): boolean {
    return isTransient(this.kind, this.status);
  }

  /** The plain-data form, which survives RPC; `JSON.stringify` uses it too. */
  toJSON(): JevErrorData {
    return {
      kind: this.kind,
      message: this.message,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      body: this.body,
      issues: structuredClone(this.issues) as Issue[],
      attempts: this.attempts,
      retryable: this.retryable,
    };
  }
}

/** A non-2xx response. */
export class JevApiError extends JevError {
  declare readonly kind: ApiErrorKind;
  declare readonly status: number;

  constructor(
    kind: ApiErrorKind,
    message: string,
    init: JevErrorInit & { readonly status: number },
  ) {
    super(kind, message, init);
    this.name = "JevApiError";
  }
}

/** The request was refused before sending. */
export class JevInvalidRequestError extends JevError {
  declare readonly kind: "invalid_request";

  constructor(issues: readonly Issue[], init: JevErrorInit = {}) {
    super("invalid_request", `invalid request: ${formatIssues(issues)}`, {
      ...init,
      issues,
    });
    this.name = "JevInvalidRequestError";
  }
}

/** A 2xx response that does not answer what was asked. */
export class JevDecodeError extends JevError {
  declare readonly kind: "decode";

  constructor(issues: readonly Issue[], init: JevErrorInit = {}) {
    super("decode", `unexpected response: ${formatIssues(issues)}`, {
      ...init,
      issues,
    });
    this.name = "JevDecodeError";
  }
}

/** No HTTP response arrived, or its body was cut short. */
export class JevConnectionError extends JevError {
  declare readonly kind: "connection";

  constructor(message: string, init: JevErrorInit = {}) {
    super("connection", message, init);
    this.name = "JevConnectionError";
  }
}

/** An attempt, or the retry budget, ran out of time. */
export class JevTimeoutError extends JevError {
  declare readonly kind: "timeout";

  constructor(message: string, init: JevErrorInit = {}) {
    super("timeout", message, init);
    this.name = "JevTimeoutError";
  }
}

/** The caller aborted. Never retried. */
export class JevAbortError extends JevError {
  declare readonly kind: "aborted";

  constructor(message = "the request was aborted", init: JevErrorInit = {}) {
    super("aborted", message, init);
    this.name = "JevAbortError";
  }
}

/** The classes, as a union that narrows on `kind`. */
export type AnyJevError =
  | JevApiError
  | JevInvalidRequestError
  | JevDecodeError
  | JevConnectionError
  | JevTimeoutError
  | JevAbortError;

/** True for any error this library throws. */
export function isJevError(value: unknown): value is AnyJevError {
  return value instanceof JevError;
}

/** The error kind for an HTTP status. */
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
    case 422:
      return "validation";
    case 429:
      return "rate_limited";
    case 529:
      return "overloaded";
  }
  return status >= 500 && status <= 599 ? "server" : "http";
}

/** Rebuilds the error class from its plain-data form. */
export function jevErrorFromData(data: JevErrorData): AnyJevError {
  const init: JevErrorInit = {
    status: data.status,
    retryAfterMs: data.retryAfterMs,
    requestId: data.requestId,
    body: data.body,
    issues: data.issues,
    attempts: data.attempts,
  };
  let error: AnyJevError;
  switch (data.kind) {
    case "invalid_request":
      error = new JevInvalidRequestError(data.issues, init);
      break;
    case "decode":
      error = new JevDecodeError(data.issues, init);
      break;
    case "connection":
      error = new JevConnectionError(data.message, init);
      break;
    case "timeout":
      error = new JevTimeoutError(data.message, init);
      break;
    case "aborted":
      error = new JevAbortError(data.message, init);
      break;
    default:
      error = new JevApiError(data.kind, data.message, {
        ...init,
        status: data.status ?? 0,
      });
  }
  // The subclass constructors derive their messages from issues; keep the
  // original text instead.
  error.message = data.message;
  return error;
}
