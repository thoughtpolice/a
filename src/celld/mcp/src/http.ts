// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Streamable HTTP transport, server side, as a `@celld/web/router` route.
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
 * lines over a private router. Its options must say how requests
 * authenticate: `{ resource }`, `{ auth }`, or `{ public: true }` for an
 * endpoint anyone may call; there is no default.
 *
 * One POST carries one JSON-RPC message. A notification gets `202`. A
 * request is answered with a single JSON response, unless the handler emits
 * a notification (progress or log, only sent when the request asked for
 * them) before it finishes: then the response becomes an SSE stream carrying
 * those notifications and the final response. `subscriptions/listen` is
 * always a stream. Closing the stream, or the client going away (`c.signal`),
 * cancels the request at once (`499`, or the stream ends), without waiting
 * for a handler that ignores its signal; there is no session, no GET stream
 * and no resumption, so GET and DELETE get the router's `405`.
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
 * Follow-ups (`tasks/get`, `tasks/update`, `tasks/cancel`, a listen stream
 * naming tasks, a later round of a multi round-trip request) are refused
 * the same way when the caller no longer holds the scopes stored with the
 * task or sealed state; the server finds those in the stored record.
 * Errors raised while running a request are JSON-RPC errors with status
 * `200`, except a missing client capability (`400`, -32021) as the spec
 * requires.
 *
 * @module
 */

import { nonNegativeMs, safeInt } from "@celld/core/bounds";
import { SSE_KEEPALIVE, sseMessage } from "@celld/http/sse";
import type { ResourceServer } from "@celld/sec/oauth/resource";
import { oauthSchemes, protectedResourceRoutes } from "@celld/sec/oauth/router";
import {
  AuthError,
  type AuthScheme,
  type Context,
  type Duration,
  type Empty,
  HttpError,
  type Middleware,
  Router,
  type RouterOptions,
} from "@celld/web/router";
import { McpError } from "./errors.ts";
import {
  decodeHeaderValue,
  HEADER,
  NAME_SOURCE,
  paramHeaderMismatch,
} from "./headers.ts";
import { META } from "./meta.ts";
import {
  isScopeRefusal,
  type McpServer,
  type PreparedRequest,
  type Principal,
} from "./server.ts";
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
   * A list is copied when the route is registered.
   */
  readonly allowedOrigins?: AllowedOrigins;
  /** Largest accepted body; default 4 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * SSE keep-alive comment interval, 0 (none) to 300 000 ms; default 15 s.
   * Anything else is a `RangeError` when the route is registered.
   */
  readonly keepAliveMs?: number;
  /**
   * The most bytes an SSE response may have queued for a reader that is
   * not reading, 64 KiB to 64 MiB; default 1 MiB. Past it the stream is
   * closed and the request's work aborted (a listen stream ends; the
   * client reconnects), rather than buffered without bound.
   */
  readonly maxBufferedBytes?: number;
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
   * router answers `504` (the outcome is unknown) and the request's signal
   * aborts. A stream, once started, is never cut off.
   */
  readonly timeout?: Duration | false;
  /**
   * Serve callers without credentials too, on a router with auth schemes
   * (a sent credential is still checked). A tool with `scopes` still
   * refuses them. Default false.
   */
  readonly public?: boolean;
}

/** The options of {@link mcpHttpHandler} other than its access choice. */
export interface HttpHandlerBaseOptions
  extends Omit<McpRouteOptions, "public"> {
  /** The MCP endpoint path; other paths get `404`. Default: every path. */
  readonly path?: string;
  /**
   * Options for the handler's private router, other than `auth` (which
   * the access choice sets). Behind a TLS-terminating proxy, give it the
   * public URL (`{ publicUrl: { mode: "fixed", origin } }`, or a trusted
   * proxy with a named peer source): the router refuses credentials over
   * plain http and checks DPoP proofs against that URL. A `timeout` over
   * five minutes also needs `limits.maxTimeout` here.
   */
  readonly router?: Omit<RouterOptions, "auth">;
}

