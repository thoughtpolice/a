// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST https://exe.dev/exec`: one command line in, the command's output out.
 *
 * {@link ExeTransport.send} is the only code that talks to the lobby. It
 * applies a per-attempt timeout (default 40 s: the server gives a command 30 s
 * and answers 504 after that), consults the limiter, maps statuses to typed
 * errors, and retries only when the command is idempotent and the failure is
 * one the policy retries. A mutating command gets exactly one attempt.
 *
 * @module
 */

import { mayRetry, type RetryFailure, truncatedBody } from "@celld/http";
import { MAX_TIMER_MS, safeInt } from "@celld/core/bounds";
import {
  type Admission,
  type RateLimiter,
  UpstreamLimit,
} from "@celld/sec/ratelimit";
import { checkBodySize, type Command } from "./command.ts";
import {
  ExeAbortError,
  ExeApiError,
  ExeConnectionError,
  ExeDecodeError,
  ExeError,
  type ExeErrorData,
  ExeTimeoutError,
  isAmbiguousKind,
  kindForStatus,
} from "./errors.ts";
import { isPlainObject, type JsonValue } from "./json.ts";
import {
  backoffDelay,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryOptions,
  type RetryPolicy,
} from "./retry.ts";
import {
  checkCredentialedOrigin,
  DEFAULT_MAX_RESPONSE_BYTES,
  defaultRuntime,
  type FetchLike,
  globalFetch,
  MAX_RESPONSE_BYTES,
  readCapped,
  rejectOnAbort,
  type Runtime,
} from "./runtime.ts";
import { staticTokenSource, type TokenSource } from "./tokens.ts";

/** The lobby's origin. */
export const DEFAULT_BASE_URL = "https://exe.dev";
/** The server's own command timeout, after which it answers 504. */
export const SERVER_TIMEOUT_MS = 30_000;
/** The default per-attempt timeout: the server's 30 s plus slack. */
export const DEFAULT_TIMEOUT_MS = 40_000;
/** This library's version, sent in the default `user-agent`. */
export const VERSION = "0.1.0";

/** What a retry is about to do, for logging and metrics. */
export interface RetryEvent {
  /** The attempt that failed, from 1. */
  readonly attempt: number;
  /** How long the client will wait before the next attempt. */
  readonly delayMs: number;
  readonly error: ExeErrorData;
}

/** How to construct a transport (and so an `ExeClient`). */
export interface TransportOptions {
  /** A bearer token (`exe0.`/`exe1.`), or a source that mints them. */
  readonly token: string | TokenSource;
  /**
   * The lobby origin; default `https://exe.dev`. It must be `https:`
   * without credentials, to a DNS name or a public address; `http:` or a
   * loopback address needs `allowLoopbackForDevelopment`.
   */
  readonly baseUrl?: string;
  /**
   * Allows `http:` and loopback addresses for `baseUrl`, for a fake lobby
   * in development and tests. Never set it in production.
   */
  readonly allowLoopbackForDevelopment?: boolean;
  /** The most bytes read from one response; default 8 MiB, at most 64 MiB. */
  readonly maxResponseBytes?: number;
  /** The `fetch` to use; default the global one. */
  readonly fetch?: FetchLike;
  /** Overrides of the default retry policy. */
  readonly retry?: RetryOptions;
  /** The per-attempt timeout; default 40 s, at most `MAX_TIMER_MS`. */
  readonly timeoutMs?: number;
  /** The `user-agent` header; default `celld-exedev/<version>`. */
  readonly userAgent?: string;
  /** Extra headers on every request; `authorization` stays the client's. */
  readonly headers?: Record<string, string>;
  /**
   * An `@celld/sec/ratelimit` limiter asked before each attempt, usually a
   * `durableLimiter` with {@link exePolicies} that every client of one SSH
   * key shares; default none. An attempt costs one unit of each policy,
   * and a 429's `retry-after` holds the key, pausing every caller.
   */
  readonly limiter?: RateLimiter;
  /**
   * The limiter key: the SSH key's fingerprint, since the server's limit is
   * per key. Default `"default"`.
   */
  readonly limiterKey?: string;
  /** Called when the limiter throws; the request then goes ahead. */
  readonly onLimiterError?: (error: unknown) => void;
  /** Called before each retry's wait. */
  readonly onRetry?: (event: RetryEvent) => void;
  /** Time and randomness; default real time. */
  readonly runtime?: Runtime;
}

