// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Router}: routes, the request pipeline and every default in it.
 *
 * A request goes through, in order:
 *
 * 1. the header size limit (431), the URL and query limits (414, and 400
 *    for too many query fields), and the time budget (504; a matched
 *    route's own `limits.timeout` replaces the router's, everything is at
 *    most `maxTimeout`, the budget ends when a response is returned, so a
 *    streamed body is not cut off, and once it is spent no later stage
 *    starts);
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
 * set through the context; then, when `cors()` saw the request, its
 * policy rewrites every `Access-Control-*` header, so nothing upstream of
 * that stage can widen it (without `cors()` every such header is removed,
 * unless the router says `cors: "passthrough"`). `fetch` never rejects:
 * `c.header` checks names and values where they are given, and a failure
 * here anyway is a bare 500.
 *
 * Before any of that, the request's public URL is resolved
 * (`RouterOptions.publicUrl`); the cleartext rule of the credential
 * schemes, the CSRF origin check, HSTS and DPoP's `htu` use it.
 *
 * @module
 */

import { MAX_TIMER_MS } from "@celld/core/bounds";
import { ulid } from "@celld/core/ulid";
import type { AnySchema, Input, Output, SieveError } from "@celld/sieve";
import {
  AuthError,
  type AuthScheme,
  formatChallenge,
  isDelegating,
  type Principal,
  toPrincipal,
} from "./auth.ts";
import {
  checkContentLength,
  checkUrl,
  DEFAULT_LIMITS,
  headerBytes,
  isForm,
  type Limits,
  toRecord,
} from "./body.ts";
import {
  type ClientIpOptions,
  explicitPeer,
  peerAddress,
} from "./client_ip.ts";
import {
  compileClientIp,
  compileCookies,
  compileScheme,
  compileSecurity,
  functionList,
  IS,
  originOf,
  stringList,
} from "./compile.ts";
import {
  abort,
  assign,
  bufferBody,
  configure,
  Context,
  type ContextSettings,
  pendingHeaders,
  readFormBody,
  readJsonBody,
  requestOf,
  setPublicUrl,
  settingsOf,
} from "./context.ts";
import type { CookieOptions } from "./cookies.ts";
import {
  checkOrigin,
  checkToken,
  compileRouteCsrf,
  type CsrfOptions,
  resolveCsrf,
  type ResolvedCsrf,
  type RouteCsrf,
  SAFE_METHODS,
} from "./csrf.ts";
import { applyCorsPolicy, corsPreflight } from "./cors.ts";
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
  type ParamNames,
  parsePattern,
  type PathParams,
  type Segment,
  shapeOf,
  splitPath,
  Trie,
} from "./path.ts";
import {
  compilePublicUrl,
  type PublicUrlOptions,
  resolvePublicUrl,
} from "./public_url.ts";
import { applySecurityHeaders, type SecurityHeaders } from "./security.ts";
import {
  exactBoolean,
  optionsRecord,
  SCOPE_TOKEN,
  tokenList,
} from "./validation.ts";

import type {
  BrowserRoute,
  ContractOptions,
  RegisteredRoutes,
  RoutesOf,
} from "./contract.ts";
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
 * router's, counted from the start of the request, and is at most the
 * serving router's `maxTimeout`; `false` means none of its own (long work
 * before a response, say), which still ends at that `maxTimeout`.
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
 *   the router it is mounted in. Mounted (at any depth) under `"none"`,
 *   every one of its routes must be `public: true`, or the mount is a
 *   {@link RouterError}; its handlers' principal is nullable unless the
 *   route demands scopes, roles or `authorize`.
 *
 * Leaving it out means every route must be `public: true`; any other route
 * is a {@link RouterError} when it is added.
 */
export type AuthConfig =
  | AuthScheme
  | readonly AuthScheme[]
  | "none"
  | "inherit";

/**
 * Router settings. Everything but `auth` and `mapError` applies only on
 * the router that serves the request, so a router given any of the others
 * cannot be mounted (see {@link Router.mount}).
 */
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
  /**
   * How the URL the client used is found ({@link Context.publicUrl}); see
   * {@link PublicUrlOptions}. Default `{ mode: "request" }`, the request
   * URL. Behind a TLS-terminating proxy, name it: `{ mode: "fixed",
   * origin }`, or `{ mode: "trusted-proxy", trustedProxies }`. Nothing
   * is read from `X-Forwarded-*` headers otherwise.
   */
  readonly publicUrl?: PublicUrlOptions;
  /**
   * Let every built-in credential scheme accept credentials over plain
   * http on any host. Default false: off loopback IP literals, a
   * credential sent over http is refused (403 `insecure_transport`), since
   * it crossed the network readable. For local development only.
   */
  readonly allowCleartextCredentialsForDevelopment?: boolean;
  /**
   * What happens to `Access-Control-*` headers on responses no `cors()`
   * middleware saw. Default: they are removed, so a handler, an error
   * mapper or a proxied upstream response cannot grant cross-origin access
   * by accident. `"passthrough"` leaves them as they were set.
   */
  readonly cors?: "passthrough";
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
   * ambient credential (a login form, say); `{ source: "header" }` checks
   * as the router would but takes the double-submit token from the header
   * only, never reading the body for it. See {@link RouteCsrf}; a setting
   * that could never apply (on a `GET` route, under `csrf: false`, or a
   * header source without tokens) is a {@link RouterError}.
   */
  readonly csrf?: RouteCsrf;
  /**
   * For OpenAPI: the answers this route gives, by status (`201`, `204`,
   * `409`, or `"default"`). A 2xx entry without a `schema` takes the
   * route's `response` schema (except 204, 205 and 304, which have no
   * body). Without a 2xx entry the document lists `200`. The errors the
   * router itself answers (400, 401, 403, 413, 415) are added where they
   * can happen, unless listed here.
   */
  readonly responses?: Readonly<Record<number | string, RouteResponse>>;
  /** For OpenAPI. */
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly deprecated?: boolean;
}