/**
 * How the endpoint of {@link mcpHttpHandler} authenticates. There is no
 * default: leaving it out is a type error and throws.
 *
 * - `{ resource, auth? }`: an OAuth resource server. Its tokens are checked
 *   (through `oauthSchemes(resource)`, unless `auth` gives other schemes),
 *   and its Protected Resource Metadata is served at
 *   `/.well-known/oauth-protected-resource{path}` and at the origin's
 *   `/.well-known/oauth-protected-resource`.
 * - `{ auth }`: one or more router schemes.
 * - `{ public: true }`: no authentication at all; anyone who can reach the
 *   endpoint may call every tool without `scopes`. Callers own nothing: a
 *   task they start is reachable only with the token its creation result
 *   carries (`_meta["celld/task-token"]`).
 *
 * With `resource` or `auth`, `public: true` makes credentials optional (a
 * sent credential is still checked, and tools with `scopes` still refuse
 * anonymous callers).
 */
export type HttpHandlerAccess =
  | {
    readonly resource: ResourceServer;
    readonly auth?: AuthScheme | readonly AuthScheme[];
    readonly public?: boolean;
  }
  | {
    readonly resource?: undefined;
    readonly auth: AuthScheme | readonly AuthScheme[];
    readonly public?: boolean;
  }
  | {
    readonly resource?: undefined;
    readonly auth?: undefined;
    readonly public: true;
  };

/** Options for {@link mcpHttpHandler}: the base options and an access choice. */
export type HttpHandlerOptions = HttpHandlerBaseOptions & HttpHandlerAccess;

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

/**
 * `allowed` as the route keeps it: a list copied and frozen (so pushing an
 * origin onto the caller's list afterwards allows nothing), a predicate as
 * given. Throws `TypeError` for a list holding anything but strings.
 */
function copyOrigins(
  allowed: AllowedOrigins | undefined,
): AllowedOrigins | undefined {
  if (allowed === undefined || typeof allowed === "function") return allowed;
  if (
    !Array.isArray(allowed) ||
    !allowed.every((origin) => typeof origin === "string")
  ) {
    throw new TypeError(
      "allowedOrigins must be a list of origins or a function",
    );
  }
  return Object.freeze([...allowed]);
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
  input: AllowedOrigins | undefined,
): Middleware {
  const allowedOrigins = copyOrigins(input);
  return async (c, next) => {
    if (c.url.pathname.startsWith("/.well-known/")) return await next();
    return refuseOrigin(allowedOrigins, c.req) ?? await next();
  };
}

/** The route's own origin check, for every path. */
function originGuard(input: AllowedOrigins | undefined): Middleware {
  const allowedOrigins = copyOrigins(input);
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

/** How an SSE response is paced and bounded. */
interface StreamLimits {
  readonly keepAliveMs: number;
  readonly maxBufferedBytes: number;
}

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
  const stream: StreamLimits = {
    keepAliveMs: nonNegativeMs(options.keepAliveMs ?? 15_000, {
      name: "keepAliveMs",
      max: 300_000,
    }),
    maxBufferedBytes: safeInt(options.maxBufferedBytes ?? 1024 * 1024, {
      name: "maxBufferedBytes",
      min: 64 * 1024,
      max: 64 * 1024 * 1024,
    }),
  };
  const satisfied = (granted: readonly string[], scope: string): boolean => {
    const value = options.scopeSatisfied === undefined
      ? granted.includes(scope)
      : options.scopeSatisfied(granted, scope);
    if (typeof value !== "boolean") {
      throw new TypeError("scopeSatisfied must return boolean");
    }
    return value;
  };
  const handler = (c: Context) => handle(c, server, maxBody, satisfied, stream);
  app.post(path, {
    before: [originGuard(options.allowedOrigins)],
    ...(options.public ? { public: true } : {}),
    limits: { body: maxBody, timeout: options.timeout ?? false },
    summary: "Model Context Protocol (Streamable HTTP)",
  }, handler);
  return app;
}

const ACCESS_CHOICES =
  "mcpHttpHandler needs { resource }, { auth } (router schemes) or { public: true }";

/**
 * The router auth and route access for {@link HttpHandlerAccess}, refusing
 * anything but an explicit choice.
 */
