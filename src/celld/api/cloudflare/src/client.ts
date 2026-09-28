// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The transport every area of `@celld/api/cloudflare` shares: where
 * requests go, authentication, the v4 envelope, errors, retries and
 * pagination.
 *
 * Two ways to reach the API:
 *
 * - Through an exe.dev HTTP proxy integration (the default): the
 *   integration holds the API token and injects `Authorization`, so the VM
 *   holds no credential. `new CloudflareClient()` uses
 *   `https://cloudflare.int.exe.xyz`; `integration` names another.
 * - Directly: `token` is sent as a bearer token to
 *   `https://api.cloudflare.com`.
 *
 * Either way requests go to `<origin>/client/v4/...`.
 *
 * @module
 */

import { BoundsError, readBounded } from "@celld/core/bounds";
import {
  backoffDelay,
  defaultRuntime,
  type FetchLike,
  globalFetch,
  type HttpRetryPolicy,
  isIdempotentMethod,
  mayRetry,
  parseRetryAfter,
  rejectOnAbort,
  resolveRetryPolicy,
  type RetryFailure,
  type RetryOptions,
  type Runtime,
} from "@celld/http";
import { type ApiMessage, apiMessages, CloudflareError } from "./errors.ts";
import { cloudflareId } from "./ids.ts";

/** One query parameter's value; a list repeats the key, `undefined` drops it. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number)[];

/** Query parameters by name (`"account.id"` and `"name.contains"` included). */
export type Query = Readonly<Record<string, QueryValue>>;

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Options of one request. */
export interface RequestOptions {
  readonly query?: Query;
  /** A JSON body. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** How long one attempt may take, from sending to the last byte. */
  readonly timeoutMs?: number;
  /**
   * Declares the request safe to send twice. By default GET, PUT and DELETE
   * are, and POST and PATCH are not: a write whose answer was lost may
   * have happened, so it is never sent again unless declared here.
   */
  readonly idempotent?: boolean;
}

/** An envelope's `result_info`: its page, or its cursor. */
export interface ResultInfo {
  readonly page?: number;
  readonly per_page?: number;
  readonly count?: number;
  readonly total_count?: number;
  readonly total_pages?: number;
  /** The next page's cursor, on the endpoints that use cursors. */
  readonly cursor?: string;
  readonly cursors?: { readonly after?: string; readonly before?: string };
}

/** A successful v4 response. */
export interface Envelope<T> {
  readonly result: T;
  readonly result_info?: ResultInfo;
  readonly messages: readonly ApiMessage[];
}

/** One page of a list. */
export interface Page<T> {
  readonly items: T[];
  readonly info?: ResultInfo;
}

/** How to walk a list. */
export interface PageOptions extends Omit<RequestOptions, "body" | "query"> {
  /** Items per request; the endpoint's own default when left out. */
  readonly perPage?: number;
  /**
   * `"page"` (the default) asks for `page=1, 2, ...` until `total_pages`,
   * or without it until `total_count` is covered, or without either until a
   * page comes back short of `per_page` or empty; a response with no
   * `per_page` at all is a list that has only the one page. `"cursor"`
   * passes `result_info.cursor` (or `cursors.after`) back as `cursor` until
   * there is none.
   */
  readonly paging?: "page" | "cursor";
}

/** How much of a list {@link CloudflareClient.list} collects. */
export interface ListOptions extends PageOptions {
  /**
   * Stop after this many items (default 10 000). A list that goes on is an
   * error unless `truncate` is set, so a partial answer is never mistaken
   * for the whole.
   */
  readonly maxItems?: number;
  /** Return the first `maxItems` instead of throwing when there are more. */
  readonly truncate?: boolean;
}

/** The `env` bindings {@link CloudflareClient.fromEnv} reads. */
export interface CloudflareEnv {
  /** An API token, as a secret binding. Leave it out behind an integration. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** The exe.dev HTTP proxy integration's name, default `cloudflare`. */
  readonly CLOUDFLARE_INTEGRATION?: string;
  /** Overrides the origin, for proxies and tests. */
  readonly CLOUDFLARE_BASE_URL?: string;
  /**
   * `"true"` allows `http:` to a loopback `CLOUDFLARE_BASE_URL`, for a fake
   * in development and tests.
   */
  readonly CLOUDFLARE_LOOPBACK_FOR_DEVELOPMENT?: string;
}

