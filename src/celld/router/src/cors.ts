// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link cors}: cross-origin access for listed origins. A router without
 * it sends no CORS headers, so browsers keep other origins' scripts from
 * reading any response.
 *
 * @module
 */

import type { Context } from "./context.ts";
import { jsonError, RouterError } from "./errors.ts";
import type { Middleware } from "./middleware.ts";

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
  /** Seconds a browser may cache a preflight; default 600. */
  readonly maxAge?: number;
}

const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (current === null) {
    headers.set("vary", value);
    return;
  }
  const names = current.split(",").map((name) => name.trim().toLowerCase());
  if (!names.includes(value.toLowerCase()) && !names.includes("*")) {
    headers.set("vary", `${current}, ${value}`);
  }
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
 * read.
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
  const expose = options.exposeHeaders ?? ["x-request-id"];
  const maxAge = String(options.maxAge ?? 600);

  const permitted = (origin: string | null, c: Context): origin is string =>
    origin !== null && origin !== "null" && allowed(origin, c);

  const allowOrigin = (headers: Headers, origin: string) => {
    headers.set("access-control-allow-origin", any ? "*" : origin);
    if (credentials) headers.set("access-control-allow-credentials", "true");
  };

  return async (c, next) => {
    const origin = c.req.headers.get("origin");
    const requested = c.req.headers.get("access-control-request-method");
    if (c.req.method === "OPTIONS" && origin !== null && requested !== null) {
      const refuse = (message: string) => {
        const response = jsonError(403, "cors", message, c.requestId);
        appendVary(response.headers, "Origin");
        return response;
      };
      if (!permitted(origin, c)) {
        return refuse("this origin may not call this API");
      }
      if (!methods.includes(requested.toUpperCase())) {
        return refuse(`${requested} is not allowed cross-origin`);
      }
      const asked = (c.req.headers.get("access-control-request-headers") ?? "")
        .split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
      const unknown = asked.filter((h) => !allowHeaders.includes(h));
      if (unknown.length > 0) {
        return refuse(
          `header ${unknown.join(", ")} is not allowed cross-origin`,
        );
      }
      const headers = new Headers();
      allowOrigin(headers, origin);
      headers.set("access-control-allow-methods", methods.join(", "));
      if (allowHeaders.length > 0) {
        headers.set("access-control-allow-headers", allowHeaders.join(", "));
      }
      headers.set("access-control-max-age", maxAge);
      appendVary(headers, "Origin");
      appendVary(headers, "Access-Control-Request-Method");
      appendVary(headers, "Access-Control-Request-Headers");
      return new Response(null, { status: 204, headers });
    }
    const response = await next();
    if (response.status === 101) return response;
    const out = new Response(response.body, response);
    appendVary(out.headers, "Origin");
    if (permitted(origin, c)) {
      allowOrigin(out.headers, origin);
      if (expose.length > 0) {
        out.headers.set("access-control-expose-headers", expose.join(", "));
      }
    }
    return out;
  };
}
