// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The client for GPT models behind an exe.dev LLM integration that uses a
 * ChatGPT subscription (`--openai=chatgpt`).
 *
 * ```ts
 * const gpt = GptClient.fromEnv(env); // https://llm.int.exe.xyz/openai/v1
 * const answer = await gpt.ask("Summarise this stack trace: ...");
 *
 * const turn = await gpt.respond({ input: "...", reasoning: { effort: "high" } });
 * turn.finalText; turn.usage; turn.toolCalls;
 *
 * for await (const event of gpt.stream({ input: "..." })) {
 *   if (event.type === "text.delta") write(event.delta);
 * }
 * ```
 *
 * The VM holds no key: the integration injects the ChatGPT credentials at
 * the network edge, so the client sends no `authorization` header.
 *
 * @module
 */

import {
  backoffDelay,
  defaultRuntime,
  type FetchLike,
  globalFetch,
  parseRetryAfter,
  rejectOnAbort,
  resolveRetryPolicy,
  type Runtime,
} from "@celld/http";
import {
  BoundsError,
  MAX_TIMER_MS,
  nonNegativeMs,
  readTextBounded,
  safeInt,
} from "@celld/core/bounds";
import { classifyHost } from "@celld/http/egress";
import { SseParser, Utf8Chunks } from "@celld/http/sse";
import type { AnySchema, Output } from "@celld/sieve";
import { toJSONSchema } from "@celld/sieve/json-schema";
import {
  accumulateResponseObject,
  OUTPUT_EVENTS,
  ResponseAccumulator,
  type StreamEvent,
} from "./events.ts";
import {
  apiErrorFromResponse,
  GptAbortError,
  GptApiError,
  GptConnectionError,
  GptDecodeError,
  GptError,
  type GptErrorData,
  GptInvalidRequestError,
  GptOutputError,
  GptStreamError,
  GptTimeoutError,
  requestIdOf,
} from "./errors.ts";
import {
  formatIssues,
  type Issue,
  type JsonObject,
  tryParseJson,
} from "./json.ts";
import { decodeModels, DEFAULT_MODEL, pickModel } from "./models.ts";
import type { Pacer, PacerDecision, PacerReport } from "./pacer.ts";
import { parseRateLimitHeaders, type RateLimitSnapshot } from "./ratelimits.ts";
import {
  buildRequest,
  type BuiltRequest,
  DEFAULT_INSTRUCTIONS,
  type Encoding,
  type GptRequest,
  requestIssues,
} from "./request.ts";
import {
  DEFAULT_RETRY_POLICY,
  type GptRetryOptions,
  type GptRetryPolicy,
  mayRetryGpt,
  requestIdempotency,
} from "./retry.ts";
import type { ModelCard, Turn } from "./types.ts";

export type { FetchLike, Runtime } from "@celld/http";

/** This library's version, sent in the default `user-agent`. */
export const VERSION = "0.1.0";
/** The default integration name, which exe.dev gives new accounts. */
export const DEFAULT_INTEGRATION = "llm";
/** Personal integrations live under this domain. */
export const INTEGRATION_DOMAIN = "int.exe.xyz";
/** Team integrations live under this domain. */
export const TEAM_INTEGRATION_DOMAIN = "team.exe.xyz";
/** How long to wait for response headers; default one minute. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
/** How long to wait between stream events; Codex's default, five minutes. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** The longest pacer hold the client waits out before failing; one minute. */
export const DEFAULT_MAX_PACER_WAIT_MS = 60_000;
/** The lease asked of the pacer per attempt; 30 minutes. */
export const DEFAULT_LEASE_MS = 30 * 60_000;
/**
 * The most bytes one response may carry, streamed or not; 32 MiB. A turn
 * is usually well under a megabyte, reasoning included.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** The largest `maxResponseBytes`: 1 GiB. */
export const MAX_RESPONSE_BYTES = 1024 * 1024 * 1024;
/**
 * An error body is read up to this many bytes, and the rest is cancelled
 * unread; what an error keeps is cut further, to `MAX_ERROR_TEXT`.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** The model list is read up to this many bytes (or `maxResponseBytes`). */
export const MAX_MODELS_BODY_BYTES = 4 * 1024 * 1024;
/** The longest one attempt's response may take, start to end; 30 minutes. */
export const DEFAULT_MAX_STREAM_MS = 30 * 60_000;

/** How requests reach OpenAI through the integration. */
export type Route =
  /** `/openai/v1`: always the OpenAI provider (the default). */
  | "openai"
  /** `/v1`: the integration routes by model id. */
  | "auto";

/** Where an integration's API root is. */
export interface IntegrationUrlOptions {
  /** A team integration (`.team.exe.xyz`) rather than a personal one. */
  readonly team?: boolean;
  /** Default `"openai"`. */
  readonly route?: Route;
  /** Replaces `int.exe.xyz`, for tests and proxies. */
  readonly domain?: string;
  /** Replaces `team.exe.xyz`. */
  readonly teamDomain?: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The API root of an LLM integration: `https://<name>.int.exe.xyz/openai/v1`
 * (or `.team.exe.xyz` for a team integration, `/v1` for model routing).
 *
 * Always `https:`; a fake integration for development is a `baseUrl` with
 * `allowLoopbackForDevelopment`.
 *
 * @throws {TypeError} a name that is not a hostname label, or the removed
 * `scheme` option set to anything but `https`.
 */
export function integrationBaseUrl(
  name: string = DEFAULT_INTEGRATION,
  options: IntegrationUrlOptions = {},
): string {
  const scheme: unknown = (options as { scheme?: unknown }).scheme;
  if (scheme !== undefined && scheme !== "https") {
    throw new TypeError(
      "integrationBaseUrl: `scheme` was removed and integrations are https; point `baseUrl` at a loopback fake with allowLoopbackForDevelopment instead",
    );
  }
  if (!LABEL.test(name)) {
    throw new TypeError(
      `integration name ${JSON.stringify(name)} is not a hostname label`,
    );
  }
  const domain = options.team
    ? options.teamDomain ?? TEAM_INTEGRATION_DOMAIN
    : options.domain ?? INTEGRATION_DOMAIN;
  const path = (options.route ?? "openai") === "openai" ? "/openai/v1" : "/v1";
  return `https://${name}.${domain}${path}`;
}

/** What a retry is about to do, for logging and metrics. */
export interface RetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: GptErrorData;
}