/** Options of a {@link CloudflareClient}. */
export interface CloudflareClientOptions {
  /**
   * The API's origin, `https://` without a path. Default: from
   * `integration`, or `https://api.cloudflare.com` when `token` is given.
   */
  readonly baseUrl?: string;
  /** The exe.dev HTTP proxy integration's name; default `cloudflare`. */
  readonly integration?: string;
  /** An API token, sent as `Authorization: Bearer`. Leave it out behind an integration. */
  readonly token?: string;
  /** Allows `http:` to a loopback `baseUrl`, for a fake in development and tests. */
  readonly allowLoopbackForDevelopment?: boolean;
  /** Per attempt; default 30 s. */
  readonly timeoutMs?: number;
  /** The largest response read; default 16 MiB. */
  readonly maxResponseBytes?: number;
  /** Retries, for idempotent requests only. */
  readonly retry?: RetryOptions;
  readonly fetch?: FetchLike;
  readonly runtime?: Runtime;
}

export const DEFAULT_INTEGRATION = "cloudflare";
export const API_ORIGIN = "https://api.cloudflare.com";
export const API_PATH = "/client/v4";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_ITEMS = 10_000;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_PAGES = 10_000;

/**
 * Retries for idempotent requests: 429 (Cloudflare's rate limit, honouring
 * `Retry-After`) and the gateway statuses.
 */
export const DEFAULT_RETRY_POLICY: HttpRetryPolicy = Object.freeze({
  maxRetries: 3,
  backoffInitialMs: 250,
  backoffMaxMs: 8_000,
  backoffJitter: 0.5,
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  budgetMs: 120_000,
  statuses: Object.freeze([429, 500, 502, 503, 504]),
  retryConnectionErrors: true,
  retryTimeouts: true,
});

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const PATH = /^\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]*$/;
const TOKEN = /^[\x21-\x7e]{1,1024}$/;

/** The origin for `options`, checked. */
export function endpointOrigin(
  options: Pick<
    CloudflareClientOptions,
    "baseUrl" | "integration" | "token" | "allowLoopbackForDevelopment"
  >,
): string {
  let base = options.baseUrl;
  if (base === undefined && options.token !== undefined) base = API_ORIGIN;
  if (base === undefined) {
    const name = options.integration ?? DEFAULT_INTEGRATION;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      throw new TypeError(`${JSON.stringify(name)} is not an integration name`);
    }
    base = `https://${name}.int.exe.xyz`;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError("baseUrl is not a URL");
  }
  if (url.username || url.password) {
    throw new TypeError("baseUrl must not carry credentials");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError(
      "baseUrl must be an origin, without a path, query or fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && options.allowLoopbackForDevelopment &&
      LOOPBACK.has(url.hostname))
  ) {
    throw new TypeError(
      "baseUrl must be https (http only to loopback with allowLoopbackForDevelopment)",
    );
  }
  return url.origin;
}

/** A token's state, from {@link CloudflareClient.verifyToken}. */
export interface TokenStatus {
  readonly id: string;
  readonly status: "active" | "disabled" | "expired" | string;
  readonly expires_on?: string;
  readonly not_before?: string;
}

type Outcome =
  | { readonly value: Response; readonly bytes: Uint8Array }
  | { readonly failure: RetryFailure; readonly error: CloudflareError };

/** A Cloudflare API client; the areas (`./zones`, `./tunnels`, ...) take one. */
export class CloudflareClient {
  /** The API's origin. */
  readonly origin: string;
  /** `<origin>/client/v4`. */
  readonly apiUrl: string;
  readonly #token?: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #retry: HttpRetryPolicy;
  readonly #fetch: FetchLike;
  readonly #runtime: Runtime;

  constructor(options: CloudflareClientOptions = {}) {
    if (options.token !== undefined && !TOKEN.test(options.token)) {
      throw new TypeError("token must be printable ASCII without spaces");
    }
    this.origin = endpointOrigin(options);
    this.apiUrl = `${this.origin}${API_PATH}`;
    this.#token = options.token;
    this.#timeoutMs = positive(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxResponseBytes = positive(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.#retry = resolveRetryPolicy(options.retry, DEFAULT_RETRY_POLICY);
    this.#fetch = options.fetch ?? globalFetch;
    this.#runtime = options.runtime ?? defaultRuntime;
  }

