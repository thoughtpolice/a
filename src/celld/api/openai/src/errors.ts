// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Every failure the client reports: one class hierarchy with a `kind`
 * discriminant and a plain-data form that survives Durable Object RPC and
 * Workflow steps (which keep only an Error's name and message).
 *
 * The classification follows the open-source Codex client
 * (`codex-rs/codex-api/src/api_bridge.rs` and `sse/responses.rs`), which is
 * the reference for what the ChatGPT backend sends: `usage_limit_reached`
 * on 429 is the subscription's window running out, `server_is_overloaded`
 * and `slow_down` arrive as 503 bodies, and policy refusals
 * (`cyber_policy`, `bio_policy`, `invalid_prompt`,
 * `misalignment_policy_violation`) as 400 bodies or `response.failed`
 * events.
 *
 * @module
 */

import {
  formatIssues,
  isPlainObject,
  type Issue,
  type JsonValue,
  tryParseJson,
} from "./json.ts";
import {
  parseRateLimitHeaders,
  type RateLimitSnapshot,
  usageResetAt,
} from "./ratelimits.ts";

/** What went wrong, from the caller's point of view. */
export type GptErrorKind =
  /** Refused before sending; `issues` has the paths. */
  | "invalid_request"
  /** 400 that is not a policy or context-window refusal. */
  | "bad_request"
  /** 401: the integration or its ChatGPT login is not authorised. */
  | "authentication"
  /** 403: not allowed (and not a policy refusal). */
  | "permission"
  /** 404: no such route or model. */
  | "not_found"
  /** 429 or a `rate_limit_exceeded`/`slow_down` code: back off briefly. */
  | "rate_limited"
  /**
   * 429 `usage_limit_reached`: the ChatGPT plan's usage window is spent.
   * `resetsAt` says when it refills. Not retried: the wait is usually hours.
   */
  | "usage_limit"
  /** Quota, spend limit, or the plan does not include this usage. */
  | "quota"
  /** `server_is_overloaded`, a 529, or `flex_unavailable`. */
  | "overloaded"
  /** Other 5xx, or a `response.failed` without a more specific code. */
  | "server"
  /** Any other non-2xx status. */
  | "http"
  /** `context_length_exceeded`: the input is too long for the model. */
  | "context_window"
  /** A safety policy refused the request; `code` names which. */
  | "policy"
  /** `response.incomplete`; `code` holds the reason (such as `max_output_tokens`). */
  | "incomplete"
  /** The event stream broke off or was malformed before `response.completed`. */
  | "stream"
  /** No HTTP response: DNS, TLS, reset. */
  | "connection"
  /** No response headers, or no stream event, within the timeout; or the budget ran out. */
  | "timeout"
  /** The caller's AbortSignal fired. */
  | "aborted"
  /** A 2xx body or event that does not have the documented shape. */
  | "decode"
  /** The model's output failed the requested schema; `issues` has the paths. */
  | "output"
  /** The model refused; `message` carries its refusal text. */
  | "refusal";

/** The kinds a server reports, by status or in the stream. */
export type ApiErrorKind =
  | "bad_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "usage_limit"
  | "quota"
  | "overloaded"
  | "server"
  | "http"
  | "context_window"
  | "policy"
  | "incomplete";

/**
 * A failure as plain data: structured-clone and JSON safe, for RPC results,
 * Workflow step outputs, queues and logs. Absent facts are `null`.
 */
export interface GptErrorData {
  readonly kind: GptErrorKind;
  readonly message: string;
  /** HTTP status, when there was a response (200 for in-stream failures). */
  readonly status: number | null;
  /** The server's error `code` or `type` (`usage_limit_reached`, `cyber_policy`...). */
  readonly code: string | null;
  /** The server's requested wait, from headers or the error message. */
  readonly retryAfterMs: number | null;
  /** When a usage limit resets, in epoch milliseconds. */
  readonly resetsAt: number | null;
  /** `x-request-id` (or `x-oai-request-id`, or `cf-ray`) of the response. */
  readonly requestId: string | null;
  /** The error body: parsed JSON, or text cut to 4 KiB. */
  readonly body: JsonValue | null;
  /** Located problems for `invalid_request`, `decode` and `output`. */
  readonly issues: readonly Issue[];
  /** Rate-limit windows reported alongside the failure. */
  readonly rateLimits: readonly RateLimitSnapshot[];
  /** HTTP attempts made before giving up. */
  readonly attempts: number;
  /** Whether the failure is transient, so a later retry may succeed. */
  readonly retryable: boolean;
}

/** Fields an error is built from; missing ones default to null or empty. */
export interface GptErrorInit {
  readonly status?: number | null;
  readonly code?: string | null;
  readonly retryAfterMs?: number | null;
  readonly resetsAt?: number | null;
  readonly requestId?: string | null;
  readonly body?: JsonValue | null;
  readonly issues?: readonly Issue[];
  readonly rateLimits?: readonly RateLimitSnapshot[];
  readonly attempts?: number;
  readonly cause?: unknown;
}

const TRANSIENT: ReadonlySet<GptErrorKind> = new Set([
  "rate_limited",
  "overloaded",
  "server",
  "stream",
  "connection",
  "timeout",
]);

/** Whether a kind of failure is transient. */
export function isTransient(kind: GptErrorKind): boolean {
  return TRANSIENT.has(kind);
}

/** Base class of every error the library throws. Narrow on `kind`. */
export class GptError extends Error {
  readonly kind: GptErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAfterMs: number | null;
  readonly resetsAt: number | null;
  readonly requestId: string | null;
  readonly body: JsonValue | null;
  readonly issues: readonly Issue[];
  readonly rateLimits: readonly RateLimitSnapshot[];
  /** HTTP attempts made; the client fills this in when it gives up. */
  attempts: number;

  constructor(kind: GptErrorKind, message: string, init: GptErrorInit = {}) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "GptError";
    this.kind = kind;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.resetsAt = init.resetsAt ?? null;
    this.requestId = init.requestId ?? null;
    this.body = init.body ?? null;
    this.issues = init.issues ?? [];
    this.rateLimits = init.rateLimits ?? [];
    this.attempts = init.attempts ?? 0;
  }

  /** Whether the failure is transient, so a later retry may succeed. */
  get retryable(): boolean {
    return isTransient(this.kind);
  }

  /** The plain-data form, which survives RPC; `JSON.stringify` uses it too. */
  toJSON(): GptErrorData {
    return {
      kind: this.kind,
      message: this.message,
      status: this.status,
      code: this.code,
      retryAfterMs: this.retryAfterMs,
      resetsAt: this.resetsAt,
      requestId: this.requestId,
      body: this.body,
      issues: this.issues.map((issue) => ({
        path: [...issue.path],
        message: issue.message,
      })),
      rateLimits: this.rateLimits.map((snapshot) => structuredClone(snapshot)),
      attempts: this.attempts,
      retryable: this.retryable,
    };
  }
}

