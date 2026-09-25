// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * For code running **on** an exe.dev VM (a celld node, an agent): the
 * reflection service, the integrations attached to the VM, and email.
 *
 * Integrations are reached at `https://<name>.int.exe.xyz` (personal) or
 * `https://<name>.team.exe.xyz` (team); exe.dev injects the stored credential
 * at the network edge, so the VM never holds it. These hostnames only resolve
 * from VMs the integration is attached to. Every helper takes an injectable
 * `fetch` and base-domain override, for tests and proxies.
 *
 * Typed helpers exist where the docs describe the wire format (reflection,
 * LLM, GitHub, Slack, Slack bot, Discord, Discord bot, VM-to-VM, token mint,
 * container registries, AWS and GCP workload identity, object storage, send
 * and receive email). {@link VmIntegrations.fetch} reaches any other
 * integration, such as the hundred-odd catalog services, as a plain proxy.
 *
 * @module
 */

import { truncatedBody } from "@celld/http";
import { v } from "@celld/sieve";
import {
  type ApiErrorKind,
  ExeApiError,
  ExeConnectionError,
  ExeDecodeError,
  ExeError,
  ExeInvalidRequestError,
  ExeTimeoutError,
} from "./errors.ts";
import { isPlainObject, type JsonObject, type JsonValue } from "./json.ts";
import { decodeWith } from "./decode.ts";
import { base64Encode } from "./quote.ts";
import {
  backoffDelay,
  parseRetryAfter,
  resolveRetryPolicy,
  type RetryOptions,
  type RetryPolicy,
} from "./retry.ts";
import {
  defaultRuntime,
  type FetchLike,
  globalFetch,
  rejectOnAbort,
  type Runtime,
} from "./runtime.ts";
import { errorDetail } from "./transport.ts";

/** The reflection service's origin. */
export const REFLECTION_URL = "https://reflection.int.exe.xyz";
/** The email gateway, on the VM's link-local metadata address. */
export const EMAIL_SEND_URL = "http://169.254.169.254/gateway/email/send";
/** Personal integrations live under this domain. */
export const INTEGRATION_DOMAIN = "int.exe.xyz";
/** Team integrations live under this domain. */
export const TEAM_INTEGRATION_DOMAIN = "team.exe.xyz";

/** How VM-side helpers make requests. */
export interface VmHttpOptions {
  /** The `fetch` to use; default the global one. */
  readonly fetch?: FetchLike;
  /** Per-request timeout; default 30 s. */
  readonly timeoutMs?: number;
  /** Retries for GET requests only; default two, as for the lobby. */
  readonly retry?: RetryOptions;
  readonly runtime?: Runtime;
  /** Replaces `int.exe.xyz` (tests, proxies). */
  readonly domain?: string;
  /** Replaces `team.exe.xyz`. */
  readonly teamDomain?: string;
  /** `https` (default) or `http`, for integration origins. */
  readonly scheme?: "https" | "http";
  /** Replaces {@link REFLECTION_URL}. */
  readonly reflectionUrl?: string;
  /** Replaces {@link EMAIL_SEND_URL}. */
  readonly emailUrl?: string;
}

/** The error kind for a status from an integration or VM endpoint. */
export function httpKind(status: number): ApiErrorKind {
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
    case 429:
      return "rate_limited";
  }
  return status >= 500 && status <= 599 ? "server" : "http";
}

/** A response read in full. */
export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly url: string;
}

const utf8 = new TextDecoder();

/**
 * Plain HTTP with the library's error types: a timeout per attempt, GET/HEAD
 * retries on 429/5xx/connection failures, and `ExeApiError` for non-2xx.
 */
export class VmHttp {
  readonly #fetch: FetchLike;
  readonly #runtime: Runtime;
  readonly #retry: RetryPolicy;
  readonly timeoutMs: number;