  /**
   * A client from Worker bindings (see {@link CloudflareEnv}). With no
   * token bound it goes through the exe.dev integration. Explicit options
   * win.
   */
  static fromEnv(
    env: CloudflareEnv,
    options: CloudflareClientOptions = {},
  ): CloudflareClient {
    return new CloudflareClient({
      ...options,
      token: options.token ?? (env.CLOUDFLARE_API_TOKEN?.trim() || undefined),
      integration: options.integration ??
        (env.CLOUDFLARE_INTEGRATION?.trim() || undefined),
      baseUrl: options.baseUrl ??
        (env.CLOUDFLARE_BASE_URL?.trim() || undefined),
      allowLoopbackForDevelopment: options.allowLoopbackForDevelopment ??
        env.CLOUDFLARE_LOOPBACK_FOR_DEVELOPMENT === "true",
    });
  }

  /** The clock and randomness the client uses; the areas share them. */
  get runtime(): Runtime {
    return this.#runtime;
  }

  /** A v4 request; resolves to its envelope, rejects with a {@link CloudflareError}. */
  async request<T>(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<Envelope<T>> {
    const response = await this.#send(
      method,
      path,
      options,
      "application/json",
    );
    const parsed = parseJson(response.bytes);
    const envelope = parsed === undefined
      ? null
      : envelopeOf(parsed, { bareResult: true });
    const fields = {
      status: response.value.status,
      rayId: rayOf(response.value),
    };
    if (envelope === null) {
      throw new CloudflareError(
        "response",
        `${method} ${path} answered ${response.value.status} without a v4 envelope`,
        fields,
      );
    }
    if (envelope.success !== true) {
      const errors = apiMessages(envelope.errors);
      throw new CloudflareError(
        "api",
        `${method} ${path} failed: ${
          errors.map((error) => `${error.code} ${error.message}`).join("; ") ||
          "success is false"
        }`,
        { ...fields, errors },
      );
    }
    return {
      result: envelope.result as T,
      ...(envelope.result_info === undefined
        ? {}
        : { result_info: envelope.result_info }),
      messages: apiMessages(envelope.messages),
    };
  }

  /** A v4 request's `result`. */
  async result<T>(
    method: Method,
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    return (await this.request<T>(method, path, options)).result;
  }

  /**
   * A request to an endpoint that answers without the envelope (a DNS
   * export, URL Scanner): the body as text. Errors are read as usual.
   */
  async text(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<string> {
    const response = await this.#send(method, path, options, "*/*");
    return new TextDecoder().decode(response.bytes);
  }

  /** Like {@link text}, parsed as JSON. */
  async json(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const response = await this.#send(
      method,
      path,
      options,
      "application/json",
    );
    const parsed = parseJson(response.bytes);
    if (parsed === undefined) {
      throw new CloudflareError(
        "response",
        `${method} ${path} answered with a body that is not JSON`,
        { status: response.value.status, rayId: rayOf(response.value) },
      );
    }
    return parsed;
  }