/** A failure the server reported, by HTTP status or inside the stream. */
export class GptApiError extends GptError {
  declare readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind, message: string, init: GptErrorInit = {}) {
    super(kind, message, init);
    this.name = "GptApiError";
  }
}

/** The request was refused before sending. */
export class GptInvalidRequestError extends GptError {
  declare readonly kind: "invalid_request";

  constructor(issues: readonly Issue[], init: GptErrorInit = {}) {
    super("invalid_request", `invalid request: ${formatIssues(issues)}`, {
      ...init,
      issues,
    });
    this.name = "GptInvalidRequestError";
  }
}

/** A body or event without the documented shape. */
export class GptDecodeError extends GptError {
  declare readonly kind: "decode";

  constructor(issues: readonly Issue[], init: GptErrorInit = {}) {
    super("decode", `unexpected response: ${formatIssues(issues)}`, {
      ...init,
      issues,
    });
    this.name = "GptDecodeError";
  }
}

/** The model's output failed the requested schema, or the model refused. */
export class GptOutputError extends GptError {
  declare readonly kind: "output" | "refusal";

  constructor(
    kind: "output" | "refusal",
    message: string,
    init: GptErrorInit = {},
  ) {
    super(kind, message, init);
    this.name = "GptOutputError";
  }
}

/** The stream broke off or was malformed before it completed. */
export class GptStreamError extends GptError {
  declare readonly kind: "stream";

  constructor(message: string, init: GptErrorInit = {}) {
    super("stream", message, init);
    this.name = "GptStreamError";
  }
}

/** No HTTP response arrived. */
export class GptConnectionError extends GptError {
  declare readonly kind: "connection";

  constructor(message: string, init: GptErrorInit = {}) {
    super("connection", message, init);
    this.name = "GptConnectionError";
  }
}

