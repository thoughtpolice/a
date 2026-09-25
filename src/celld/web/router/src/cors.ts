// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link cors}: cross-origin access for listed origins. A router without
 * it sends no CORS headers, so browsers keep other origins' scripts from
 * reading any response.
 *
 * @module
 */

import { BoundsError, safeInt } from "@celld/core/bounds";
import { type Context, requestOf } from "./context.ts";
import { jsonError, RouterError } from "./errors.ts";
import type { Middleware } from "./middleware.ts";
import { appendVary } from "./security.ts";
import {
  exactBoolean,
  HTTP_TOKEN,
  optionsRecord,
  optionType,
  tokenList,
} from "./validation.ts";

/** Who may read responses cross-origin, and how. */
export interface CorsOptions {
  /**
   * Origins allowed, exactly as browsers send them
   * (`https://app.example.com`, no path or trailing slash); `"*"` for any
   * origin (not with `credentials`); or a predicate over the `Origin`.
   */
  readonly origins:
    | readonly string[]
    | "*"
    | ((origin: string, c: Context) => boolean);
  /** Methods a preflight may ask for; default GET, HEAD, POST, PUT, PATCH, DELETE. */
  readonly methods?: readonly string[];
  /**
   * Request headers a preflight may ask for (compared without case);
   * default `content-type` and `authorization`. CORS-safelisted headers need
   * no listing.
   */
  readonly allowHeaders?: readonly string[];
  /** Response headers scripts may read; default `x-request-id`. */
  readonly exposeHeaders?: readonly string[];
  /**
   * Send `Access-Control-Allow-Credentials: true`, so scripts may send
   * cookies and read the answers. Only with a list or predicate of origins.
   * Default false.
   */
  readonly credentials?: boolean;
  /**
   * Whole seconds a browser may cache a preflight, 0 to 86400 (a day, the
   * most any browser keeps one); default 600. Anything else is a
   * {@link RouterError}.
   */
  readonly maxAge?: number;
}

function checkMaxAge(maxAge: number): number {
  try {
    return safeInt(maxAge, { name: "cors maxAge", min: 0, max: 86_400 });
  } catch (cause) {
    if (!(cause instanceof BoundsError)) throw cause;
    throw new RouterError(
      `cors maxAge must be whole seconds from 0 to 86400, got ${maxAge}`,
      { cause },
    );
  }
}

const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/** Rewrites a response's CORS headers to what the policy decided. */
type CorsVerdict = (headers: Headers) => void;

/** The verdict of the innermost `cors()` a request passed through. */
const verdicts = new WeakMap<Context, CorsVerdict>();

/**
 * What the `cors()` policies a request has passed through so far grant
 * together: an inner policy is intersected with it, so it can narrow the
 * outer ones but never widen them.
 */
interface Grant {
  /** Every policy so far allows the origin. */
  readonly allowed: boolean;
  /** Every policy so far sends credentials. */
  readonly credentials: boolean;
  /** Every policy so far is `"*"`. */
  readonly any: boolean;
  readonly expose: readonly string[];
}

interface CorsSpec {
  readonly permit: (origin: string, c: Context) => boolean;
  readonly credentials: boolean;
  readonly any: boolean;
  readonly methods: readonly string[];
  readonly headers: readonly string[];
  readonly methodSet: ReadonlySet<string>;
  readonly headerSet: ReadonlySet<string>;
  readonly maxAge: number;
}
const policies = new WeakMap<Middleware<object>, CorsSpec>();

