// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Snapshots of configuration: what a router, a scheme or a middleware is
 * given is validated, copied and frozen when it is given, so that changing
 * the caller's objects afterwards changes nothing. The caller's objects are
 * never frozen in place.
 *
 * @module
 */

import { toCidr } from "@celld/core/ip";
import { type AuthScheme, isDelegating, markDelegating } from "./auth.ts";
import type { ClientIpOptions } from "./client_ip.ts";
import {
  checkExpires,
  cookieMaxAgeMs,
  type CookieOptions,
  serializeCookie,
} from "./cookies.ts";
import { RouterError } from "./errors.ts";
import type { SecurityHeaders } from "./security.ts";
import { HTTP_TOKEN, optionsRecord, optionText } from "./validation.ts";
import { jsonSnapshot } from "@celld/core/bounds";

/** Freezes a fresh structure and everything in it; for copies only. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

/** A frozen copy of a list of strings, or undefined; throws for anything else. */
export function stringList(
  value: unknown,
  what: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length > 1024 ||
    !value.every((item) => typeof item === "string" && item.length <= 4096)
  ) {
    throw new RouterError(`${what} must be a list of strings`);
  }
  return Object.freeze([...value]);
}

/** A frozen copy of a list of functions, or undefined; throws for anything else. */
export function functionList<F>(
  value: unknown,
  what: string,
): readonly F[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.length > 1024 ||
    !value.every((item) => typeof item === "function")
  ) {
    throw new RouterError(`${what} must be a list of functions`);
  }
  return Object.freeze([...value]) as readonly F[];
}

/** Checks for the kinds of value options hold. */
export const IS = {
  boolean: (value: unknown) => typeof value === "boolean",
  string: (value: unknown) => typeof value === "string",
  function: (value: unknown) => typeof value === "function",
} as const;

function optional(value: unknown, type: keyof typeof IS, what: string): void {
  if (value !== undefined && !IS[type](value)) {
    throw new RouterError(`${what} must be a ${type}`);
  }
}

/**
 * A frozen stand-in for `scheme` that holds the members it had when it was
 * given: its `name`, `ambient` flag and `openapi` object are copied, and
 * its methods are captured (and still called on the original, so a scheme
 * keeps its own state). Reassigning a member of the original afterwards
 * changes nothing.
 */
export function compileScheme(scheme: AuthScheme): AuthScheme {
  if (typeof scheme !== "object" || scheme === null) {
    throw new RouterError("an auth scheme must be an object");
  }
  const {
    name,
    ambient,
    authenticate,
    challenge,
    unauthenticated,
    openapi,
    ready,
  } = scheme;
  if (typeof name !== "string" || name === "") {
    throw new RouterError("an auth scheme needs a name");
  }
  optionText(name, "auth scheme name", HTTP_TOKEN);
  if (typeof authenticate !== "function") {
    throw new RouterError(`auth scheme ${name} has no authenticate`);
  }
  if (typeof ambient !== "boolean") {
    throw new RouterError(
      `auth scheme ${name} must say whether its credential is ambient ` +
        "(ambient: true for cookies and Basic, false for headers the " +
        "client sets itself)",
    );
  }
  optional(challenge, "function", `auth scheme ${name}'s challenge`);
  optional(ready, "function", `auth scheme ${name}'s ready`);
  optional(
    unauthenticated,
    "function",
    `auth scheme ${name}'s unauthenticated`,
  );
  let document: Readonly<Record<string, unknown>> | undefined;
  if (openapi !== undefined) {
    try {
      document = jsonSnapshot(openapi);
    } catch (cause) {
      throw new RouterError(`auth scheme ${name}'s openapi is not plain data`, {
        cause,
      });
    }
  }
  const compiled: AuthScheme = {
    name,
    ambient,
    authenticate: (c) => authenticate.call(scheme, c),
    ...(ready === undefined ? {} : { ready: () => ready.call(scheme) }),
    ...(challenge === undefined
      ? {}
      : { challenge: (error, c) => challenge.call(scheme, error, c) }),
    ...(unauthenticated === undefined
      ? {}
      : { unauthenticated: (c) => unauthenticated.call(scheme, c) }),
    ...(document === undefined ? {} : { openapi: document }),
  };
  if (isDelegating(scheme)) markDelegating(compiled);
  const frozen = Object.freeze(compiled);
  ORIGINS.set(frozen, ORIGINS.get(scheme) ?? scheme);
  return frozen;
}

/** The scheme object each compiled stand-in was made from. */
const ORIGINS = new WeakMap<AuthScheme, AuthScheme>();

/**
 * The scheme object `scheme` was compiled from (itself when it was not),
 * so two routers given the same scheme are known to share it.
 */