  constructor(options: VmHttpOptions = {}) {
    this.#fetch = options.fetch ?? globalFetch;
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#retry = resolveRetryPolicy(options.retry);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #once(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<HttpResult> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = this.#runtime.setTimer(timeoutMs, () => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    });
    const outer = init.signal ?? undefined;
    const onAbort = () => controller.abort(outer!.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    const method = init.method ?? "GET";
    const fail = (cause: unknown): ExeError => {
      if (outer?.aborted) {
        return new ExeError("aborted", "the request was aborted", { cause });
      }
      if (timedOut) {
        return new ExeTimeoutError(
          `no response from ${method} ${url} within ${timeoutMs} ms`,
          {
            cause,
            ambiguous: method !== "GET" && method !== "HEAD",
          },
        );
      }
      return new ExeConnectionError(
        `${method} ${url} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    };
    try {
      let response: Response;
      try {
        response = await rejectOnAbort(
          this.#fetch(url, { ...init, signal: controller.signal }),
          controller.signal,
        );
      } catch (cause) {
        throw fail(cause);
      }
      let body: Uint8Array;
      try {
        body = new Uint8Array(
          await rejectOnAbort(response.arrayBuffer(), controller.signal),
        );
      } catch (cause) {
        throw fail(cause);
      }
      return { status: response.status, headers: response.headers, body, url };
    } finally {
      cancel();
      outer?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Sends a request and returns the response in full.
   *
   * @throws {ExeApiError} a non-2xx status (unless `accept` allows it).
   * @throws {ExeConnectionError} / {ExeTimeoutError} no response.
   */
  async request(
    url: string,
    init: RequestInit = {},
    options: {
      readonly accept?: (status: number) => boolean;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<HttpResult> {
    const method = (init.method ?? "GET").toUpperCase();
    const retries = method === "GET" || method === "HEAD"
      ? this.#retry.maxRetries
      : 0;
    for (let attempt = 0;; attempt++) {
      let error: ExeError;
      try {
        const result = await this.#once(
          url,
          init,
          options.timeoutMs ?? this.timeoutMs,
        );
        if (
          (result.status >= 200 && result.status <= 299) ||
          options.accept?.(result.status)
        ) {
          return result;
        }
        const text = utf8.decode(result.body);
        const body = truncatedBody(text);
        const detail = errorDetail(body);
        const kind = httpKind(result.status);
        throw new ExeApiError(
          kind,
          `${method} ${url} answered ${result.status}${
            detail === null ? "" : `: ${detail}`
          }`,
          {
            status: result.status,
            body,
            detail,
            retryAfterMs: parseRetryAfter(result.headers, this.#runtime.now()),
            ambiguous: kind === "server" && method !== "GET" &&
              method !== "HEAD",
          },
        );
      } catch (caught) {
        if (!(caught instanceof ExeError)) throw caught;
        error = caught;
      }
      error.attempts = attempt + 1;
      const transient = error instanceof ExeApiError
        ? this.#retry.statuses.includes(error.status)
        : error.kind === "connection" || error.kind === "timeout";
      if (attempt >= retries || !transient) throw error;
      const delay = error.retryAfterMs !== null
        ? Math.min(error.retryAfterMs, this.#retry.maxRetryAfterMs)
        : backoffDelay(this.#retry, attempt, this.#runtime.random());
      await this.#runtime.sleep(delay, init.signal ?? undefined);
    }
  }

  /** Sends a request and parses a JSON response. */
  async json(url: string, init: RequestInit = {}): Promise<JsonValue> {
    const result = await this.request(url, init);
    const text = utf8.decode(result.body);
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new ExeDecodeError([{
        path: [],
        message: "the response is not JSON",
      }], {
        status: result.status,
        body: truncatedBody(text),
      });
    }
  }

  /** Sends a request and returns its text. */
  async text(url: string, init: RequestInit = {}): Promise<string> {
    return utf8.decode((await this.request(url, init)).body);
  }
}

function jsonInit(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** One entry of the reflection index's `paths`. */
export interface ReflectionPath {
  readonly path: string;
  readonly description?: string;
}

/** The reflection index: the VM's own name and emoji, and what it may read. */
export interface ReflectionIndex {
  readonly name: string;
  readonly emoji?: string;
  readonly paths: readonly ReflectionPath[];
  readonly raw: JsonObject;
}

/** An integration attached to this VM, as reflection lists it. */
export interface AttachedIntegration {
  readonly name: string;
  /** `http-proxy`, `github`, `llm`, `reflection`, a catalog handle... */
  readonly type: string;
  readonly comment?: string;
  /** A usage hint, such as `curl https://llm.int.exe.xyz/v1/models`. */
  readonly help?: string;
  readonly raw: JsonObject;
}

/** A string that is kept when present and dropped when anything else. */
const lenientText = v.string().optional().catch(undefined);

/** Keeps the members that are set, so results compare and clone cleanly. */
function present<T>(value: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

/** One `paths` entry of the reflection index: a string `path`. */
export const ReflectionPath: v.Schema<ReflectionPath, unknown> = v
  .looseObject({ path: v.string(), description: lenientText })
  .transform(({ path, description }) =>
    present<ReflectionPath>({ path, description })
  ).meta({ id: "ReflectionPath" });

/**
 * The reflection index (`GET /`): `name` is required; `emoji` and `paths`
 * are read when they have the documented types, and entries of `paths`
 * without a string `path` are skipped.
 */
export const ReflectionIndex: v.Schema<ReflectionIndex, unknown> = v
  .looseObject({
    name: v.string(),
    emoji: lenientText,
    // Entries without a string path are skipped rather than refused.
    paths: v.array(ReflectionPath.nullable().catch(null)).catch([]).optional(),
  })
  .transform((object) =>
    present<ReflectionIndex>({
      name: object.name,
      emoji: object.emoji,
      paths: (object.paths ?? []).filter((item) => item !== null),
      raw: object,
    })
  ).meta({ id: "ReflectionIndex" });

/** One entry of reflection's `/integrations`: string `name` and `type`. */
export const AttachedIntegration: v.Schema<AttachedIntegration, unknown> = v
  .looseObject({
    name: v.string(),
    type: v.string(),
    comment: lenientText,
    help: lenientText,
  })
  .transform((object) =>
    present<AttachedIntegration>({
      name: object.name,
      type: object.type,
      comment: object.comment,
      help: object.help,
      raw: object,
    })
  ).meta({ id: "AttachedIntegration" });

function field(value: JsonValue, name: string): JsonValue | undefined {
  if (isPlainObject(value)) return (value as JsonObject)[name];
  return value;
}

const REFLECTION_EMAIL = v.string("expected an email address").min(
  1,
  "expected an email address",
);
const REFLECTION_TAGS = v.union([
  v.array(v.string()),
  v.string().transform((text) =>
    text.split(/[\s,]+/).filter((tag) => tag !== "")
  ),
], "expected a list of tags");
const REFLECTION_COMMENT = v.string("expected a string").nullable()
  .transform((comment) => comment ?? "");
const REFLECTION_PORT = v.union([
  v.null(),
  v.literal("").transform(() => null),
  v.number(),
  v.string().transform((text) => Number(text)),
], "expected a port number").pipe(
  v.int("expected a port number").min(1, "expected a port number").max(
    65535,
    "expected a port number",
  ).nullable(),
);

/**
 * Reads the reflection integration (`https://reflection.int.exe.xyz`). The
 * index and `/integrations` shapes are documented; `/email`, `/tags`,
 * `/comment` and `/default_port` are not, so each accepts a JSON object with
 * the field named like the path, a bare JSON value, or plain text. A field
 * the integration does not expose answers with an error status.
 */
export class ReflectionClient {
  readonly baseUrl: string;
  readonly #http: VmHttp;

  constructor(options: VmHttpOptions = {}) {
    this.baseUrl = (options.reflectionUrl ?? REFLECTION_URL).replace(
      /\/+$/,
      "",
    );
    this.#http = new VmHttp(options);
  }

  async #read(path: string): Promise<JsonValue> {
    const text = await this.#http.text(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
    });
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text.trim();
    }
  }

  /** `GET /`: the VM's name, emoji and the paths it may read. */
  async index(): Promise<ReflectionIndex> {
    return decodeWith(
      ReflectionIndex,
      await this.#http.json(`${this.baseUrl}/`),
    );
  }

  /** `GET /integrations`: the integrations attached to this VM. */
  async integrations(): Promise<AttachedIntegration[]> {
    const raw = await this.#http.json(`${this.baseUrl}/integrations`);
    return isPlainObject(raw)
      ? decodeWith(
        v.array(AttachedIntegration),
        raw.integrations,
        ["integrations"],
      )
      : decodeWith(v.array(AttachedIntegration), raw);
  }

  /** The first attached integration matching `type` and/or `name`, or null. */
  async findIntegration(
    match: { readonly type?: string; readonly name?: string },
  ): Promise<AttachedIntegration | null> {
    return (await this.integrations()).find((item) =>
      (match.type === undefined || item.type === match.type) &&
      (match.name === undefined || item.name === match.name)
    ) ?? null;
  }

  /** `GET /email`: the owner's email address. */
  async email(): Promise<string> {
    return decodeWith(
      REFLECTION_EMAIL,
      field(await this.#read("/email"), "email"),
      ["email"],
    );
  }

  /** `GET /tags`: the VM's tags. */
  async tags(): Promise<string[]> {
    return decodeWith(
      REFLECTION_TAGS,
      field(await this.#read("/tags"), "tags"),
      ["tags"],
    );
  }

  /** `GET /comment`: the VM's comment, `""` when none. */
  async comment(): Promise<string> {
    return decodeWith(
      REFLECTION_COMMENT,
      field(await this.#read("/comment"), "comment"),
      ["comment"],
    );
  }

  /** `GET /default_port`: the port `https://<vm>.exe.xyz/` proxies to, or null. */
  async defaultPort(): Promise<number | null> {
    return decodeWith(
      REFLECTION_PORT,
      field(await this.#read("/default_port"), "default_port"),
      ["default_port"],
    );
  }
}

/** What a token-mint endpoint returns: the vendor's response, verbatim. */
export interface MintedToken {
  readonly access_token: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly raw: JsonObject;
}

const lenientNumber = v.number().optional().catch(undefined);

/**
 * A token-mint answer: a non-empty `access_token`; `expires_in` and
 * `token_type` are read when they have the right types.
 */
export const MintedToken: v.Schema<MintedToken, unknown> = v.looseObject({
  access_token: v.string("expected a non-empty string").min(
    1,
    "expected a non-empty string",
  ),
  expires_in: lenientNumber,
  token_type: lenientText,
}).transform((object) =>
  present<MintedToken>({
    access_token: object.access_token,
    expires_in: object.expires_in,
    token_type: object.token_type,
    raw: object,
  })
).meta({ id: "MintedToken" });

/** The documented token paths of the token-mint catalog services. */
export const TOKEN_MINT_PATHS = Object.freeze(
  {
    googlesa: "/token",
    twitch: "/oauth2/token",
    "reddit-ads": "/api/v1/access_token",
  } as const,
);

/** A registry token, as the OCI token realm returns it. */
export interface RegistryToken {
  readonly token: string;
  readonly expires_in?: number;
  readonly issued_at?: string;
  readonly raw: JsonObject;
}

/** The documented token realms of the container registry integrations. */
export const REGISTRY_REALMS = Object.freeze(
  {
    quay: "/v2/auth",
    ghcr: "/token",
    atcr: "/auth/token",
    gar: "/v2/token",
  } as const,
);

/** The `service` each registry's realm expects by default. */
export const REGISTRY_SERVICES = Object.freeze(
  {
    quay: "quay.io",
    ghcr: "ghcr.io",
    atcr: "atcr.io",
    gar: "us-docker.pkg.dev",
  } as const,
);

/** What a GCP workload identity integration's `/metadata` returns. */
export interface GcpWifMetadata {
  readonly project_id?: string;
  readonly project_number: string;
  readonly pool_id: string;
  readonly provider_id: string;
  readonly service_account: string;
  readonly raw: JsonObject;
}

/** An email the VM sends through the gateway. */
export interface OutgoingEmail {
  /** You, a team member, someone who logged in to a shared VM, or a correspondent. */
  readonly to: string;
  readonly subject: string;
  /** Plain text. */
  readonly body: string;
  readonly reply_to?: string;
  /** The `Message-ID` being answered; needed to reply to correspondents. */
  readonly in_reply_to?: string;
  readonly references?: string;
  readonly attachments?: readonly {
    readonly filename: string;
    /** Bytes (encoded here) or base64 text. */
    readonly content: Uint8Array | string;
    readonly content_type?: string;
  }[];
}

function stringField(object: JsonValue, name: string, path: string[]): string {
  const value = isPlainObject(object)
    ? (object as JsonObject)[name]
    : undefined;
  if (typeof value !== "string" || value === "") {
    throw new ExeDecodeError([{
      path: [...path, name],
      message: "expected a non-empty string",
    }]);
  }
  return value;
}

/** Everything on the VM side; see the module notes. */
export class VmIntegrations {
  readonly http: VmHttp;
  readonly reflection: ReflectionClient;
  readonly #options: VmHttpOptions;

  constructor(options: VmHttpOptions = {}) {
    this.#options = options;
    this.http = new VmHttp(options);
    this.reflection = new ReflectionClient(options);
  }

  /** `https://<name>.int.exe.xyz`, or `.team.exe.xyz` for a team integration. */
  origin(name: string, options: { readonly team?: boolean } = {}): string {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(name)) {
      throw new ExeInvalidRequestError([{
        path: ["name"],
        message: "must be an integration name usable as a hostname label",
      }]);
    }
    const domain = options.team
      ? this.#options.teamDomain ?? TEAM_INTEGRATION_DOMAIN
      : this.#options.domain ?? INTEGRATION_DOMAIN;
    return `${this.#options.scheme ?? "https"}://${name}.${domain}`;
  }

  /** A URL on an integration's host; `path` must start with `/`. */
  url(
    name: string,
    path = "/",
    options: { readonly team?: boolean } = {},
  ): string {
    if (!path.startsWith("/")) {
      throw new ExeInvalidRequestError([{
        path: ["path"],
        message: "must start with /",
      }]);
    }
    return `${this.origin(name, options)}${path}`;
  }

  /**
   * Any integration as a plain proxy: HTTP proxy, VM-to-VM (peer), catalog
   * services. Returns the raw `Response`; nothing is retried or decoded.
   */
  fetch(
    name: string,
    path: string,
    init: RequestInit = {},
    options: { readonly team?: boolean } = {},
  ): Promise<Response> {
    return (this.#options.fetch ?? globalFetch)(
      this.url(name, path, options),
      init,
    );
  }

  // LLM.

  /** `GET /v1/models` on an LLM integration (default `llm`). */
  llmModels(
    name = "llm",
    options: { readonly team?: boolean } = {},
  ): Promise<JsonValue> {
    return this.http.json(this.url(name, "/v1/models", options));
  }

  /** `POST /v1/responses`: the OpenAI Responses API through the integration. */
  llmResponses(
    body: JsonObject,
    name = "llm",
    options: { readonly team?: boolean } = {},
  ): Promise<JsonValue> {
    return this.http.json(
      this.url(name, "/v1/responses", options),
      jsonInit("POST", body),
    );
  }

  /** `POST /v1/chat/completions`: OpenAI-compatible chat. */
  llmChatCompletions(
    body: JsonObject,
    name = "llm",
    options: { readonly team?: boolean } = {},
  ): Promise<JsonValue> {
    return this.http.json(
      this.url(name, "/v1/chat/completions", options),
      jsonInit("POST", body),
    );
  }

  /** `POST /v1/messages`: the Anthropic Messages API through the integration. */
  llmMessages(
    body: JsonObject,
    name = "llm",
    options: { readonly team?: boolean; readonly anthropicVersion?: string } =
      {},
  ): Promise<JsonValue> {
    return this.http.json(
      this.url(name, "/v1/messages", options),
      jsonInit("POST", body, {
        "anthropic-version": options.anthropicVersion ?? "2023-06-01",
      }),
    );
  }

  /**
   * A provider-specific base URL (`/openai/v1`, `/anthropic/v1`,
   * `/fireworks/inference/v1`, `/deepgram/v1`), for SDKs that take one.
   */
  llmProviderBase(
    provider: "openai" | "anthropic" | "fireworks" | "deepgram",
    name = "llm",
    options: { readonly team?: boolean } = {},
  ): string {
    const prefix = provider === "fireworks"
      ? "/fireworks/inference/v1"
      : `/${provider}/v1`;
    return this.url(name, prefix, options);
  }

  // GitHub.

  /**
   * The clone URL of a repository through the GitHub integration. The docs
   * use one aggregate host, `github.int.exe.xyz`, whatever the integration's
   * name; `gh` works with `GH_HOST` set to it.
   */
  githubCloneUrl(repository: string): string {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new ExeInvalidRequestError([{
        path: ["repository"],
        message: "must be owner/repo",
      }]);
    }
    return `${this.origin("github")}/${repository.replace(/\.git$/, "")}.git`;
  }

  /** The value for `GH_HOST`. */
  githubHost(): string {
    return new URL(this.origin("github")).host;
  }

  // Slack.

  /**
   * Posts an incoming-webhook payload (`text`, `blocks`, ...) through a Slack
   * integration. Slack answers `ok`; the integration allows 5 per minute.
   */
  async slackPost(name: string, payload: JsonObject): Promise<string> {
    return await this.http.text(this.url(name, "/"), jsonInit("POST", payload));
  }

  /**
   * Calls a Slack Web API method through a Slack bot integration
   * (`POST /api/<method>`). Slack reports failures as `{ok: false, error}` with
   * status 200; that is returned as is.
   */
  slackCall(
    name: string,
    method: string,
    payload?: JsonObject,
  ): Promise<JsonValue> {
    if (!/^[a-zA-Z]+(\.[a-zA-Z]+)+$/.test(method)) {
      throw new ExeInvalidRequestError([{
        path: ["method"],
        message: "must be a Slack method such as chat.postMessage",
      }]);
    }
    return this.http.json(
      this.url(name, `/api/${method}`),
      jsonInit("POST", payload),
    );
  }

  /** `apps.connections.open`: a single-use `wss://` URL for Socket Mode. */
  async slackSocketUrl(name: string): Promise<string> {
    const result = await this.slackCall(name, "apps.connections.open");
    if (isPlainObject(result) && result.ok === false) {
      throw new ExeApiError(
        "http",
        `Slack refused apps.connections.open: ${String(result.error)}`,
        {
          status: 200,
          body: result,
        },
      );
    }
    const url = stringField(result, "url", []);
    if (!url.startsWith("wss://")) {
      throw new ExeDecodeError([{
        path: ["url"],
        message: "expected a wss:// URL",
      }]);
    }
    return url;
  }

  /**
   * The integration URL for a private Slack file (`url_private`, under
   * `/files-pri/` or `/files-tmb/`): the host replaced, path and query kept.
   * Fetch it with redirects followed and no Authorization header.
   */
  slackFileUrl(name: string, slackUrl: string): string {
    const url = new URL(slackUrl);
    if (!/^\/files-(pri|tmb)\//.test(url.pathname)) {
      throw new ExeInvalidRequestError([{
        path: ["slackUrl"],
        message: "must be a /files-pri/ or /files-tmb/ URL",
      }]);
    }
    return `${this.origin(name)}${url.pathname}${url.search}`;
  }

  // Discord.

  /**
   * Executes a Discord webhook through a Discord integration. `username` and
   * `avatar_url` are refused (the integration rejects them), the JSON body is
   * at most 256 KiB, and `wait` returns the created message.
   */
  async discordPost(
    name: string,
    payload: JsonObject,
    options: { readonly wait?: boolean; readonly threadId?: string } = {},
  ): Promise<JsonValue | null> {
    const issues = [];
    for (const key of ["username", "avatar_url"]) {
      if (key in payload) {
        issues.push({
          path: [key],
          message: "is rejected by the Discord integration",
        });
      }
    }
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > 256 * 1024) {
      issues.push({ path: [], message: "the payload is over 256 KiB" });
    }
    if (issues.length > 0) throw new ExeInvalidRequestError(issues);
    const query = new URLSearchParams();
    if (options.wait) query.set("wait", "true");
    if (options.threadId !== undefined) {
      query.set("thread_id", options.threadId);
    }
    const suffix = query.size === 0 ? "" : `?${query}`;
    const result = await this.http.request(this.url(name, `/${suffix}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = utf8.decode(result.body);
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }

  /**
   * Calls the Discord Bot REST API through a Discord bot integration. `path`
   * includes the version prefix, e.g. `/api/v10/channels/123/messages`.
   */
  discordBot(
    name: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: JsonValue,
  ): Promise<HttpResult> {
    if (!path.startsWith("/api/")) {
      throw new ExeInvalidRequestError([{
        path: ["path"],
        message: "must start with /api/ (e.g. /api/v10/...)",
      }]);
    }
    return this.http.request(this.url(name, path), jsonInit(method, body));
  }

  // Token mint and registries.

  /**
   * Mints a short-lived access token from a token-mint integration: `POST`
   * with an empty body to the service's token path (`googlesa`, `twitch`,
   * `reddit-ads`, or a Keycloak realm via `path`). Re-mint when the vendor
   * answers 401 rather than tracking expiry.
   */
  async mintToken(
    name: string,
    service: keyof typeof TOKEN_MINT_PATHS | { readonly path: string },
    options: { readonly team?: boolean } = {},
  ): Promise<MintedToken> {
    const path = typeof service === "string"
      ? TOKEN_MINT_PATHS[service]
      : service.path;
    return decodeWith(
      MintedToken,
      await this.http.json(this.url(name, path, options), { method: "POST" }),
    );
  }

  /** The Keycloak client-credentials token path for `realm`. */
  static keycloakTokenPath(realm: string): { readonly path: string } {
    return {
      path: `/realms/${
        encodeURIComponent(realm)
      }/protocol/openid-connect/token`,
    };
  }

  /**
   * Mints a registry token through a container registry integration: `GET`
   * of the realm with `service` and one `scope` per entry (e.g.
   * `repository:org/repo:pull`). Use the token directly against the registry.
   */
  async registryToken(
    name: string,
    registry: keyof typeof REGISTRY_REALMS | {
      readonly realm: string;
      readonly service: string;
    },
    scopes: readonly string[],
    options: { readonly service?: string; readonly team?: boolean } = {},
  ): Promise<RegistryToken> {
    const realm = typeof registry === "string"
      ? REGISTRY_REALMS[registry]
      : registry.realm;
    const service = options.service ??
      (typeof registry === "string"
        ? REGISTRY_SERVICES[registry]
        : registry.service);
    const query = new URLSearchParams({ service });
    for (const scope of scopes) query.append("scope", scope);
    const raw = await this.http.json(
      this.url(name, `${realm}?${query}`, options),
    );
    const token = isPlainObject(raw) && typeof raw.token === "string"
      ? raw.token
      : stringField(raw, "access_token", []);
    return {
      token,
      ...(isPlainObject(raw) && typeof raw.expires_in === "number"
        ? { expires_in: raw.expires_in }
        : {}),
      ...(isPlainObject(raw) && typeof raw.issued_at === "string"
        ? { issued_at: raw.issued_at }
        : {}),
      raw: raw as JsonObject,
    };
  }

  /**
   * A Docker `config.json` that makes docker, crane and oras send `token` as
   * a bearer token to `registryHost` (the `registrytoken` field). It does not
   * refresh itself.
   */
  static dockerConfig(registryHost: string, token: string): JsonObject {
    return { auths: { [registryHost]: { registrytoken: token } } };
  }

  // Workload identity federation.

  /** `GET /token` on a WIF integration: a short-lived exe.dev OIDC token. */
  async wifToken(
    name: string,
    options: { readonly team?: boolean } = {},
  ): Promise<string> {
    return stringField(
      await this.http.json(this.url(name, "/token", options)),
      "token",
      [],
    );
  }

  /** `GET /metadata` on a WIF integration. */
  async wifMetadata(
    name: string,
    options: { readonly team?: boolean } = {},
  ): Promise<JsonObject> {
    const raw = await this.http.json(this.url(name, "/metadata", options));
    if (!isPlainObject(raw)) {
      throw new ExeDecodeError([{ path: [], message: "expected an object" }]);
    }
    return raw as JsonObject;
  }

  /**
   * What AWS SDKs need for `AssumeRoleWithWebIdentity`: the role ARN from
   * `/metadata` and a fresh token. Write the token to the file named by
   * `AWS_WEB_IDENTITY_TOKEN_FILE`, and refresh it before the SDK next calls
   * STS.
   */
  async awsWebIdentity(
    name: string,
    options: { readonly team?: boolean } = {},
  ): Promise<{ readonly roleArn: string; readonly token: string }> {
    const metadata = await this.wifMetadata(name, options);
    return {
      roleArn: stringField(metadata, "role_arn", []),
      token: await this.wifToken(name, options),
    };
  }

  /** The GCP identifiers from a GCP WIF integration's `/metadata`. */
  async gcpWifMetadata(
    name: string,
    options: { readonly team?: boolean } = {},
  ): Promise<GcpWifMetadata> {
    const raw = await this.wifMetadata(name, options);
    const text = (key: string) => {
      const value = raw[key];
      if (typeof value === "number") return String(value);
      return stringField(raw, key, []);
    };
    return {
      ...(typeof raw.project_id === "string"
        ? { project_id: raw.project_id }
        : {}),
      project_number: text("project_number"),
      pool_id: text("pool_id"),
      provider_id: text("provider_id"),
      service_account: text("service_account"),
      raw,
    };
  }

  /**
   * A Google `external_account` credential configuration, as
   * `gcloud iam workload-identity-pools create-cred-config` writes it, that
   * fetches fresh tokens from the integration's `/token`. Point
   * `GOOGLE_APPLICATION_CREDENTIALS` at it.
   */
  gcpCredentialConfig(
    name: string,
    metadata: GcpWifMetadata,
    options: { readonly team?: boolean } = {},
  ): JsonObject {
    const provider = gcpProviderResource(metadata);
    return {
      type: "external_account",
      audience: `//iam.googleapis.com/${provider}`,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url:
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${metadata.service_account}:generateAccessToken`,
      credential_source: {
        url: this.url(name, "/token", options),
        format: { type: "json", subject_token_field_name: "token" },
      },
    };
  }

  // Object storage.

  /** The URL of an object through an S3 integration (requests are signed at the edge). */
  objectUrl(
    name: string,
    key: string,
    options: { readonly team?: boolean } = {},
  ): string {
    if (key === "" || key.startsWith("/")) {
      throw new ExeInvalidRequestError([{
        path: ["key"],
        message: "must be a non-empty key without a leading /",
      }]);
    }
    return this.url(
      name,
      `/${key.split("/").map(encodeURIComponent).join("/")}`,
      options,
    );
  }

  // Email.

  /**
   * Sends a plain-text email through the VM's gateway. Answers
   * `{"success": true}`; a refusal (recipient not allowed, rate limit) is
   * thrown with the gateway's `error` message.
   */
  async sendEmail(message: OutgoingEmail): Promise<{ readonly success: true }> {
    const issues = [];
    for (const key of ["to", "subject", "body"] as const) {
      if (typeof message[key] !== "string" || message[key].trim() === "") {
        issues.push({ path: [key], message: "is required" });
      }
    }
    message.attachments?.forEach((attachment, index) => {
      if (attachment.filename.trim() === "") {
        issues.push({
          path: ["attachments", index, "filename"],
          message: "is required",
        });
      }
    });
    if (issues.length > 0) throw new ExeInvalidRequestError(issues);
    const body: JsonObject = {
      to: message.to,
      subject: message.subject,
      body: message.body,
    };
    if (message.reply_to !== undefined) body.reply_to = message.reply_to;
    if (message.in_reply_to !== undefined) {
      body.in_reply_to = message.in_reply_to;
    }
    if (message.references !== undefined) body.references = message.references;
    if (message.attachments !== undefined) {
      body.attachments = message.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: typeof attachment.content === "string"
          ? attachment.content
          : base64Encode(attachment.content),
        ...(attachment.content_type === undefined
          ? {}
          : { content_type: attachment.content_type }),
      }));
    }
    const result = await this.http.request(
      this.#options.emailUrl ?? EMAIL_SEND_URL,
      jsonInit("POST", body),
      { accept: () => true },
    );
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(utf8.decode(result.body)) as JsonValue;
    } catch {
      parsed = utf8.decode(result.body);
    }
    if (
      result.status >= 200 && result.status <= 299 && isPlainObject(parsed) &&
      parsed.success === true
    ) {
      return { success: true };
    }
    const detail = errorDetail(parsed) ?? `status ${result.status}`;
    throw new ExeApiError(
      result.status >= 200 && result.status <= 299
        ? "http"
        : httpKind(result.status),
      `the email gateway refused the message: ${detail}`,
      { status: result.status, body: parsed, detail },
    );
  }
}

/** `projects/<n>/locations/global/workloadIdentityPools/<pool>/providers/<id>`. */
export function gcpProviderResource(
  metadata: Pick<GcpWifMetadata, "project_number" | "pool_id" | "provider_id">,
): string {
  return `projects/${metadata.project_number}/locations/global/workloadIdentityPools/${metadata.pool_id}/providers/${metadata.provider_id}`;
}

/** The headers of a raw email, in order; folded lines are joined. */
export function parseEmailHeaders(
  raw: string | Uint8Array,
): { name: string; value: string }[] {
  const text = typeof raw === "string" ? raw : utf8.decode(raw);
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const out: { name: string; value: string }[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      out.push({
        name: line.slice(0, colon).trim(),
        value: line.slice(colon + 1).trim(),
      });
    }
  }
  return out;
}

/**
 * The envelope recipient of a delivered email: the `Delivered-To:` header
 * exe.dev injects as the first line. Use it, not `To:` or `Cc:`, to learn
 * which address the mail was sent to.
 */
export function deliveredTo(raw: string | Uint8Array): string | null {
  const first = parseEmailHeaders(raw)[0];
  return first !== undefined && first.name.toLowerCase() === "delivered-to"
    ? first.value
    : null;
}