/** How to construct a {@link GptClient}. */
export interface GptClientOptions {
  /**
   * The API root, such as `https://llm.int.exe.xyz/openai/v1`. Default:
   * built from `integration`, `team` and `route`. It must be `https:`
   * without credentials; `http:` only to a loopback host, with
   * `allowLoopbackForDevelopment`.
   */
  readonly baseUrl?: string;
  /**
   * Allows `http:` for a `baseUrl` on a loopback host (`127.0.0.1`, `::1`,
   * `localhost`), for a fake integration in development and tests. Never
   * set it in production.
   */
  readonly allowLoopbackForDevelopment?: boolean;
  /** The integration's name; default `llm`. */
  readonly integration?: string;
  /** Whether it is a team integration. */
  readonly team?: boolean;
  /** Default `"openai"`: force the OpenAI provider. */
  readonly route?: Route;
  /** The default model; default {@link DEFAULT_MODEL}. */
  readonly model?: string;
  /** Default instructions; default {@link DEFAULT_INSTRUCTIONS}. */
  readonly instructions?: string;
  /** Force a request encoding; default from the model catalog. */
  readonly encoding?: Encoding;
  readonly fetch?: FetchLike;
  readonly runtime?: Runtime;
  readonly retry?: GptRetryOptions;
  /** How long to wait for response headers. */
  readonly connectTimeoutMs?: number;
  /** How long to wait for each stream event. */
  readonly idleTimeoutMs?: number;
  /**
   * The longest one attempt may take, from sending the request to the
   * last event, however steadily the server keeps sending; default
   * {@link DEFAULT_MAX_STREAM_MS}, at most `MAX_TIMER_MS`. Past it the
   * attempt is a `timeout`.
   */
  readonly maxStreamMs?: number;
  /**
   * The most bytes a response may carry (the event stream, or a JSON
   * answer); default {@link DEFAULT_MAX_RESPONSE_BYTES}, from 1024 to
   * {@link MAX_RESPONSE_BYTES}. Past it the body is cancelled and the
   * call fails with a `decode` error, which is not retried.
   */
  readonly maxResponseBytes?: number;
  /** The `user-agent`; default `celld-openai/<version>`. */
  readonly userAgent?: string;
  /**
   * Extra headers on every request. `content-type`, `accept` and
   * `session-id` are the client's.
   */
  readonly headers?: Record<string, string>;
  /** Admission control shared with other callers; default none. */
  readonly pacer?: Pacer;
  /** The lease asked of the pacer per attempt; at most `MAX_TIMER_MS`. */
  readonly leaseMs?: number;
  /**
   * The longest pacer hold waited out; beyond it the call fails at once
   * (with `usage_limit` when the hold is a usage limit). From 0 to
   * `MAX_TIMER_MS`.
   */
  readonly maxPacerWaitMs?: number;
  /**
   * Called when the pacer throws, or answers a wait that is not a
   * non-negative number (a `RangeError`); the call then goes ahead unpaced.
   */
  readonly onPacerError?: (error: unknown) => void;
  /** Called before each retry's wait. */
  readonly onRetry?: (event: RetryEvent) => void;
  /** Called with the rate-limit windows each response reports. */
  readonly onRateLimits?: (rateLimits: readonly RateLimitSnapshot[]) => void;
}

/** Per-call settings. */
export interface CallOptions {
  /**
   * Cancels the call, including pacer and retry waits; a call cancelled
   * before it is sent is never sent.
   */
  readonly signal?: AbortSignal;
  readonly retry?: GptRetryOptions;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Overrides the client's `maxStreamMs` for this call. */
  readonly maxStreamMs?: number;
  readonly headers?: Record<string, string>;
  /** Every stream event, for progress; a `retry` event voids earlier ones. */
  readonly onEvent?: (event: StreamEvent) => void;
}

/** An outcome as plain data. */
export type GptOutcome<T = Turn> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: GptErrorData };

/** A decoded structured answer and the turn it came from. */
export interface Structured<T> {
  readonly value: T;
  readonly turn: Turn;
}

/** The `env` bindings {@link GptClient.fromEnv} reads. */
export interface GptEnv {
  /** The API root, overriding the integration (OpenAI SDK's name). */
  readonly OPENAI_BASE_URL?: string;
  /** The integration's name; default `llm`. */
  readonly EXE_LLM_INTEGRATION?: string;
  /** `1`/`true` for a team integration. */
  readonly EXE_LLM_TEAM?: string;
  /** The default model. */
  readonly OPENAI_MODEL?: string;
  /**
   * `true` allows an `http:` `OPENAI_BASE_URL` on a loopback host (see
   * `allowLoopbackForDevelopment`); for development only.
   */
  readonly OPENAI_LOOPBACK_FOR_DEVELOPMENT?: string;
}

