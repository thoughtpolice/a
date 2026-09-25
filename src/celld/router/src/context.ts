// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Context}: what a handler and middleware get for one request.
 *
 * @module
 */

import type { IpAddress } from "@celld/ip";
import type { AnySchema } from "@celld/sieve";
import type { Principal } from "./auth.ts";
import { negotiate } from "./accept.ts";
import {
  type Limits,
  readBytes as readBytesBody,
  readForm as readFormBody,
  readJson as readJsonBody,
  readText as readTextBody,
} from "./body.ts";
import { clientIp, type ClientIpOptions } from "./client_ip.ts";
import {
  type CookieOptions,
  parseCookies,
  serializeCookie,
} from "./cookies.ts";
import { HttpError } from "./errors.ts";

/** The types a {@link Context} is specialised with. */
export interface ContextTypes {
  env: unknown;
  params: unknown;
  query: unknown;
  body: unknown;
  state: object;
  principal: Principal | null;
  /** What `c.json` takes: a route's `response` schema input, else anything. */
  response: unknown;
}

/** A context of any types, for middleware and schemes that work on every route. */
export interface AnyContextTypes extends ContextTypes {
  // deno-lint-ignore no-explicit-any
  env: any;
  // deno-lint-ignore no-explicit-any
  params: any;
  // deno-lint-ignore no-explicit-any
  query: any;
  // deno-lint-ignore no-explicit-any
  body: any;
  // deno-lint-ignore no-explicit-any
  state: any;
  // deno-lint-ignore no-explicit-any
  principal: any;
  // deno-lint-ignore no-explicit-any
  response: any;
}

/** Per-request settings the router hands a context. */
export interface ContextSettings {
  readonly limits: Limits;
  readonly cookies: CookieOptions;
  readonly clientIp: ClientIpOptions;
}

interface Internal {
  settings: ContextSettings;
  response: AnySchema | undefined;
  headers: [string, string][];
  cookies: Map<string, string> | undefined;
  controller: AbortController;
}

const internals = new WeakMap<Context, Internal>();

function internal(c: Context): Internal {
  return internals.get(c)!;
}

/** How `c.json` and friends take a status or a full `ResponseInit`. */
export type Init = number | ResponseInit;

function responseInit(init: Init | undefined, type: string): ResponseInit {
  const base = typeof init === "number" ? { status: init } : init ?? {};
  const headers = new Headers(base.headers);
  if (!headers.has("content-type")) headers.set("content-type", type);
  return { ...base, headers };
}

