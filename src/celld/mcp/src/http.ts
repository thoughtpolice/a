// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Streamable HTTP transport, server side, as a `@celld/router` route.
 *
 * ```ts
 * const app = router({ auth: oauthSchemes(resource) });
 * protectedResourceRoutes(app, resource);
 * mcpRoutes(app, "/mcp", server);
 * export default { fetch: app.fetch };
 * ```
 *
 * or, for a Worker that serves nothing else,
 * `mcpHttpHandler(server, { path: "/mcp", resource })`, which is those
 * lines over a private router.
 *
 * One POST carries one JSON-RPC message. A notification gets `202`. A
 * request is answered with a single JSON response, unless the handler emits
 * a notification (progress or log, only sent when the request asked for
 * them) before it finishes: then the response becomes an SSE stream carrying
 * those notifications and the final response. `subscriptions/listen` is
 * always a stream. Closing the stream, or the client going away (`c.signal`),
 * cancels the request; there is no session, no GET stream and no
 * resumption, so GET and DELETE get the router's `405`.
 *
 * The router answers first: `413` for a declared `Content-Length` over the
 * limit, then authentication (`401` with every scheme's challenge, `400` or
 * `401` for a bad credential). Then, in the route: the `Origin` allowlist
 * (`403`), the content type (`415`), the body size (`413`) and encoding,
 * JSON (`400`, -32700), JSON-RPC framing (`400`, -32600), then for requests
 * the `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` headers and `_meta`
 * (`400`: -32020, -32602), the version (`400`, -32022), the method (`404`,
 * -32601), params (`400`, -32602), the tool's `Mcp-Param-*` headers (`400`,
 * -32020), and the tool's `scopes` (an `AuthError`, which the router turns
 * into `403 insufficient_scope` with the authenticating scheme's challenge).
 * Errors raised while running a request are JSON-RPC errors with status
 * `200`, except a missing client capability (`400`, -32021) as the spec
 * requires.
 *
 * @module
 */

