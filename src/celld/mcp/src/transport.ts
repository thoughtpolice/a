// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The client's view of a transport, and the Streamable HTTP one.
 *
 * A transport sends one request and reports what comes back on that
 * request's own stream: notifications as they arrive, then the response.
 * There is nothing else to manage, since the protocol has no sessions.
 *
 * @module
 */

import {
  BoundsError,
  parseJsonBounded,
  readTextBounded,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import { type FetchLike, globalFetch } from "@celld/http";
import { sseEvents } from "@celld/http/sse";
import { isLoopbackLiteral } from "@celld/web/router";
import { McpError } from "./errors.ts";
import { HEADER } from "./headers.ts";
import { isPlainObject } from "./json.ts";
import { META } from "./meta.ts";
import type {
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONValue,
} from "./types.ts";
import { frame, MESSAGE_JSON_LIMITS } from "./validate.ts";

export type { FetchLike };

/** Per-request transport options. */
export interface TransportRequest {
  /** Aborting closes the stream, which cancels the request on the server. */
  readonly signal: AbortSignal;
  /** Extra headers: `Mcp-Name` and `Mcp-Param-*`. Transports without headers ignore them. */
  readonly headers: Readonly<Record<string, string>>;
  /** Receives each notification on the request's stream, in order. */
  readonly onNotification: (notification: JSONRPCNotification) => void;
}

/** Carries requests to a server. */
export interface Transport {
  /**
   * Sends `message` and resolves to its response. Throws an McpError: `http`
   * or `unauthorized` for HTTP failures without a JSON-RPC body,
   * `connection` when nothing came back, `stream` (with `accepted: true`)
   * when the response began but ended without the final answer, so the
   * server may have acted on the request,
   * `decode` for malformed messages, `aborted` when the signal fired.
   */
  request(
    message: JSONRPCRequest,
    options: TransportRequest,
  ): Promise<JSONRPCResponse>;
  /**
   * The server this transport reaches (the HTTP endpoint URL), if it has
   * one. `McpClient` keeps cached results per endpoint.
   */
  readonly endpoint?: string;
}

/** The request an {@link HttpAuthProvider} makes headers for. */
export interface AuthRequest {
  /** Always `POST` for this transport. */
  readonly method: string;
  /** The MCP endpoint. */
  readonly url: string;
  readonly signal?: AbortSignal;
}

/** A response from the MCP endpoint, for {@link HttpAuthProvider.observe}. */
export interface AuthResponse {
  /** Exact object returned by headers for this request; opaque to the transport. */
  readonly authContext: object;
  /** The MCP endpoint. */
  readonly url: string;
  readonly headers: Headers;
}

/** A 401 or 403 from the MCP endpoint, for {@link HttpAuthProvider.challenge}. */
export interface AuthChallenge extends AuthRequest {
  readonly authContext: object;
  readonly status: number;
  /** The response's headers: `WWW-Authenticate`, and `DPoP-Nonce` if any. */
  readonly headers: Headers;
  /** How many challenges this request has met so far, from 1. */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

/**
 * Supplies credentials to the HTTP transport and reacts to challenges.
 * `OAuthSession` from `@celld/sec/oauth/client` provides one with
 * `session.httpAuth()` (its resource-bound headers, `challenge` and
 * `observe`), so an MCP client authorizes with
 * `McpClient.http(url, { auth: session.httpAuth() })`; so can anything else that
 * authenticates HTTP requests (a platform's own tokens, say), with no
 * dependency on this library beyond this interface.
 */
export interface HttpAuthProvider {
  /** Headers for a request, such as `Authorization` (and a `DPoP` proof). */
  headers(
    request: AuthRequest,
  ): Record<string, string> | Promise<Record<string, string>>;
  /**
   * Handles a 401 or 403. Resolve true once new credentials are ready and
   * the request should be sent again, false to give up (the request fails
   * as `unauthorized`). A rejection fails the request as `unauthorized` with
   * the error as its cause.
   */
  challenge(challenge: AuthChallenge): Promise<boolean>;
  /**
   * Sees every other response's headers, successes included (a resource
   * may rotate its `DPoP-Nonce` on any of them). Optional.
   */
  observe?(response: AuthResponse): unknown;
}

/** Options for {@link httpTransport}. */
export interface HttpTransportOptions {
  /** The fetch to use; default the global one, called late. */
  readonly fetch?: FetchLike;
  /**
   * Headers for every request, such as `Authorization`, or a function that
   * produces them per request (to refresh tokens).
   */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Credentials and challenge handling; its headers override `headers`.
   * A request is re-sent after each challenge it accepts, at most
   * `maxAuthAttempts` (default 3) times.
   */
  readonly auth?: HttpAuthProvider;
  /** Re-sends after accepted challenges, 0 to 10; default 3. */
  readonly maxAuthAttempts?: number;
  /**
   * Also allow `http:` to a loopback IP literal (`http://127.0.0.1:8787`),
   * for a server on this machine during development; never a name such as
   * `localhost`. Default false: the endpoint must be https.
   */
  readonly allowLoopbackForDevelopment?: boolean;
  /**
   * The largest JSON answer, and the largest single event of an SSE
   * answer, read from the server, 1 KiB to 256 MiB; default 4 MiB. Either
   * is a `decode` McpError past it, and each is parsed with the depth and
   * width limits of `MESSAGE_JSON_LIMITS`.
   */
  readonly maxResponseBytes?: number;
  /**
   * The most bytes one SSE answer (a long tool call's progress, a listen
   * stream) may carry in all, 1 KiB to 1 GiB; default 64 MiB. Past it the
   * stream is cancelled and the request fails as `stream` (the server
   * accepted it); a listen stream is then reopened by its caller.
   */
  readonly maxStreamBytes?: number;
}

/** An SSE answer passed `maxStreamBytes`. */
class StreamCapError extends Error {
  override name = "StreamCapError";
}

/**
 * `body` passing through at most `max` bytes: one more errors the stream
 * (and cancels the source).
 */
function capped(
  body: ReadableStream<Uint8Array>,
  max: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) {
          controller.error(
            new StreamCapError(
              `the event stream carried more than ${max} bytes`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The endpoint as a URL the transport may send credentials to: https (or
 * http to a loopback IP literal with `allowLoopbackForDevelopment`), with
 * no user information or fragment. Throws `TypeError` otherwise, before
 * anything is sent.
 */
function checkEndpoint(url: string | URL, loopback: boolean): string {
  if (typeof url !== "string" && !(url instanceof URL)) {
    throw new TypeError("the MCP endpoint must be a URL or string");
  }
  const text = String(url);
  // deno-lint-ignore no-control-regex -- reject URL parser stripping controls
  if (text.length > 8192 || /[\x00-\x20\x7f\\]/.test(text)) {
    throw new TypeError(
      "the MCP endpoint is too long or contains unsafe characters",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError("the MCP endpoint is not an absolute URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("the MCP endpoint must not carry user information");
  }
  if (text.includes("#")) {
    throw new TypeError("the MCP endpoint must not have a fragment");
  }
  if (parsed.protocol === "https:") return parsed.href;
  if (
    parsed.protocol === "http:" && loopback &&
    isLoopbackLiteral(parsed.hostname)
  ) {
    return parsed.href;
  }
  throw new TypeError(
    "the MCP endpoint must use https (http only to a loopback IP literal, with allowLoopbackForDevelopment)",
  );
}

/** Header data is bounded and copied without invoking accessors or coercions. */
function headerSnapshot(
  value: unknown,
  name: string,
): Readonly<Record<string, string>> {
  const keys = value !== null && typeof value === "object"
    ? Object.keys(value)
    : [];
  if (keys.length > 128) throw new TypeError(`${name} has too many headers`);
  strictRecord(value, keys, name);
  const result: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  let total = 0;
  for (const key of keys) {
    const item = value[key];
    const lower = key.toLowerCase();
    if (
      key.length > 256 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) ||
      typeof item !== "string" || item.length > 16384 ||
      // deno-lint-ignore no-control-regex -- HTTP field values admit HTAB only
      /[^\x09\x20-\x7e\x80-\xff]/.test(item) || seen.has(lower)
    ) {
      throw new TypeError(`${name} contains an invalid or duplicate header`);
    }
    total += key.length + item.length;
    if (total > 65536) throw new TypeError(`${name} is too large`);
    seen.add(lower);
    result[lower] = item;
  }
  return Object.freeze(result);
}

/**
 * Bind capability methods once, preserving class/private state, but never
 * execute an accessor to discover a method. Replacing a provider's public
 * method after construction must not change this transport's policy.
 */
function authSnapshot(
  value: HttpAuthProvider | undefined,
): HttpAuthProvider | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new TypeError("auth must be an HTTP auth provider");
  }
  const method = (key: keyof HttpAuthProvider, optional = false) => {
    let owner: object | null = value;
    for (let depth = 0; owner !== null && depth < 16; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor)) {
          throw new TypeError(`auth.${key} must be a method, not an accessor`);
        }
        if (optional && descriptor.value === undefined) return undefined;
        if (typeof descriptor.value !== "function") {
          throw new TypeError(`auth.${key} must be a function`);
        }
        return descriptor.value.bind(value);
      }
      owner = Object.getPrototypeOf(owner);
    }
    if (optional && owner === null) return undefined;
    throw new TypeError(`auth.${key} must be a function`);
  };
  return Object.freeze({
    headers: method("headers"),
    challenge: method("challenge"),
    observe: method("observe", true),
  });
}

/** An error's plain-data form (`toJSON`), if it has one, for `McpError.data`. */
function plainData(error: unknown): JSONValue | null {
  if (typeof (error as { toJSON?: unknown })?.toJSON !== "function") {
    return null;
  }
  try {
    const data = JSON.parse(JSON.stringify(error));
    return isPlainObject(data) ? data as JSONValue : null;
  } catch {
    return null;
  }
}

function aborted(signal: AbortSignal): McpError {
  return new McpError("aborted", "the request was aborted", {
    cause: signal.reason,
  });
}

/** Parses one message from the server, which must not be a request. */
function serverMessage(
  value: unknown,
): JSONRPCNotification | JSONRPCResponse {
  let framed;
  try {
    framed = frame(value);
  } catch (error) {
    throw new McpError(
      "decode",
      `malformed message from server: ${(error as Error).message}`,
    );
  }
  if (framed.type === "request") {
    throw new McpError(
      "decode",
      "the server sent a JSON-RPC request, which this revision forbids",
    );
  }
  return framed.message;
}

/** The Streamable HTTP transport, over one MCP endpoint URL. */
export function httpTransport(
  url: string | URL,
  options: HttpTransportOptions = {},
): Transport {
  strictRecord(options as unknown, [
    "fetch",
    "headers",
    "auth",
    "maxAuthAttempts",
    "allowLoopbackForDevelopment",
    "maxResponseBytes",
    "maxStreamBytes",
  ], "HTTP transport options");
  if (
    options.allowLoopbackForDevelopment !== undefined &&
    typeof options.allowLoopbackForDevelopment !== "boolean"
  ) throw new TypeError("allowLoopbackForDevelopment must be a boolean");
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new TypeError("fetch must be a function");
  }
  for (
    const key of [
      "maxAuthAttempts",
      "maxResponseBytes",
      "maxStreamBytes",
    ] as const
  ) {
    if (options[key] !== undefined && typeof options[key] !== "number") {
      throw new TypeError(`${key} must be a number`);
    }
  }
  const endpoint = checkEndpoint(
    url,
    options.allowLoopbackForDevelopment === true,
  );
  const doFetch: FetchLike = options.fetch ?? globalFetch;
  const maxResponseBytes = safeInt(
    options.maxResponseBytes ?? 4 * 1024 * 1024,
    {
      name: "maxResponseBytes",
      min: 1024,
      max: 256 * 1024 * 1024,
    },
  );
  const maxStreamBytes = safeInt(options.maxStreamBytes ?? 64 * 1024 * 1024, {
    name: "maxStreamBytes",
    min: 1024,
    max: 1024 * 1024 * 1024,
  });
  const auth = authSnapshot(options.auth);
  const maxAuth = safeInt(options.maxAuthAttempts ?? 3, {
    name: "maxAuthAttempts",
    min: 0,
    max: 10,
  });
  // Capture the callback too: subsequent options mutation cannot redirect
  // how credentials are obtained. Its returned data is checked per request.
  const extraHeaders = options.headers;
  const fixedHeaders = typeof extraHeaders === "function"
    ? null
    : headerSnapshot(extraHeaders === undefined ? {} : extraHeaders, "headers");
  return Object.freeze<Transport>({
    endpoint,
    async request(message, { signal, headers, onNotification }) {
      if (signal.aborted) throw aborted(signal);
      const perRequestHeaders = headerSnapshot(headers, "request headers");
      const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
      const version = meta[META.protocolVersion];
      const payload = JSON.stringify(message);
      let response: Response;
      for (let attempt = 1;; attempt++) {
        if (signal.aborted) throw aborted(signal);
        const extra = fixedHeaders ?? headerSnapshot(
          await (extraHeaders as () =>
            | Record<string, string>
            | Promise<Record<string, string>>)(),
          "dynamic headers",
        );
        if (signal.aborted) throw aborted(signal);
        const credentials = auth === undefined
          ? {}
          : await auth.headers({ method: "POST", url: endpoint, signal });
        if (signal.aborted) throw aborted(signal);
        const credentialHeaders = headerSnapshot(credentials, "auth headers");
        // Headers are case-insensitive. Object spread could both duplicate
        // Authorization and let per-call values replace the token described
        // by authContext. The provider owns its credential names.
        const requestHeaders = new Headers(extra);
        for (const [name, value] of Object.entries(perRequestHeaders)) {
          requestHeaders.set(name, value);
        }
        for (const [name, value] of Object.entries(credentialHeaders)) {
          requestHeaders.set(name, value);
        }
        requestHeaders.set("content-type", "application/json");
        requestHeaders.set("accept", "application/json, text/event-stream");
        requestHeaders.set(HEADER.method, message.method);
        if (typeof version === "string") {
          requestHeaders.set(HEADER.protocolVersion, version);
        }
        try {
          // Never re-send the body (and its credentials) to a redirect
          // target: Streamable HTTP has no redirects.
          response = await doFetch(endpoint, {
            method: "POST",
            headers: requestHeaders,
            body: payload,
            signal,
            redirect: "error",
          });
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          throw new McpError(
            "connection",
            `could not reach ${endpoint}: ${(error as Error).message ?? error}`,
            { cause: error, method: message.method },
          );
        }
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw aborted(signal);
        }
        const status = response.status;
        if (status !== 401 && status !== 403) {
          try {
            auth?.observe?.({
              url: endpoint,
              headers: response.headers,
              authContext: credentials,
            });
          } catch (error) {
            await response.body?.cancel().catch(() => {});
            throw error;
          }
          break;
        }
        // Sending the same request again after a 401 or 403 is safe only
        // because such an answer is a refusal made before anything ran:
        // the route authenticates first, and `McpServer.execute` rejects
        // only with its own up-front scope refusal (`isScopeRefusal`),
        // never with an `unauthorized` error a handler threw.
        await response.body?.cancel();
        const wwwAuthenticate = response.headers.get("www-authenticate");
        const refused = (cause?: unknown) =>
          new McpError(
            "unauthorized",
            cause === undefined
              ? `the server refused the credentials (${status})`
              : `authorization failed (${status}): ${
                (cause as Error)?.message ?? cause
              }`,
            {
              status,
              method: message.method,
              wwwAuthenticate,
              cause,
              data: plainData(cause),
            },
          );
        if (auth === undefined || attempt > maxAuth) throw refused();
        let retry: boolean;
        try {
          retry = await auth.challenge({
            method: "POST",
            url: endpoint,
            status,
            headers: response.headers,
            attempt,
            signal,
            authContext: credentials,
          });
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          throw refused(error);
        }
        if (retry !== true) throw refused();
      }
      const status = response.status;
      const type = (response.headers.get("content-type") ?? "").toLowerCase();

      if (type.startsWith("text/event-stream") && response.ok) {
        if (response.body === null) {
          throw new McpError("stream", "empty event stream", {
            status,
            accepted: true,
          });
        }
        const events = sseEvents(capped(response.body, maxStreamBytes), {
          maxEventLength: maxResponseBytes,
        });
        try {
          for await (const event of events) {
            if (event.event !== "message") continue;
            let parsed: unknown;
            try {
              parsed = parseJsonBounded(event.data, MESSAGE_JSON_LIMITS);
            } catch (cause) {
              throw new McpError(
                "decode",
                cause instanceof BoundsError && cause.code !== "syntax"
                  ? `an event's data is too large or deep: ${cause.message}`
                  : "an event's data is not JSON",
                { status, cause },
              );
            }
            const item = serverMessage(parsed);
            if ("method" in item) {
              onNotification(item);
              continue;
            }
            if (item.id !== message.id) {
              throw new McpError(
                "decode",
                `a response for id ${
                  JSON.stringify(item.id ?? null)
                } arrived on the stream of ${JSON.stringify(message.id)}`,
                { status },
              );
            }
            // The response ends the stream's use: leaving the generator
            // cancels the body, which releases the connection. The server
            // closes the stream after the response, so nothing is lost.
            await events.return(undefined);
            return item;
          }
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          if (error instanceof McpError) throw error;
          if (error instanceof BoundsError && error.code === "too_large") {
            throw new McpError(
              "decode",
              `an event is larger than ${maxResponseBytes} characters`,
              { cause: error, status },
            );
          }
          throw new McpError(
            "stream",
            `the event stream broke: ${(error as Error).message}`,
            { cause: error, status, accepted: true },
          );
        }
        if (signal.aborted) throw aborted(signal);
        throw new McpError(
          "stream",
          "the event stream ended without a response",
          { status, accepted: true },
        );
      }

      let text: string;
      try {
        text = await readTextBounded(response, {
          maxBytes: maxResponseBytes,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw aborted(signal);
        if (error instanceof BoundsError && error.code === "too_large") {
          throw new McpError(
            "decode",
            `the response is larger than ${maxResponseBytes} bytes`,
            { cause: error, status, method: message.method },
          );
        }
        throw new McpError("stream", "the response body broke off", {
          cause: error,
          status,
          accepted: true,
        });
      }
      let body: unknown = undefined;
      if (type.startsWith("application/json") && text !== "") {
        try {
          body = parseJsonBounded(text, MESSAGE_JSON_LIMITS);
        } catch {
          body = undefined;
        }
      }
      const isRpc = isPlainObject(body) && body.jsonrpc === "2.0" &&
        ("result" in body || "error" in body);
      if (!isRpc) {
        if (response.ok) {
          throw new McpError(
            "decode",
            `expected a JSON-RPC response, got ${status} ${
              type || "(no content type)"
            }`,
            { status, method: message.method },
          );
        }
        throw new McpError("http", `the server returned ${status}`, {
          status,
          method: message.method,
          data: text === "" ? null : text.slice(0, 4096) as JSONValue,
        });
      }
      const item = serverMessage(body);
      if ("method" in item) {
        throw new McpError("decode", "expected a response, got a notification");
      }
      if (item.id !== undefined && item.id !== message.id) {
        throw new McpError(
          "decode",
          "the response id does not match the request",
          {
            status,
          },
        );
      }
      if ("error" in item) {
        // Errors without an id (a malformed request) still belong to this POST.
        return { ...item, id: message.id, [STATUS]: status } as JSONRPCResponse;
      }
      return item;
    },
  });
}

/**
 * Where an HTTP transport records the status of an error response, so the
 * client can report it; not part of the wire message.
 */
export const STATUS: unique symbol = Symbol("mcp.httpStatus");
