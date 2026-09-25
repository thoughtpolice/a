// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Context}: what a handler and middleware get for one request.
 *
 * @module
 */

import type { IpAddress } from "@celld/core/ip";
import type { AnySchema } from "@celld/sieve";
import type { Principal } from "./auth.ts";
import { negotiate } from "./accept.ts";
import {
  checkContentLength,
  decodeUtf8,
  type Limits,
  parseFormText,
  parseJsonText,
  readBytes as readBytesBody,
  requireForm,
  requireJson,
  tooLarge,
  toRecord,
} from "./body.ts";
import { clientIp, type ClientIpOptions } from "./client_ip.ts";
import {
  type CookieOptions,
  parseCookies,
  serializeCookie,
} from "./cookies.ts";
import { HttpError } from "./errors.ts";
import type { ResolvedCsrf } from "./csrf.ts";
import type { CompiledPublicUrl } from "./public_url.ts";

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
  /** How the public URL is found; see `RouterOptions.publicUrl`. */
  readonly publicUrl: CompiledPublicUrl;
  /** Whether credentials may cross plain http off loopback. */
  readonly allowCleartextCredentialsForDevelopment: boolean;
  /** The serving router's CSRF policy, null when it is off. */
  readonly csrf: ResolvedCsrf | null;
}