  /** Like {@link text}, as bytes (a screenshot, say). */
  async bytes(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    return (await this.#send(method, path, options, "*/*")).bytes;
  }

  /** One page of a list endpoint. */
  async page<T>(
    path: string,
    query: Query = {},
    options: Omit<RequestOptions, "body" | "query"> = {},
  ): Promise<Page<T>> {
    const envelope = await this.request<unknown>("GET", path, {
      ...options,
      query,
    });
    if (!Array.isArray(envelope.result)) {
      throw new CloudflareError(
        "response",
        `GET ${path} answered a result that is not a list`,
      );
    }
    return {
      items: envelope.result as T[],
      ...(envelope.result_info === undefined
        ? {}
        : { info: envelope.result_info }),
    };
  }

  /** Every page of a list endpoint, in order. */
  async *pages<T>(
    path: string,
    query: Query = {},
    options: PageOptions = {},
  ): AsyncGenerator<T[]> {
    const { perPage, paging = "page", ...request } = options;
    const base: Record<string, QueryValue> = { ...query };
    if (perPage !== undefined) {
      base.per_page = positive(perPage, "perPage");
    }
    let page = 1;
    let cursor: string | undefined;
    for (let fetched = 0; fetched < MAX_PAGES; fetched++) {
      const current = paging === "page"
        ? { ...base, page }
        : { ...base, ...(cursor === undefined ? {} : { cursor }) };
      const { items, info } = await this.page<T>(path, current, request);
      yield items;
      if (paging === "cursor") {
        const next = info?.cursor || info?.cursors?.after || undefined;
        if (next === undefined || items.length === 0 || next === cursor) return;
        cursor = next;
        continue;
      }
      if (items.length === 0 || info === undefined) return;
      const perPage = info.per_page;
      if (typeof info.total_pages === "number") {
        if (page >= info.total_pages) return;
      } else if (typeof perPage !== "number" || perPage < 1) {
        // Nothing says the list is paged: it is this one page.
        return;
      } else if (typeof info.total_count === "number") {
        if (page * perPage >= info.total_count) return;
      } else if (items.length < perPage) {
        return;
      }
      page++;
    }
    throw new CloudflareError(
      "response",
      `GET ${path} went on for more than ${MAX_PAGES} pages`,
    );
  }

  /**
   * Every item of a list endpoint, at most `maxItems` of them.
   *
   * @throws {RangeError} when there are more, unless `truncate` is set.
   */
  async list<T>(
    path: string,
    query: Query = {},
    options: ListOptions = {},
  ): Promise<T[]> {
    const { maxItems = DEFAULT_MAX_ITEMS, truncate = false, ...paging } =
      options;
    positive(maxItems, "maxItems");
    const all: T[] = [];
    for await (const items of this.pages<T>(path, query, paging)) {
      for (const item of items) {
        if (all.length === maxItems) {
          if (truncate) return all;
          throw new RangeError(
            `GET ${path} lists more than ${maxItems} items; walk it with pages() or raise maxItems`,
          );
        }
        all.push(item);
      }
    }
    return all;
  }

  /**
   * The state of the token in use: `GET /user/tokens/verify`, or
   * `/accounts/<id>/tokens/verify` for an account-owned token.
   */
  async verifyToken(
    options: { readonly accountId?: string; readonly signal?: AbortSignal } =
      {},
  ): Promise<TokenStatus> {
    const path = options.accountId === undefined
      ? "/user/tokens/verify"
      : `/accounts/${
        cloudflareId(options.accountId, "accountId")
      }/tokens/verify`;
    const status = await this.result<TokenStatus>("GET", path, {
      signal: options.signal,
    });
    if (
      status === null || typeof status !== "object" ||
      typeof status.id !== "string" || typeof status.status !== "string"
    ) {
      throw new CloudflareError("response", `GET ${path} answered no token`);
    }
    return status;
  }

  async #send(
    method: Method,
    path: string,
    options: RequestOptions,
    accept: string,
  ): Promise<{ value: Response; bytes: Uint8Array }> {
    const url = this.#url(path, options.query);
    const headers: Record<string, string> = { accept };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (this.#token !== undefined) {
      headers.authorization = `Bearer ${this.#token}`;
    }
    const idempotent = options.idempotent ?? isIdempotentMethod(method);
    const timeoutMs = positive(
      options.timeoutMs ?? this.#timeoutMs,
      "timeoutMs",
    );
    const started = this.#runtime.now();
    for (let retry = 0;; retry++) {
      const outcome = await this.#attempt(
        method,
        path,
        url,
        headers,
        body,
        timeoutMs,
        options.signal,
      );
      if ("value" in outcome) return outcome;
      const { failure, error } = outcome;
      const asked = error.retryAfterMs;
      const delay = asked !== undefined && this.#retry.respectRetryAfter
        ? Math.min(asked, this.#retry.maxRetryAfterMs)
        : backoffDelay(this.#retry, retry, this.#runtime.random());
      const budget = this.#retry.budgetMs;
      const inBudget = budget === null ||
        this.#runtime.now() + delay - started < budget;
      if (
        retry >= this.#retry.maxRetries || !inBudget ||
        !mayRetry(this.#retry, failure, { idempotent })
      ) throw error;
      await this.#runtime.sleep(delay, options.signal);
    }
  }

  #url(path: string, query: Query | undefined): string {
    if (!PATH.test(path) || path.split("/").some((part) => part === "..")) {
      throw new TypeError(`${JSON.stringify(path)} is not an API path`);
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.append(key, String(value));
      }
    }
    const search = params.toString();
    return `${this.apiUrl}${path}${search === "" ? "" : `?${search}`}`;
  }

