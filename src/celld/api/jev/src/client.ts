// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The System One client.
 *
 * ```ts
 * const client = JevClient.fromEnv(env);
 * const { answers } = await client.ask({
 *   state: ticket,
 *   questions: {
 *     team: choice("Which team should handle this?", ["billing", "technical"]),
 *     urgent: noul("Does this convey urgency?"),
 *   },
 * });
 * answers.team.choice; // "billing" | "technical"
 * ```
 *
 * It uses only `fetch`, `AbortController`, timers and `crypto.subtle`, so it
 * runs in celld Workers, Durable Objects and Workflows, and in Deno tests with
 * an injected `fetch` and {@link Runtime}.
 *
 * @module
 */

import { isPinnedModel } from "./builders.ts";
import { cacheKey } from "./cache.ts";
import { decodeModels, decodeResponse } from "./decode.ts";
import {
  JevAbortError,
  JevApiError,
  JevConnectionError,
  JevDecodeError,
  JevError,
  type JevErrorData,
  JevInvalidRequestError,
  JevTimeoutError,
  kindForStatus,
} from "./errors.ts";
import {
  defaultRuntime,
  type FetchLike,
  globalFetch,
  rejectOnAbort,
  type Runtime,
  truncatedBody,
} from "@celld/http";
import type { Issue } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import {
  backoffDelay,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryOptions,
  type RetryPolicy,
} from "./retry.ts";
import { type DecodeOptions, requestIssues } from "./schemas.ts";
import type {
  AnswerCache,
  AnswersFor,
  CacheStatus,
  JevRequest,
  JevResult,
  Limiter,
  LimiterDecision,
  Model,
  ModelCard,
  Questions,
  Usage,
} from "./types.ts";

export { defaultRuntime, type FetchLike, type Runtime } from "@celld/http";

/** The API root the SDKs use. */
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** The SDKs' default model: TypeSafe's most recent stable release. */
export const DEFAULT_MODEL = "jev-latest";
/** The SDKs' default per-attempt timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** This library's version, sent in the default `user-agent`. */
export const VERSION = "0.1.0";

/** What a retry is about to do, for logging and metrics. */
export interface RetryEvent {
  /** The attempt that failed, from 1. */
  readonly attempt: number;
  /** How long the client will wait before the next attempt. */
  readonly delayMs: number;
  readonly error: JevErrorData;
}

/** How to construct a {@link JevClient}. */
export interface JevClientOptions {
  /** The TypeSafe API key. Take it from a secret binding, never source. */
  readonly apiKey: string;
  /** The API root; default `https://api.typesafe.ai`. */
  readonly baseUrl?: string;
  /** The default model; default `jev-latest`. Pin a version to tune on. */
  readonly model?: Model;
  /** The `fetch` to use; default the global one. */
  readonly fetch?: FetchLike;
  /** Overrides of the default {@link RetryPolicy}. */
  readonly retry?: RetryOptions;
  /** The per-attempt timeout; default 10 s. */
  readonly timeoutMs?: number;
  /** The `user-agent` header; default `celld-jev/<version>`. */
  readonly userAgent?: string;
  /**
   * Extra headers on every request. `authorization`, `content-type` and
   * `accept` are the client's and cannot be overridden.
   */
  readonly headers?: Record<string, string>;
  /** Admission control consulted before each attempt; default none. */
  readonly limiter?: Limiter;
  /**
   * Input tokens to reserve from the limiter before each attempt; default 0.
   * The actual count is charged once the response reports it.
   */
  readonly reserveTokens?: number;
  /**
   * Called when the limiter throws. The request then goes ahead (the server's
   * 429 stays authoritative), so a limiter outage does not stop traffic.
   */
  readonly onLimiterError?: (error: unknown) => void;
  /** The answer cache, used only for versioned models; default none. */
  readonly cache?: AnswerCache;
  /** How strictly to decode responses. */
  readonly decode?: DecodeOptions;
  /** Called before each retry's wait. */
  readonly onRetry?: (event: RetryEvent) => void;
  /** Time and randomness; default real time. */
  readonly runtime?: Runtime;
}