/** Per-call settings. */
export interface CallOptions {
  /**
   * Cancels the call, including limiter, token and retry waits; a call
   * cancelled before it is sent is never sent.
   */
  readonly signal?: AbortSignal;
  /** The per-attempt timeout for this call. */
  readonly timeoutMs?: number;
  /** Retry overrides for this call, or `false` for a single attempt. */
  readonly retry?: RetryOptions | false;
  /** Extra headers for this call. */
  readonly headers?: Record<string, string>;
  /**
   * Non-2xx statuses to return as responses instead of throwing (the caller
   * then turns them into errors with {@link ExeTransport.apiError}).
   */
  readonly acceptStatuses?: readonly number[];
}

/** A response to one command: 2xx, or a status the caller accepted. */
export interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  /** HTTP attempts made. */
  readonly attempts: number;
}

const utf8 = new TextDecoder();

/** The human-readable part of an error body. */
export function errorDetail(body: JsonValue | null): string | null {
  if (typeof body === "string") return body.trim() === "" ? null : body.trim();
  if (!isPlainObject(body)) return null;
  for (const field of [body.error, body.message, body.detail, body.output]) {
    if (typeof field === "string" && field.trim() !== "") return field.trim();
    if (isPlainObject(field) && typeof field.message === "string") {
      return field.message;
    }
  }
  return null;
}

/** A timeout: a positive number of milliseconds a timer can hold. */
export function checkTimeout(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${value}`);
  }
  if (value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be at most ${MAX_TIMER_MS} ms, got ${value}`,
    );
  }
  return value;
}

/**
 * Settles like `promise`, or rejects as soon as `signal` fires (a limiter or
 * token source that takes no signal cannot hold a cancelled call).
 */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return signal === undefined ? promise : rejectOnAbort(promise, signal);
}

/** How connection errors the transport made failed, for `mayRetry`. */
const FAILURES = new WeakMap<ExeError, RetryFailure>();

/**
 * Timeouts from a limiter that will not admit the request before the
 * budget ends. It said when it would, so trying again within the call is
 * refused again: they are not retried here, though an outer retry, later,
 * may be.
 */
const UNADMITTED = new WeakSet<ExeError>();

/** The HTTPS transport; see the module notes. */
export class ExeTransport {
  /** The lobby origin, without a trailing slash. */
  readonly baseUrl: string;
  /** The resolved retry policy. */
  readonly retry: RetryPolicy;
  /** The per-attempt timeout, in milliseconds. */
  readonly timeoutMs: number;
  /** The clock this transport uses. */
  readonly runtime: Runtime;
  /** The most bytes read from one response. */
  readonly maxResponseBytes: number;

  readonly #tokens: TokenSource;
  readonly #fetch: FetchLike;
  readonly #headers: Headers;
  readonly #limit: UpstreamLimit | null;
  readonly #onRetry: (event: RetryEvent) => void;