import { SSE_KEEPALIVE, sseMessage } from "@celld/http/sse";
import type { ResourceServer } from "@celld/oauth/resource";
import { oauthSchemes, protectedResourceRoutes } from "@celld/oauth/router";
import {
  AuthError,
  type AuthScheme,
  type Context,
  type Duration,
  type Empty,
  HttpError,
  type Middleware,
  Router,
} from "@celld/router";
import { McpError } from "./errors.ts";
import {
  decodeHeaderValue,
  HEADER,
  NAME_SOURCE,
  paramHeaderMismatch,
} from "./headers.ts";
import { META } from "./meta.ts";
import type { McpServer, PreparedRequest, Principal } from "./server.ts";
import {
  HEADER_MISMATCH,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse,
  METHOD_NOT_FOUND,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  type RequestId,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./types.ts";
import { frame, parseJson } from "./validate.ts";

/** Which browser origins may call the endpoint. */
export type AllowedOrigins =
  | readonly string[]
  | ((origin: string, request: Request) => boolean);

/** Options for {@link mcpRoutes}. */
export interface McpRouteOptions {
  /**
   * Origins allowed to call the endpoint (DNS rebinding protection). A
   * request with an `Origin` header not allowed here gets `403`; requests
   * without one (non-browser clients) pass. Default: no browser origin.
   */
  readonly allowedOrigins?: AllowedOrigins;
  /** Largest accepted body; default 4 MiB. */
  readonly maxBodyBytes?: number;
  /** SSE keep-alive comment interval; default 15 s, 0 for none. */
  readonly keepAliveMs?: number;
  /**
   * Whether granted scopes satisfy a required one, for tools' `scopes`;
   * default exact membership. Supply it when broader scopes imply narrower
   * ones (the spec requires accounting for such hierarchies).
   */
  readonly scopeSatisfied?: (
    granted: readonly string[],
    required: string,
  ) => boolean;
  /**
   * The route's time budget until a response starts (seconds or an ISO
   * 8601 duration); `false`, the default, for none. When it runs out the
   * router answers `503` and the request's signal aborts. A stream, once
   * started, is never cut off.
   */
  readonly timeout?: Duration | false;
  /**
   * Serve callers without credentials too, on a router with auth schemes
   * (a sent credential is still checked). A tool with `scopes` still
   * refuses them. Default false.
   */
  readonly public?: boolean;
}

/** Options for {@link mcpHttpHandler}. */
export interface HttpHandlerOptions extends McpRouteOptions {
  /** The MCP endpoint path; other paths get `404`. Default: every path. */
  readonly path?: string;
  /**
   * How requests authenticate: router schemes, or `"none"`. Default
   * `oauthSchemes(resource)` with a `resource`, else `"none"`.
   */
  readonly auth?: AuthScheme | readonly AuthScheme[] | "none";
  /**
   * The OAuth resource server this endpoint is: its tokens are checked
   * (unless `auth` says otherwise), and its Protected Resource Metadata is
   * served at `/.well-known/oauth-protected-resource{path}` and at the
   * origin's `/.well-known/oauth-protected-resource`.
   */
  readonly resource?: ResourceServer;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(
  status: number,
  id: RequestId | null,
  error: McpError,
  headers: Record<string, string> = {},
): Response {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    error: error.toRpcError(),
  };
  if (id !== null) body.id = id;
  return jsonResponse(status, body, headers);
}

/** The HTTP status for a JSON-RPC error code. */
export function statusForCode(
  code: number,
  phase: "prepare" | "execute",
): number {
  switch (code) {
    case METHOD_NOT_FOUND:
      return 404;
    case HEADER_MISMATCH:
    case MISSING_REQUIRED_CLIENT_CAPABILITY:
    case UNSUPPORTED_PROTOCOL_VERSION:
      return 400;
    default:
      return phase === "prepare" ? 400 : 200;
  }
}

function originAllowed(
  allowed: AllowedOrigins | undefined,
  origin: string,
  request: Request,
): boolean {
  if (allowed === undefined) return false;
  return typeof allowed === "function"
    ? allowed(origin, request)
    : allowed.includes(origin);
}

/** The `403` for a browser origin that is not allowed, or null. */
function refuseOrigin(
  allowed: AllowedOrigins | undefined,
  request: Request,
): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null || originAllowed(allowed, origin, request)) return null;
  return errorResponse(
    403,
    null,
    McpError.invalidRequest(`Origin not allowed: ${origin}`),
  );
}

/**
 * Router middleware refusing (`403`, a JSON-RPC error body) a request whose
 * `Origin` is not allowed. {@link mcpRoutes} runs it on its route before
 * authentication, so a cross-origin request without credentials gets the
 * spec's `403` rather than a `401`. As router-wide middleware
 * (`app.use(mcpOriginCheck(allowed))`) it covers every path, but lets
 * requests under `/.well-known/` (Protected Resource Metadata) pass.
 */
export function mcpOriginCheck(
  allowedOrigins: AllowedOrigins | undefined,
): Middleware {
  return async (c, next) => {
    if (c.url.pathname.startsWith("/.well-known/")) return await next();
    return refuseOrigin(allowedOrigins, c.req) ?? await next();
  };
}

/** The route's own origin check, for every path. */
function originGuard(allowedOrigins: AllowedOrigins | undefined): Middleware {
  return async (c, next) => refuseOrigin(allowedOrigins, c.req) ?? await next();
}