/** One documented answer of a route; see {@link RouteOptions.responses}. */
export interface RouteResponse {
  readonly description: string;
  /** The JSON body, as the handler sends it. */
  readonly schema?: AnySchema;
}

type SchemaOf<O, K extends string> = O extends { readonly [P in K]: infer S }
  ? (S extends AnySchema ? S : never)
  : never;

/**
 * Whether a route's options demand a principal whatever auth it ends up
 * under: a non-empty `scopes` or `roles` list, or `authorize`. Such a route
 * cannot be anonymous (under `auth: "none"` it is a registration error).
 */
type Demands<O> = O extends { readonly scopes: readonly [string, ...string[]] }
  ? true
  : O extends { readonly roles: readonly [string, ...string[]] } ? true
  : O extends { readonly authorize: (...args: never[]) => unknown } ? true
  : false;

/**
 * The context types of a route: from its pattern, its options and the
 * router. `A` is whether the router's routes are authenticated: `true` for
 * schemes, `false` for `auth: "none"`, `boolean` when that is not known
 * statically (`auth: "inherit"`, or an `AuthConfig` variable), where the
 * principal is nullable unless the route {@link Demands} one.
 */
export interface RouteTypes<
  E,
  S extends object,
  A extends boolean,
  P extends string,
  O,
  Pre extends string = never,
> {
  env: E;
  params: [SchemaOf<O, "params">] extends [never]
    ? ([Pre] extends [never] ? PathParams<P>
      : { readonly [K in ParamNames<P> | Pre]: string })
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
  principal: [A] extends [false] ? null
    : O extends { readonly public: true } ? Principal | null
    : [A] extends [true] ? Principal
    : Demands<O> extends true ? Principal
    : Principal | null;
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
  Pre extends string = never,
> = Context<RouteTypes<E, S, A, P, O, Pre>>;

/** Adds a route for one method: `(path, handler)` or `(path, options, handler)`. */
export interface RouteMethod<
  E,
  S extends object,
  A extends boolean,
  Pre extends string = never,
> {
  <const P extends string>(
    path: P,
    handler: Handler<RouteContext<E, S, A, P, Empty, Pre>>,
  ): Router<E, S, A, Pre>;
  <const P extends string, const O extends RouteOptions>(
    path: P,
    options: O & NoExtraRouteOptions<O>,
    handler: Handler<RouteContext<E, S, A, P, O, Pre>>,
  ): Router<E, S, A, Pre>;
}

/** Reject misspelled options even when inference captures an intermediate value. */
type NoExtraRouteOptions<O> =
  & Record<Exclude<keyof O, keyof RouteOptions>, never>
  & (O extends { readonly limits: infer L } ? {
      readonly limits: L & Record<Exclude<keyof L, keyof RouteLimits>, never>;
    }
    : unknown)
  & (O extends { readonly responses: infer R } ? {
      readonly responses: {
        readonly [K in keyof R]:
          & R[K]
          & Record<Exclude<keyof R[K], keyof RouteResponse>, never>;
      };
    }
    : unknown);

/** A route as {@link Router.routes} lists it: a frozen copy, fresh on every call. */
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
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** What a request id may be: it goes into a header and every log line. */
const REQUEST_ID = /^[\x21-\x7E]{1,256}$/;

/**
 * The settings that only the router serving a request applies: all but
 * `auth` and `mapError`. A mounted router's would be ignored, so a router
 * given any of them cannot be mounted.
 */
const SERVING_SETTINGS = [
  "limits",
  "security",
  "csrf",
  "cookies",
  "clientIp",
  "onError",
  "requestId",
  "requestIdHeader",
  "publicUrl",
  "allowCleartextCredentialsForDevelopment",
  "cors",
] as const satisfies readonly (keyof RouterOptions)[];

function resolveAuth(auth: AuthConfig | undefined): OwnAuth {
  if (auth === undefined) return "unset";
  if (auth === "none" || auth === "inherit") {
    return auth === "none" ? Object.freeze({ mode: "none" }) : "inherit";
  }
  const schemes: readonly AuthScheme[] = Object.freeze(
    (Array.isArray(auth) ? [...auth as readonly AuthScheme[]] : [
      auth as AuthScheme,
    ]).map(compileScheme),
  );
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
  return Object.freeze({ mode: "schemes", schemes });
}

function describeRoute(method: string, segments: readonly Segment[]): string {
  return `${method} ${formatPattern(segments)}`;
}

/** Throws unless a route's access settings make sense under `auth`. */
function checkAccess(
  route: RouteDef,
  auth: ResolvedAuth | "unset",
  where: readonly Segment[],
  inherits = false,
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
  // An inheriting router's routes were written expecting authentication;
  // under "none" they would run anonymously. Only public ones may.
  if (inherits && auth !== "unset" && auth.mode === "none" && !options.public) {
    throw new RouterError(
      `${name} inherits auth from a router with auth "none": mark it ` +
        `{ public: true }, or give the router it is in auth of its own`,
    );
  }
}

/**
 * Throws unless the route's CSRF setting can apply under `csrf`, the
 * policy of the router building it.
 */
function checkRouteCsrf(
  route: RouteDef,
  csrf: ResolvedCsrf | null,
  name: string,
): void {
  const own = route.options.csrf;
  if (own === undefined || own === false) return;
  if (csrf === null) {
    throw new RouterError(
      `${name} asks for a csrf check, but its router has csrf: false`,
    );
  }
  if (typeof own === "object" && csrf.token === null) {
    throw new RouterError(
      `${name} takes its csrf token from a header, but its router has no csrf tokens`,
    );
  }
}

/** Throws unless every parameter of the flattened route has its own name. */
function checkNames(method: string, segments: readonly Segment[]): void {
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind === "static") continue;
    if (seen.has(segment.name)) {
      throw new RouterError(
        `${
          describeRoute(method, segments)
        } names the parameter ${segment.name} twice`,
      );
    }
    seen.add(segment.name);
  }
}

