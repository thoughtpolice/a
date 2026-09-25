// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The public URL of a request: the URL the client used, which is what
 * every security decision about the transport and the origin is made on
 * (the cleartext rule for credentials, CSRF origin checks, HSTS, DPoP's
 * `htu`, same-origin redirects). Behind a TLS-terminating proxy the Worker
 * sees another URL (`http://10.0.0.7:8080/...`), so the router resolves
 * the public one once per request from settings the operator gives
 * explicitly; nothing is inferred from `X-Forwarded-*` headers unless a
 * trusted proxy sent them.
 *
 * @module
 */

import { type Cidr, parseIp, toCidr } from "@celld/core/ip";
import { AuthError } from "./auth.ts";
import { type Context, settingsOf } from "./context.ts";
import { HttpError, RouterError } from "./errors.ts";
import { optionsRecord } from "./validation.ts";

/**
 * How the router finds a request's public URL ({@link Context.publicUrl}):
 *
 * - `{ mode: "request" }` (the default): the request URL as the Worker
 *   received it. Right when clients reach the Worker directly.
 * - `{ mode: "trusted-proxy", trustedProxies, proto?, host? }`: when the
 *   connecting peer (the router's `clientIp.peer` or `clientIp.peerHeader`,
 *   which this mode requires to be set: the `CF-Connecting-IP` default is
 *   not enough) is in one of the `trustedProxies` CIDR
 *   blocks, its `proto` header (default `x-forwarded-proto`, `http` or
 *   `https`) and `host` header (default `x-forwarded-host`, one
 *   `host[:port]`) replace the request URL's scheme and host. Name only
 *   headers the proxy itself sets (overwriting what the client sent):
 *   a named header the trusted peer did not send is a 400, never a quiet
 *   fall back to the request's own value, and `false` says the proxy does
 *   not set that one (it forwards the `Host` itself, say), so it is never
 *   read and the request URL's part stands; not both `false`. From any
 *   other peer the headers are ignored and the request URL stands. A trusted
 *   peer's malformed header (a list, a path, user information) is a 400.
 * - `{ mode: "fixed", origin }`: this origin (`https://api.example.com`),
 *   with the request's path and query. The simplest choice behind a proxy
 *   when the Worker has one public name.
 * - a function of the context returning a `URL`, for anything else. It
 *   runs once per request, before middleware; returning something other
 *   than a `URL` (or throwing) is a 500.
 */
export type PublicUrlOptions =
  | { readonly mode: "request" }
  | {
    readonly mode: "trusted-proxy";
    readonly trustedProxies: readonly (Cidr | string)[];
    readonly proto?: string | false;
    readonly host?: string | false;
  }
  | { readonly mode: "fixed"; readonly origin: string }
  | ((c: Context) => URL);

/** A validated, frozen {@link PublicUrlOptions}. */
export type CompiledPublicUrl =
  | { readonly mode: "request" }
  | {
    readonly mode: "trusted-proxy";
    readonly trustedProxies: readonly Cidr[];
    /** The header the proxy sets, or null when it sets none. */
    readonly proto: string | null;
    readonly host: string | null;
  }
  | { readonly mode: "fixed"; readonly origin: string }
  | { readonly mode: "function"; readonly resolve: (c: Context) => URL };

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

function headerName(
  value: unknown,
  fallback: string,
  what: string,
): string | null {
  if (value === undefined) return fallback;
  if (value === false) return null;
  if (typeof value !== "string" || !HEADER_NAME.test(value)) {
    throw new RouterError(`publicUrl.${what} must be a header name or false`);
  }
  return value.toLowerCase();
}

/** Throws {@link RouterError} unless `origin` is exactly `http(s)://host[:port]`. */
export function checkPublicOrigin(origin: unknown, what: string): string {
  if (typeof origin !== "string") {
    throw new RouterError(`${what} must be an origin string`);
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new RouterError(`${what} ${JSON.stringify(origin)} is not a URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.origin !== origin.toLowerCase()
  ) {
    throw new RouterError(
      `${what} ${JSON.stringify(origin)} must be http(s)://host[:port]`,
    );
  }
  return url.origin;
}

/** Validates and freezes {@link PublicUrlOptions}; throws {@link RouterError}. */
export function compilePublicUrl(
  options: PublicUrlOptions | undefined,
): CompiledPublicUrl {
  if (options === undefined) return Object.freeze({ mode: "request" });
  if (typeof options === "function") {
    return Object.freeze({ mode: "function", resolve: options });
  }
  if (typeof options !== "object" || options === null) {
    throw new RouterError(
      'publicUrl must be { mode: "request" | "trusted-proxy" | "fixed" } or a function',
    );
  }
  // Validate descriptors before inspecting the discriminant: a mode getter
  // must not execute while deciding which schema to validate.
  optionsRecord(
    options,
    ["mode", "origin", "trustedProxies", "proto", "host"],
    "publicUrl",
  );
  optionsRecord(
    options,
    options.mode === "trusted-proxy"
      ? ["mode", "trustedProxies", "proto", "host"]
      : options.mode === "fixed"
      ? ["mode", "origin"]
      : ["mode"],
    "publicUrl",
  );
  switch (options.mode) {
    case "request":
      return Object.freeze({ mode: "request" });
    case "fixed":
      return Object.freeze({
        mode: "fixed",
        origin: checkPublicOrigin(options.origin, "publicUrl.origin"),
      });
    case "trusted-proxy": {
      const proxies = options.trustedProxies;
      if (!Array.isArray(proxies) || proxies.length === 0) {
        throw new RouterError(
          "publicUrl.trustedProxies must list the proxies' CIDR blocks",
        );
      }
      const proto = headerName(options.proto, "x-forwarded-proto", "proto");
      const host = headerName(options.host, "x-forwarded-host", "host");
      if (proto === null && host === null) {
        throw new RouterError(
          'publicUrl: proto and host cannot both be false in trusted-proxy mode; use { mode: "request" }',
        );
      }
      return Object.freeze({
        mode: "trusted-proxy",
        trustedProxies: Object.freeze(proxies.map(toCidr)),
        proto,
        host,
      });
    }
    default:
      throw new RouterError(
        `publicUrl mode must be "request", "trusted-proxy" or "fixed", got ${
          JSON.stringify((options as { mode?: unknown }).mode)
        }`,
      );
  }
}