/** Checks `Mcp-Method`, `Mcp-Name` and the presence of `MCP-Protocol-Version`. */
function checkStandardHeaders(request: Request, message: JSONRPCRequest): void {
  const method = request.headers.get(HEADER.method);
  if (method === null) throw McpError.headerMismatch("Mcp-Method is missing");
  if (method !== message.method) {
    throw McpError.headerMismatch(
      `Mcp-Method header value '${method}' does not match body value '${message.method}'`,
    );
  }
  if (request.headers.get(HEADER.protocolVersion) === null) {
    throw McpError.headerMismatch("MCP-Protocol-Version is missing");
  }
  const source = NAME_SOURCE[message.method];
  if (source === undefined) return;
  const raw = request.headers.get(HEADER.name);
  if (raw === null) throw McpError.headerMismatch("Mcp-Name is missing");
  const name = decodeHeaderValue(raw);
  if (name === null) {
    throw McpError.headerMismatch(
      "Mcp-Name has invalid characters or encoding",
    );
  }
  const body = message.params?.[source];
  if (typeof body === "string" && body !== name) {
    throw McpError.headerMismatch(
      `Mcp-Name header value '${name}' does not match body value '${body}'`,
    );
  }
}

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;

/**
 * Registers the Streamable HTTP endpoint for `server` on `app`: `POST path`,
 * with the body limit and time budget as route limits. It checks `Origin`
 * first (a route `before` hook), then the route needs a principal when
 * `app` has auth schemes (unless `public`); the router answers other
 * methods on `path` with `405` and `OPTIONS` with `204`. Returns `app`.
 */
export function mcpRoutes<E, S extends object, A extends boolean>(
  app: Router<E, S, A>,
  path: string,
  server: McpServer,
  options: McpRouteOptions = {},
): Router<E, S, A> {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const satisfied = options.scopeSatisfied ??
    ((granted: readonly string[], scope: string) => granted.includes(scope));
  const handler = (c: Context) =>
    handle(c, server, maxBody, satisfied, keepAliveMs);
  app.post(path, {
    before: [originGuard(options.allowedOrigins)],
    ...(options.public ? { public: true } : {}),
    limits: { body: maxBody, timeout: options.timeout ?? false },
    summary: "Model Context Protocol (Streamable HTTP)",
  }, handler);
  return app;
}

/**
 * The Streamable HTTP endpoint for `server`, as a `fetch` handler: a private
 * router with the auth (`oauthSchemes(resource)` by default when there is
 * a `resource`), the resource's metadata routes, and {@link mcpRoutes}.
 * The Worker's `env` and `ctx` are passed on.
 */
export function mcpHttpHandler(
  server: McpServer,
  options: HttpHandlerOptions = {},
): (
  request: Request,
  env?: unknown,
  ctx?: ExecutionContext,
) => Promise<Response> {
  const resource = options.resource;
  const auth = options.auth ??
    (resource === undefined ? "none" : oauthSchemes(resource));
  const app = new Router<unknown, Empty, boolean>({ auth });
  if (resource !== undefined) {
    protectedResourceRoutes(app, resource, { root: true });
  }
  mcpRoutes(app, options.path ?? "/*path", server, options);
  return (request, env, ctx) => app.fetch(request, env, ctx);
}

