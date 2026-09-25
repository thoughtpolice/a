// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link HttpError}, which a handler throws to answer with a status, and
 * {@link RouterError}, which the router throws for a mistake in how it was
 * set up (at registration, never while serving).
 *
 * @module
 */

const CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  408: "request_timeout",
  409: "conflict",
  410: "gone",
  412: "precondition_failed",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable_content",
  429: "too_many_requests",
  431: "headers_too_large",
  500: "internal_error",
  501: "not_implemented",
  502: "bad_gateway",
  503: "unavailable",
  504: "gateway_timeout",
};

/** The default `error` code for a status: `not_found` for 404, and so on. */
export function codeForStatus(status: number): string {
  return CODES[status] ?? (status >= 500 ? "internal_error" : "error");
}

/** Options for {@link HttpError}. */
export interface HttpErrorOptions {
  /** The `error` field of the body; default from the status (`not_found`). */
  readonly code?: string;
  /**
   * Whether the message reaches the client. Default true below 500 and
   * false from 500 up, where the body says only `internal error`.
   */
  readonly expose?: boolean;
  /** Extra response headers, such as `Retry-After`. */
  readonly headers?: HeadersInit;
  /** Extra fields for the JSON body (never for an unexposed error). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * An error that is an HTTP answer. Throw it from a handler or middleware and
 * the router responds with its status and a JSON body
 * `{ "error": code, "message": message, "requestId": ... }`.
 *
 * ```ts
 * throw new HttpError(404, "no such note");
 * throw new HttpError(429, "slow down", { headers: { "retry-after": "30" } });
 * ```
 */
export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;
  readonly headers: Headers;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    message?: string,
    options: HttpErrorOptions = {},
  ) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`an HttpError status is 400 to 599, got ${status}`);
    }
    super(message ?? codeForStatus(status).replaceAll("_", " "), {
      cause: options.cause,
    });
    this.status = status;
    this.code = options.code ?? codeForStatus(status);
    this.expose = options.expose ?? status < 500;
    this.headers = new Headers(options.headers);
    this.details = options.details ?? {};
  }
}

/**
 * A router set up wrongly: a route that is neither public nor
 * authenticated, a duplicate route, a bad pattern or cookie name, CORS
 * that would reflect any origin with credentials. Thrown when the mistake is
 * made, not when a request arrives.
 */
export class RouterError extends Error {
  override readonly name = "RouterError";
}

/**
 * The JSON response for an error: the {@link HttpError}'s own, or an opaque
 * 500 for anything else. Nothing about an unexpected error (its message,
 * stack or type) reaches the body.
 */
export function errorResponse(error: unknown, requestId: string): Response {
  if (!(error instanceof HttpError)) {
    return jsonError(500, "internal_error", "internal error", requestId);
  }
  const body = error.expose
    ? { ...error.details, error: error.code, message: error.message }
    : { error: codeForStatus(error.status), message: "internal error" };
  const response = jsonBody({ ...body, requestId }, error.status);
  error.headers.forEach((value, name) => {
    if (name === "set-cookie") response.headers.append(name, value);
    else response.headers.set(name, value);
  });
  return response;
}

/** `{ error, message, requestId }` with `status`. */
export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Response {
  return jsonBody({ ...extra, error: code, message, requestId }, status);
}

function jsonBody(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
