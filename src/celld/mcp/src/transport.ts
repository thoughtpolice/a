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

import { type FetchLike, globalFetch } from "@celld/http";
import { sseEvents } from "@celld/http/sse";
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
import { frame } from "./validate.ts";

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
   * `connection` when nothing came back, `stream` when the stream ended
   * without a response (the caller may re-issue the request with a new id),
   * `decode` for malformed messages, `aborted` when the signal fired.
   */
  request(
    message: JSONRPCRequest,
    options: TransportRequest,
  ): Promise<JSONRPCResponse>;
}

/** The request an {@link HttpAuthProvider} makes headers for. */
export interface AuthRequest {
  /** Always `POST` for this transport. */
  readonly method: string;
  /** The MCP endpoint. */
  readonly url: string;
}

/** A response from the MCP endpoint, for {@link HttpAuthProvider.observe}. */
export interface AuthResponse {
  /** The MCP endpoint. */
  readonly url: string;
  readonly headers: Headers;
}

/** A 401 or 403 from the MCP endpoint, for {@link HttpAuthProvider.challenge}. */
export interface AuthChallenge extends AuthRequest {
  readonly status: number;
  /** The response's headers: `WWW-Authenticate`, and `DPoP-Nonce` if any. */
  readonly headers: Headers;
  /** How many challenges this request has met so far, from 1. */
  readonly attempt: number;
  readonly signal: AbortSignal;
}

/**
 * Supplies credentials to the HTTP transport and reacts to challenges.
 * `OAuthSession` from `@celld/oauth/client` matches it as it is (its
 * `headers`, `challenge` and `observe`), so an MCP client authorizes with
 * `McpClient.http(url, { auth: session })`; so can anything else that
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
  readonly maxAuthAttempts?: number;
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
  const endpoint = String(url);
  const doFetch: FetchLike = options.fetch ?? globalFetch;
  const auth = options.auth;
  const maxAuth = options.maxAuthAttempts ?? 3;
  return {
    async request(message, { signal, headers, onNotification }) {
      const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
      const version = meta[META.protocolVersion];
      const payload = JSON.stringify(message);
      let response: Response;
      for (let attempt = 1;; attempt++) {
        const extra = typeof options.headers === "function"
          ? await options.headers()
          : options.headers ?? {};
        const credentials = auth === undefined
          ? {}
          : await auth.headers({ method: "POST", url: endpoint });
        const requestHeaders: Record<string, string> = {
          ...extra,
          ...credentials,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          [HEADER.method]: message.method,
          ...headers,
        };
        if (typeof version === "string") {
          requestHeaders[HEADER.protocolVersion] = version;
        }
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: requestHeaders,
            body: payload,
            signal,
          });
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          throw new McpError(
            "connection",
            `could not reach ${endpoint}: ${(error as Error).message ?? error}`,
            { cause: error, method: message.method },
          );
        }
        const status = response.status;
        if (status !== 401 && status !== 403) {
          auth?.observe?.({ url: endpoint, headers: response.headers });
          break;
        }
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
          });
        } catch (error) {
          if (signal.aborted) throw aborted(signal);
          throw refused(error);
        }
        if (!retry) throw refused();
      }
      const status = response.status;
      const type = (response.headers.get("content-type") ?? "").toLowerCase();

      if (type.startsWith("text/event-stream") && response.ok) {
        if (response.body === null) {
          throw new McpError("stream", "empty event stream", { status });
        }
        const events = sseEvents(response.body);
        try {
          for await (const event of events) {
            if (event.event !== "message") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data);
            } catch {
              throw new McpError("decode", "an event's data is not JSON", {
                status,
              });
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
          throw new McpError(
            "stream",
            `the event stream broke: ${(error as Error).message}`,
            { cause: error, status },
          );
        }
        if (signal.aborted) throw aborted(signal);
        throw new McpError(
          "stream",
          "the event stream ended without a response",
          { status },
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw aborted(signal);
        throw new McpError("stream", "the response body broke off", {
          cause: error,
          status,
        });
      }
      let body: unknown = undefined;
      if (type.startsWith("application/json") && text !== "") {
        try {
          body = JSON.parse(text);
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
  };
}

/**
 * Where an HTTP transport records the status of an error response, so the
 * client can report it; not part of the wire message.
 */
export const STATUS: unique symbol = Symbol("mcp.httpStatus");