  /**
   * @throws {TypeError} a missing token, a base URL that is not http(s), or
   * a limiter or limiter key that is not one.
   * @throws {RangeError} a timeout or retry setting out of range.
   */
  constructor(options: TransportOptions) {
    if (typeof options.token === "string") {
      if (options.token.trim() === "") {
        throw new TypeError("ExeClient needs a token");
      }
      if (/\s/.test(options.token)) {
        throw new TypeError("the token must not contain whitespace");
      }
    } else if (typeof options.token?.token !== "function") {
      throw new TypeError("ExeClient needs a token or a TokenSource");
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new TypeError(`baseUrl is not a URL: ${baseUrl}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError(`baseUrl must be http(s), got ${baseUrl}`);
    }
    checkCredentialedOrigin(
      url,
      options.allowLoopbackForDevelopment === true,
      "baseUrl",
    );
    this.baseUrl = baseUrl;
    this.maxResponseBytes = safeInt(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      { name: "maxResponseBytes", min: 1, max: MAX_RESPONSE_BYTES },
    );
    this.retry = resolveRetryPolicy(options.retry);
    this.timeoutMs = checkTimeout(
      "timeoutMs",
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.runtime = options.runtime ?? defaultRuntime;
    this.#tokens = typeof options.token === "string"
      ? staticTokenSource(options.token)
      : options.token;
    this.#fetch = options.fetch ?? globalFetch;
    this.#headers = new Headers(options.headers);
    this.#headers.set(
      "user-agent",
      options.userAgent ?? `celld-exedev/${VERSION}`,
    );
    this.#limit = options.limiter === undefined
      ? null
      : new UpstreamLimit(options.limiter, {
        key: options.limiterKey,
        onError: options.onLimiterError,
      });
    this.#onRetry = options.onRetry ?? (() => {});
  }

  async #sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.runtime.sleep(ms, signal);
    } catch (cause) {
      if (signal?.aborted) throw new ExeAbortError(undefined, { cause });
      throw cause;
    }
  }

  /** Waits for the limiter's admission; true when one was spent. */
  async #admit(
    deadline: number,
    budgetMs: number | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const limit = this.#limit;
    if (limit === null) return false;
    let admission: Admission;
    try {
      admission = await limit.admit({
        deadline,
        runtime: this.runtime,
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw new ExeAbortError(undefined, { cause });
      throw cause;
    }
    if (admission === "refused") {
      const error = new ExeTimeoutError(
        `the rate limiter could not admit the request within the ${budgetMs} ms budget`,
      );
      UNADMITTED.add(error);
      throw error;
    }
    return admission === "admitted";
  }

  /** The bearer token; waiting for it ends when the signal fires. */
  async #token(signal: AbortSignal | undefined): Promise<string> {
    try {
      return await abortable(this.#tokens.token(), signal);
    } catch (cause) {
      if (signal?.aborted) throw new ExeAbortError(undefined, { cause });
      throw cause;
    }
  }

  /** Whether `error` may be retried, by `@celld/http`'s `mayRetry`. */
  #retryable(
    error: ExeError,
    policy: RetryPolicy,
    idempotent: boolean,
  ): boolean {
    if (UNADMITTED.has(error)) return false;
    const failure: RetryFailure | null = FAILURES.get(error) ??
      (error instanceof ExeApiError
        ? { kind: "status", status: error.status }
        : error instanceof ExeTimeoutError
        ? { kind: "timeout" }
        : null);
    if (failure === null) return false;
    return mayRetry(policy, failure, { idempotent });
  }

  async #attempt(
    command: Command,
    headers: Headers,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const url = `${this.baseUrl}/exec`;
    // A cancelled call is never sent, whatever the caller awaited before.
    if (signal?.aborted) {
      throw new ExeAbortError(undefined, {
        cause: signal.reason,
        command: command.redacted,
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = this.runtime.setTimer(timeoutMs, () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    });
    const onAbort = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const failure = (cause: unknown, stage: string): ExeError => {
      if (signal?.aborted) {
        return new ExeAbortError(undefined, {
          cause,
          command: command.redacted,
        });
      }
      if (timedOut) {
        return new ExeTimeoutError(
          `no ${stage} for \`${command.redacted}\` within ${timeoutMs} ms`,
          { cause, command: command.redacted, ambiguous: true },
        );
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      const error = new ExeConnectionError(
        `POST ${url} failed reading the ${stage}: ${reason}`,
        { cause, command: command.redacted },
      );
      FAILURES.set(
        error,
        stage === "response" ? { kind: "connection" } : { kind: "body" },
      );
      return error;
    };
    try {
      let response: Response;
      try {
        response = await rejectOnAbort(
          this.#fetch(url, {
            method: "POST",
            headers,
            body: command.line,
            // A redirect is answered as the error it is: the token never
            // follows it to another origin.
            redirect: "manual",
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (cause) {
        throw failure(cause, "response");
      }
      let body: Uint8Array | null;
      try {
        body = await rejectOnAbort(
          readCapped(response, this.maxResponseBytes, controller.signal),
          controller.signal,
        );
      } catch (cause) {
        throw failure(cause, "response body");
      }
      if (body === null) {
        if (response.status >= 200 && response.status <= 299) {
          throw new ExeDecodeError([{
            path: [],
            message:
              `the response is larger than ${this.maxResponseBytes} bytes`,
          }], { status: response.status, command: command.redacted });
        }
        body = new Uint8Array(0);
      }
      return { status: response.status, headers: response.headers, body };
    } finally {
      cancel();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The typed error for a non-2xx response. */
  apiError(
    command: Command,
    status: number,
    headers: Headers,
    body: Uint8Array,
  ): ExeApiError {
    const kind = kindForStatus(status);
    const parsed = truncatedBody(utf8.decode(body));
    const detail = errorDetail(parsed);
    const what: Record<string, string> = {
      bad_request: "the lobby could not parse the command",
      authentication: "the token was refused",
      permission: "the token's cmds do not allow this command",
      not_found: "no such command",
      method_not_allowed: "only POST is accepted",
      too_large: "the command is over 64 KiB",
      command_failed: "the command failed",
      rate_limited: "too many requests from this SSH key",
      command_timeout: "the command ran longer than 30 seconds",
      server: "exe.dev had an internal error",
      http: "unexpected status",
    };
    return new ExeApiError(
      kind,
      `exe.dev answered ${status} to \`${command.redacted}\`: ${
        detail ?? what[kind]
      }`,
      {
        status,
        body: parsed,
        detail,
        command: command.redacted,
        retryAfterMs: parseRetryAfter(headers, this.runtime.now()),
        ambiguous: isAmbiguousKind(kind),
      },
    );
  }

  /**
   * Sends one command and returns the 2xx response, retrying only when the
   * command is idempotent (see the module notes).
   *
   * @throws {ExeApiError} a non-2xx response, once retries are spent.
   * @throws {ExeConnectionError} no response, once retries are spent.
   * @throws {ExeTimeoutError} an attempt or the budget ran out of time.
   * @throws {ExeAbortError} the signal fired.
   */
  async send(
    command: Command,
    options: CallOptions = {},
  ): Promise<RawResponse> {
    checkBodySize(command.line);
    const single = options.retry === false || !command.idempotent;
    const policy = options.retry === false || options.retry === undefined
      ? this.retry
      : resolveRetryPolicy(options.retry, this.retry);
    const maxRetries = single ? 0 : policy.maxRetries;
    const timeoutMs = checkTimeout(
      "timeoutMs",
      options.timeoutMs ?? this.timeoutMs,
    );
    const { signal } = options;
    const deadline = policy.budgetMs === null
      ? Number.POSITIVE_INFINITY
      : this.runtime.now() + policy.budgetMs;

    let attempts = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new ExeAbortError(undefined, {
          attempts,
          cause: signal.reason,
          command: command.redacted,
        });
      }
      let error: ExeError;
      try {
        const admitted = await this.#admit(deadline, policy.budgetMs, signal);
        let token: string;
        try {
          token = await this.#token(signal);
          // The limiter and the token source may answer after the caller
          // gave up: a call cancelled while they held it is not sent.
          if (signal?.aborted) {
            throw new ExeAbortError(undefined, {
              cause: signal.reason,
              command: command.redacted,
            });
          }
        } catch (unsent) {
          // What the admission spent goes back, since nothing was sent.
          if (admitted) await this.#limit!.giveBack();
          throw unsent;
        }
        const remaining = deadline - this.runtime.now();
        if (remaining <= 0) {
          // Nothing was sent, so what the admission spent goes back.
          if (admitted) await this.#limit!.giveBack();
          throw new ExeTimeoutError(
            `the ${policy.budgetMs} ms retry budget ran out`,
            {
              command: command.redacted,
            },
          );
        }
        const headers = new Headers(this.#headers);
        for (const [name, value] of new Headers(options.headers)) {
          headers.set(name, value);
        }
        headers.set("authorization", `Bearer ${token}`);
        headers.set("content-type", "text/plain; charset=utf-8");
        attempts++;
        const response = await this.#attempt(
          command,
          headers,
          Math.min(timeoutMs, remaining),
          signal,
        );
        if (
          (response.status >= 200 && response.status <= 299) ||
          options.acceptStatuses?.includes(response.status)
        ) {
          return { ...response, attempts };
        }
        const apiError = this.apiError(
          command,
          response.status,
          response.headers,
          response.body,
        );
        if (
          apiError.kind === "rate_limited" && apiError.retryAfterMs !== null &&
          apiError.retryAfterMs > 0
        ) {
          await this.#limit?.hold(
            Math.min(apiError.retryAfterMs, policy.maxRetryAfterMs),
          );
        }
        throw apiError;
      } catch (caught) {
        if (!(caught instanceof ExeError)) throw caught;
        error = caught;
      }
      error.attempts = attempts;
      if (
        attempts > maxRetries ||
        !this.#retryable(error, policy, command.idempotent)
      ) {
        throw error;
      }
      const delayMs = policy.respectRetryAfter && error.retryAfterMs !== null
        ? Math.min(error.retryAfterMs, policy.maxRetryAfterMs)
        : backoffDelay(policy, attempts - 1, this.runtime.random());
      if (this.runtime.now() + delayMs >= deadline) throw error;
      this.#onRetry({ attempt: attempts, delayMs, error: error.toJSON() });
      try {
        await this.#sleep(delayMs, signal);
      } catch (aborted) {
        if (aborted instanceof ExeError) aborted.attempts = attempts;
        throw aborted;
      }
    }
  }
}