/** Evaluate only CORS policies on the selected method's router/route chain. */
export function corsPreflight(
  c: Context,
  middleware: readonly Middleware<object>[],
): Response | null {
  const request = requestOf(c);
  const origin = request.headers.get("origin");
  const method = request.headers.get("access-control-request-method");
  if (request.method !== "OPTIONS" || origin === null || method === null) {
    return null;
  }
  const applicable = middleware.flatMap((m) => {
    const p = policies.get(m);
    return p ? [p] : [];
  });
  if (applicable.length === 0) return null;
  const asked = (request.headers.get("access-control-request-headers") ?? "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  let accepted = origin !== "null" && HTTP_TOKEN.test(method) &&
    method === method.toUpperCase() && asked.every((h) => HTTP_TOKEN.test(h));
  let methods = [...applicable[0].methods];
  let headers = [...applicable[0].headers];
  let credentials = true;
  let any = true;
  let maxAge = 86400;
  // Install refusal before callbacks: even a throwing/malformed predicate must
  // remove downstream CORS headers from the router's opaque error response.
  const refused = (h: Headers) => {
    strip(h);
    appendVary(h, "Origin");
  };
  verdicts.set(c, refused);
  for (const p of applicable) {
    const permits = p.permit(origin, c);
    accepted = accepted && permits && p.methodSet.has(method) &&
      asked.every((h) => p.headerSet.has(h));
    methods = methods.filter((m) => p.methodSet.has(m));
    headers = headers.filter((h) => p.headerSet.has(h));
    credentials &&= p.credentials;
    any &&= p.any;
    maxAge = Math.min(maxAge, p.maxAge);
  }
  if (!accepted) {
    return jsonError(
      403,
      "cors",
      "the cross-origin request is not allowed",
      c.requestId,
    );
  }
  const verdict = (h: Headers) => {
    strip(h);
    h.set("access-control-allow-origin", any ? "*" : origin);
    if (credentials) h.set("access-control-allow-credentials", "true");
    h.set("access-control-allow-methods", methods.join(", "));
    if (headers.length > 0) {
      h.set("access-control-allow-headers", headers.join(", "));
    }
    h.set("access-control-max-age", String(maxAge));
    for (
      const name of [
        "Origin",
        "Access-Control-Request-Method",
        "Access-Control-Request-Headers",
      ]
    ) appendVary(h, name);
  };
  verdicts.set(c, verdict);
  const result = new Response(null, { status: 204 });
  verdict(result.headers);
  return result;
}

const grants = new WeakMap<Context, Grant>();

/** Removes every `Access-Control-*` header. */
function strip(headers: Headers): void {
  const names = new Set<string>();
  for (const name of headers.keys()) {
    if (name.toLowerCase().startsWith("access-control-")) names.add(name);
  }
  for (const name of names) headers.delete(name);
}

/**
 * The authoritative CORS stage, which the router runs on every response
 * after the headers set with `c.header` are applied: when a `cors()`
 * middleware saw the request, every `Access-Control-*` header is removed
 * (the handler's, an error mapper's, an upstream response's, outer
 * middleware's) and only the policy's are written, with `Vary: Origin`.
 * Without `cors()` every such header is removed too, unless the router
 * was made with `cors: "passthrough"`.
 */
export function applyCorsPolicy(
  c: Context,
  headers: Headers,
  passthrough: boolean,
): void {
  const verdict = verdicts.get(c);
  if (verdict !== undefined) verdict(headers);
  else if (!passthrough) strip(headers);
}

function checkOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new RouterError(
      `CORS origin ${JSON.stringify(origin)} is not an origin`,
    );
  }
  if (url.origin === "null" || url.origin !== origin.toLowerCase()) {
    throw new RouterError(
      `CORS origin ${
        JSON.stringify(origin)
      } must be scheme://host[:port] with no path, as browsers send it`,
    );
  }
  return url.origin;
}

/**
 * CORS middleware. Use it on the router (`app.use(cors({...}))`), so it
 * answers preflights before routing and authentication, and decorates
 * every answer, 401s included, that an allowed origin should be able to
 * read. Its options are copied when it is made.
 *
 * The policy is authoritative: the router rewrites the CORS headers of the
 * final response, after `c.header` values are applied, so a handler, an
 * error mapper, a proxied upstream response or middleware outside `cors()`
 * cannot add, widen or keep any `Access-Control-*` header; only the ones
 * below are sent. When several `cors()` see one request (the router's and
 * a mounted router's, say), they intersect: an origin is granted only when
 * every one of them allows it, credentials only when every one sends them,
 * and `*` only when every one is `*` (else the origin is echoed); the
 * exposed response headers are intersected. The router selects the route by
 * the requested preflight method, then evaluates all registered CORS policies
 * on that chain without running authentication or ordinary middleware. Methods
 * and request headers intersect; the smallest maxAge wins. Register cors()
 * directly with use()/before rather than hiding it in a callback wrapper.
 *
 * - An allowed origin is echoed back exactly in
 *   `Access-Control-Allow-Origin`; `Vary: Origin` is always added so
 *   caches keep answers for different origins apart.
 * - A request from an origin that is not allowed gets no CORS headers, and
 *   its preflight a 403, so the browser refuses it.
 * - The literal `null` origin (sandboxed frames, `file:`) is never allowed
 *   by a list.
 * - `"*"` with `credentials` is a {@link RouterError}: that would let any
 *   site read authenticated answers.
 */