interface Internal {
  /** The request as it arrived. */
  raw: Request;
  /** `c.req`, made on first use. */
  view: Request | undefined;
  /** `c.query`, parsed on first use (or set by the route's schema). */
  query: unknown;
  /** The body, when the router had to read it before the handler. */
  buffered: Uint8Array<ArrayBuffer> | undefined;
  settings: ContextSettings;
  response: AnySchema | undefined;
  headers: [string, string][];
  cookies: Map<string, string> | undefined;
  controller: AbortController;
  publicUrl: string;
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
  /**
   * `req.url`, parsed: the URL the Worker received. Behind a proxy that is
   * not the one the client used; security decisions use
   * {@link publicUrl}.
   */
  readonly url: URL;
  /** The Worker's bindings. */
  readonly env: T["env"];
  /** The execution context (`waitUntil`, ...); a no-op one when none was given. */
  readonly ctx: ExecutionContext;
  /** A ULID naming this request; sent back as `X-Request-Id` and in error bodies. */
  readonly requestId: string;
  /**
   * Path parameters: from the pattern (an object without a prototype, so
   * any name, `__proto__` included, is an own property), or the route's
   * `params` schema's output.
   */
  readonly params: T["params"];
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
    this.url = new URL(request.url);
    this.env = env;
    this.ctx = ctx ?? NOOP_CONTEXT;
    this.requestId = requestId;
    this.params = Object.create(null) as T["params"];
    this.body = undefined as T["body"];
    this.principal = null as T["principal"];
    this.state = {} as T["state"];
    this.route = null;
    const controller = new AbortController();
    this.signal = AbortSignal.any([controller.signal, request.signal]);
    internals.set(this as Context, {
      raw: request,
      view: undefined,
      query: undefined,
      buffered: undefined,
      settings,
      response: undefined,
      headers: [],
      cookies: undefined,
      controller,
      publicUrl: this.url.href,
    });
  }

  /**
   * The request, with a body that goes through the router's limits: its
   * `text()`, `json()`, `arrayBuffer()`, `bytes()`, `formData()` and
   * `body` stream stop with a 413 past the body limit (whatever
   * `Content-Length` said, chunked bodies included) and fail with
   * `c.signal`'s reason when it aborts. They do not apply the JSON depth
   * and key limits; `c.readJson()` does. Everything else (method, URL,
   * headers) is the request's. Made on first use.
   */
  get req(): Request {
    const state = internal(this as Context);
    state.view ??= limitedRequest(this as Context, state);
    return state.view;
  }

  /**
   * The request exactly as the platform handed it over. **Its body
   * bypasses every limit**: reading it takes as many bytes as the client
   * sends, for as long as it sends them, and ignores `c.signal`. Only for
   * what the router does not cover (a platform property such as `cf`, or
   * a body that must be streamed through unlimited on purpose).
   */
  get unsafeRequest(): Request {
    return internal(this as Context).raw;
  }

  /**
   * Query parameters: the route's `query` schema's output, or else every
   * name as a string (a list when repeated), parsed in one pass the first
   * time it is read. The URL and query limits were checked before routing.
   */
  get query(): T["query"] {
    const state = internal(this as Context);
    state.query ??= toRecord(this.url.searchParams);
    return state.query as T["query"];
  }

  /**
   * The URL the client used, as the router's `publicUrl` setting resolves
   * it once per request (by default the request URL itself; behind a
   * proxy, from a fixed origin or the trusted proxy's headers). The
   * cleartext rule for credentials, the CSRF origin check, HSTS, DPoP's
   * `htu` and same-origin redirects all use it. A fresh copy each time.
   */
  get publicUrl(): URL {
    return new URL(internal(this as Context).publicUrl);
  }

  /** The request method. */
  get method(): string {
    return internal(this as Context).raw.method;
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
    const here = this.publicUrl;
    const target = new URL(location, here);
    if (target.origin !== here.origin && !options.external) {
      throw new Error(
        `refusing to redirect to another origin: ${target.origin}`,
      );
    }
    const href = target.origin === here.origin
      ? target.pathname + target.search + target.hash
      : target.href;
    return new Response(null, { status, headers: { location: href } });
  }

  /**
   * Sets a header on the response that goes out, whatever it is. Throws a
   * `TypeError` at once for a name or value a header cannot carry (CR, LF
   * or NUL in the value, say, from echoed input), so the mistake is the
   * handler's error (an opaque 500), never a failed response.
   */
  header(name: string, value: string): void {
    try {
      new Headers([[name, value]]);
    } catch (cause) {
      throw new TypeError(
        `c.header: ${
          JSON.stringify(String(name))
        } with that value is not a valid header`,
        { cause },
      );
    }
    internal(this as Context).headers.push([name, value]);
  }

  /** The request's cookie `name`, as sent; undefined when absent. */
  cookie(name: string): string | undefined {
    const state = internal(this as Context);
    state.cookies ??= parseCookies(state.raw.headers.get("cookie"));
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
   * The client's address, per the router's `clientIp` settings: the peer,
   * and `X-Forwarded-For` only when the peer is a trusted proxy. For logs
   * and keys; access decisions use `clientIpForAuthorization(c)`.
   */
  ip(): IpAddress | null {
    return clientIp(this as Context);
  }

  /**
   * The body's bytes, under the body limit (413 over it, whatever
   * `Content-Length` said), whatever its `Content-Type`. Stops, cancelling
   * the body, and rejects with the reason when `c.signal` aborts.
   */
  async readBytes(): Promise<Uint8Array<ArrayBuffer>> {
    return await bodyBytes(this as Context);
  }

  /** The body as text, under the body limit; 400 unless UTF-8. */
  async readText(): Promise<string> {
    return decodeUtf8(await bodyBytes(this as Context));
  }

  /** The body as JSON, under the body, depth and key limits; 415 unless JSON. */
  async readJson(): Promise<unknown> {
    return await readJsonBody(this as Context);
  }

  /** The body as a form (see `toRecord`), under the limits; 415 unless urlencoded. */
  async readForm(): Promise<Record<string, string | string[]>> {
    return await readFormBody(this as Context);
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
    return negotiate(
      internal(this as Context).raw.headers.get("accept"),
      types,
    );
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
  const { query, ...rest } = fields;
  if ("query" in fields) internal(c).query = query;
  Object.assign(c, rest);
}

/** The body's bytes: the ones read before the handler, or read now. */
async function bodyBytes(c: Context): Promise<Uint8Array<ArrayBuffer>> {
  const state = internal(c);
  if (state.buffered !== undefined) return state.buffered.slice();
  return await readBytesBody(state.raw, state.settings.limits.body, c.signal);
}

/**
 * Reads the body now, under the limits, and keeps it for every later
 * reader (`c.readForm()`, `c.req.text()`, ...): for the router's CSRF form
 * token, which it must see before the handler runs.
 */
export async function bufferBody(c: Context): Promise<Uint8Array> {
  const state = internal(c);
  state.buffered ??= await readBytesBody(
    state.raw,
    state.settings.limits.body,
    c.signal,
  );
  return state.buffered;
}

/** The body parsed as JSON under the limits; 415, 413 and 400 as they apply. */
export async function readJsonBody(c: Context): Promise<unknown> {
  const state = internal(c);
  requireJson(state.raw);
  return parseJsonText(decodeUtf8(await bodyBytes(c)), state.settings.limits);
}

/** An urlencoded form body as an object; 415, 413 and 400 as they apply. */
export async function readFormBody(
  c: Context,
  arrays?: ReadonlySet<string>,
): Promise<Record<string, string | string[]>> {
  const state = internal(c);
  requireForm(state.raw);
  return parseFormText(
    decodeUtf8(await bodyBytes(c)),
    state.settings.limits,
    arrays,
  );
}

/**
 * The request as it arrived, for the router's own reads of its method and
 * headers (never its body, which goes through the limited readers).
 */
export function requestOf(c: Context): Request {
  return internal(c).raw;
}

/**
 * `c.req`: the request with its body behind a stream that enforces the
 * body limit in force when it is read (the route's, once one matched) and
 * errors with `c.signal`'s reason when that aborts, cancelling the
 * request's own body either way.
 */
function limitedRequest(c: Context, state: Internal): Request {
  const raw = state.raw;
  const init: RequestInit & { duplex?: "half" } = {
    method: raw.method,
    headers: raw.headers,
    signal: c.signal,
    redirect: raw.redirect,
  };
  if (raw.body !== null) {
    init.body = limitedBody(c, state);
    init.duplex = "half";
  }
  return new Request(raw.url, init);
}

function limitedBody(c: Context, state: Internal): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let total = 0;
  let onAbort: (() => void) | undefined;
  const release = () => {
    if (onAbort !== undefined) c.signal.removeEventListener("abort", onAbort);
    onAbort = undefined;
  };
  const stop = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: unknown,
  ) => {
    release();
    controller.error(reason);
    const source = reader ??
      (state.raw.body?.locked ? undefined : state.raw.body);
    source?.cancel(reason).catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (c.signal.aborted) {
        stop(controller, c.signal.reason);
        return;
      }
      onAbort = () => stop(controller, c.signal.reason);
      c.signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      const limit = state.settings.limits.body;
      try {
        if (reader === undefined && state.buffered !== undefined) {
          release();
          controller.enqueue(state.buffered.slice());
          controller.close();
          return;
        }
        if (reader === undefined) {
          checkContentLength(state.raw, limit);
          if (state.raw.bodyUsed || state.raw.body === null) {
            throw new Error("the request body was already read");
          }
          reader = state.raw.body.getReader();
        }
        const { done, value } = await reader.read();
        if (c.signal.aborted) return;
        if (done) {
          release();
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > limit) throw tooLarge(limit);
        controller.enqueue(value);
      } catch (error) {
        stop(controller, error);
      }
    },
    cancel(reason) {
      release();
      (reader ?? state.raw.body)?.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 }); // Nothing is pulled from the request until read.
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

/** Sets the public URL the router resolved for `c`. */
export function setPublicUrl(c: Context, url: URL): void {
  internal(c).publicUrl = url.href;
}

/** Aborts `c.signal`. */
export function abort(c: Context, reason: unknown): void {
  internal(c).controller.abort(reason);
}