  async #attempt(
    method: Method,
    path: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
    outer: AbortSignal | undefined,
  ): Promise<Outcome> {
    outer?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(outer!.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const cancel = this.#runtime.setTimer(timeoutMs, () => {
      timedOut = true;
      controller.abort(
        new DOMException("the Cloudflare request timed out", "TimeoutError"),
      );
    });
    const signal = controller.signal;
    const what = `${method} ${path}`;
    const lost = (error: unknown, stage: "connection" | "body"): Outcome => {
      if (outer?.aborted) throw outer.reason;
      const write = isIdempotentMethod(method)
        ? ""
        : "; the change may have been made";
      if (timedOut) {
        return {
          failure: { kind: "timeout" },
          error: new CloudflareError(
            "timeout",
            `${what}: no answer within ${timeoutMs} ms${write}`,
            { cause: error },
          ),
        };
      }
      return {
        failure: { kind: stage },
        error: new CloudflareError(
          "network",
          `${what}: the connection failed${write}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        ),
      };
    };
    try {
      let response: Response;
      try {
        response = await rejectOnAbort(
          this.#fetch(url, { method, headers, body, signal }),
          signal,
        );
      } catch (error) {
        return lost(error, "connection");
      }
      const rayId = rayOf(response);
      const limit = response.ok ? this.#maxResponseBytes : MAX_ERROR_BYTES;
      let bytes: Uint8Array;
      try {
        bytes = await rejectOnAbort(
          readBounded(response, { maxBytes: limit, signal }),
          signal,
        );
      } catch (error) {
        if (!(error instanceof BoundsError)) return lost(error, "body");
        return {
          failure: { kind: "status", status: response.status },
          error: new CloudflareError(
            response.ok ? "too-large" : "http",
            response.ok
              ? `${what}: the response is larger than ${limit} bytes`
              : `${what} answered ${response.status} with an oversized body`,
            { status: response.status, rayId },
          ),
        };
      }
      if (response.ok) return { value: response, bytes };
      return {
        failure: { kind: "status", status: response.status },
        error: failureOf(what, response, bytes, this.#runtime.now()),
      };
    } finally {
      cancel();
      outer?.removeEventListener("abort", onAbort);
    }
  }
}

/** The error for a non-2xx response. */
function failureOf(
  what: string,
  response: Response,
  bytes: Uint8Array,
  now: number,
): CloudflareError {
  const status = response.status;
  const rayId = rayOf(response);
  const parsed = parseJson(bytes);
  const record = parsed !== null && typeof parsed === "object" &&
      !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const errors = apiMessages(record?.errors);
  const retryAfterMs = status === 429
    ? parseRetryAfter(response.headers, now) ?? undefined
    : undefined;
  // URL Scanner's own errors: { message, status, errors: [{ title, detail }] }.
  const serviceMessage = typeof record?.message === "string"
    ? record.message
    : undefined;
  const detail = errors.length > 0
    ? errors.map((error) => `${error.code} ${error.message}`).join("; ")
    : serviceMessage ??
      new TextDecoder().decode(bytes.subarray(0, 200)).trim();
  const kind = status === 429
    ? "rate-limited"
    : errors.length > 0 || serviceMessage !== undefined
    ? "api"
    : "http";
  return new CloudflareError(
    kind,
    `${what} answered ${status}${
      detail === "" ? "" : `: ${detail.slice(0, 500)}`
    }`,
    { status, errors, rayId, retryAfterMs, body: record },
  );
}

interface RawEnvelope {
  readonly success: unknown;
  readonly result?: unknown;
  readonly result_info?: ResultInfo;
  readonly errors?: unknown;
  readonly messages?: unknown;
}

/**
 * The envelope in `value`, or null. With `bareResult`, `{ result }`
 * without `success` counts as a success: that is the documented answer of
 * some deletes.
 */
function envelopeOf(
  value: unknown,
  options: { readonly bareResult?: boolean } = {},
): RawEnvelope | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    options.bareResult && record.success === undefined && "result" in record &&
    record.errors === undefined
  ) {
    return { success: true, result: record.result, messages: record.messages };
  }
  if (typeof record.success !== "boolean") return null;
  const info = record.result_info;
  return {
    success: record.success,
    result: record.result,
    errors: record.errors,
    messages: record.messages,
    ...(info !== null && typeof info === "object" && !Array.isArray(info)
      ? { result_info: info as ResultInfo }
      : {}),
  };
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function rayOf(response: Response): string | undefined {
  return response.headers.get("cf-ray") ?? undefined;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