function checkTimeout(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${value}`);
  }
  if (value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be at most ${MAX_TIMER_MS} ms (a timer's limit), got ${value}`,
    );
  }
  return value;
}

/**
 * Throws a `TypeError` for an API root that may not be used: not
 * `https:` (unless `http:` to a loopback host under the development
 * flag), or carrying credentials.
 */
function checkBaseUrl(url: URL, loopback: boolean): void {
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("baseUrl must not carry credentials");
  }
  if (
    url.protocol === "http:" &&
    !(loopback && classifyHost(url.hostname) === "loopback")
  ) {
    throw new TypeError(
      `baseUrl must be https (http only to a loopback host, with allowLoopbackForDevelopment), got ${url.origin}`,
    );
  }
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes)$/i.test(value.trim());
}

type Mode = "stream" | "respond";

interface AttemptResult {
  readonly turn: Turn;
}

/**
 * A streaming response: iterate it for events, or await {@link result}.
 * It can be iterated once; `result` works whether or not it was.
 */
export class ResponseStream implements AsyncIterable<StreamEvent> {
  readonly #source: AsyncGenerator<StreamEvent, Turn>;
  #started = false;
  #result: Promise<Turn> | null = null;
  #resolve!: (turn: Turn) => void;
  #reject!: (error: unknown) => void;

  constructor(source: AsyncGenerator<StreamEvent, Turn>) {
    this.#source = source;
    this.#result = new Promise<Turn>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A result nobody awaits must not become an unhandled rejection.
    this.#result.catch(() => {});
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent, void> {
    if (this.#started) {
      throw new TypeError("a ResponseStream can be iterated once");
    }
    this.#started = true;
    try {
      for (;;) {
        const next = await this.#source.next();
        if (next.done) {
          this.#resolve(next.value);
          return;
        }
        yield next.value;
      }
    } catch (error) {
      this.#reject(error);
      throw error;
    } finally {
      // Breaking out early cancels the request.
      await this.#source.return(undefined as never).catch(() => {});
      this.#reject(new GptAbortError("the stream was not consumed to the end"));
    }
  }

  /** The finished turn; drains the stream if nobody is iterating it. */
  get result(): Promise<Turn> {
    if (!this.#started) {
      (async () => {
        for await (const _ of this) { /* drain */ }
      })().catch(() => {});
    }
    return this.#result!;
  }

  /** The final text, once the stream completes. */
  async text(): Promise<string> {
    return (await this.result).finalText;
  }
}

/**
 * A client for `POST /responses` and `GET /models` on an exe.dev LLM
 * integration backed by a ChatGPT subscription.
 *
 * Every call validates its request, asks the pacer (if any), streams the
 * response, and retries transient failures under the {@link GptRetryPolicy}.
 * Failures are thrown as {@link GptError}s; the `try*` methods return them
 * as plain data.
 */
export class GptClient {
  /** The API root, without a trailing slash. */
  readonly baseUrl: string;
  /** The default model. */
  readonly model: string;
  /** The default instructions. */
  readonly instructions: string;
  readonly retry: GptRetryPolicy;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxStreamMs: number;
  readonly maxResponseBytes: number;
  /** `GET /models`. */
  readonly models: {
    /** The models the integration serves. */
    list(options?: CallOptions): Promise<ModelCard[]>;
    /**
     * The first preference served (exact id, else `pref-*`), or null.
     * `pick(["gpt-6", "gpt-5.5"])` finds `gpt-6-astra` if listed.
     */
    pick(
      preferences: readonly string[],
      options?: CallOptions,
    ): Promise<string | null>;
  };

  readonly #fetch: FetchLike;
  readonly #runtime: Runtime;
  readonly #headers: Headers;
  readonly #encoding: Encoding | undefined;
  readonly #pacer: Pacer | null;
  readonly #leaseMs: number;
  readonly #maxPacerWaitMs: number;
  readonly #onPacerError: (error: unknown) => void;
  readonly #onRetry: (event: RetryEvent) => void;
  readonly #onRateLimits: (rateLimits: readonly RateLimitSnapshot[]) => void;