/** A timeout, or the retry budget, ran out. */
export class GptTimeoutError extends GptError {
  declare readonly kind: "timeout";

  constructor(message: string, init: GptErrorInit = {}) {
    super("timeout", message, init);
    this.name = "GptTimeoutError";
  }
}

/** The caller aborted. Never retried. */
export class GptAbortError extends GptError {
  declare readonly kind: "aborted";

  constructor(message = "the request was aborted", init: GptErrorInit = {}) {
    super("aborted", message, init);
    this.name = "GptAbortError";
  }
}

/** The classes, as a union that narrows on `kind`. */
export type AnyGptError =
  | GptApiError
  | GptInvalidRequestError
  | GptDecodeError
  | GptOutputError
  | GptStreamError
  | GptConnectionError
  | GptTimeoutError
  | GptAbortError;

/** True for any error this library throws. */
export function isGptError(value: unknown): value is AnyGptError {
  return value instanceof GptError;
}

/** Rebuilds the error class from its plain-data form. */
export function gptErrorFromData(data: GptErrorData): AnyGptError {
  const init: GptErrorInit = {
    status: data.status,
    code: data.code,
    retryAfterMs: data.retryAfterMs,
    resetsAt: data.resetsAt,
    requestId: data.requestId,
    body: data.body,
    issues: data.issues,
    rateLimits: data.rateLimits,
    attempts: data.attempts,
  };
  let error: AnyGptError;
  switch (data.kind) {
    case "invalid_request":
      error = new GptInvalidRequestError(data.issues, init);
      break;
    case "decode":
      error = new GptDecodeError(data.issues, init);
      break;
    case "output":
    case "refusal":
      error = new GptOutputError(data.kind, data.message, init);
      break;
    case "stream":
      error = new GptStreamError(data.message, init);
      break;
    case "connection":
      error = new GptConnectionError(data.message, init);
      break;
    case "timeout":
      error = new GptTimeoutError(data.message, init);
      break;
    case "aborted":
      error = new GptAbortError(data.message, init);
      break;
    default:
      error = new GptApiError(data.kind, data.message, init);
  }
  error.message = data.message;
  return error;
}

/** Error bodies kept on errors are cut to this many characters. */
export const MAX_ERROR_TEXT = 4096;

/** An error body: parsed JSON, or text cut to {@link MAX_ERROR_TEXT}. */
export function errorBody(text: string): JsonValue | null {
  if (text === "") return null;
  const parsed = tryParseJson(text);
  if (parsed !== undefined) return parsed;
  return text.length > MAX_ERROR_TEXT
    ? `${text.slice(0, MAX_ERROR_TEXT)}…`
    : text;
}

/** The `{type, code, message, ...}` object of an OpenAI-style error. */
export interface ServerErrorObject {
  readonly type: string | null;
  readonly code: string | null;
  readonly message: string | null;
  /** `resets_at`, in epoch seconds, for usage limits. */
  readonly resetsAt: number | null;
  readonly planType: string | null;
}

/** Reads the error object from `{error: {...}}`, a bare error, or `{detail}`. */
export function serverErrorObject(body: JsonValue | null): ServerErrorObject {
  const empty: ServerErrorObject = {
    type: null,
    code: null,
    message: null,
    resetsAt: null,
    planType: null,
  };
  if (typeof body === "string") {
    return { ...empty, message: body.trim() === "" ? null : body };
  }
  if (!isPlainObject(body)) return empty;
  const inner = isPlainObject(body.error) ? body.error : body;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  const detail = text(body.detail);
  return {
    type: text(inner.type),
    code: text(inner.code),
    message: text(inner.message) ?? text(body.error) ?? detail,
    resetsAt: typeof inner.resets_at === "number" &&
        Number.isFinite(inner.resets_at)
      ? inner.resets_at
      : null,
    planType: text(inner.plan_type),
  };
}

const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "usage_not_included",
]);

const POLICY_CODES = new Set([
  "cyber_policy",
  "bio_policy",
  "invalid_prompt",
  "misalignment_policy_violation",
]);

const RETRY_IN = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)\b/i;

/**
 * The wait a `rate_limit_exceeded` message asks for ("try again in 1.5s"),
 * which Codex reads out of the text since no header carries it in-stream.
 */