function resolveAccess(
  options: HttpHandlerOptions | undefined,
): { auth: AuthScheme | readonly AuthScheme[] | "none"; public: boolean } {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${ACCESS_CHOICES}, got ${options}`);
  }
  const { resource, auth } = options as {
    resource?: ResourceServer;
    auth?: unknown;
  };
  if (auth === "none") {
    throw new TypeError(
      `${ACCESS_CHOICES}: auth "none" is spelled { public: true }`,
    );
  }
  if (Array.isArray(auth) && auth.length === 0) {
    throw new TypeError(
      `${ACCESS_CHOICES}: auth lists no schemes; to serve without authentication pass { public: true }`,
    );
  }
  const optional = options.public === true;
  if (resource !== undefined) {
    return {
      auth: (auth as AuthScheme | readonly AuthScheme[] | undefined) ??
        oauthSchemes(resource),
      public: optional,
    };
  }
  if (auth !== undefined) {
    return {
      auth: auth as AuthScheme | readonly AuthScheme[],
      public: optional,
    };
  }
  if (optional) return { auth: "none", public: true };
  throw new TypeError(`${ACCESS_CHOICES}; none was given`);
}

/**
 * The Streamable HTTP endpoint for `server`, as a `fetch` handler: a private
 * router with the access `options` choose (see {@link HttpHandlerAccess}),
 * the resource's metadata routes, and {@link mcpRoutes}. The Worker's `env`
 * and `ctx` are passed on.
 *
 * @throws {TypeError} when `options` make no access choice.
 */
export function mcpHttpHandler(
  server: McpServer,
  options: HttpHandlerOptions,
): (
  request: Request,
  env?: unknown,
  ctx?: ExecutionContext,
) => Promise<Response> {
  const access = resolveAccess(options);
  const app = new Router<unknown, Empty, boolean>({
    ...options.router,
    auth: access.auth,
  });
  if (options.resource !== undefined) {
    protectedResourceRoutes(app, options.resource, { root: true });
  }
  mcpRoutes(app, options.path ?? "/*path", server, {
    ...options,
    public: access.public,
  });
  return (request, env, ctx) => app.fetch(request, env, ctx);
}

async function handle(
  c: Context,
  server: McpServer,
  maxBody: number,
  satisfied: (granted: readonly string[], scope: string) => boolean,
  stream: StreamLimits,
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
    stream,
    satisfied,
    (promise) => c.ctx.waitUntil(promise),
  );
}

/**
 * The router's form of the server's scope refusal (see
 * `McpServer.execute`), so a follow-up lacking the stored scopes gets the
 * same `403 insufficient_scope` challenge as a `tools/call` would.
 */
function asAuthError(error: unknown): unknown {
  if (!isScopeRefusal(error)) return error;
  const data = error.data as { scope?: unknown } | null;
  const scope = Array.isArray(data?.scope) ? data.scope as string[] : [];
  return new AuthError("insufficient_scope", error.message, { scope });
}

async function run(
  server: McpServer,
  prepared: PreparedRequest,
  signal: AbortSignal,
  principal: Principal | null,
  canStream: boolean,
  stream: StreamLimits,
  satisfied: (granted: readonly string[], scope: string) => boolean,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  // The route's signal aborts on the time budget and when the client goes
  // away; closing the stream aborts this one too.
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let finish = () => {};
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
      return;
    }
    // A reader that stopped reading: close the stream (what is queued is
    // kept, nothing more is) and stop the work, instead of queueing every
    // later notification in memory.
    const desired = controller.desiredSize;
    if (desired !== null && desired < -stream.maxBufferedBytes) {
      overflowed = true;
      finish();
      abort.abort(new Error("the event stream's reader fell behind"));
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
    scopeSatisfied: satisfied,
    waitUntil,
  });
  let first: JSONRPCResponse | null | "stream";
  try {
    first = await Promise.race([done, opened]);
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    throw asAuthError(error);
  }
  if (first !== "stream") {
    signal.removeEventListener("abort", onAbort);
    const response = first;
    if (response === null) return new Response(null, { status: 499 });
    const status = "error" in response
      ? statusForCode(response.error.code, "execute")
      : 200;
    return jsonResponse(status, response);
  }

  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let overflowed = false;
  finish = () => {
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
      if (stream.keepAliveMs > 0) {
        keepAlive = setInterval(
          () => write(SSE_KEEPALIVE),
          stream.keepAliveMs,
        );
      }
    },
    cancel(reason) {
      closed = true;
      clearInterval(keepAlive);
      signal.removeEventListener("abort", onAbort);
      abort.abort(reason);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 }));
  done.then((response) => {
    if (response !== null && !overflowed) write(sseMessage(response));
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