  /**
   * @throws {TypeError} a base URL that is not https (or loopback http for
   * development, see `allowLoopbackForDevelopment`), or a bad integration
   * name.
   * @throws {RangeError} a timeout or retry setting out of range.
   */
  constructor(options: GptClientOptions = {}) {
    const baseUrl = (options.baseUrl ??
      integrationBaseUrl(options.integration ?? DEFAULT_INTEGRATION, {
        team: options.team,
        route: options.route,
      })).replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new TypeError(`baseUrl is not a URL: ${baseUrl}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError(`baseUrl must be http(s), got ${baseUrl}`);
    }
    checkBaseUrl(url, options.allowLoopbackForDevelopment === true);
    if (options.model !== undefined && options.model.trim() === "") {
      throw new TypeError("model must not be blank");
    }
    if (
      options.instructions !== undefined && options.instructions.trim() === ""
    ) {
      throw new TypeError("instructions must not be blank");
    }
    this.baseUrl = baseUrl;
    this.model = options.model ?? DEFAULT_MODEL;
    this.instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
    this.retry = resolveRetryPolicy(options.retry, DEFAULT_RETRY_POLICY);
    this.connectTimeoutMs = checkTimeout(
      "connectTimeoutMs",
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.idleTimeoutMs = checkTimeout(
      "idleTimeoutMs",
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    );
    this.maxStreamMs = checkTimeout(
      "maxStreamMs",
      options.maxStreamMs ?? DEFAULT_MAX_STREAM_MS,
    );
    this.maxResponseBytes = safeInt(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      { name: "maxResponseBytes", min: 1024, max: MAX_RESPONSE_BYTES },
    );
    this.#fetch = options.fetch ?? globalFetch;
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#headers = new Headers(options.headers);
    this.#headers.set(
      "user-agent",
      options.userAgent ?? `celld-openai/${VERSION}`,
    );
    this.#encoding = options.encoding;
    this.#pacer = options.pacer ?? null;
    this.#leaseMs = checkTimeout(
      "leaseMs",
      options.leaseMs ?? DEFAULT_LEASE_MS,
    );
    this.#maxPacerWaitMs = nonNegativeMs(
      options.maxPacerWaitMs ?? DEFAULT_MAX_PACER_WAIT_MS,
      { name: "maxPacerWaitMs" },
    );
    this.#onPacerError = options.onPacerError ?? (() => {});
    this.#onRetry = options.onRetry ?? (() => {});
    this.#onRateLimits = options.onRateLimits ?? (() => {});
    this.models = {
      list: (callOptions = {}) => this.#listModels(callOptions),
      pick: async (preferences, callOptions = {}) =>
        pickModel(await this.#listModels(callOptions), preferences),
    };
  }

  /**
   * A client from Worker bindings: `OPENAI_BASE_URL`, else the integration
   * named by `EXE_LLM_INTEGRATION` (default `llm`, team if `EXE_LLM_TEAM`),
   * and `OPENAI_MODEL`; `OPENAI_LOOPBACK_FOR_DEVELOPMENT` (`"true"`) is
   * `allowLoopbackForDevelopment`. Explicit options win.
   */
  static fromEnv(env: GptEnv = {}, options: GptClientOptions = {}): GptClient {
    return new GptClient({
      ...options,
      baseUrl: options.baseUrl ?? (env.OPENAI_BASE_URL || undefined),
      integration: options.integration ??
        (env.EXE_LLM_INTEGRATION || undefined),
      team: options.team ?? truthy(env.EXE_LLM_TEAM),
      model: options.model ?? (env.OPENAI_MODEL || undefined),
      allowLoopbackForDevelopment: options.allowLoopbackForDevelopment ??
        env.OPENAI_LOOPBACK_FOR_DEVELOPMENT === "true",
    });
  }

  /**
   * Streams a response. Transient failures are retried only while nothing
   * has been output yet (a `retry` event says so); after output has
   * started, the error is thrown, since the caller has already seen part
   * of an answer.
   */
  stream(request: GptRequest, options: CallOptions = {}): ResponseStream {
    return new ResponseStream(this.#run(request, options, "stream"));
  }

  /**
   * The finished turn. Transient failures are retried whenever they happen,
   * restarting the response, since nothing was handed out yet.
   *
   * @throws {GptError} every failure; narrow on `kind`.
   */
  async respond(request: GptRequest, options: CallOptions = {}): Promise<Turn> {
    const run = this.#run(request, options, "respond");
    for (;;) {
      const next = await run.next();
      if (next.done) return next.value;
      options.onEvent?.(next.value);
    }
  }

  /** {@link respond}, with failures as plain data. Bugs still throw. */
  async tryRespond(
    request: GptRequest,
    options: CallOptions = {},
  ): Promise<GptOutcome> {
    try {
      return { ok: true, result: await this.respond(request, options) };
    } catch (error) {
      if (error instanceof GptError) {
        return { ok: false, error: error.toJSON() };
      }
      throw error;
    }
  }

  /** The final text for one prompt. */
  async ask(
    prompt: string,
    request: Omit<GptRequest, "input"> = {},
    options: CallOptions = {},
  ): Promise<string> {
    return (await this.respond({ ...request, input: prompt }, options))
      .finalText;
  }

  /**
   * A structured answer: the request is sent with the schema as a strict
   * `json_schema` format (sieve's `openai-strict` target), and the answer
   * is parsed with it, so `value` is the schema's output.
   *
   * @throws {GptInvalidRequestError} a schema strict mode would refuse (an
   * `.optional()` key, say), before anything is sent.
   * @throws {GptOutputError} `refusal` if the model refused, `output` if the
   * text is not JSON or does not match the schema (with every path).
   */
  async structured<S extends AnySchema>(
    request: Omit<GptRequest, "format"> & {
      readonly schema: S;
      /** The format name; default `output`. */
      readonly name?: string;
    },
    options: CallOptions = {},
  ): Promise<Structured<Output<S>>> {
    const { schema, name, ...rest } = request;
    const turn = await this.respond({
      ...rest,
      format: {
        name: name ?? "output",
        schema: strictSchema(schema),
        strict: true,
      },
    }, options);
    return { value: decodeStructured(schema, turn), turn };
  }

  /** {@link structured}, with failures as plain data. */
  async tryStructured<S extends AnySchema>(
    request: Omit<GptRequest, "format"> & {
      readonly schema: S;
      readonly name?: string;
    },
    options: CallOptions = {},
  ): Promise<GptOutcome<Structured<Output<S>>>> {
    try {
      return { ok: true, result: await this.structured(request, options) };
    } catch (error) {
      if (error instanceof GptError) {
        return { ok: false, error: error.toJSON() };
      }
      throw error;
    }
  }

  async #sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.#runtime.sleep(ms, signal);
    } catch (cause) {
      if (signal?.aborted) throw new GptAbortError(undefined, { cause });
      throw cause;
    }
  }

  async #admit(
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const pacer = this.#pacer;
    if (pacer === null) return null;
    const started = this.#runtime.now();
    for (;;) {
      let decision: PacerDecision;
      const pending = new Promise<PacerDecision>((resolve) =>
        resolve(pacer.acquire({ leaseMs: this.#leaseMs }))
      );
      try {
        decision = signal === undefined
          ? await pending
          : await rejectOnAbort(pending, signal);
      } catch (error) {
        if (signal?.aborted) {
          // The pacer may still grant the cancelled call a lease: release it
          // when it does.
          pending.then(
            (late) =>
              late.granted ? this.#releaseUnsent(late.lease) : undefined,
            () => {},
          );
          throw new GptAbortError(undefined, { cause: error });
        }
        this.#onPacerError(error);
        return null;
      }
      if (decision.granted) return decision.lease;
      const waitMs: unknown = decision.waitMs;
      if (
        typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0
      ) {
        // A remote answer that is not a wait: a hot poll or an endless
        // sleep otherwise. Treated like a pacer that cannot be reached.
        this.#onPacerError(
          new RangeError(`the pacer answered a wait of ${String(waitMs)}`),
        );
        return null;
      }
      const now = this.#runtime.now();
      const wait = Math.min(Math.max(1, Math.ceil(waitMs)), MAX_TIMER_MS);
      const block = decision.block;
      if (now + wait - started > this.#maxPacerWaitMs) {
        if (
          block !== null &&
          (block.reason === "usage_limit" || block.reason === "exhausted")
        ) {
          throw new GptApiError(
            "usage_limit",
            `the shared subscription is at its usage limit until ${
              Temporal.Instant.fromEpochMilliseconds(block.until).toString()
            }; the request was not sent`,
            { code: block.code, resetsAt: block.until },
          );
        }
        throw new GptTimeoutError(
          `the pacer held the request (${decision.reason}${
            block === null ? "" : `: ${block.reason}`
          }) longer than ${this.#maxPacerWaitMs} ms; it was not sent`,
          { retryAfterMs: wait },
        );
      }
      if (now + wait >= deadline) {
        throw new GptTimeoutError(
          "the retry budget ran out while the pacer held the request",
        );
      }
      await this.#sleep(wait, signal);
    }
  }