export function retryDelayFromMessage(message: string | null): number | null {
  if (message === null) return null;
  const match = RETRY_IN.exec(message);
  if (match === null) return null;
  const value = Number(match[1]);
  return match[2].toLowerCase() === "ms"
    ? Math.ceil(value)
    : Math.ceil(value * 1000);
}

/**
 * The kind for an error code, when the code alone decides it; `null` when the
 * status (or the in-stream default) should.
 */
export function kindForCode(code: string | null): ApiErrorKind | null {
  if (code === null) return null;
  if (code === "usage_limit_reached") return "usage_limit";
  if (QUOTA_CODES.has(code)) return "quota";
  if (POLICY_CODES.has(code)) return "policy";
  if (code === "context_length_exceeded") return "context_window";
  if (code === "server_is_overloaded" || code === "flex_unavailable") {
    return "overloaded";
  }
  if (code === "rate_limit_exceeded" || code === "slow_down") {
    return "rate_limited";
  }
  return null;
}

/** The kind for an HTTP status when no code decides it. */
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
    case 429:
      return "rate_limited";
    case 529:
      return "overloaded";
  }
  return status >= 500 && status <= 599 ? "server" : "http";
}

const POLICY_FALLBACK: Record<string, string> = {
  cyber_policy:
    "This request has been flagged for possible cybersecurity risk.",
  bio_policy: "This content was flagged for possible biological risk.",
  invalid_prompt: "Invalid request.",
  misalignment_policy_violation:
    "This request was blocked due to a misalignment policy violation.",
};

/** The request id headers Codex reads, in its order of preference. */
export function requestIdOf(headers: Headers): string | null {
  return headers.get("x-request-id") ?? headers.get("x-oai-request-id") ??
    headers.get("cf-ray");
}

/**
 * Classifies a non-2xx response the way Codex's `api_bridge` does. The
 * `retryAfterMs` argument is the parsed `retry-after`, if any.
 */
export function apiErrorFromResponse(
  status: number,
  text: string,
  headers: Headers,
  retryAfterMs: number | null,
): GptApiError {
  const body = errorBody(text);
  const error = serverErrorObject(body);
  const code = error.type === "usage_limit_reached" ||
      error.type === "usage_not_included" ||
      error.type === "insufficient_quota"
    ? error.type
    : error.code ?? error.type;
  let kind = kindForCode(code) ?? kindForStatus(status);
  // A code only counts where Codex honours it: policy codes on 400/403,
  // overload and slow-down on 503, usage and quota on 429.
  if (kind === "policy" && status !== 400 && status !== 403) {
    kind = kindForStatus(status);
  }
  const rateLimits = parseRateLimitHeaders(headers);
  const resetsAt = kind !== "usage_limit"
    ? null
    : error.resetsAt !== null
    ? error.resetsAt * 1000
    : usageResetAt(rateLimits, headers.get("x-codex-active-limit"));
  const detail = error.message ??
    (code !== null ? POLICY_FALLBACK[code] ?? null : null);
  return new GptApiError(
    kind,
    `GPT returned ${status} (${kind}${code === null ? "" : `: ${code}`})${
      detail === null ? "" : `: ${detail}`
    }`,
    {
      status,
      code,
      body,
      requestId: requestIdOf(headers),
      retryAfterMs: retryAfterMs ??
        (kind === "rate_limited" ? retryDelayFromMessage(error.message) : null),
      resetsAt,
      rateLimits,
    },
  );
}

/**
 * Classifies the `error` of a `response.failed` event, or an `error` event,
 * as Codex's `process_responses_event` does: specific codes map to their
 * kinds, and anything else is a retryable `server` failure.
 */
export function apiErrorFromEvent(
  error: unknown,
  what: string,
  requestId: string | null,
): GptApiError {
  const parsed = serverErrorObject((error ?? null) as JsonValue | null);
  const code = parsed.code ?? parsed.type;
  const kind = kindForCode(code) ?? "server";
  const detail = parsed.message ??
    (code !== null ? POLICY_FALLBACK[code] ?? null : null);
  return new GptApiError(
    kind,
    `${what} (${kind}${code === null ? "" : `: ${code}`})${
      detail === null ? "" : `: ${detail}`
    }`,
    {
      status: 200,
      code,
      requestId,
      body: (error ?? null) as JsonValue | null,
      retryAfterMs: kind === "rate_limited"
        ? retryDelayFromMessage(parsed.message)
        : null,
      resetsAt: parsed.resetsAt === null ? null : parsed.resetsAt * 1000,
    },
  );
}