const NOOP_CONTEXT: ExecutionContext = {
  waitUntil: (promise) => void promise.catch(() => {}),
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

/**
 * One request as a handler sees it. The router fills `params`, `query`,
 * `body` and `principal` for the route that matched; middleware adds typed
 * fields to `state`. `json`, `text` and `html` build responses, and
 * `header` and `setCookie` add headers to whatever response goes out,
 * errors included.
 */
export class Context<T extends ContextTypes = AnyContextTypes> {
  /** The request as it arrived. */
  readonly req: Request;
  /** `req.url`, parsed. */
  readonly url: URL;
  /** The Worker's bindings. */
  readonly env: T["env"];
  /** The execution context (`waitUntil`, ...); a no-op one when none was given. */
  readonly ctx: ExecutionContext;
  /** A ULID naming this request; sent back as `X-Request-Id` and in error bodies. */
  readonly requestId: string;
  /** Path parameters: from the pattern, or the route's `params` schema's output. */
  readonly params: T["params"];
  /**
   * Query parameters: the route's `query` schema's output, or else every
   * name as a string (a list when repeated).
   */
  readonly query: T["query"];
  /** The route's `body` schema's output; `undefined` for a route without one. */
  readonly body: T["body"];
  /** Who the request is from; null on public routes without a credential. */
  readonly principal: T["principal"];
  /** Fields set by middleware. */
  readonly state: T["state"];
  /** The pattern of the route that matched (`/users/:id`), or null. */
  readonly route: string | null;
  /**
   * Aborted when the request's time budget runs out (the reason is a
   * `TimeoutError`), or when the request's own signal aborts, as a runtime
   * does when the client disconnects (the reason is the request's).
   */
  readonly signal: AbortSignal;

  constructor(
    request: Request,
    env: T["env"],
    ctx: ExecutionContext | undefined,
    requestId: string,
    settings: ContextSettings,
  ) {
    this.req = request;
    this.url = new URL(request.url);
    this.env = env;
    this.ctx = ctx ?? NOOP_CONTEXT;
    this.requestId = requestId;
    this.params = {} as T["params"];
    this.query = {} as T["query"];
    this.body = undefined as T["body"];
    this.principal = null as T["principal"];
    this.state = {} as T["state"];
    this.route = null;
    const controller = new AbortController();
    this.signal = AbortSignal.any([controller.signal, request.signal]);
    internals.set(this as Context, {
      settings,
      response: undefined,
      headers: [],
      cookies: undefined,
      controller,
    });
  }

  /** The request method. */
  get method(): string {
    return this.req.method;
  }

  /**
   * A JSON response. With a route `response` schema, a 2xx body is parsed
   * by it first (unknown keys are stripped), so a handler cannot leak a
   * field the schema does not list; a body that fails is a 500.
   */
  json(data: T["response"], init?: Init): Response {
    const options = responseInit(init, "application/json");
    const schema = internal(this as Context).response;
    let body: unknown = data;
    const status = options.status ?? 200;
    if (schema !== undefined && status >= 200 && status < 300) {
      const result = schema.safeParse(data);
      if (!result.success) {
        throw new Error(
          `the response does not match the route's schema: ${result.error.message}`,
        );
      }
      body = result.data;
    }
    return new Response(JSON.stringify(body), options);
  }

  /** A `text/plain; charset=utf-8` response. */
  text(text: string, init?: Init): Response {
    return new Response(text, responseInit(init, "text/plain; charset=utf-8"));
  }

  /** A `text/html; charset=utf-8` response, which gets the HTML CSP. */
  html(html: string, init?: Init): Response {
    return new Response(html, responseInit(init, "text/html; charset=utf-8"));
  }

  /** An empty response, 204 by default. */
  empty(status = 204): Response {
    return new Response(null, { status });
  }

  /**
   * A redirect (302 by default) to a path or a URL on this request's
   * origin. Another origin throws unless `external` is set, so a `next`
   * parameter passed straight through cannot become an open redirect.
   */
  redirect(
    location: string,
    status: 301 | 302 | 303 | 307 | 308 = 302,
    options: { readonly external?: boolean } = {},
  ): Response {
    const target = new URL(location, this.url);
    if (target.origin !== this.url.origin && !options.external) {
      throw new Error(
        `refusing to redirect to another origin: ${target.origin}`,
      );
    }
    const href = target.origin === this.url.origin
      ? target.pathname + target.search + target.hash
      : target.href;
    return new Response(null, { status, headers: { location: href } });
  }

  /** Sets a header on the response that goes out, whatever it is. */
  header(name: string, value: string): void {
    internal(this as Context).headers.push([name, value]);
  }

  /** The request's cookie `name`, as sent; undefined when absent. */
  cookie(name: string): string | undefined {
    const state = internal(this as Context);
    state.cookies ??= parseCookies(this.req.headers.get("cookie"));
    return state.cookies.get(name);
  }

  /**
   * Adds a `Set-Cookie`. Options default to the router's cookie defaults,
   * which default to `HttpOnly; Secure; SameSite=Lax; Path=/`.
   */
  setCookie(name: string, value: string, options: CookieOptions = {}): void {
    const defaults = internal(this as Context).settings.cookies;
    this.header(
      "set-cookie",
      serializeCookie(name, value, { ...defaults, ...options }),
    );
  }

  /** Expires the cookie `name` (give the `path` and `domain` it was set with). */
  deleteCookie(name: string, options: CookieOptions = {}): void {
    this.setCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) });
  }

  /**
   * The client's address, per the router's `clientIp` settings: the peer
   * header, and `X-Forwarded-For` only when the peer is a trusted proxy.
   */
  ip(): IpAddress | null {
    return clientIp(this.req, internal(this as Context).settings.clientIp);
  }

  /**
   * The body's bytes, under the body limit (413 over it, whatever
   * `Content-Length` said), whatever its `Content-Type`.
   */
  async readBytes(): Promise<Uint8Array<ArrayBuffer>> {
    return await readBytesBody(
      this.req,
      internal(this as Context).settings.limits.body,
    );
  }

  /** The body as text, under the body limit. */
  async readText(): Promise<string> {
    return await readTextBody(
      this.req,
      internal(this as Context).settings.limits.body,
    );
  }

  /** The body as JSON, under the body, depth and key limits; 415 unless JSON. */
  async readJson(): Promise<unknown> {
    return await readJsonBody(
      this.req,
      internal(this as Context).settings.limits,
    );
  }

  /** The body as a form (see `toRecord`), under the limits; 415 unless urlencoded. */
  async readForm(): Promise<Record<string, string | string[]>> {
    return await readFormBody(
      this.req,
      internal(this as Context).settings.limits,
    );
  }

  /**
   * Which of `types` (media types such as `text/html`, in the server's
   * order of preference) the request's `Accept` header takes best, or null
   * when it takes none of them (RFC 9110 section 12.5.1). Each type gets
   * the `q` of the most specific range that matches it (`text/html`, then
   * `text/*`, then the wildcard range); ties go to the earlier type. Without an
   * `Accept` header every type is acceptable, so the first is returned.
   *
   * ```ts
   * if (c.accepts("application/json", "text/html") === "text/html") ...
   * ```
   */
  accepts(...types: string[]): string | null {
    return negotiate(this.req.headers.get("accept"), types);
  }

  /** Throws an {@link HttpError}; handy in expressions. */
  fail(status: number, message?: string): never {
    throw new HttpError(status, message);
  }
}

/** Sets the router-owned fields of `c`. */
export function assign(
  c: Context,
  fields: Partial<
    Pick<Context, "params" | "query" | "body" | "principal" | "route">
  >,
): void {
  Object.assign(c, fields);
}

/** Replaces the settings (a route's own limits) and the response schema. */
export function configure(
  c: Context,
  settings: ContextSettings,
  response: AnySchema | undefined,
): void {
  const state = internal(c);
  state.settings = settings;
  state.response = response;
}

/** The settings in force for `c`. */
export function settingsOf(c: Context): ContextSettings {
  return internal(c).settings;
}

/** Headers added with `c.header` and `c.setCookie`, in order. */
export function pendingHeaders(c: Context): readonly [string, string][] {
  return internal(c).headers;
}

/** Aborts `c.signal`. */
export function abort(c: Context, reason: unknown): void {
  internal(c).controller.abort(reason);
}