  async #release(report: PacerReport): Promise<void> {
    try {
      await this.#pacer?.release(report);
    } catch (error) {
      this.#onPacerError(error);
    }
  }

  /** Releases a lease whose call was cancelled before it was sent. */
  #releaseUnsent(lease: string): Promise<void> {
    return this.#release({
      lease,
      error: {
        kind: "aborted",
        code: null,
        retryAfterMs: null,
        resetsAt: null,
      },
    });
  }

  async *#run(
    request: GptRequest,
    options: CallOptions,
    mode: Mode,
  ): AsyncGenerator<StreamEvent, Turn> {
    const started = this.#runtime.now();
    const { signal } = options;
    if (signal?.aborted) throw new GptAbortError();
    const issues = requestIssues(request);
    if (issues.length > 0) throw new GptInvalidRequestError(issues);
    const built = await buildRequest(request, {
      model: this.model,
      instructions: this.instructions,
      encoding: this.#encoding,
    });
    const policy = options.retry === undefined
      ? this.retry
      : resolveRetryPolicy(options.retry, this.retry);
    const deadline = policy.budgetMs === null
      ? Number.POSITIVE_INFINITY
      : started + policy.budgetMs;
    const payload = JSON.stringify(built.body);
    // Declared from the body actually sent: only `store: false` may repeat.
    const idempotent = requestIdempotency("responses", built.body);
    let attempts = 0;
    for (;;) {
      if (signal?.aborted) throw new GptAbortError(undefined, { attempts });
      let lease: string | null;
      try {
        lease = await this.#admit(deadline, signal);
      } catch (error) {
        if (error instanceof GptError) error.attempts = attempts;
        throw error;
      }
      // The pacer may answer after the caller gave up: a call cancelled
      // while it waited is not sent, and its lease is released.
      if (signal?.aborted) {
        if (lease !== null) await this.#releaseUnsent(lease);
        throw new GptAbortError(undefined, { attempts, cause: signal.reason });
      }
      if (this.#runtime.now() >= deadline) {
        throw new GptTimeoutError(
          `the ${policy.budgetMs} ms retry budget ran out`,
          { attempts },
        );
      }
      attempts++;
      const report: {
        lease: string;
        rateLimits: RateLimitSnapshot[];
        usage: Turn["usage"] | null;
        error: PacerReport["error"];
      } = { lease: lease ?? "", rateLimits: [], usage: null, error: null };
      let producedOutput = false;
      let failure: GptError;
      const attempt = this.#attempt(built, payload, options, report, {
        deadline,
        budgetMs: policy.budgetMs,
      });
      try {
        for (;;) {
          const next = await attempt.next();
          if (next.done) {
            const turn: Turn = {
              ...next.value.turn,
              meta: {
                ...next.value.turn.meta,
                attempts,
                latencyMs: this.#runtime.now() - started,
              },
            };
            report.usage = turn.usage;
            yield { type: "completed", turn };
            return turn;
          }
          if (OUTPUT_EVENTS.has(next.value.type)) producedOutput = true;
          yield next.value;
        }
      } catch (caught) {
        if (!(caught instanceof GptError)) throw caught;
        failure = caught;
        report.error = {
          kind: failure.kind,
          code: failure.code,
          retryAfterMs: failure.retryAfterMs,
          resetsAt: failure.resetsAt,
        };
        if (failure.rateLimits.length > 0) {
          report.rateLimits = [...failure.rateLimits];
        }
      } finally {
        // Runs the attempt's own cleanup (timers, body, fetch) when the
        // consumer stops early; a finished attempt ignores it.
        await attempt.return(undefined as never).catch(() => {});
        if (lease !== null) await this.#release(report);
      }
      failure.attempts = attempts;
      const retryable = mayRetryGpt(policy, failure, { idempotent }) &&
        attempts <= policy.maxRetries &&
        (mode === "respond" || !producedOutput);
      if (!retryable) throw failure;
      const delayMs = policy.respectRetryAfter && failure.retryAfterMs !== null
        ? Math.min(failure.retryAfterMs, policy.maxRetryAfterMs)
        : backoffDelay(policy, attempts - 1, this.#runtime.random());
      if (this.#runtime.now() + delayMs >= deadline) throw failure;
      const event = { attempt: attempts, delayMs, error: failure.toJSON() };
      this.#onRetry(event);
      yield { type: "retry", ...event };
      try {
        await this.#sleep(delayMs, signal);
      } catch (aborted) {
        if (aborted instanceof GptError) aborted.attempts = attempts;
        throw aborted;
      }
    }
  }

  async *#attempt(
    built: BuiltRequest,
    payload: string,
    options: CallOptions,
    report: { rateLimits: RateLimitSnapshot[] },
    budget: { deadline: number; budgetMs: number | null },
  ): AsyncGenerator<StreamEvent, AttemptResult> {
    const url = `${this.baseUrl}/responses`;
    const connectTimeoutMs = checkTimeout(
      "connectTimeoutMs",
      options.connectTimeoutMs ?? this.connectTimeoutMs,
    );
    const idleTimeoutMs = checkTimeout(
      "idleTimeoutMs",
      options.idleTimeoutMs ?? this.idleTimeoutMs,
    );
    const maxStreamMs = checkTimeout(
      "maxStreamMs",
      options.maxStreamMs ?? this.maxStreamMs,
    );
    const maxBytes = this.maxResponseBytes;
    const headers = new Headers(this.#headers);
    for (const [name, value] of new Headers(options.headers)) {
      headers.set(name, value);
    }
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    // ChatGPT derives prompt-cache affinity from this header (Codex's
    // `responses_session_id`); it carries the prompt cache key.
    headers.set("session-id", built.promptCacheKey);

    const { signal } = options;
    // A cancelled call is never sent, whatever the caller awaited before.
    if (signal?.aborted) {
      throw new GptAbortError(undefined, { cause: signal.reason });
    }
    const controller = new AbortController();
    let timedOut: "connect" | "idle" | "total" | "budget" | null = null;
    let cancelTimer = this.#runtime.setTimer(connectTimeoutMs, () => {
      timedOut = "connect";
      controller.abort(new Error("timeout"));
    });
    // However often the server sends, the attempt ends by `maxStreamMs`, or
    // sooner when that is all the retry budget has left.
    const left = budget.deadline - this.#runtime.now();
    const cancelTotal = this.#runtime.setTimer(
      Math.max(0, Math.min(maxStreamMs, left)),
      () => {
        timedOut = left < maxStreamMs ? "budget" : "total";
        controller.abort(new Error("timeout"));
      },
    );
    const arm = () => {
      cancelTimer();
      cancelTimer = this.#runtime.setTimer(idleTimeoutMs, () => {
        timedOut = "idle";
        controller.abort(new Error("timeout"));
      });
    };
    const onAbort = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let requestId: string | null = null;
    const fail = (cause: unknown, stage: "headers" | "body"): GptError => {
      if (cause instanceof GptError) return cause;
      if (signal?.aborted) return new GptAbortError(undefined, { cause });
      if (timedOut === "connect") {
        return new GptTimeoutError(
          `no response from POST ${url} within ${connectTimeoutMs} ms`,
          { cause, requestId },
        );
      }
      if (timedOut === "idle") {
        return new GptTimeoutError(
          `no stream event within ${idleTimeoutMs} ms`,
          { cause, requestId },
        );
      }
      if (timedOut === "total") {
        return new GptTimeoutError(
          `the response took longer than maxStreamMs (${maxStreamMs} ms)`,
          { cause, requestId },
        );
      }
      if (timedOut === "budget") {
        return new GptTimeoutError(
          `the ${budget.budgetMs} ms retry budget ran out during the response`,
          { cause, requestId },
        );
      }
      if (cause instanceof BoundsError && cause.code === "too_large") {
        return tooLarge(maxBytes, requestId);
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      return stage === "headers"
        ? new GptConnectionError(`POST ${url} failed: ${reason}`, { cause })
        : new GptStreamError(`the stream broke off: ${reason}`, {
          cause,
          requestId,
        });
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let finished = false;
    try {
      let response: Response;
      try {
        response = await rejectOnAbort(
          this.#fetch(url, {
            method: "POST",
            headers,
            body: payload,
            // Never followed: a redirect would carry the request (prompt
            // and all) to wherever it points.
            redirect: "manual",
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (cause) {
        throw fail(cause, "headers");
      }
      arm();
      requestId = requestIdOf(response.headers);
      refuseRedirect(response, "POST", url, requestId);
      const rateLimits = parseRateLimitHeaders(response.headers);
      report.rateLimits = rateLimits;
      if (rateLimits.length > 0) {
        this.#onRateLimits(rateLimits);
        yield { type: "rate_limits", rateLimits };
      }
      const servedModel = response.headers.get("openai-model");
      if (servedModel !== null) yield { type: "model", model: servedModel };

      if (response.status < 200 || response.status > 299) {
        let text = "";
        try {
          text = await errorText(response, controller.signal);
        } catch (cause) {
          if (signal?.aborted || timedOut !== null) throw fail(cause, "body");
        }
        throw apiErrorFromResponse(
          response.status,
          text,
          response.headers,
          parseRetryAfter(response.headers, this.#runtime.now()),
        );
      }

      const meta = {
        attempts: 0,
        latencyMs: 0,
        requestId,
        promptCacheKey: built.promptCacheKey,
        encoding: built.encoding,
        rateLimits,
      };
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        // A proxy that answered without streaming.
        let text: string;
        try {
          text = await readTextBounded(response, {
            maxBytes,
            signal: controller.signal,
          });
        } catch (cause) {
          throw fail(cause, "body");
        }
        const json = tryParseJson(text);
        if (json === undefined) {
          throw new GptDecodeError([{
            path: [],
            message: "the response body is not JSON",
          }], {
            status: response.status,
            requestId,
          });
        }
        const accumulator = accumulateResponseObject(json, requestId);
        if (servedModel !== null) accumulator.setServedModel(servedModel);
        if (accumulator.state !== "completed") throw accumulator.error!;
        finished = true;
        return { turn: accumulator.turn(built.model, meta) };
      }
      if (response.body === null) {
        throw new GptStreamError("the response has no body", { requestId });
      }

      const accumulator = new ResponseAccumulator(requestId);
      if (servedModel !== null) accumulator.setServedModel(servedModel);
      const parser = new SseParser();
      const utf8 = new Utf8Chunks();
      reader = response.body.getReader();
      let truncated = false;
      let received = 0;
      read: for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await rejectOnAbort(reader.read(), controller.signal);
        } catch (cause) {
          throw fail(cause, "body");
        }
        arm();
        if (!chunk.done) {
          // The parser's buffer and the accumulator grow with the stream:
          // the whole of it is capped.
          received += chunk.value.byteLength;
          if (received > maxBytes) throw tooLarge(maxBytes, requestId);
        }
        const events = chunk.done
          ? [
            ...parser.push(utf8.finish()),
            ...(() => {
              const end = parser.finish();
              truncated = end.truncated;
              return end.events;
            })(),
          ]
          : parser.push(utf8.push(chunk.value));
        for (const sse of events) {
          for (const event of accumulator.handle(sse)) yield event;
          if (accumulator.state !== "open") break read;
        }
        if (chunk.done) break;
      }
      switch (accumulator.state) {
        case "completed":
          finished = true;
          return { turn: accumulator.turn(built.model, meta) };
        case "failed":
        case "incomplete":
          finished = true;
          throw accumulator.error!;
        default: {
          finished = true;
          const pending = accumulator.pendingError;
          if (pending !== null) throw pending;
          throw new GptStreamError(
            `the stream ended before response.completed${
              truncated ? ", in the middle of an event" : ""
            }`,
            { requestId },
          );
        }
      }
    } finally {
      cancelTimer();
      cancelTotal();
      signal?.removeEventListener("abort", onAbort);
      if (reader !== null) {
        // Stop the body download when we are done early or failed.
        reader.cancel().catch(() => {});
      }
      if (!finished) controller.abort(new Error("released"));
    }
  }

  async #listModels(options: CallOptions): Promise<ModelCard[]> {
    const started = this.#runtime.now();
    const policy = options.retry === undefined
      ? this.retry
      : resolveRetryPolicy(options.retry, this.retry);
    const deadline = policy.budgetMs === null
      ? Number.POSITIVE_INFINITY
      : started + policy.budgetMs;
    const connectTimeoutMs = checkTimeout(
      "connectTimeoutMs",
      options.connectTimeoutMs ?? this.connectTimeoutMs,
    );
    const url = `${this.baseUrl}/models`;
    const { signal } = options;
    const idempotent = requestIdempotency("models.list");
    let attempts = 0;
    for (;;) {
      if (signal?.aborted) throw new GptAbortError(undefined, { attempts });
      // Each attempt gets what is left of the budget, if that is shorter.
      const remaining = deadline - this.#runtime.now();
      if (remaining <= 0) {
        throw new GptTimeoutError(
          `the ${policy.budgetMs} ms retry budget ran out`,
          { attempts },
        );
      }
      const timeoutMs = Math.min(connectTimeoutMs, remaining);
      attempts++;
      let failure: GptError;
      const controller = new AbortController();
      let timedOut = false;
      const cancel = this.#runtime.setTimer(timeoutMs, () => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      });
      const onAbort = () => controller.abort(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const headers = new Headers(this.#headers);
        for (const [name, value] of new Headers(options.headers)) {
          headers.set(name, value);
        }
        headers.set("accept", "application/json");
        const response = await rejectOnAbort(
          this.#fetch(url, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: controller.signal,
          }),
          controller.signal,
        );
        refuseRedirect(response, "GET", url, requestIdOf(response.headers));
        const ok = response.status >= 200 && response.status <= 299;
        let text: string;
        try {
          text = ok
            ? await readTextBounded(response, {
              maxBytes: Math.min(MAX_MODELS_BODY_BYTES, this.maxResponseBytes),
              signal: controller.signal,
            })
            : await errorText(response, controller.signal);
        } catch (cause) {
          if (cause instanceof BoundsError && cause.code === "too_large") {
            throw tooLarge(
              Math.min(MAX_MODELS_BODY_BYTES, this.maxResponseBytes),
              requestIdOf(response.headers),
            );
          }
          throw cause;
        }
        if (!ok) {
          throw apiErrorFromResponse(
            response.status,
            text,
            response.headers,
            parseRetryAfter(response.headers, this.#runtime.now()),
          );
        }
        const issues: Issue[] = [];
        const json = tryParseJson(text);
        const models = json === undefined ? [] : decodeModels(json, issues);
        if (json === undefined) {
          issues.push({ path: [], message: "the body is not JSON" });
        }
        if (issues.length > 0) {
          throw new GptDecodeError(issues, {
            status: response.status,
            requestId: requestIdOf(response.headers),
          });
        }
        return models;
      } catch (caught) {
        if (caught instanceof GptError) failure = caught;
        else if (signal?.aborted) {
          failure = new GptAbortError(undefined, { cause: caught });
        } else if (timedOut) {
          failure = new GptTimeoutError(
            `no response from GET ${url} within ${timeoutMs} ms`,
          );
        } else {
          failure = new GptConnectionError(
            `GET ${url} failed: ${
              caught instanceof Error ? caught.message : String(caught)
            }`,
          );
        }
      } finally {
        cancel();
        signal?.removeEventListener("abort", onAbort);
      }
      failure.attempts = attempts;
      if (
        !mayRetryGpt(policy, failure, { idempotent }) ||
        attempts > policy.maxRetries
      ) {
        throw failure;
      }
      const delayMs = policy.respectRetryAfter && failure.retryAfterMs !== null
        ? Math.min(failure.retryAfterMs, policy.maxRetryAfterMs)
        : backoffDelay(policy, attempts - 1, this.#runtime.random());
      if (this.#runtime.now() + delayMs >= deadline) throw failure;
      this.#onRetry({ attempt: attempts, delayMs, error: failure.toJSON() });
      try {
        await this.#sleep(delayMs, signal);
      } catch (aborted) {
        if (aborted instanceof GptError) aborted.attempts = attempts;
        throw aborted;
      }
    }
  }
}

const MAX_OUTPUT_BODY = 4096;

/** A response past its byte cap: not retried, since it would be again. */
function tooLarge(maxBytes: number, requestId: string | null): GptDecodeError {
  return new GptDecodeError([{
    path: [],
    message: `the response is larger than ${maxBytes} bytes (maxResponseBytes)`,
  }], { status: 200, requestId });
}

/**
 * Throws for a redirect, which `redirect: "manual"` hands back (a 3xx, or
 * an opaque one with status 0) instead of following: the body is dropped
 * unread and the call fails as `http`, not retried.
 */
function refuseRedirect(
  response: Response,
  method: string,
  url: string,
  requestId: string | null,
): void {
  if (
    response.type !== "opaqueredirect" &&
    (response.status < 300 || response.status > 399)
  ) {
    return;
  }
  response.body?.cancel().catch(() => {});
  const location = response.headers.get("location");
  throw new GptApiError(
    "http",
    `${method} ${url} answered a redirect (${response.status}${
      location === null ? "" : ` to ${location.slice(0, 200)}`
    }); redirects are not followed`,
    { status: response.status, requestId },
  );
}

/**
 * An error body's first {@link MAX_ERROR_BODY_BYTES}; the rest is
 * cancelled unread.
 */
async function errorText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const next = await rejectOnAbort(reader.read(), signal);
      if (next.done) break;
      const room = MAX_ERROR_BODY_BYTES - total;
      const chunk = next.value.byteLength > room
        ? next.value.subarray(0, room)
        : next.value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * A schema's strict JSON Schema, for a structured format.
 *
 * @throws {GptInvalidRequestError} when strict mode would refuse it.
 */
export function strictSchema(schema: AnySchema): JsonObject {
  try {
    return toJSONSchema(schema, { target: "openai-strict" }) as JsonObject;
  } catch (error) {
    throw new GptInvalidRequestError([{
      path: ["format", "schema"],
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
}

/**
 * Decodes a turn's answer with a schema.
 *
 * @throws {GptOutputError} `refusal` or `output`, as for `structured`.
 */
export function decodeStructured<S extends AnySchema>(
  schema: S,
  turn: Turn,
): Output<S> {
  if (turn.refusal !== null) {
    throw new GptOutputError("refusal", `the model refused: ${turn.refusal}`, {
      status: 200,
      requestId: turn.meta.requestId,
      body: turn.refusal,
    });
  }
  const text = turn.finalText;
  let issues: readonly Issue[];
  const json = tryParseJson(text);
  if (json === undefined) {
    issues = [{ path: [], message: "the answer is not JSON" }];
  } else {
    const result = schema.safeParse(json);
    if (result.success) return result.data;
    issues = result.error.issues;
  }
  throw new GptOutputError(
    "output",
    `the answer does not match the schema: ${formatIssues(issues)}`,
    {
      status: 200,
      requestId: turn.meta.requestId,
      issues,
      body: text.length > MAX_OUTPUT_BODY
        ? `${text.slice(0, MAX_OUTPUT_BODY)}…`
        : text,
    },
  );
}
