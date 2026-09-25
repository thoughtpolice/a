// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Router}: routes, the request pipeline and every default in it.
 *
 * A request goes through, in order:
 *
 * 1. the header size limit (431) and the time budget (503; a matched
 *    route's own `limits.timeout` replaces the router's, and the budget
 *    ends when a response is returned, so a streamed body is not cut off);
 * 2. the router's middleware (`app.use`), outermost first; CORS belongs
 *    here, so preflights are answered before anything needs a credential;
 * 3. matching: 400 for a path that is not valid percent-encoding, 404,
 *    405 with `Allow`, the automatic `OPTIONS`, `HEAD` served by `GET`;
 * 4. a mounted router's middleware;
 * 5. the route's `before` middleware, which runs before authentication (an
 *    `Origin` check that must answer 403 before a 401, say); then
 *    `Content-Length` over the body limit (413);
 * 6. authentication (401, or a scheme's `unauthenticated` answer when no
 *    credential was sent; the scheme's 400 or 401 for a bad one), then
 *    `scopes`, `roles` and `authorize` (403);
 * 7. the CSRF origin check for state-changing requests on ambient
 *    credentials (403);
 * 8. validation of params, query and body (415, 413, 400), then the CSRF
 *    token if configured;
 * 9. the route's own middleware (`use`), then the handler.
 *
 * A thrown error first goes to the `mapError` hooks: the route's, then
 * those of the routers it is mounted in (innermost first), then the
 * serving router's. The first to return a `Response` answers; one that
 * throws replaces the error. Otherwise errors become JSON answers on the
 * way out: an `HttpError` its own, an `AuthError` its own with the
 * challenge of the scheme that authenticated the request (every route
 * scheme's when anonymous), any other exception an opaque 500 naming only
 * the request id (and it goes to `onError`). Finally every response gets
 * the security headers, the request id and the `Set-Cookie`s and headers
 * set through the context.
 *
 * @module
 */

import { ulid } from "@celld/ulid";
import type { AnySchema, Input, Output, SieveError } from "@celld/sieve";
import {
  AuthError,
  type AuthScheme,
  formatChallenge,
  type Principal,
  toPrincipal,
} from "./auth.ts";
import {
  checkContentLength,
  DEFAULT_LIMITS,
  headerBytes,
  type Limits,
  readForm,
  readJson,
  toRecord,
} from "./body.ts";
import type { ClientIpOptions } from "./client_ip.ts";
import {
  abort,
  assign,
  configure,
  Context,
  type ContextSettings,
  pendingHeaders,
  settingsOf,
} from "./context.ts";
import type { CookieOptions } from "./cookies.ts";
import {
  checkOrigin,
  checkToken,
  type CsrfOptions,
  resolveCsrf,
  type ResolvedCsrf,
  SAFE_METHODS,
} from "./csrf.ts";
import { type Duration, durationMs } from "./duration.ts";
import { errorResponse, HttpError, jsonError, RouterError } from "./errors.ts";
import {
  type AddsAll,
  type AddsOf,
  compose,
  type Empty,
  type Middleware,
} from "./middleware.ts";
import {
  formatPattern,
  parsePattern,
  type PathParams,
  type Segment,
  shapeOf,
  splitPath,
  Trie,
} from "./path.ts";
import { applySecurityHeaders, type SecurityHeaders } from "./security.ts";

/** Answers a request. */
export type Handler<C> = (c: C) => Response | Promise<Response>;

/** Reports an unexpected error; a returned Promise is kept alive with `waitUntil`. */
export type ErrorReporter = (
  error: unknown,
  c: Context,
) => void | Promise<void>;

/**
 * Turns a thrown error into a response: a `Response` answers the request
 * (it still gets the security headers, the request id and the context's
 * headers), and `null` or `undefined` leaves the error to the next hook
 * and then the router. Throwing replaces the error, so a hook can rethrow
 * an `HttpError` (a `502` for an upstream failure, say). A mapped error is
 * not reported to `onError`.
 */
export type ErrorMapper = (
  error: unknown,
  c: Context,
) =>
  | Response
  | null
  | undefined
  | Promise<Response | null | undefined>;

/**
 * Limits a route may set for itself. A route's `timeout` replaces the
 * router's, counted from the start of the request; `false` means none (a
 * long-lived stream, say).
 */
export type RouteLimits = Partial<
  Pick<Limits, "body" | "jsonDepth" | "jsonKeys" | "timeout">
>;

/**
 * How a router authenticates:
 *
 * - one scheme or a list, tried in order; every route then needs a
 *   principal unless it is `public: true`;
 * - `"none"`: no authentication at all, said out loud; routes are
 *   anonymous and may not ask for scopes or roles;
 * - `"inherit"`: for a router meant to be mounted, which uses the auth of
 *   the router it is mounted in.
 *
 * Leaving it out means every route must be `public: true`; any other route
 * is a {@link RouterError} when it is added.
 */
export type AuthConfig =
  | AuthScheme
  | readonly AuthScheme[]
  | "none"
  | "inherit";

/** Router settings. Everything but `auth` applies to the router that serves the request. */
export interface RouterOptions {
  readonly auth?: AuthConfig;
  /** Request limits over {@link DEFAULT_LIMITS}. */
  readonly limits?: Partial<Limits>;
  /** Security header values and switches; see {@link SecurityHeaders}. */
  readonly security?: SecurityHeaders;
  /**
   * The CSRF check for state-changing requests with ambient credentials
   * (cookies, Basic); `false` turns it off. On by default, origin-based.
   */
  readonly csrf?: CsrfOptions | false;
  /** Defaults for `c.setCookie`, over `HttpOnly; Secure; SameSite=Lax; Path=/`. */
  readonly cookies?: CookieOptions;
  /** How `c.ip()` finds the client; `X-Forwarded-For` is ignored unless the peer is trusted. */
  readonly clientIp?: ClientIpOptions;
  /** Called with every unexpected error (never with an `HttpError`) no hook mapped. */
  readonly onError?: ErrorReporter;
  /**
   * Maps thrown errors to responses, for every route of this router (and,
   * on the router that serves requests, for errors outside routes too);
   * see {@link ErrorMapper}. A mounted router's runs before the serving
   * router's.
   */
  readonly mapError?: ErrorMapper;
  /** Makes request ids; default a ULID. */
  readonly requestId?: () => string;
  /** The response header carrying the request id; default `x-request-id`, `false` for none. */
  readonly requestIdHeader?: string | false;
}

/** Per-route settings: access, validation, middleware and documentation. */
export interface RouteOptions {
  /**
   * Anyone may call it. A credential that is sent is still checked (and a
   * bad one refused); `c.principal` is null without one.
   */
  readonly public?: boolean;
  /** Scopes the principal must all have (403 `insufficient_scope` otherwise). */
  readonly scopes?: readonly string[];
  /** Roles of which the principal must have at least one (403). */
  readonly roles?: readonly string[];
  /** A last check on the principal (403 when false). */
  readonly authorize?: (
    principal: Principal,
    c: Context,
  ) => boolean | Promise<boolean>;
  /** Parses the path params (strings); 400 on failure. */
  readonly params?: AnySchema;
  /**
   * Parses the query, given as an object whose values are strings, or lists
   * for repeated names and names the schema types as arrays; 400 on failure.
   */
  readonly query?: AnySchema;
  /** Parses the body; 415 for the wrong `Content-Type`, 413 over the limit, 400 on failure. */
  readonly body?: AnySchema;
  /** The body's encoding: JSON (default) or a urlencoded form. */
  readonly bodyType?: "json" | "form";
  /** What `c.json` sends for 2xx: parsed (and stripped) by this schema. */
  readonly response?: AnySchema;
  /** Middleware run after authentication and validation, just around the handler. */
  readonly use?: readonly Middleware<object>[];
  /**
   * Middleware run once the route has matched but before the body limit
   * and authentication: `c.principal` is null, and `c.body` is not parsed.
   * For checks that must answer before a 401, such as `Origin`.
   */
  readonly before?: readonly Middleware<object>[];
  /** Maps errors thrown for this route, before the routers' hooks; see {@link ErrorMapper}. */
  readonly mapError?: ErrorMapper;
  readonly limits?: RouteLimits;
  /**
   * `false` skips the CSRF check here; `true` runs it even without an
   * ambient credential (a login form, say).
   */
  readonly csrf?: boolean;
  /** For OpenAPI. */
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly deprecated?: boolean;
}

type SchemaOf<O, K extends string> = O extends { readonly [P in K]: infer S }
  ? (S extends AnySchema ? S : never)
  : never;

/** The context types of a route: from its pattern, its options and the router. */
export interface RouteTypes<
  E,
  S extends object,
  A extends boolean,
  P extends string,
  O,
> {
  env: E;
  params: [SchemaOf<O, "params">] extends [never] ? PathParams<P>
    : Output<SchemaOf<O, "params">>;
  query: [SchemaOf<O, "query">] extends [never]
    ? Readonly<Record<string, string | readonly string[]>>
    : Output<SchemaOf<O, "query">>;
  body: [SchemaOf<O, "body">] extends [never] ? undefined
    : Output<SchemaOf<O, "body">>;
  state:
    & S
    & (O extends { readonly before: infer M extends readonly unknown[] }
      ? AddsAll<M>
      : Empty)
    & (O extends { readonly use: infer M extends readonly unknown[] }
      ? AddsAll<M>
      : Empty);
  principal: A extends false ? null
    : O extends { readonly public: true } ? Principal | null
    : Principal;
  response: [SchemaOf<O, "response">] extends [never] ? unknown
    : Input<SchemaOf<O, "response">>;
}

/** The context a route's handler gets. */
export type RouteContext<
  E,
  S extends object,
  A extends boolean,
  P extends string,
  O,
> = Context<RouteTypes<E, S, A, P, O>>;

/** Adds a route for one method: `(path, handler)` or `(path, options, handler)`. */
export interface RouteMethod<E, S extends object, A extends boolean> {
  <const P extends string>(
    path: P,
    handler: Handler<RouteContext<E, S, A, P, Empty>>,
  ): Router<E, S, A>;
  <const P extends string, const O extends RouteOptions>(
    path: P,
    options: O,
    handler: Handler<RouteContext<E, S, A, P, O>>,
  ): Router<E, S, A>;
}

/** A route as {@link Router.routes} lists it. */
export interface RouteInfo {
  readonly method: string;
  /** The full pattern, mount prefixes included. */
  readonly pattern: string;
  readonly segments: readonly Segment[];
  readonly options: RouteOptions;
  /** The schemes that authenticate it; empty for `auth: "none"`. */
  readonly schemes: readonly AuthScheme[];
}

type ResolvedAuth =
  | { readonly mode: "schemes"; readonly schemes: readonly AuthScheme[] }
  | { readonly mode: "none" };

type OwnAuth = ResolvedAuth | "inherit" | "unset";

interface RouteDef {
  readonly method: string;
  readonly segments: readonly Segment[];
  readonly options: RouteOptions;
  readonly handler: Handler<Context>;
}

interface FlatRoute extends RouteDef {
  readonly pattern: string;
  readonly names: readonly string[];
  readonly auth: ResolvedAuth;
  readonly chain: readonly Middleware<object>[];
  /** The route's and its routers' error hooks, innermost first. */
  readonly mappers: readonly ErrorMapper[];
}

interface Compiled {
  readonly trie: Trie<FlatRoute>;
  readonly routes: readonly FlatRoute[];
}

const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;

function resolveAuth(auth: AuthConfig | undefined): OwnAuth {
  if (auth === undefined) return "unset";
  if (auth === "none" || auth === "inherit") {
    return auth === "none" ? { mode: "none" } : "inherit";
  }
  const schemes: readonly AuthScheme[] = Array.isArray(auth)
    ? auth as readonly AuthScheme[]
    : [auth as AuthScheme];
  if (schemes.length === 0) {
    throw new RouterError('auth needs at least one scheme (or "none")');
  }
  const names = new Set<string>();
  for (const scheme of schemes) {
    if (names.has(scheme.name)) {
      throw new RouterError(`two auth schemes are named ${scheme.name}`);
    }
    names.add(scheme.name);
  }
  return { mode: "schemes", schemes };
}

function describeRoute(method: string, segments: readonly Segment[]): string {
  return `${method} ${formatPattern(segments)}`;
}

/** Throws unless a route's access settings make sense under `auth`. */
function checkAccess(
  route: RouteDef,
  auth: ResolvedAuth | "unset",
  where: readonly Segment[],
): void {
  const { options } = route;
  const name = describeRoute(route.method, where);
  const demands = (options.scopes?.length ?? 0) > 0 ||
    (options.roles?.length ?? 0) > 0 || options.authorize !== undefined;
  if (options.public && demands) {
    throw new RouterError(
      `${name} is public but asks for scopes, roles or authorize`,
    );
  }
  if (auth === "unset" && !options.public) {
    throw new RouterError(
      `${name} is not public and its router has no auth: configure auth schemes, ` +
        `mark the route { public: true }, or opt out with router({ auth: "none" })`,
    );
  }
  if (auth !== "unset" && auth.mode === "none" && demands) {
    throw new RouterError(
      `${name} asks for scopes, roles or authorize, but auth is "none"`,
    );
  }
}

function checkLimits(limits: Partial<Limits>, what: string): void {
  for (const key of ["body", "headers", "jsonDepth", "jsonKeys"] as const) {
    const value = limits[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RouterError(`${what}.${key} must be a positive integer`);
    }
  }
  timeoutMs(limits.timeout, `${what}.timeout`);
}

/** A timeout in milliseconds, null for none; throws {@link RouterError} for a bad one. */
function timeoutMs(
  timeout: Duration | false | undefined,
  what: string,
): number | null {
  if (timeout === undefined || timeout === false) return null;
  return durationMs(timeout, what);
}

/**
 * A request's time budget. The router arms it with its own timeout, a
 * matched route may re-arm it with its own (from the same start), and it
 * is disarmed for good once a response is chosen.
 */
class Deadline {
  readonly #start = Date.now();
  readonly #expire: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #settled = false;
  #expired = false;

  constructor(expire: () => void) {
    this.#expire = expire;
  }

  /** Whether it ran out. */
  get expired(): boolean {
    return this.#expired;
  }

  /**
   * Expires `ms` after the request started, at once when that has passed;
   * null never expires.
   */
  arm(ms: number | null): void {
    if (this.#settled) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (ms === null) return;
    const left = this.#start + ms - Date.now();
    if (left <= 0) this.#fire();
    else this.#timer = setTimeout(() => this.#fire(), left);
  }

  #fire(): void {
    this.#settled = true;
    this.#expired = true;
    this.#expire();
  }

  settle(): void {
    this.#settled = true;
    clearTimeout(this.#timer);
  }
}

/** What a request's auth came to, once a route has matched. */
interface RequestAuth {
  /** The route's schemes; empty for `auth: "none"`. */
  readonly schemes: readonly AuthScheme[];
  /** The scheme that authenticated the request, if one did. */
  scheme: AuthScheme | undefined;
  /** The answer stands in for a 401 (a scheme's `unauthenticated`). */
  refused: boolean;
}

const requestAuth = new WeakMap<Context, RequestAuth>();
const requestMappers = new WeakMap<Context, readonly ErrorMapper[]>();
const deadlines = new WeakMap<Context, Deadline>();

interface DefShape {
  readonly kind: string;
  readonly inner?: { readonly def: DefShape };
  readonly in?: { readonly def: DefShape };
  readonly shape?: Readonly<Record<string, { readonly def: DefShape }>>;
}

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "catch",
  "readonly",
]);

function unwrap(def: DefShape): DefShape {
  let current = def;
  for (;;) {
    if (WRAPPERS.has(current.kind) && current.inner) {
      current = current.inner.def;
    } else if (current.kind === "pipe" && current.in) current = current.in.def;
    else return current;
  }
}

const arrayKeyCache = new WeakMap<AnySchema, ReadonlySet<string>>();

/** Keys of an object schema whose values are arrays, so a single value becomes a list. */
function arrayKeys(schema: AnySchema): ReadonlySet<string> {
  let keys = arrayKeyCache.get(schema);
  if (keys === undefined) {
    const set = new Set<string>();
    const def = unwrap(schema.def as unknown as DefShape);
    if (def.kind === "object" && def.shape) {
      for (const [key, value] of Object.entries(def.shape)) {
        if (unwrap(value.def).kind === "array") set.add(key);
      }
    }
    keys = set;
    arrayKeyCache.set(schema, keys);
  }
  return keys;
}

function invalid(location: string, error: SieveError): HttpError {
  const { formErrors, fieldErrors } = error.flatten();
  return new HttpError(400, `the ${location} is not valid`, {
    code: "validation_failed",
    details: {
      location,
      formErrors,
      fieldErrors,
      issues: error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    },
  });
}

async function parse(
  schema: AnySchema,
  value: unknown,
  location: string,
): Promise<unknown> {
  const result = await schema.safeParseAsync(value);
  if (!result.success) throw invalid(location, result.error);
  return result.data;
}

interface Authenticated {
  readonly principal: Principal;
  readonly scheme: AuthScheme;
}

function challengeResponse(
  error: AuthError,
  schemes: readonly AuthScheme[],
  c: Context,
  options: { readonly anonymous?: boolean } = {},
): Response {
  const response = jsonError(
    error.status,
    error.code,
    error.message,
    c.requestId,
  );
  error.headers.forEach((value, name) => response.headers.set(name, value));
  const challenged = options.anonymous ? undefined : error;
  for (const scheme of schemes) {
    const challenge = scheme.challenge?.(challenged, c);
    if (challenge) {
      response.headers.append("www-authenticate", formatChallenge(challenge));
    }
  }
  return response;
}

async function authenticate(
  schemes: readonly AuthScheme[],
  c: Context,
): Promise<Authenticated | Response | null> {
  for (const scheme of schemes) {
    let outcome;
    try {
      outcome = await scheme.authenticate(c);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      outcome = error;
    }
    if (outcome === null) continue;
    if (outcome instanceof AuthError) {
      return challengeResponse(outcome, [scheme], c);
    }
    const principal = toPrincipal(outcome, scheme.name);
    if (outcome.headers !== undefined) {
      for (const [name, value] of new Headers(outcome.headers)) {
        c.header(name, value);
      }
    }
    return { principal, scheme };
  }
  return null;
}

function unauthenticated(schemes: readonly AuthScheme[], c: Context): Response {
  for (const scheme of schemes) {
    const answer = scheme.unauthenticated?.(c);
    if (answer instanceof Response) {
      requestAuth.get(c)!.refused = true;
      return answer;
    }
    if (answer !== null && answer !== undefined) {
      throw new TypeError(
        `auth scheme ${scheme.name}'s unauthenticated returned something other than a Response`,
      );
    }
  }
  const response = jsonError(
    401,
    "unauthorized",
    "authentication required",
    c.requestId,
  );
  for (const scheme of schemes) {
    const challenge = scheme.challenge?.(undefined, c);
    if (challenge) {
      response.headers.append("www-authenticate", formatChallenge(challenge));
    }
  }
  return response;
}

function methodsOf(
  matches: readonly { entries: ReadonlyMap<string, unknown> }[],
): string {
  const methods = new Set<string>();
  for (const match of matches) {
    for (const method of match.entries.keys()) methods.add(method);
  }
  if (methods.has("GET")) methods.add("HEAD");
  methods.add("OPTIONS");
  return [...methods].sort().join(", ");
}

/**
 * Routes and the pipeline around them. Make one with {@link router};
 * `export default { fetch: app.fetch }` (or `export default app`) serves
 * it.
 */
export class Router<
  E = unknown,
  S extends object = Empty,
  A extends boolean = boolean,
> {
  readonly #auth: OwnAuth;
  readonly #options: RouterOptions;
  readonly #settings: ContextSettings;
  readonly #csrf: ResolvedCsrf | null;
  readonly #timeoutMs: number | null;
  readonly #middleware: Middleware<object>[] = [];
  readonly #routes: RouteDef[] = [];
  readonly #shapes = new Set<string>();
  readonly #mounts: {
    prefix: readonly Segment[];
    child: Router<E, object, boolean>;
  }[] = [];
  #mounted = false;
  #compiled: Compiled | null = null;

  /** Throws {@link RouterError} for bad settings; see {@link RouterOptions}. */
  constructor(options: RouterOptions = {}) {
    this.#auth = resolveAuth(options.auth);
    this.#options = options;
    checkLimits(options.limits ?? {}, "limits");
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#settings = {
      limits,
      cookies: options.cookies ?? {},
      clientIp: options.clientIp ?? {},
    };
    this.#timeoutMs = timeoutMs(limits.timeout, "limits.timeout");
    this.#csrf = options.csrf === false ? null : resolveCsrf(options.csrf);
  }

  /**
   * Adds middleware around every route of this router (and, on the router
   * that serves requests, around 404s, 405s and automatic `OPTIONS` too).
   * It runs before authentication: `c.principal` is not set yet.
   */
  use<M extends Middleware<object>>(
    middleware: M,
  ): Router<E, S & AddsOf<M>, A> {
    this.#mutable();
    this.#middleware.push(middleware);
    return this as unknown as Router<E, S & AddsOf<M>, A>;
  }

  /** `GET`; `HEAD` is served by it unless there is a `HEAD` route. */
  readonly get: RouteMethod<E, S, A> = this.#method("GET");
  readonly post: RouteMethod<E, S, A> = this.#method("POST");
  readonly put: RouteMethod<E, S, A> = this.#method("PUT");
  readonly patch: RouteMethod<E, S, A> = this.#method("PATCH");
  readonly delete: RouteMethod<E, S, A> = this.#method("DELETE");
  readonly head: RouteMethod<E, S, A> = this.#method("HEAD");
  /** An explicit `OPTIONS` route replaces the automatic `204` with `Allow`. */
  readonly options: RouteMethod<E, S, A> = this.#method("OPTIONS");

  /**
   * Adds a route for another method (`PURGE`, `PROPFIND`, ...); same
   * arguments as {@link get} after the method.
   */
  on<const P extends string, const O extends RouteOptions>(
    method: string,
    path: P,
    options: O,
    handler: Handler<RouteContext<E, S, A, P, O>>,
  ): Router<E, S, A> {
    this.#add(method, path, options, handler as Handler<Context>);
    return this;
  }

  /**
   * Serves `child`'s routes under `prefix` (which may have params, but no
   * wildcard). `child` keeps its middleware and its auth (or takes this
   * router's with `auth: "inherit"`); limits, headers, CSRF and error
   * reporting come from the router serving the request. A router can be
   * mounted once, and not changed afterwards.
   */
  mount(prefix: string, child: Router<E, object, boolean>): this {
    this.#mutable();
    if (child === (this as unknown as Router<E, object, boolean>)) {
      throw new RouterError("a router cannot mount itself");
    }
    if (child.#mounted) throw new RouterError("that router is already mounted");
    const segments = parsePattern(prefix);
    if (segments.some((segment) => segment.kind === "wildcard")) {
      throw new RouterError(`a mount prefix cannot have a wildcard: ${prefix}`);
    }
    this.#mounts.push({ prefix: segments, child });
    try {
      this.#check();
    } catch (error) {
      this.#mounts.pop();
      throw error;
    }
    child.#mounted = true;
    return this;
  }

  /** Every route this router serves, mounted ones included, in the order added. */
  routes(): RouteInfo[] {
    return this.#compile().routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
      segments: route.segments,
      options: route.options,
      schemes: route.auth.mode === "schemes" ? route.auth.schemes : [],
    }));
  }

  /** Serves one request: the Worker `fetch` handler. */
  readonly fetch = async (
    request: Request,
    env?: E,
    ctx?: ExecutionContext,
  ): Promise<Response> => {
    const compiled = this.#compile();
    const requestId = (this.#options.requestId ?? ulid)();
    const c = new Context(request, env, ctx, requestId, this.#settings);
    let response: Response;
    try {
      if (headerBytes(request.headers) > this.#settings.limits.headers) {
        response = jsonError(
          431,
          "headers_too_large",
          "the request headers are too large",
          requestId,
        );
      } else {
        response = await this.#timed(
          c,
          compose(this.#middleware, (c) => this.#dispatch(compiled, c)),
        );
      }
    } catch (error) {
      response = await this.#fail(error, c);
    }
    return this.#finish(response, c);
  };

  #method(method: string): RouteMethod<E, S, A> {
    return ((
      path: string,
      second: RouteOptions | Handler<Context>,
      third?: Handler<Context>,
    ) => {
      if (typeof second === "function") this.#add(method, path, {}, second);
      else this.#add(method, path, second, third!);
      return this;
    }) as RouteMethod<E, S, A>;
  }

  #mutable(): void {
    if (this.#mounted) {
      throw new RouterError("a mounted router cannot be changed");
    }
    this.#compiled = null;
  }

  #add(
    method: string,
    path: string,
    options: RouteOptions,
    handler: Handler<Context>,
  ): void {
    this.#mutable();
    if (!METHOD.test(method)) {
      throw new RouterError(`not an upper-case method: ${method}`);
    }
    if (typeof handler !== "function") {
      throw new RouterError(`${method} ${path} has no handler`);
    }
    const segments = parsePattern(path);
    const route: RouteDef = { method, segments, options, handler };
    if (options.limits !== undefined) {
      checkLimits(options.limits, `${method} ${path} limits`);
    }
    if (options.body !== undefined && SAFE_METHODS.has(method)) {
      throw new RouterError(`${method} ${path} cannot have a body schema`);
    }
    if (this.#auth !== "inherit") checkAccess(route, this.#auth, segments);
    const shape = `${method} ${shapeOf(segments)}`;
    if (this.#shapes.has(shape)) {
      throw new RouterError(
        `${describeRoute(method, segments)} collides with another route`,
      );
    }
    this.#shapes.add(shape);
    this.#routes.push(route);
  }

  #flatten(
    prefix: readonly Segment[],
    chain: readonly Middleware<object>[],
    mappers: readonly ErrorMapper[],
    inherited: ResolvedAuth | "unset" | "defer",
  ): FlatRoute[] {
    const auth = this.#auth === "inherit" ? inherited : this.#auth;
    const out: FlatRoute[] = [];
    for (const route of this.#routes) {
      const segments = [...prefix, ...route.segments];
      if (auth !== "defer") checkAccess(route, auth, segments);
      const own = route.options.mapError;
      out.push({
        ...route,
        segments,
        pattern: formatPattern(segments),
        names: segments.flatMap((s) => s.kind === "static" ? [] : [s.name]),
        auth: typeof auth === "string" ? { mode: "none" } : auth,
        chain,
        mappers: own === undefined ? mappers : [own, ...mappers],
      });
    }
    for (const { prefix: more, child } of this.#mounts) {
      const map = child.#options.mapError;
      out.push(
        ...child.#flatten(
          [...prefix, ...more],
          [...chain, ...child.#middleware],
          map === undefined ? mappers : [map, ...mappers],
          auth,
        ),
      );
    }
    return out;
  }

  /** The serving router's own error hook, as a list. */
  #mappers(): readonly ErrorMapper[] {
    const map = this.#options.mapError;
    return map === undefined ? [] : [map];
  }

  #build(inherited: ResolvedAuth | "unset" | "defer"): Compiled {
    const routes = this.#flatten([], [], this.#mappers(), inherited);
    const trie = new Trie<FlatRoute>();
    for (const route of routes) trie.add(route.segments, route.method, route);
    return { trie, routes };
  }

  #check(): void {
    this.#build(this.#auth === "inherit" ? "defer" : this.#auth);
  }

  #compile(): Compiled {
    if (this.#compiled !== null) return this.#compiled;
    if (this.#auth === "inherit") {
      throw new RouterError(
        'a router with auth "inherit" must be mounted in another',
      );
    }
    this.#compiled = this.#build(this.#auth);
    return this.#compiled;
  }

  async #timed(
    c: Context,
    run: (c: Context) => Promise<Response>,
  ): Promise<Response> {
    let expired!: (response: Response) => void;
    const timeout = new Promise<Response>((resolve) => expired = resolve);
    const deadline = new Deadline(() => {
      abort(c, new DOMException("the request took too long", "TimeoutError"));
      expired(
        jsonError(503, "timeout", "the request took too long", c.requestId),
      );
    });
    deadlines.set(c, deadline);
    deadline.arm(this.#timeoutMs);
    const work = run(c);
    // After a timeout the work goes on unobserved; its failure is moot.
    work.catch(() => {});
    try {
      return await Promise.race([work, timeout]);
    } finally {
      deadline.settle();
    }
  }

  async #dispatch(compiled: Compiled, c: Context): Promise<Response> {
    try {
      const path = splitPath(c.url.pathname);
      if (path === null) {
        throw new HttpError(400, "the path is not valid percent-encoding");
      }
      const matches = compiled.trie.match(path);
      if (matches.length === 0) {
        throw new HttpError(404, "no route matches this path");
      }
      const method = c.req.method;
      for (const match of matches) {
        const route = match.entries.get(method) ??
          (method === "HEAD" ? match.entries.get("GET") : undefined);
        if (route !== undefined) return await this.#run(route, match.values, c);
      }
      const allow = methodsOf(matches);
      const first = matches[0].entries.values().next().value!;
      return await compose(first.chain, () =>
        Promise.resolve(
          method === "OPTIONS"
            ? new Response(null, { status: 204, headers: { allow } })
            : errorResponse(
              new HttpError(405, `${method} is not allowed here`, {
                headers: { allow },
              }),
              c.requestId,
            ),
        ))(c);
    } catch (error) {
      return await this.#fail(error, c);
    }
  }

  async #run(
    route: FlatRoute,
    values: readonly string[],
    c: Context,
  ): Promise<Response> {
    const params: Record<string, string> = {};
    route.names.forEach((name, index) => params[name] = values[index]);
    assign(c, { params, route: route.pattern });
    requestMappers.set(c, route.mappers);
    requestAuth.set(c, {
      schemes: route.auth.mode === "schemes" ? route.auth.schemes : [],
      scheme: undefined,
      refused: false,
    });
    const limits = route.options.limits;
    if (limits?.timeout !== undefined) {
      const deadline = deadlines.get(c);
      deadline?.arm(
        timeoutMs(limits.timeout, `${route.pattern} limits.timeout`),
      );
      // The 503 has gone out; the route must not act on a request answered.
      if (deadline?.expired) return c.empty(503);
    }
    configure(
      c,
      limits === undefined ? this.#settings : {
        ...this.#settings,
        limits: { ...this.#settings.limits, ...limits },
      },
      route.options.response,
    );
    return await compose(route.chain, (c) => this.#core(route, c))(c);
  }

  async #core(route: FlatRoute, c: Context): Promise<Response> {
    const before = route.options.before;
    if (before === undefined || before.length === 0) {
      return await this.#guarded(route, c);
    }
    return await compose(before, (c) => this.#guarded(route, c))(c);
  }

  async #guarded(route: FlatRoute, c: Context): Promise<Response> {
    const { options } = route;
    const limits = settingsOf(c).limits;
    checkContentLength(c.req, limits.body);

    let scheme: AuthScheme | undefined;
    if (route.auth.mode === "schemes") {
      const result = await authenticate(route.auth.schemes, c);
      if (result instanceof Response) return result;
      if (result === null && !options.public) {
        return unauthenticated(route.auth.schemes, c);
      }
      if (result !== null) {
        assign(c, { principal: result.principal });
        scheme = result.scheme;
        requestAuth.get(c)!.scheme = scheme;
        const denied = await this.#authorize(route, result, c);
        if (denied !== null) return denied;
      }
    }

    const csrf = this.#csrf !== null && options.csrf !== false &&
        !SAFE_METHODS.has(c.req.method) &&
        (options.csrf === true || scheme?.ambient === true)
      ? this.#csrf
      : null;
    if (csrf !== null) checkOrigin(c, csrf);

    if (options.params !== undefined) {
      assign(c, { params: await parse(options.params, c.params, "path") });
    }
    const query = toRecord(
      c.url.searchParams,
      options.query === undefined ? undefined : arrayKeys(options.query),
    );
    assign(c, {
      query: options.query === undefined
        ? query
        : await parse(options.query, query, "query"),
    });
    let form: Record<string, unknown> | undefined;
    if (options.body !== undefined) {
      let raw: unknown;
      if (options.bodyType === "form") {
        form = await readForm(c.req, limits, arrayKeys(options.body));
        raw = { ...form };
        if (csrf?.token) {
          delete (raw as Record<string, unknown>)[csrf.token.field];
        }
      } else {
        raw = await readJson(c.req, limits);
      }
      assign(c, { body: await parse(options.body, raw, "body") });
    }
    if (csrf !== null) checkToken(c, csrf, form);

    return await compose(
      options.use ?? [],
      (c) => Promise.resolve(route.handler(c)),
    )(c);
  }

  async #authorize(
    route: FlatRoute,
    auth: Authenticated,
    c: Context,
  ): Promise<Response | null> {
    const { options } = route;
    const { principal, scheme } = auth;
    const scopes = options.scopes ?? [];
    if (scopes.some((scope) => !principal.scopes.includes(scope))) {
      return challengeResponse(
        new AuthError(
          "insufficient_scope",
          `this needs the scopes: ${scopes.join(" ")}`,
          {
            scope: scopes,
          },
        ),
        [scheme],
        c,
      );
    }
    const roles = options.roles ?? [];
    if (
      roles.length > 0 && !roles.some((role) => principal.roles.includes(role))
    ) {
      return jsonError(
        403,
        "forbidden",
        `this needs one of the roles: ${roles.join(", ")}`,
        c.requestId,
      );
    }
    if (
      options.authorize !== undefined && !await options.authorize(principal, c)
    ) {
      return jsonError(403, "forbidden", "not allowed", c.requestId);
    }
    return null;
  }

  async #fail(error: unknown, c: Context): Promise<Response> {
    for (const map of requestMappers.get(c) ?? this.#mappers()) {
      try {
        const mapped = await map(error, c);
        if (mapped instanceof Response) return mapped;
        if (mapped !== null && mapped !== undefined) {
          throw new TypeError(
            "a mapError hook returned something other than a Response",
          );
        }
      } catch (thrown) {
        error = thrown;
        break;
      }
    }
    return this.#answer(error, c);
  }

  #answer(error: unknown, c: Context): Response {
    if (error instanceof AuthError) {
      const auth = requestAuth.get(c);
      if (auth === undefined) return challengeResponse(error, [], c);
      if (auth.scheme !== undefined) {
        return challengeResponse(error, [auth.scheme], c);
      }
      // RFC 6750 section 3.1: a request with no credentials gets no error
      // code or other error information in its challenges.
      return challengeResponse(error, auth.schemes, c, { anonymous: true });
    }
    if (!(error instanceof HttpError) || error.status >= 500 && !error.expose) {
      this.#report(error, c);
    }
    return errorResponse(error, c.requestId);
  }

  #report(error: unknown, c: Context): void {
    const reporter = this.#options.onError;
    if (reporter === undefined) return;
    try {
      const pending = reporter(error, c);
      if (pending instanceof Promise) c.ctx.waitUntil(pending.catch(() => {}));
    } catch {
      // A failing reporter must not change the answer.
    }
  }

  #finish(response: Response, c: Context): Response {
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of pendingHeaders(c)) {
      if (name.toLowerCase() === "set-cookie") headers.append(name, value);
      else headers.set(name, value);
    }
    const idHeader = this.#options.requestIdHeader ?? "x-request-id";
    if (idHeader !== false) headers.set(idHeader, c.requestId);
    applySecurityHeaders(
      headers,
      this.#options.security ?? {},
      c.url.protocol === "https:",
      c.principal !== null || requestAuth.get(c)?.refused === true,
      response.status,
    );
    return new Response(c.req.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * A new router. `auth` decides what "not public" means (see
 * {@link AuthConfig}); `E` types `c.env`.
 *
 * ```ts
 * const app = router<Env>({ auth: jwtBearer({ ... }) });
 * app.get("/health", { public: true }, (c) => c.text("ok"));
 * app.get("/notes/:id", { scopes: ["notes:read"] }, (c) => c.json({ id: c.params.id }));
 * export default { fetch: app.fetch };
 * ```
 */
export function router<E = unknown>(
  options: RouterOptions & { readonly auth: "none" },
): Router<E, Empty, false>;
export function router<E = unknown>(
  options?: RouterOptions,
): Router<E, Empty, true>;
export function router<E = unknown>(
  options: RouterOptions = {},
): Router<E, Empty, boolean> {
  return new Router<E, Empty, boolean>(options);
}