/** Per-call settings. */
export interface AskOptions {
  /** Cancels the call, including limiter and retry waits. */
  readonly signal?: AbortSignal;
  /** The model for this call; must agree with `request.model` if both are set. */
  readonly model?: Model;
  /** The per-attempt timeout for this call. */
  readonly timeoutMs?: number;
  /** Retry overrides for this call, over the client's policy. */
  readonly retry?: RetryOptions;
  /** Extra headers for this call, over the client's. */
  readonly headers?: Record<string, string>;
}

/** An outcome as plain data: a result, or a failure's plain-data form. */
export type JevOutcome<Qs extends Questions = Questions> =
  | { readonly ok: true; readonly result: JevResult<Qs> }
  | { readonly ok: false; readonly error: JevErrorData };

/** The `env` bindings {@link JevClient.fromEnv} reads. */
export interface JevEnv {
  /** The API key, as a secret binding. */
  readonly TYPESAFE_API_KEY?: string;
  /** Overrides the API root, for proxies and tests. */
  readonly TYPESAFE_BASE_URL?: string;
  /** Overrides the default model. */
  readonly TYPESAFE_DEFAULT_MODEL?: string;
}

interface Exchange {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The human-readable part of an error body, in the shapes APIs use. */
function errorDetail(body: JsonValue | null): string | null {
  if (typeof body === "string") return body.trim() === "" ? null : body;
  if (!isPlainObject(body)) return null;
  for (const field of [body.detail, body.message, body.error]) {
    if (typeof field === "string") return field;
    if (isPlainObject(field) && typeof field.message === "string") {
      return field.message;
    }
  }
  return null;
}

/**
 * The located problems in a 422 body. FastAPI-style `{"detail": [{"loc",
 * "msg"}]}` becomes one issue per entry, with `body` dropped from the
 * location so paths match the request (`questions.dept.criteria`); any other
 * detail becomes one issue at the root. Each is a sieve `custom` issue.
 */
export function validationIssues(body: JsonValue | null): Issue[] {
  if (isPlainObject(body) && Array.isArray(body.detail)) {
    const issues: Issue[] = [];
    for (const item of body.detail) {
      if (!isPlainObject(item)) continue;
      const location = Array.isArray(item.loc)
        ? item.loc.filter((part): part is string | number =>
          typeof part === "string" || typeof part === "number"
        )
        : [];
      if (location[0] === "body") location.shift();
      const message = typeof item.msg === "string"
        ? item.msg
        : typeof item.message === "string"
        ? item.message
        : JSON.stringify(item);
      issues.push({ code: "custom", path: location, message });
    }
    if (issues.length > 0) return issues;
  }
  const detail = errorDetail(body);
  return detail === null ? [] : [{ code: "custom", path: [], message: detail }];
}

function checkTimeout(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${value}`);
  }
  return value;
}

/**
 * A client for TypeSafe's System One API (`POST /v1/systemone`) and model
 * listing (`GET /v1/models`).
 *
 * Every call validates its request, waits for the limiter if there is one,
 * and retries transient failures under the {@link RetryPolicy}; answers are
 * decoded strictly against the questions asked. Failures are thrown as
 * {@link JevError}s; {@link JevClient.tryAsk} returns them as plain data.
 */
export class JevClient {
  /** The API root, without a trailing slash. */
  readonly baseUrl: string;
  /** The model used when a request names none. */
  readonly model: Model;
  /** The resolved retry policy. */
  readonly retry: RetryPolicy;
  /** The per-attempt timeout, in milliseconds. */
  readonly timeoutMs: number;
  /** Access to `GET /v1/models`. */
  readonly models: {
    /** The models and aliases the account can use. */
    list(options?: AskOptions): Promise<ModelCard[]>;
  };

  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #headers: Headers;
  readonly #limiter: Limiter | null;
  readonly #reserveTokens: number;
  readonly #onLimiterError: (error: unknown) => void;
  readonly #cache: AnswerCache | null;
  readonly #decode: DecodeOptions;
  readonly #onRetry: (event: RetryEvent) => void;
  readonly #runtime: Runtime;

  /**
   * @throws {TypeError} a missing key, or a base URL that is not http(s).
   * @throws {RangeError} a timeout, reservation or retry setting out of range.
   */
  constructor(options: JevClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
      throw new TypeError("JevClient needs an apiKey");
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
    const reserve = options.reserveTokens ?? 0;
    if (!Number.isFinite(reserve) || reserve < 0) {
      throw new RangeError(
        `reserveTokens must be non-negative, got ${reserve}`,
      );
    }
    this.baseUrl = baseUrl;
    this.model = options.model ?? DEFAULT_MODEL;
    this.retry = resolveRetryPolicy(options.retry);
    this.timeoutMs = checkTimeout(
      "timeoutMs",
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalFetch;
    this.#headers = new Headers(options.headers);
    this.#headers.set(
      "user-agent",
      options.userAgent ?? `celld-jev/${VERSION}`,
    );
    this.#limiter = options.limiter ?? null;
    this.#reserveTokens = reserve;
    this.#onLimiterError = options.onLimiterError ?? (() => {});
    this.#cache = options.cache ?? null;
    this.#decode = options.decode ?? {};
    this.#onRetry = options.onRetry ?? (() => {});
    this.#runtime = options.runtime ?? defaultRuntime;
    this.models = {
      list: async (callOptions: AskOptions = {}) =>
        (await this.#send(
          "GET",
          "/v1/models",
          undefined,
          callOptions,
          decodeModels,
          () => 0,
        )).value,
    };
  }

  /**
   * A client configured from Worker bindings: `TYPESAFE_API_KEY` (a secret),
   * and optionally `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`, the
   * SDKs' variable names. Explicit options win.
   *
   * @throws {TypeError} when no API key is bound.
   */
  static fromEnv(
    env: JevEnv,
    options: Omit<JevClientOptions, "apiKey"> & { readonly apiKey?: string } =
      {},
  ): JevClient {
    const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY;
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new TypeError(
        "TYPESAFE_API_KEY is not bound; add it as a secret for this Worker",
      );
    }
    return new JevClient({
      ...options,
      apiKey,
      baseUrl: options.baseUrl ?? (env.TYPESAFE_BASE_URL || undefined),
      model: options.model ?? (env.TYPESAFE_DEFAULT_MODEL || undefined),
    });
  }

  /**
   * Asks the questions about the state and returns their answers, typed by
   * the questions.
   *
   * @throws {JevInvalidRequestError} before sending, with every problem.
   * @throws {JevApiError} a non-2xx response, once retries are spent.
   * @throws {JevConnectionError} no response, once retries are spent.
   * @throws {JevTimeoutError} an attempt or the budget ran out of time.
   * @throws {JevAbortError} the signal fired.
   * @throws {JevDecodeError} a 2xx response that does not answer the request.
   */
  async ask<const Qs extends Questions>(
    request: JevRequest<Qs>,
    options: AskOptions = {},
  ): Promise<JevResult<Qs>> {
    const started = this.#runtime.now();
    if (options.signal?.aborted) throw new JevAbortError();
    const issues: Issue[] = [];
    if (!isPlainObject(request)) {
      throw new JevInvalidRequestError([{
        code: "custom",
        path: [],
        message: "the request must be an object with state and questions",
      }]);
    }
    if (
      request.model !== undefined && options.model !== undefined &&
      request.model !== options.model
    ) {
      issues.push({
        code: "custom",
        path: ["model"],
        message: `request.model ${
          JSON.stringify(request.model)
        } disagrees with options.model ${JSON.stringify(options.model)}`,
      });
    }
    const model = request.model ?? options.model ?? this.model;
    issues.push(...requestIssues(request, model));
    if (issues.length > 0) throw new JevInvalidRequestError(issues);

    const body = { state: request.state, model, questions: request.questions };
    let cache: CacheStatus = "off";
    let key: string | null = null;
    if (this.#cache !== null) {
      if (!isPinnedModel(model)) cache = "bypass";
      else {
        cache = "miss";
        key = await cacheKey(body);
        const hit = await this.#cached(key, model, request.questions);
        if (hit !== null) {
          return {
            ...hit,
            answers: hit.answers as AnswersFor<Qs>,
            meta: {
              requestedModel: model,
              attempts: 0,
              latencyMs: this.#runtime.now() - started,
              requestId: null,
              cache: "hit",
            },
          };
        }
      }
    }

    const sent = await this.#send(
      "POST",
      "/v1/systemone",
      body,
      options,
      (json) => decodeResponse(json, request.questions, this.#decode),
      (decoded) => decoded.usage.input_tokens,
    );
    const decoded = sent.value;
    if (key !== null && decoded.model === model) {
      try {
        await this.#cache!.put(
          key,
          JSON.stringify({
            model: decoded.model,
            answers: decoded.answers,
            usage: decoded.usage,
          }),
        );
      } catch {
        // A cache write failure costs a future hit, never this answer.
      }
    }
    return {
      model: decoded.model,
      answers: decoded.answers as AnswersFor<Qs>,
      usage: decoded.usage,
      meta: {
        requestedModel: model,
        attempts: sent.attempts,
        latencyMs: this.#runtime.now() - started,
        requestId: sent.requestId,
        cache,
      },
    };
  }

  /**
   * {@link JevClient.ask}, with failures returned as plain data instead of
   * thrown, for results that cross Durable Object RPC or Workflow steps.
   * Errors that are not {@link JevError}s (bugs) still throw.
   */
  async tryAsk<const Qs extends Questions>(
    request: JevRequest<Qs>,
    options: AskOptions = {},
  ): Promise<JevOutcome<Qs>> {
    try {
      return { ok: true, result: await this.ask(request, options) };
    } catch (error) {
      if (error instanceof JevError) {
        return { ok: false, error: error.toJSON() };
      }
      throw error;
    }
  }

  async #cached(
    key: string,
    model: string,
    questions: Questions,
  ): Promise<{ model: string; answers: unknown; usage: Usage } | null> {
    try {
      const stored = await this.#cache!.get(key);
      if (stored === null) return null;
      const decoded = decodeResponse(
        JSON.parse(stored),
        questions,
        this.#decode,
      );
      return decoded.model === model ? decoded : null;
    } catch {
      return null;
    }
  }

  async #admit(
    deadline: number,
    budgetMs: number | null,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const limiter = this.#limiter;
    if (limiter === null) return false;
    for (;;) {
      let decision: LimiterDecision;
      try {
        decision = await limiter.acquire({
          reserveTokens: this.#reserveTokens,
        });
      } catch (error) {
        this.#onLimiterError(error);
        return false;
      }
      if (decision.granted === true) return true;
      const wait = Number.isFinite(decision.waitMs) && decision.waitMs > 0
        ? Math.ceil(decision.waitMs)
        : 1;
      if (this.#runtime.now() + wait >= deadline) {
        throw new JevTimeoutError(
          `the rate limiter could not admit the request within the ${budgetMs} ms budget`,
        );
      }
      await this.#sleep(wait, signal);
    }
  }

  async #settle(actualTokens: number): Promise<void> {
    try {
      await this.#limiter!.settle({
        reservedTokens: this.#reserveTokens,
        actualTokens,
      });
    } catch (error) {
      this.#onLimiterError(error);
    }
  }

  async #throttle(retryAfterMs: number): Promise<void> {
    try {
      await this.#limiter?.throttle?.({ retryAfterMs });
    } catch (error) {
      this.#onLimiterError(error);
    }
  }

  async #sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.#runtime.sleep(ms, signal);
    } catch (cause) {
      if (signal?.aborted) throw new JevAbortError(undefined, { cause });
      throw cause;
    }
  }

  #retryable(error: JevError, policy: RetryPolicy): boolean {
    if (error instanceof JevApiError) {
      return policy.statuses.includes(error.status);
    }
    if (error instanceof JevConnectionError) {
      return policy.retryConnectionErrors;
    }
    if (error instanceof JevTimeoutError) return policy.retryTimeouts;
    return false;
  }

  async #exchange(
    method: string,
    url: string,
    payload: string | undefined,
    headers: Headers,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Exchange> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = this.#runtime.setTimer(timeoutMs, () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    });
    const onAbort = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const failure = (cause: unknown, stage: string): JevError => {
      if (signal?.aborted) return new JevAbortError(undefined, { cause });
      if (timedOut) {
        return new JevTimeoutError(
          `no ${stage} from ${method} ${url} within ${timeoutMs} ms`,
          { cause },
        );
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      return new JevConnectionError(
        `${method} ${url} failed reading the ${stage}: ${reason}`,
        { cause },
      );
    };
    try {
      let response: Response;
      try {
        response = await rejectOnAbort(
          this.#fetch(url, {
            method,
            headers,
            body: payload,
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (cause) {
        throw failure(cause, "response");
      }
      let text: string;
      try {
        text = await rejectOnAbort(response.text(), controller.signal);
      } catch (cause) {
        throw failure(cause, "response body");
      }
      return { status: response.status, headers: response.headers, text };
    } finally {
      cancel();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #apiError(exchange: Exchange, requestId: string | null): JevApiError {
    const { status } = exchange;
    const kind = kindForStatus(status);
    const body = truncatedBody(exchange.text);
    const detail = errorDetail(body);
    return new JevApiError(
      kind,
      `TypeSafe returned ${status} (${kind})${
        detail === null ? "" : `: ${detail}`
      }`,
      {
        status,
        body,
        requestId,
        retryAfterMs: parseRetryAfter(exchange.headers, this.#runtime.now()),
        issues: kind === "validation" ? validationIssues(body) : [],
      },
    );
  }

  async #send<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: AskOptions,
    decode: (json: unknown) => T,
    tokensOf: (value: T) => number,
  ): Promise<{ value: T; attempts: number; requestId: string | null }> {
    const policy = options.retry === undefined
      ? this.retry
      : resolveRetryPolicy(options.retry, this.retry);
    const timeoutMs = checkTimeout(
      "timeoutMs",
      options.timeoutMs ?? this.timeoutMs,
    );
    const { signal } = options;
    const url = this.baseUrl + path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = new Headers(this.#headers);
    for (const [name, value] of new Headers(options.headers)) {
      headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${this.#apiKey}`);
    headers.set("accept", "application/json");
    if (payload !== undefined) headers.set("content-type", "application/json");
    const deadline = policy.budgetMs === null
      ? Number.POSITIVE_INFINITY
      : this.#runtime.now() + policy.budgetMs;