export function cors(options: CorsOptions): Middleware {
  optionsRecord(options, [
    "origins",
    "methods",
    "allowHeaders",
    "exposeHeaders",
    "credentials",
    "maxAge",
  ], "cors options");
  optionType(options.credentials, "boolean", "cors credentials");
  for (const key of ["methods", "allowHeaders", "exposeHeaders"] as const) {
    tokenList(options[key], `cors ${key}`);
  }
  if (
    options.origins !== "*" && typeof options.origins !== "function" &&
    (!Array.isArray(options.origins) || options.origins.length > 1024 ||
      !options.origins.every((v) => typeof v === "string" && v.length <= 4096))
  ) {
    throw new RouterError(
      "cors origins must be *, a predicate, or a bounded list",
    );
  }
  const credentials = options.credentials ?? false;
  if (options.origins === "*" && credentials) {
    throw new RouterError(
      "CORS with credentials needs a list of origins, not *",
    );
  }
  const allowed = typeof options.origins === "function"
    ? options.origins
    : options.origins === "*"
    ? () => true
    : ((set: ReadonlySet<string>) => (origin: string) => set.has(origin))(
      new Set((options.origins as readonly string[]).map(checkOrigin)),
    );
  const any = options.origins === "*";
  const methods = (options.methods ?? DEFAULT_METHODS).map((m) =>
    m.toUpperCase()
  );
  const allowHeaders =
    (options.allowHeaders ?? ["content-type", "authorization"])
      .map((h) => h.toLowerCase());
  const expose = [...(options.exposeHeaders ?? ["x-request-id"])].map((h) =>
    h.toLowerCase()
  );
  const maxAge = String(checkMaxAge(options.maxAge ?? 600));
  const methodSet = new Set(methods);
  const headerSet = new Set(allowHeaders);

  const permitted = (origin: string | null, c: Context): origin is string =>
    origin !== null && origin !== "null" &&
    exactBoolean(allowed(origin, c), "CORS predicate");

  const allowOrigin = (
    headers: Headers,
    origin: string,
    grant: Grant = { allowed: true, credentials, any, expose },
  ) => {
    headers.set("access-control-allow-origin", grant.any ? "*" : origin);
    if (grant.credentials) {
      headers.set("access-control-allow-credentials", "true");
    }
  };

  /** The headers of an answered preflight, in the order they are written. */
  const preflightHeaders = (headers: Headers, origin: string) => {
    strip(headers);
    allowOrigin(headers, origin);
    headers.set("access-control-allow-methods", methods.join(", "));
    if (allowHeaders.length > 0) {
      headers.set("access-control-allow-headers", allowHeaders.join(", "));
    }
    headers.set("access-control-max-age", maxAge);
    appendVary(headers, "Origin");
    appendVary(headers, "Access-Control-Request-Method");
    appendVary(headers, "Access-Control-Request-Headers");
  };
  /** The headers of any other answer: the origin's grant, or nothing. */
  const actualHeaders = (
    headers: Headers,
    origin: string | null,
    grant: Grant,
  ) => {
    strip(headers);
    appendVary(headers, "Origin");
    if (origin !== null) {
      allowOrigin(headers, origin, grant);
      if (grant.expose.length > 0) {
        headers.set("access-control-expose-headers", grant.expose.join(", "));
      }
    }
  };
  const refusedHeaders = (headers: Headers) => {
    strip(headers);
    appendVary(headers, "Origin");
  };

  const middleware: Middleware = async (c, next) => {
    const origin = requestOf(c).headers.get("origin");
    const requested = requestOf(c).headers.get("access-control-request-method");
    if (c.method === "OPTIONS" && origin !== null && requested !== null) {
      const refuse = (message: string) => {
        verdicts.set(c, refusedHeaders);
        const response = jsonError(403, "cors", message, c.requestId);
        refusedHeaders(response.headers);
        return response;
      };
      if (!permitted(origin, c)) {
        return refuse("this origin may not call this API");
      }
      if (!methodSet.has(requested.toUpperCase())) {
        return refuse(`${requested} is not allowed cross-origin`);
      }
      const asked =
        (requestOf(c).headers.get("access-control-request-headers") ?? "")
          .split(",").map((h) => h.trim().toLowerCase()).filter((h) =>
            h !== ""
          );
      const unknown = asked.filter((h) => !headerSet.has(h));
      if (unknown.length > 0) {
        return refuse(
          `header ${unknown.join(", ")} is not allowed cross-origin`,
        );
      }
      const verdict = (headers: Headers) => preflightHeaders(headers, origin);
      verdicts.set(c, verdict);
      const headers = new Headers();
      verdict(headers);
      return new Response(null, { status: 204, headers });
    }
    // Decided before anything downstream runs, so an error thrown past
    // this middleware is answered under the same policy; intersected with
    // any policy outside this one.
    const outer = grants.get(c);
    verdicts.set(c, refusedHeaders);
    const grant: Grant = {
      allowed: permitted(origin, c) && (outer?.allowed ?? true),
      credentials: credentials && (outer?.credentials ?? true),
      any: any && (outer?.any ?? true),
      expose: outer === undefined
        ? expose
        : expose.filter((h) => outer.expose.includes(h)),
    };
    grants.set(c, grant);
    const granted = grant.allowed ? origin : null;
    const verdict = (headers: Headers) =>
      actualHeaders(headers, granted, grant);
    verdicts.set(c, verdict);
    const response = await next();
    if (response.status === 101) return response;
    const out = new Response(response.body, response);
    verdict(out.headers);
    return out;
  };
  policies.set(middleware, {
    permit: permitted,
    credentials,
    any,
    methods,
    headers: allowHeaders,
    methodSet,
    headerSet,
    maxAge: Number(maxAge),
  });
  return middleware;
}