/**
 * Validates route options and returns a frozen copy: lists are copied,
 * `limits` checked and copied, schemas and functions kept by reference.
 * The caller's object is left as it was.
 */
function compileRouteOptions(
  options: RouteOptions,
  where: string,
): RouteOptions {
  optionsRecord(options, [
    "public",
    "csrf",
    "deprecated",
    "summary",
    "description",
    "operationId",
    "authorize",
    "mapError",
    "params",
    "query",
    "body",
    "response",
    "bodyType",
    "scopes",
    "roles",
    "tags",
    "use",
    "before",
    "responses",
    "limits",
  ], where);
  if (typeof options !== "object" || options === null) {
    throw new RouterError(`${where} options must be an object`);
  }
  const out: Record<string, unknown> = {};
  const take = (key: keyof RouteOptions, type: keyof typeof IS) => {
    const value = options[key];
    if (value === undefined) return;
    if (!IS[type](value)) {
      throw new RouterError(`${where} ${key} must be a ${type}`);
    }
    out[key] = value;
  };
  take("public", "boolean");
  if (options.csrf !== undefined) {
    out.csrf = compileRouteCsrf(options.csrf, where);
  }
  take("deprecated", "boolean");
  take("summary", "string");
  take("description", "string");
  take("operationId", "string");
  take("authorize", "function");
  take("mapError", "function");
  for (const key of ["params", "query", "body", "response"] as const) {
    const schema = options[key];
    if (schema === undefined) continue;
    if (
      typeof schema !== "object" || schema === null ||
      typeof schema.safeParseAsync !== "function"
    ) {
      throw new RouterError(`${where} ${key} must be a schema`);
    }
    out[key] = schema;
  }
  if (options.bodyType !== undefined) {
    if (options.bodyType !== "json" && options.bodyType !== "form") {
      throw new RouterError(`${where} bodyType must be "json" or "form"`);
    }
    out.bodyType = options.bodyType;
  }
  for (const key of ["scopes", "roles", "tags"] as const) {
    if (key !== "tags") {
      tokenList(
        options[key],
        `${where} ${key}`,
        // deno-lint-ignore no-control-regex
        key === "scopes" ? SCOPE_TOKEN : /^[^\u0000-\u001f\u007f]+$/u,
        false,
      );
    }
    const list = stringList(options[key], `${where} ${key}`);
    if (list !== undefined) out[key] = list;
  }
  for (const key of ["use", "before"] as const) {
    const list = functionList(options[key], `${where} ${key}`);
    if (list !== undefined) out[key] = list;
  }
  if (options.responses !== undefined) {
    out.responses = compileResponses(options.responses, where);
  }
  if (options.limits !== undefined) {
    optionsRecord(
      options.limits,
      ["body", "jsonDepth", "jsonKeys", "timeout"],
      `${where} limits`,
    );
    if (typeof options.limits !== "object" || options.limits === null) {
      throw new RouterError(`${where} limits must be an object`);
    }
    const limits: Record<string, unknown> = {};
    for (const key of ["body", "jsonDepth", "jsonKeys", "timeout"] as const) {
      if (options.limits[key] !== undefined) limits[key] = options.limits[key];
    }
    checkLimits(limits, `${where} limits`);
    out.limits = Object.freeze(limits);
  }
  return Object.freeze(out) as RouteOptions;
}

const STATUS_KEY = /^(?:[1-5][0-9][0-9]|default)$/;

function isSchema(value: unknown): value is AnySchema {
  return typeof value === "object" && value !== null &&
    typeof (value as { safeParseAsync?: unknown }).safeParseAsync ===
      "function";
}

/** A frozen, validated copy of a route's `responses`. */
function compileResponses(
  responses: unknown,
  where: string,
): Readonly<Record<string, RouteResponse>> {
  if (typeof responses !== "object" || responses === null) {
    throw new RouterError(`${where} responses must be an object`);
  }
  const out: Record<string, RouteResponse> = Object.create(null);
  for (const [status, entry] of Object.entries(responses)) {
    optionsRecord(
      entry,
      ["description", "schema"],
      `${where} responses ${status}`,
    );
    if (!STATUS_KEY.test(status)) {
      throw new RouterError(
        `${where} responses: ${
          JSON.stringify(status)
        } is not a status (100 to 599, or "default")`,
      );
    }
    const { description, schema } = (entry ?? {}) as Partial<RouteResponse>;
    if (typeof entry !== "object" || typeof description !== "string") {
      throw new RouterError(
        `${where} responses[${status}] needs a description`,
      );
    }
    if (schema !== undefined && !isSchema(schema)) {
      throw new RouterError(
        `${where} responses[${status}].schema must be a schema`,
      );
    }
    out[status] = Object.freeze({
      description,
      ...(schema === undefined ? {} : { schema }),
    });
  }
  return Object.freeze(out);
}