export function originOf(scheme: AuthScheme): AuthScheme {
  return ORIGINS.get(scheme) ?? scheme;
}

/** A frozen copy of cookie defaults. */
export function compileCookies(
  options: CookieOptions | undefined,
): CookieOptions {
  if (options === undefined) return Object.freeze({});
  optionsRecord(options, [
    "expires",
    "maxAge",
    "httpOnly",
    "secure",
    "partitioned",
    "path",
    "domain",
    "sameSite",
  ], "cookies");
  if (typeof options !== "object" || options === null) {
    throw new RouterError("cookies must be an object");
  }
  // Validate attributes during construction, even if no handler sets a cookie.
  serializeCookie("configuration-check", "", options);
  const { expires, ...rest } = options;
  if (expires !== undefined) checkExpires(expires, "cookies.expires");
  if (rest.maxAge !== undefined) cookieMaxAgeMs(rest.maxAge, "cookies.maxAge");
  for (const key of ["httpOnly", "secure", "partitioned"] as const) {
    optional(rest[key], "boolean", `cookies.${key}`);
  }
  for (const key of ["path", "domain"] as const) {
    optional(rest[key], "string", `cookies.${key}`);
  }
  if (
    rest.sameSite !== undefined &&
    !["Strict", "Lax", "None"].includes(rest.sameSite)
  ) {
    throw new RouterError('cookies.sameSite must be "Strict", "Lax" or "None"');
  }
  return Object.freeze({
    ...rest,
    ...(expires === undefined ? {} : { expires: new Date(expires.getTime()) }),
  });
}

/**
 * A frozen copy of client-IP settings, with `trustedProxies` parsed now:
 * a block that does not parse throws when the router is made.
 */
export function compileClientIp(
  options: ClientIpOptions | undefined,
): ClientIpOptions {
  if (options === undefined) return Object.freeze({});
  optionsRecord(options, [
    "peerHeader",
    "forwardedHeader",
    "peer",
    "strict",
    "trustedProxies",
  ], "clientIp");
  optionText(options.peerHeader, "clientIp.peerHeader", HTTP_TOKEN);
  optionText(options.forwardedHeader, "clientIp.forwardedHeader", HTTP_TOKEN);
  if (typeof options !== "object" || options === null) {
    throw new RouterError("clientIp must be an object");
  }
  optional(options.peerHeader, "string", "clientIp.peerHeader");
  optional(options.forwardedHeader, "string", "clientIp.forwardedHeader");
  optional(options.peer, "function", "clientIp.peer");
  optional(options.strict, "boolean", "clientIp.strict");
  if (options.peer !== undefined && options.peerHeader !== undefined) {
    throw new RouterError(
      "clientIp takes a peer function or a peerHeader, not both",
    );
  }
  const proxies = options.trustedProxies;
  if (proxies !== undefined && !Array.isArray(proxies)) {
    throw new RouterError("clientIp.trustedProxies must be a list");
  }
  return Object.freeze({
    ...(options.peerHeader === undefined
      ? {}
      : { peerHeader: options.peerHeader }),
    ...(options.forwardedHeader === undefined
      ? {}
      : { forwardedHeader: options.forwardedHeader }),
    ...(proxies === undefined
      ? {}
      : { trustedProxies: Object.freeze(proxies.map(toCidr)) }),
    ...(options.peer === undefined ? {} : { peer: options.peer }),
    ...(options.strict === undefined ? {} : { strict: options.strict }),
  });
}

/** A frozen copy of the security header settings. */
export function compileSecurity(
  options: SecurityHeaders | undefined,
): SecurityHeaders {
  if (options === undefined) return Object.freeze({});
  optionsRecord(options, [
    "contentTypeOptions",
    "referrerPolicy",
    "frameOptions",
    "csp",
    "htmlCsp",
    "hsts",
    "noStore",
  ], "security");
  if (typeof options !== "object" || options === null) {
    throw new RouterError("security must be an object");
  }
  const keys = [
    "contentTypeOptions",
    "referrerPolicy",
    "frameOptions",
    "csp",
    "htmlCsp",
    "hsts",
  ] as const;
  const out: Record<string, string | boolean> = {};
  for (const key of keys) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== "string" && value !== false) {
      throw new RouterError(`security.${key} must be a string or false`);
    }
    if (typeof value === "string" && /[\0\r\n]/.test(value)) {
      throw new RouterError(
        `security.${key} cannot hold CR, LF or NUL: it is a header value`,
      );
    }
    out[key] = value;
  }
  optional(options.noStore, "boolean", "security.noStore");
  if (options.noStore !== undefined) out.noStore = options.noStore;
  return Object.freeze(out) as SecurityHeaders;
}