async function handle(
  c: Context,
  server: McpServer,
  maxBody: number,
  satisfied: (granted: readonly string[], scope: string) => boolean,
  keepAliveMs: number,
): Promise<Response> {
  const request = c.req;

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return errorResponse(
      415,
      null,
      McpError.invalidRequest("Content-Type must be application/json"),
    );
  }
  let text: string;
  try {
    text = await c.readText();
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 413) {
      return errorResponse(
        413,
        null,
        McpError.invalidRequest(`Body larger than ${maxBody} bytes`),
      );
    }
    if (error.status === 400) {
      return errorResponse(
        400,
        null,
        McpError.parseError("Parse error: the body is not UTF-8"),
      );
    }
    throw error;
  }

  let framed;
  try {
    framed = frame(parseJson(text));
  } catch (error) {
    if (error instanceof McpError) return errorResponse(400, null, error);
    throw error;
  }
  if (framed.type === "response") {
    return errorResponse(
      400,
      null,
      McpError.invalidRequest(
        "Invalid request: clients must not send responses",
      ),
    );
  }
  if (framed.type === "notification") {
    // No client notification has an effect on this transport: cancelling
    // is closing the stream.
    return new Response(null, { status: 202 });
  }

  const message = framed.message;
  let prepared: PreparedRequest;
  try {
    checkStandardHeaders(request, message);
    prepared = server.prepare(message, {
      afterMeta(meta) {
        const header = request.headers.get(HEADER.protocolVersion);
        if (header !== meta[META.protocolVersion]) {
          throw McpError.headerMismatch(
            `MCP-Protocol-Version header value '${header}' does not match body value '${
              meta[META.protocolVersion]
            }'`,
          );
        }
      },
      afterParams(prepared) {
        if (prepared.method !== "tools/call") return;
        const headers = server.paramHeadersOf(prepared.params.name as string);
        if (headers === null) return;
        const mismatch = paramHeaderMismatch(
          headers,
          prepared.params.arguments as Record<string, unknown> | undefined,
          (name) => request.headers.get(name),
        );
        if (mismatch !== null) throw McpError.headerMismatch(mismatch);
      },
    });
  } catch (error) {
    if (!(error instanceof McpError)) throw error;
    return errorResponse(
      statusForCode(error.code ?? 0, "prepare"),
      message.id,
      error,
    );
  }

  // Per-tool scopes, once the tool is known: all of them in one challenge,
  // which the router writes for the scheme that authenticated the request.
  const principal = c.principal as Principal | null;
  const required = server.requiredScopes(prepared);
  const granted = principal?.scopes ?? [];
  const missing = required.filter((scope) => !satisfied(granted, scope));
  if (missing.length > 0) {
    throw new AuthError(
      "insufficient_scope",
      `Missing scopes: ${missing.join(" ")}`,
      { scope: required },
    );
  }

  const canStream = c.accepts("text/event-stream") !== null;
  if (prepared.method === "subscriptions/listen" && !canStream) {
    return errorResponse(
      406,
      message.id,
      McpError.invalidRequest(
        "subscriptions/listen needs Accept: text/event-stream",
      ),
    );
  }
  return await run(
    server,
    prepared,
    c.signal,
    principal,
    canStream,
    keepAliveMs,
  );
}

async function run(
  server: McpServer,
  prepared: PreparedRequest,
  signal: AbortSignal,
  principal: Principal | null,
  canStream: boolean,
  keepAliveMs: number,
): Promise<Response> {
  // The route's signal aborts on the time budget and when the client goes
  // away; closing the stream aborts this one too.
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const pending: JSONRPCNotification[] = [];
  let open!: () => void;
  const opened = new Promise<"stream">((resolve) => {
    open = () => resolve("stream");
  });
  const write = (bytes: Uint8Array) => {
    if (closed || controller === null) return;
    try {
      controller.enqueue(bytes);
    } catch {
      closed = true;
    }
  };
  const emit = canStream
    ? (notification: JSONRPCNotification) => {
      if (controller !== null) write(sseMessage(notification));
      else {
        pending.push(notification);
        open();
      }
    }
    : undefined;

  const done = server.execute(prepared, {
    signal: abort.signal,
    principal,
    emit,
  });
  const first = await Promise.race([done, opened]);
  if (first !== "stream") {
    signal.removeEventListener("abort", onAbort);
    const response = first as JSONRPCResponse | null;
    if (response === null) return new Response(null, { status: 499 });
    const status = "error" in response
      ? statusForCode(response.error.code, "execute")
      : 200;
    return jsonResponse(status, response);
  }

  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    signal.removeEventListener("abort", onAbort);
    try {
      controller?.close();
    } catch {
      // Already closed or errored by the consumer.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const notification of pending) write(sseMessage(notification));
      pending.length = 0;
      if (keepAliveMs > 0) {
        keepAlive = setInterval(() => write(SSE_KEEPALIVE), keepAliveMs);
      }
    },
    cancel(reason) {
      closed = true;
      clearInterval(keepAlive);
      signal.removeEventListener("abort", onAbort);
      abort.abort(reason);
    },
  });
  done.then((response) => {
    if (response !== null) write(sseMessage(response));
    finish();
  }, (error) => {
    console.error("mcp: request failed after streaming began:", error);
    finish();
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