/** A fresh frozen copy of compiled route options, for {@link Router.routes}. */
function copyRouteOptions(options: RouteOptions): RouteOptions {
  const out: Record<string, unknown> = { ...options };
  for (const key of ["scopes", "roles", "tags", "use", "before"] as const) {
    const list = options[key];
    if (list !== undefined) out[key] = Object.freeze([...list]);
  }
  if (options.limits !== undefined) {
    out.limits = Object.freeze({ ...options.limits });
  }
  if (options.responses !== undefined) {
    const responses: Record<string, RouteResponse> = Object.create(null);
    for (const [status, entry] of Object.entries(options.responses)) {
      responses[status] = Object.freeze({ ...entry });
    }
    out.responses = Object.freeze(responses);
  }
  return Object.freeze(out) as RouteOptions;
}

function checkLimits(limits: Partial<Limits>, what: string): void {
  optionsRecord(limits, [
    "body",
    "headers",
    "jsonDepth",
    "jsonKeys",
    "maxUrlBytes",
    "maxQueryBytes",
    "maxQueryFields",
    "timeout",
    "maxTimeout",
  ], what);
  for (
    const key of [
      "body",
      "headers",
      "jsonDepth",
      "jsonKeys",
      "maxUrlBytes",
      "maxQueryBytes",
      "maxQueryFields",
    ] as const
  ) {
    const value = limits[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RouterError(`${what}.${key} must be a positive integer`);
    }
  }
  const max = limits.maxTimeout === undefined
    ? MAX_TIMER_MS
    : maxTimeoutMs(limits.maxTimeout, `${what}.maxTimeout`);
  timeoutMs(limits.timeout, `${what}.timeout`, max);
}

/** A router's `maxTimeout` in milliseconds, at most the timer range. */
function maxTimeoutMs(maxTimeout: Duration, what: string): number {
  return durationMs(maxTimeout, what, {
    maxMs: MAX_TIMER_MS,
    maxName: "2^31 - 1 ms (the longest timer)",
  });
}

/**
 * A timeout in milliseconds, null when none is given; throws
 * {@link RouterError} for a bad one or one over `maxMs`. `false` (none of
 * its own) is `maxMs`: nothing escapes the maximum.
 */