/**
 * The origin a trusted proxy reported, or null to keep the request's.
 * Throws a 400 {@link HttpError} when a header the proxy is said to set is
 * missing.
 */
function forwardedOrigin(
  request: Request,
  url: URL,
  proto: string | null,
  host: string | null,
): string | null {
  const sent = (name: string | null) => {
    if (name === null) return null;
    const value = request.headers.get(name);
    if (value === null) {
      throw new HttpError(
        400,
        `the trusted proxy did not send ${name}, which it is configured to set`,
      );
    }
    return value;
  };
  const sentProto = sent(proto);
  const sentHost = sent(host);
  let scheme = url.protocol.slice(0, -1);
  if (sentProto !== null) {
    const value = sentProto.trim().toLowerCase();
    if (value !== "http" && value !== "https") {
      throw new HttpError(400, "the trusted proxy sent an invalid protocol");
    }
    scheme = value;
  }
  let authority = url.host;
  if (sentHost !== null) {
    const value = sentHost.trim();
    if (!HOST.test(value)) {
      throw new HttpError(400, "the trusted proxy sent an invalid authority");
    }
    authority = value;
  }
  try {
    return new URL(`${scheme}://${authority}`).origin;
  } catch {
    throw new HttpError(400, "the trusted proxy sent an invalid authority");
  }
}

/**
 * The public URL of `c` under `options`, with `peer` naming the connecting
 * address (for `trusted-proxy`).
 */
export function resolvePublicUrl(
  options: CompiledPublicUrl,
  c: Context,
  peer: (c: Context) => string | null,
): URL {
  const url = c.url;
  const atOrigin = (origin: string) => {
    const resolved = new URL(origin);
    // The request path is data, not a URL reference. A leading // must never
    // replace the fixed/trusted authority with a request-controlled hostname.
    resolved.pathname = url.pathname;
    resolved.search = url.search;
    return resolved;
  };
  switch (options.mode) {
    case "request":
      return new URL(url.href);
    case "fixed":
      return atOrigin(options.origin);
    case "function": {
      const resolved = options.resolve(c);
      if (
        !(resolved instanceof URL) ||
        (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
        resolved.username !== "" || resolved.password !== "" ||
        resolved.hash !== ""
      ) {
        throw new TypeError(
          "the router's publicUrl function must return an HTTP(S) URL without credentials or fragments",
        );
      }
      return new URL(resolved.href);
    }
    case "trusted-proxy": {
      const text = peer(c);
      const address = text === null ? null : parseIp(text.trim());
      const unmapped = address === null ? null : address.toIpv4() ?? address;
      if (
        unmapped === null ||
        !options.trustedProxies.some((block) => block.contains(unmapped))
      ) {
        return new URL(url.href);
      }
      const origin = forwardedOrigin(
        c.unsafeRequest,
        url,
        options.proto,
        options.host,
      );
      return origin === null ? new URL(url.href) : atOrigin(origin);
    }
  }
}

const LOOPBACK: readonly Cidr[] = [toCidr("127.0.0.0/8"), toCidr("::1/128")];

/** Whether `hostname` (a URL's, IPv6 in brackets) is a loopback IP literal. */
export function isLoopbackLiteral(hostname: string): boolean {
  const text = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const address = parseIp(text);
  if (address === null) return false;
  const unmapped = address.toIpv4() ?? address;
  return LOOPBACK.some((block) => block.contains(unmapped));
}

/**
 * The transport rule every built-in credential scheme applies once it has
 * found its credential: over plain http the credential is refused (403
 * `insecure_transport`, and no challenge, so browsers do not prompt)
 * unless the public URL's host is a loopback IP literal (`127.0.0.0/8`,
 * `[::1]`; not the name `localhost`, which a resolver may send elsewhere)
 * or the router was made with `allowCleartextCredentialsForDevelopment`.
 * `url` defaults to `c.publicUrl`. Null when the credential may be used.
 */
export function cleartextRefusal(
  c: Context,
  what: string,
  url: URL = c.publicUrl,
): AuthError | null {
  if (url.protocol === "https:") return null;
  if (settingsOf(c).allowCleartextCredentialsForDevelopment) return null;
  if (url.protocol === "http:" && isLoopbackLiteral(url.hostname)) return null;
  return new AuthError(
    "insecure_transport",
    `${what} are refused over plain http`,
  );
}