    let attempts = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new JevAbortError(undefined, { attempts, cause: signal.reason });
      }
      let error: JevError;
      try {
        const admitted = await this.#admit(deadline, policy.budgetMs, signal);
        const remaining = deadline - this.#runtime.now();
        if (remaining <= 0) {
          throw new JevTimeoutError(
            `the ${policy.budgetMs} ms retry budget ran out`,
          );
        }
        attempts++;
        let tokens = 0;
        try {
          const exchange = await this.#exchange(
            method,
            url,
            payload,
            headers,
            Math.min(timeoutMs, remaining),
            signal,
          );
          const requestId = exchange.headers.get("x-typesafe-request-id");
          if (exchange.status >= 200 && exchange.status <= 299) {
            let json: unknown;
            try {
              json = JSON.parse(exchange.text);
            } catch {
              throw new JevDecodeError(
                [{
                  code: "custom",
                  path: [],
                  message: "the response body is not JSON",
                }],
                {
                  status: exchange.status,
                  requestId,
                  body: truncatedBody(exchange.text),
                },
              );
            }
            let value: T;
            try {
              value = decode(json);
            } catch (cause) {
              if (cause instanceof JevDecodeError) {
                throw new JevDecodeError(cause.issues, {
                  status: exchange.status,
                  requestId,
                  body: truncatedBody(exchange.text),
                });
              }
              throw cause;
            }
            tokens = tokensOf(value);
            return { value, attempts, requestId };
          }
          const apiError = this.#apiError(exchange, requestId);
          if (
            (apiError.kind === "rate_limited" ||
              apiError.kind === "overloaded") &&
            apiError.retryAfterMs !== null && apiError.retryAfterMs > 0
          ) {
            await this.#throttle(
              Math.min(apiError.retryAfterMs, policy.maxRetryAfterMs),
            );
          }
          throw apiError;
        } finally {
          if (admitted) await this.#settle(tokens);
        }
      } catch (caught) {
        if (!(caught instanceof JevError)) throw caught;
        error = caught;
      }
      error.attempts = attempts;
      if (!this.#retryable(error, policy) || attempts > policy.maxRetries) {
        throw error;
      }
      const delayMs = policy.respectRetryAfter && error.retryAfterMs !== null
        ? Math.min(error.retryAfterMs, policy.maxRetryAfterMs)
        : backoffDelay(policy, attempts - 1, this.#runtime.random());
      if (this.#runtime.now() + delayMs >= deadline) throw error;
      this.#onRetry({ attempt: attempts, delayMs, error: error.toJSON() });
      try {
        await this.#sleep(delayMs, signal);
      } catch (aborted) {
        if (aborted instanceof JevError) aborted.attempts = attempts;
        throw aborted;
      }
    }
  }
}