function timeoutMs(
  timeout: Duration | false | undefined,
  what: string,
  maxMs: number,
): number | null {
  if (timeout === undefined) return null;
  if (timeout === false) return maxMs;
  return durationMs(timeout, what, {
    maxMs,
    maxName: `the router's limits.maxTimeout (${maxMs} ms)`,
  });
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
    const due = this.#start + ms;
    const wait = () => {
      const left = due - Date.now();
      if (left <= 0) this.#fire();
      // A timer takes at most 2^31 - 1 ms (a larger delay fires at once),
      // so a longer deadline is re-armed in steps.
      else this.#timer = setTimeout(wait, Math.min(left, MAX_TIMER_MS));
    };
    wait();
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

/**
 * What the pipeline returns in place of a stage once the request's time
 * budget has run out, null while it lasts. The client already has the
 * 504; this answer is discarded.
 */
function abandoned(c: Context): Response | null {
  if (deadlines.get(c)?.expired !== true) return null;
  return jsonError(504, "timeout", "the request took too long", c.requestId);
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
  // A credential refused for crossing plain http gets no challenge: a
  // browser would prompt for it again, over the same connection.
  if (error.code === "insecure_transport") return response;
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
      requestAuth.get(c)!.refused = true;
      if (!(error instanceof AuthError)) throw error;
      outcome = error;
    }
    if (outcome === null) continue;
    if (outcome instanceof AuthError) {
      requestAuth.get(c)!.refused = true;
      return challengeResponse(outcome, [scheme], c);
    }
    // A malformed scheme result is still an authentication attempt. Never
    // let a programmer error here make a credentialed response cacheable.
    requestAuth.get(c)!.refused = true;
    // `scheme` is the first part of the principal's key: a scheme answers
    // for itself, except a session, which carries the scheme its principal
    // logged in with (sealed in its cookie).
    const name = isDelegating(scheme) && typeof outcome.scheme === "string"
      ? outcome.scheme
      : scheme.name;
    const principal = toPrincipal(outcome, name);
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
  Pre extends string = never,
> {
  readonly #auth: OwnAuth;
  readonly #settings: ContextSettings;
  readonly #csrf: ResolvedCsrf | null;
  readonly #timeoutMs: number | null;
  readonly #maxTimeoutMs: number;
  readonly #security: SecurityHeaders;
  readonly #onError: ErrorReporter | undefined;
  readonly #mapError: ErrorMapper | undefined;
  readonly #requestId: () => string;
  readonly #requestIdHeader: string | false;
  readonly #corsPassthrough: boolean;
  /** The serving-router settings it was given; such a router is never mounted. */
  readonly #own: readonly string[];
  readonly #middleware: Middleware<object>[] = [];
  readonly #routes: RouteDef[] = [];
  readonly #shapes = new Set<string>();
  #registrationTrie = new Trie<RouteDef>();
  readonly #mounts: {
    prefix: readonly Segment[];
    child: Router<E, object, boolean>;
  }[] = [];
  #mounted = false;
  #compiled: Compiled | null = null;

  /**
   * Throws {@link RouterError} for bad settings; see {@link RouterOptions}.
   * Every setting is validated and copied here: changing `options` (or
   * anything in it) afterwards changes nothing.
   */
  constructor(options: RouterOptions = {}) {
    optionsRecord(options, [
      "auth",
      "limits",
      "allowCleartextCredentialsForDevelopment",
      "csrf",
      "clientIp",
      "publicUrl",
      "cookies",
      "cors",
      "security",
      "onError",
      "mapError",
      "requestId",
      "requestIdHeader",
    ], "router options");
    this.#auth = resolveAuth(options.auth);
    this.#own = Object.freeze(
      SERVING_SETTINGS.filter((key) => options[key] !== undefined),
    );
    checkLimits(options.limits ?? {}, "limits");
    const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    const cleartext = options.allowCleartextCredentialsForDevelopment ?? false;
    if (typeof cleartext !== "boolean") {
      throw new RouterError(
        "allowCleartextCredentialsForDevelopment must be a boolean",
      );
    }
    const csrf = options.csrf === false ? null : resolveCsrf(options.csrf);
    this.#csrf = csrf === null ? null : Object.freeze({
      trustedOrigins: new Set(csrf.trustedOrigins),
      token: csrf.token === null ? null : Object.freeze({ ...csrf.token }),
    });
    const clientIp = compileClientIp(options.clientIp);
    const publicUrl = compilePublicUrl(options.publicUrl);
    if (publicUrl.mode === "trusted-proxy" && !explicitPeer(clientIp)) {
      throw new RouterError(
        'publicUrl: { mode: "trusted-proxy" } needs the peer source named: ' +
          'clientIp.peer, or clientIp.peerHeader ("cf-connecting-ip" on ' +
          "Cloudflare's edge); the default header is one clients can write",
      );
    }
    this.#settings = Object.freeze({
      csrf: this.#csrf,
      limits,
      cookies: compileCookies(options.cookies),
      clientIp,
      publicUrl,
      allowCleartextCredentialsForDevelopment: cleartext,
    });
    if (options.cors !== undefined && options.cors !== "passthrough") {
      throw new RouterError('cors must be "passthrough" when it is set');
    }
    this.#corsPassthrough = options.cors === "passthrough";
    this.#maxTimeoutMs = maxTimeoutMs(limits.maxTimeout, "limits.maxTimeout");
    this.#timeoutMs = timeoutMs(
      limits.timeout,
      "limits.timeout",
      this.#maxTimeoutMs,
    );
    this.#security = compileSecurity(options.security);
    for (const key of ["onError", "mapError", "requestId"] as const) {
      if (options[key] !== undefined && typeof options[key] !== "function") {
        throw new RouterError(`${key} must be a function`);
      }
    }
    this.#onError = options.onError;
    this.#mapError = options.mapError;
    this.#requestId = options.requestId ?? ulid;
    const idHeader = options.requestIdHeader ?? "x-request-id";
    if (
      idHeader !== false &&
      (typeof idHeader !== "string" || !HEADER_NAME.test(idHeader))
    ) {
      throw new RouterError("requestIdHeader must be a header name or false");
    }
    this.#requestIdHeader = idHeader;
  }

  /**
   * Adds middleware around every route of this router (and, on the router
   * that serves requests, around 404s, 405s and automatic `OPTIONS` too).
   * It runs before authentication: `c.principal` is not set yet.
   */
  use<M extends Middleware<object>>(
    middleware: M,
  ): Router<E, S & AddsOf<M>, A, Pre> {
    this.#mutable();
    if (typeof middleware !== "function") {
      throw new RouterError("middleware must be a function");
    }
    this.#middleware.push(middleware);
    return this as unknown as Router<E, S & AddsOf<M>, A, Pre>;
  }

  /** `GET`; `HEAD` is served by it unless there is a `HEAD` route. */
  readonly get: RouteMethod<E, S, A, Pre> = this.#method("GET");
  readonly post: RouteMethod<E, S, A, Pre> = this.#method("POST");
  readonly put: RouteMethod<E, S, A, Pre> = this.#method("PUT");
  readonly patch: RouteMethod<E, S, A, Pre> = this.#method("PATCH");
  readonly delete: RouteMethod<E, S, A, Pre> = this.#method("DELETE");
  readonly head: RouteMethod<E, S, A, Pre> = this.#method("HEAD");
  /** An explicit `OPTIONS` route replaces the automatic `204` with `Allow`. */
  readonly options: RouteMethod<E, S, A, Pre> = this.#method("OPTIONS");

  /**
   * Adds a route for another method (`PURGE`, `PROPFIND`, ...); same
   * arguments as {@link get} after the method.
   */
  on<const P extends string>(
    method: string,
    path: P,
    handler: Handler<RouteContext<E, S, A, P, Empty, Pre>>,
  ): Router<E, S, A, Pre>;
  on<const P extends string, const O extends RouteOptions>(
    method: string,
    path: P,
    options: O & NoExtraRouteOptions<O>,
    handler: Handler<RouteContext<E, S, A, P, O, Pre>>,
  ): Router<E, S, A, Pre>;
  on(
    method: string,
    path: string,
    options: RouteOptions | Handler<Context>,
    handler?: Handler<Context>,
  ): Router<E, S, A, Pre> {
    this.#add(
      method,
      path,
      typeof options === "function" ? {} : options,
      typeof options === "function" ? options : handler!,
    );
    return this;
  }

  /**
   * Registers a shared schema-only definition, keeping handlers and access
   * policy on the server. Chain the returned registrations to retain the
   * route union used by the browser client's type-only router contract.
   */
  register<T extends this, const D extends BrowserRoute>(
    this: T,
    definition: D,
    handler: Handler<RouteContext<E, S, A, D["path"], D["options"], Pre>>,
  ): Router<E, S, A, Pre> & RegisteredRoutes<RoutesOf<T> | D>;
  register<
    T extends this,
    const D extends BrowserRoute,
    const O extends Omit<RouteOptions, keyof ContractOptions>,
  >(
    this: T,
    definition: D,
    options:
      & O
      & NoExtraRouteOptions<O>
      & Record<Extract<keyof O, keyof ContractOptions>, never>,
    handler: Handler<RouteContext<E, S, A, D["path"], D["options"] & O, Pre>>,
  ): Router<E, S, A, Pre> & RegisteredRoutes<RoutesOf<T> | D>;
  register(
    definition: BrowserRoute,
    options: Omit<RouteOptions, keyof ContractOptions> | Handler<Context>,
    handler?: Handler<Context>,
  ): Router<E, S, A, Pre> & RegisteredRoutes<BrowserRoute> {
    const serverOptions = typeof options === "function" ? {} : options;
    for (
      const key of [
        "params",
        "query",
        "body",
        "bodyType",
        "response",
        "responses",
      ]
    ) {
      if (Object.hasOwn(serverOptions, key)) {
        throw new RouterError(`register cannot override the shared ${key}`);
      }
    }
    this.#add(
      definition.method,
      definition.path,
      { ...serverOptions, ...definition.options },
      typeof options === "function" ? options : handler!,
    );
    return this as unknown as
      & Router<E, S, A, Pre>
      & RegisteredRoutes<BrowserRoute>;
  }

  /**
   * Serves `child`'s routes under `prefix` (which may have params, but no
   * wildcard). `child` keeps its middleware, its routes' own settings, its
   * `mapError` and its auth (or takes this router's with `auth:
   * "inherit"`); limits, headers, CSRF, cookies, client IP, public URL,
   * request ids and error reporting come from the router serving the
   * request, so a `child` made with any of those settings is refused
   * rather than silently weakened. A router can be mounted once, and not
   * changed afterwards. Throws {@link RouterError}, leaving this router as
   * it was, for such a `child`; when a flattened route would name a
   * parameter twice (`/orgs/:id` over `/users/:id`); when an inheriting
   * router's private route would end up under `auth: "none"`; when two
   * different scheme objects of one name would serve in one tree (their
   * principals' `key`s would collide); or on any other conflict.
   */
  mount<const P extends string, C extends string = never>(
    prefix: P,
    mounted:
      & Router<E, object, boolean, C>
      & NoInfer<
        [C] extends [Pre | ParamNames<P>] ? unknown
          : { readonly "~prefix": `the prefix does not supply ${C}` }
      >,
  ): this {
    this.#mutable();
    const child = mounted as unknown as Router<E, object, boolean>;
    if (child === (this as unknown as Router<E, object, boolean>)) {
      throw new RouterError("a router cannot mount itself");
    }
    if (child.#mounted) throw new RouterError("that router is already mounted");
    if (child.#own.length > 0) {
      const own = child.#own;
      throw new RouterError(
        `a router made with its own ${
          own.join(", ")
        } cannot be mounted: a mounted router's routes run under the ` +
          "settings of the router serving the request, so " +
          (own.length === 1 ? "that one" : "those") +
          " would be ignored; set them on the serving router" +
          (own.includes("limits")
            ? " (a route's own limits: body, jsonDepth, jsonKeys and " +
              "timeout, travel with it)"
            : ""),
      );
    }
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

  /**
   * Every route this router serves, mounted ones included, in the order
   * added. Each is a frozen copy made for this call; the router's own
   * records are never handed out.
   */
  routes(): RouteInfo[] {
    return this.#compile().routes.map((route) =>
      Object.freeze({
        method: route.method,
        pattern: route.pattern,
        segments: Object.freeze(
          route.segments.map((segment) => Object.freeze({ ...segment })),
        ),
        options: copyRouteOptions(route.options),
        schemes: Object.freeze(
          route.auth.mode === "schemes" ? [...route.auth.schemes] : [],
        ),
      })
    );
  }

  /** Check all configured auth algorithms, keys and dependencies before listen. */
  async ready(): Promise<void> {
    const schemes = new Set<AuthScheme>();
    for (const route of this.#compile().routes) {
      if (route.auth.mode === "schemes") {
        for (const scheme of route.auth.schemes) {
          schemes.add(originOf(scheme));
        }
      }
    }
    await Promise.all([...schemes].map((s) => s.ready?.()));
  }

  /** Serves one request: the Worker `fetch` handler. */
  readonly fetch = async (
    request: Request,
    env?: E,
    ctx?: ExecutionContext,
  ): Promise<Response> => {
    let requestId: string;
    let badId: unknown = null;
    try {
      requestId = this.#requestId();
      if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
        badId = new TypeError(
          "requestId() returned something that is not 1 to 256 visible ASCII characters",
        );
        requestId = ulid();
      }
    } catch (error) {
      badId = error;
      requestId = ulid();
    }
    const c = new Context(request, env, ctx, requestId, this.#settings);
    if (badId !== null) this.#report(badId, c);
    let response: Response;
    try {
      // Every route is checked as it is added, so this cannot fail for a
      // router that registered; if it does, it is a 500 like any error.
      const compiled = this.#compile();
      setPublicUrl(
        c,
        resolvePublicUrl(this.#settings.publicUrl, c, peerAddress),
      );
      if (headerBytes(request.headers) > this.#settings.limits.headers) {
        response = jsonError(
          431,
          "headers_too_large",
          "the request headers are too large",
          requestId,
        );
      } else {
        checkUrl(request.url, this.#settings.limits);
        response = await this.#timed(
          c,
          async (c) => {
            const requested = requestOf(c).headers.get(
              "access-control-request-method",
            );
            if (requestOf(c).method === "OPTIONS" && requested !== null) {
              const path = splitPath(c.url.pathname);
              if (path === null) {
                throw new HttpError(
                  400,
                  "the path is not valid percent-encoding",
                );
              }
              const matches = compiled.trie.match(path);
              let selected: FlatRoute | undefined;
              for (const match of matches) {
                selected = match.entries.get(requested) ??
                  (requested === "HEAD" ? match.entries.get("GET") : undefined);
                if (selected !== undefined) break;
              }
              selected ??= matches[0]?.entries.values().next().value;
              const preflight = corsPreflight(c, [
                ...this.#middleware,
                ...(selected?.chain ?? []),
                ...(selected?.options.before ?? []),
                ...(selected?.options.use ?? []),
              ]);
              if (preflight !== null) return preflight;
            }
            return await compose(
              this.#middleware,
              (c) => this.#dispatch(compiled, c),
            )(c);
          },
        );
      }
    } catch (error) {
      response = await this.#fail(error, c);
    }
    try {
      return this.#finish(response, c);
    } catch (error) {
      // Nothing above should throw (header names and values are checked
      // where they are given); if something does, `fetch` still answers.
      this.#report(error, c);
      const opaque = jsonError(
        500,
        "internal_error",
        "internal error",
        c.requestId,
      );
      opaque.headers.set("cache-control", "no-store");
      opaque.headers.set("x-content-type-options", "nosniff");
      if (this.#requestIdHeader !== false) {
        opaque.headers.set(this.#requestIdHeader, c.requestId);
      }
      return opaque;
    }
  };

  #method(method: string): RouteMethod<E, S, A, Pre> {
    return ((
      path: string,
      second: RouteOptions | Handler<Context>,
      third?: Handler<Context>,
    ) => {
      if (typeof second === "function") this.#add(method, path, {}, second);
      else this.#add(method, path, second, third!);
      return this;
    }) as RouteMethod<E, S, A, Pre>;
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
    if (method === "TRACE" || method === "CONNECT") {
      throw new RouterError(
        "TRACE and CONNECT are not supported by the safe router",
      );
    }
    if (typeof handler !== "function") {
      throw new RouterError(`${method} ${path} has no handler`);
    }
    const segments = Object.freeze(parsePattern(path));
    checkNames(method, segments);
    const compiled = compileRouteOptions(options, `${method} ${path}`);
    const route: RouteDef = Object.freeze({
      method,
      segments,
      options: compiled,
      handler,
    });
    if (compiled.body !== undefined && SAFE_METHODS.has(method)) {
      throw new RouterError(`${method} ${path} cannot have a body schema`);
    }
    if (
      compiled.csrf !== undefined && compiled.csrf !== false &&
      SAFE_METHODS.has(method)
    ) {
      throw new RouterError(
        `${method} ${path} asks for a csrf check, which ${method} never gets`,
      );
    }
    if (this.#auth !== "inherit") checkAccess(route, this.#auth, segments);
    timeoutMs(
      compiled.limits?.timeout,
      `${method} ${path} limits.timeout`,
      this.#maxTimeoutMs,
    );
    checkRouteCsrf(route, this.#csrf, `${method} ${path}`);
    const shape = `${method} ${shapeOf(segments)}`;
    if (this.#shapes.has(shape)) {
      throw new RouterError(
        `${describeRoute(method, segments)} collides with another route`,
      );
    }
    // Every existing route was validated at insertion/mount. The only new
    // cross-route invariant is this shape's collision; do O(path) work.
    this.#registrationTrie.add(segments, method, route);
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
      const segments = Object.freeze([...prefix, ...route.segments]);
      checkNames(route.method, segments);
      if (auth !== "defer") {
        checkAccess(route, auth, segments, this.#auth === "inherit");
      }
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
      const map = child.#mapError;
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
    const map = this.#mapError;
    return map === undefined ? [] : [map];
  }

  #build(inherited: ResolvedAuth | "unset" | "defer"): Compiled {
    const routes = this.#flatten([], [], this.#mappers(), inherited);
    const trie = new Trie<FlatRoute>();
    // A principal's key starts with its scheme's name, so one name must
    // mean one scheme across everything this router serves.
    const named = new Map<string, AuthScheme>();
    for (const route of routes) {
      const name = describeRoute(route.method, route.segments);
      if (route.auth.mode === "schemes") {
        for (const scheme of route.auth.schemes) {
          const origin = originOf(scheme);
          const seen = named.get(scheme.name);
          if (seen === undefined) named.set(scheme.name, origin);
          else if (seen !== origin) {
            throw new RouterError(
              `two different auth schemes are named ${scheme.name} (at ${name}): ` +
                "their principals' keys would collide; give one another name",
            );
          }
        }
      }
      timeoutMs(
        route.options.limits?.timeout,
        `${name} limits.timeout`,
        this.#maxTimeoutMs,
      );
      checkRouteCsrf(route, this.#csrf, name);
      trie.add(route.segments, route.method, route);
    }
    return { trie, routes };
  }

  #check(): void {
    const checked = this.#build(
      this.#auth === "inherit" ? "defer" : this.#auth,
    );
    this.#registrationTrie = checked.trie;
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
    const running: { work?: Promise<Response> } = {};
    const deadline = new Deadline(() => {
      abort(c, new DOMException("the request took too long", "TimeoutError"));
      // The handler cannot be interrupted and may still be writing: hold it
      // with waitUntil so the runtime does not cut its side effects off
      // half-way, and answer 504 (not 503, which says the request was not
      // processed and invites a retry) with no Retry-After.
      if (running.work !== undefined) {
        c.ctx.waitUntil(running.work.catch(() => {}));
      }
      expired(
        jsonError(
          504,
          "timeout",
          "the request took too long; it may still take effect",
          c.requestId,
        ),
      );
    });
    deadlines.set(c, deadline);
    deadline.arm(this.#timeoutMs);
    if (deadline.expired) return await timeout;
    const work = running.work = run(c);
    // Expired before the work began (a spent budget): hold it the same way.
    if (deadline.expired) c.ctx.waitUntil(work.catch(() => {}));
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
      const method = requestOf(c).method;
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
    // No prototype: `__proto__`, `constructor` and the like are ordinary
    // own properties, and nothing is inherited.
    const params: Record<string, string> = Object.create(null);
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
        timeoutMs(
          limits.timeout,
          `${route.pattern} limits.timeout`,
          this.#maxTimeoutMs,
        ),
      );
    }
    // The 504 has gone out; the route must not act on a request answered.
    const spent = abandoned(c);
    if (spent !== null) return spent;
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
    const request = requestOf(c);
    // Each stage starts only while the budget lasts: after a 504 nothing
    // more is authenticated, authorized, read or run.
    let spent = abandoned(c);
    if (spent !== null) return spent;
    checkContentLength(request, limits.body);

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
        spent = abandoned(c);
        if (spent !== null) return spent;
        const denied = await this.#authorize(route, result, c);
        if (denied !== null) return denied;
      }
    }
    spent = abandoned(c);
    if (spent !== null) return spent;

    const csrf = this.#csrf !== null && options.csrf !== false &&
        !SAFE_METHODS.has(request.method) &&
        (options.csrf === true || scheme?.ambient === true)
      ? this.#csrf
      : null;
    if (csrf !== null) checkOrigin(c, csrf);
    // The form token is read before the handler, whatever the route's
    // body schema: the body is read once, under the limits, and kept for
    // the handler's own readers. `{ source: "header" }` never reads it.
    let formToken: string | undefined;
    if (
      csrf?.token != null && typeof options.csrf !== "object" &&
      isForm(request)
    ) {
      await bufferBody(c);
      const field = (await readFormBody(c))[csrf.token.field];
      if (typeof field === "string") formToken = field;
    }

    if (options.params !== undefined) {
      assign(c, { params: await parse(options.params, c.params, "path") });
    }
    // Without a schema the query is parsed only if the handler reads it.
    if (options.query !== undefined) {
      const query = toRecord(c.url.searchParams, arrayKeys(options.query));
      assign(c, { query: await parse(options.query, query, "query") });
    }
    if (options.body !== undefined) {
      let raw: unknown;
      if (options.bodyType === "form") {
        raw = { ...await readFormBody(c, arrayKeys(options.body)) };
        if (csrf?.token) {
          delete (raw as Record<string, unknown>)[csrf.token.field];
        }
      } else {
        raw = await readJsonBody(c);
      }
      assign(c, { body: await parse(options.body, raw, "body") });
    }
    if (csrf !== null) checkToken(c, csrf, formToken);

    spent = abandoned(c);
    if (spent !== null) return spent;
    return await compose(
      options.use ?? [],
      (c) => Promise.resolve(abandoned(c) ?? route.handler(c)),
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
      options.authorize !== undefined &&
      !exactBoolean(await options.authorize(principal, c), "authorize")
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
    const reporter = this.#onError;
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
    // After everything else that writes headers: CORS has the last word.
    applyCorsPolicy(c, headers, this.#corsPassthrough);
    const idHeader = this.#requestIdHeader;
    if (idHeader !== false) headers.set(idHeader, c.requestId);
    applySecurityHeaders(
      headers,
      this.#security,
      c.publicUrl.protocol === "https:",
      c.principal !== null || requestAuth.get(c)?.refused === true,
      response.status,
    );
    return new Response(requestOf(c).method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * A new router. `auth` decides what "not public" means (see
 * {@link AuthConfig}); `E` types `c.env`. `Pre` names the parameters the
 * prefixes it will be mounted under supply (`router<Env, "org">(...)`
 * for a router mounted at `/orgs/:org`), so its handlers see them in
 * `c.params`; {@link Router.mount} refuses a prefix that does not supply
 * them.
 *
 * ```ts
 * const app = router<Env>({ auth: jwtBearer({ ... }) });
 * app.get("/health", { public: true }, (c) => c.text("ok"));
 * app.get("/notes/:id", { scopes: ["notes:read"] }, (c) => c.json({ id: c.params.id }));
 * export default { fetch: app.fetch };
 * ```
 */
export function router<E = unknown, Pre extends string = never>(
  options: RouterOptions & { readonly auth: "none" },
): Router<E, Empty, false, Pre>;
export function router<E = unknown, Pre extends string = never>(
  options: RouterOptions & { readonly auth: "inherit" },
): Router<E, Empty, boolean, Pre>;
export function router<E = unknown, Pre extends string = never>(
  options?: RouterOptions & {
    readonly auth?: AuthScheme | readonly AuthScheme[];
  },
): Router<E, Empty, true, Pre>;
export function router<E = unknown, Pre extends string = never>(
  options: RouterOptions,
): Router<E, Empty, boolean, Pre>;
export function router<E = unknown, Pre extends string = never>(
  options: RouterOptions = {},
): Router<E, Empty, boolean, Pre> {
  return new Router<E, Empty, boolean, Pre>(options);
}
