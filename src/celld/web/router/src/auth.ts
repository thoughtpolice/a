// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The authentication contract: {@link Principal}, {@link AuthScheme},
 * {@link AuthError} and {@link Challenge}, and `WWW-Authenticate` and
 * `Authorization` syntax (RFC 9110 section 11).
 *
 * @module
 */

import type { Context } from "./context.ts";
import { jsonSnapshot, strictRecord } from "@celld/core/bounds";

const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
const errorHeaders = new WeakMap<AuthError, Headers>();

/** Internal nonce augmentation; callers receive defensive header snapshots. */
export function setAuthErrorHeader(
  error: AuthError,
  name: string,
  value: string,
): void {
  errorHeaders.get(error)!.set(name, value);
}

/** Who a request is from, as an {@link AuthScheme} established it. */
export interface Principal {
  /** The user or client the credential names (a JWT `sub`, an API key's owner). */
  readonly subject: string;
  /** Granted OAuth-style scopes; routes' `scopes` are checked against these. */
  readonly scopes: readonly string[];
  /** Roles; routes' `roles` are checked against these. */
  readonly roles: readonly string[];
  /** Everything else the credential said (a JWT's claims, say). */
  readonly claims: Readonly<Record<string, unknown>>;
  /** The {@link AuthScheme.name} that authenticated it. */
  readonly scheme: string;
  readonly clientId?: string;
  readonly tenant?: string;
  /** Who issued the credential (a token's `iss`), when the scheme knows. */
  readonly issuer?: string;
  /** The kind of credential (`Bearer`, `DPoP`, ...), when the scheme says. */
  readonly tokenType?: string;
  /** When the credential expires, in epoch milliseconds, when known. */
  readonly expiresAt?: number;
  /**
   * The token's confirmation (RFC 7800): `jkt` is the SHA-256 thumbprint of
   * the key a DPoP-bound token (RFC 9449) is bound to.
   */
  readonly cnf?: { readonly jkt?: string };
  /**
   * The ownership fingerprint: `scheme`, `issuer`, `tenant`, `clientId` and
   * `subject` (absent ones empty) joined with `\u0000`, which none of them
   * may contain. Two principals are the same owner exactly when their keys
   * are equal. Anything that records who owns a resource (a task, sealed
   * request state, a session) must store and compare `key`, never
   * `subject`: equal subjects from two issuers, schemes, tenants or
   * clients are different callers.
   */
  readonly key: string;
}

/** What a scheme or verifier returns for a good credential; the router fills in the rest. */
export interface PrincipalInput {
  readonly subject: string;
  readonly scopes?: readonly string[];
  readonly roles?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * The scheme's name, which is the default: a scheme cannot name another
   * (the router answers 500), since `scheme` is the first part of the
   * principal's `key`. Only `session()` carries the scheme that first
   * authenticated its principal, which it sealed at login.
   */
  readonly scheme?: string;
  readonly clientId?: string;
  readonly tenant?: string;
  /** The credential's issuer; part of the principal's `key`. */
  readonly issuer?: string;
  /** The kind of credential, such as `Bearer` or `DPoP`. */
  readonly tokenType?: string;
  /** Expiry in epoch milliseconds. */
  readonly expiresAt?: number;
  readonly cnf?: { readonly jkt?: string };
  /**
   * Headers for the response, whatever it turns out to be: the handler's,
   * or an error produced later (a 403 for a missing scope, a 400 for a bad
   * body). A resource server's fresh `DPoP-Nonce` goes here. They are
   * added as `c.header` adds them, and are not part of the {@link Principal}.
   */
  readonly headers?: HeadersInit;
}

/** Error codes with their default statuses. */
const STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  invalid_token: 401,
  invalid_credentials: 401,
  invalid_dpop_proof: 401,
  use_dpop_nonce: 401,
  insufficient_scope: 403,
  forbidden: 403,
  insecure_transport: 403,
};

/** Options for {@link AuthError}. */
export interface AuthErrorOptions {
  /** Default by code: 400 for `invalid_request`, 403 for `insufficient_scope`, else 401. */
  readonly status?: number;
  /** The scopes that would be enough, for `insufficient_scope`. */
  readonly scope?: readonly string[];
  /** Extra response headers, such as `DPoP-Nonce`. */
  readonly headers?: HeadersInit;
}

/**
 * A credential was presented and refused. A scheme returns (or throws) one
 * instead of a principal, and the router answers with its status, its
 * scheme's challenge carrying `error` and `error_description`, and a JSON
 * body; the request never goes on as anonymous. Codes follow RFC 6750
 * (`invalid_request`, `invalid_token`, `insufficient_scope`) and RFC 9449
 * (`invalid_dpop_proof`, `use_dpop_nonce`); `invalid_credentials` is for
 * schemes without a standard code (API keys, Basic, sessions).
 *
 * A handler, a route's `use` middleware or `authorize` may throw one as
 * well (an `insufficient_scope` only the body reveals, say): once a route
 * has matched, the answer carries the challenge of the scheme that
 * authenticated the request, or of every one of the route's schemes when
 * it is anonymous (then without error details, per RFC 6750 section 3.1),
 * built by `challenge(error, c)` as for the router's own.
 */
export class AuthError extends Error {
  override readonly name = "AuthError";
  readonly code: string;
  readonly status: number;
  readonly scope: readonly string[] | undefined;
  get headers(): Headers {
    return new Headers(errorHeaders.get(this));
  }

  constructor(
    code: string,
    description: string,
    options: AuthErrorOptions = {},
  ) {
    strictRecord(
      options as unknown,
      ["status", "scope", "headers"],
      "AuthError options",
    );
    const status = options.status ??
      (Object.hasOwn(STATUS, code) ? STATUS[code] : 401);
    if (!Number.isInteger(status) || status < 400 || status > 499) {
      throw new RangeError("an AuthError status is 400 to 499");
    }
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
      throw new TypeError("AuthError code must be a bounded token");
    }
    if (typeof description !== "string" || description.length > 4096) {
      throw new TypeError("AuthError description must be a bounded string");
    }
    if (
      options.scope !== undefined &&
      (!Array.isArray(options.scope) || options.scope.length > 256 ||
        !options.scope.every((v) => typeof v === "string" && SCOPE.test(v)))
    ) {
      throw new TypeError(
        "AuthError scope must be a bounded list of scope tokens",
      );
    }
    super(description);
    this.code = code;
    this.status = status;
    this.scope = options.scope === undefined
      ? undefined
      : Object.freeze([...options.scope]);
    errorHeaders.set(this, new Headers(options.headers));
  }
}

/** One `WWW-Authenticate` challenge: `Bearer realm="api", error="invalid_token"`. */
export interface Challenge {
  /** The auth-scheme: `Bearer`, `DPoP`, `Basic`, ... */
  readonly scheme: string;
  /** Parameters, written in this order as quoted strings. */
  readonly params?: readonly (readonly [string, string])[];
}

/** Parameters most challenges can carry, for {@link challengeParams}. */
export interface ChallengeOptions {
  /** `realm` (RFC 9110 section 11.5). */
  readonly realm?: string;
  /**
   * `resource_metadata` (RFC 9728 section 5.1): the URL of the protected
   * resource's metadata, from which a client finds its authorization
   * servers.
   */
  readonly resourceMetadata?: string;
}

/** What {@link AuthScheme.authenticate} found. */
export type AuthOutcome = PrincipalInput | null | AuthError;

/**
 * A way to authenticate requests. Router config takes a list of them,
 * tried in order: the first that returns a principal wins; one that
 * returns (or throws) an {@link AuthError} ends the request with that
 * error; `null` means "no credential of mine here" and the next one is
 * tried. When all return null, a route that needs authentication answers
 * with the first scheme's {@link AuthScheme.unauthenticated} response, or
 * else 401 with every scheme's {@link challenge}.
 */
export interface AuthScheme {
  /** Probe configured cryptography/dependencies before serving traffic. */
  ready?(): Promise<void>;
  /** Identifies the scheme: `Principal.scheme`, and the OpenAPI security scheme's key. */
  readonly name: string;
  /**
   * Whether browsers attach the credential by themselves (cookies, Basic),
   * which makes state-changing requests authenticated by it subject to the
   * router's CSRF check. Required: a scheme that leaves it out is a
   * `RouterError` when the router is made, since guessing "not
   * ambient" would switch the CSRF check off for a cookie scheme.
   */
  readonly ambient: boolean;
  /** Finds and checks this scheme's credential in the request. */
  authenticate(c: Context): AuthOutcome | Promise<AuthOutcome>;
  /**
   * The challenge to send with a 401 (no `error`), or with this scheme's
   * {@link AuthError} (`error` set); null for none.
   */
  challenge?(error: AuthError | undefined, c: Context): Challenge | null;
  /**
   * The answer to a request no scheme found a credential in, on a route
   * that needs one, in place of the router's 401: a redirect to a login
   * page for a browser, say. The route's schemes are asked in order and
   * the first Response wins; null or undefined from all of them means the
   * 401. It is never asked about a malformed or refused credential (those
   * are the scheme's 400 or 401), nor on a public route. The response
   * still gets the security headers, `Cache-Control: no-store`, and the
   * headers set with `c.header`.
   */
  unauthenticated?(c: Context): Response | null | undefined;
  /** The OpenAPI 3.1 Security Scheme Object for this scheme. */
  readonly openapi?: Readonly<Record<string, unknown>>;
}

const DESCRIPTION_UNSAFE = /[^\x20-\x21\x23-\x5B\x5D-\x7E]/g;

/**
 * `text` as an `error_description`: RFC 6750 allows only printable ASCII
 * without `"` and `\`, so anything else becomes `?`.
 */
export function describe(text: string): string {
  return text.replace(DESCRIPTION_UNSAFE, "?");
}

const HEADER_UNSAFE = /[^\t\x20-\x7E]/g;

/**
 * `value` as a quoted-string: `"` and `\` are escaped, and characters a
 * header cannot carry (controls, anything outside visible ASCII) become `?`.
 */
function quote(value: string): string {
  const clean = value.replace(HEADER_UNSAFE, "?");
  return `"${clean.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

/** A challenge as header text: `Bearer realm="api", error="invalid_token"`. */
export function formatChallenge(challenge: Challenge): string {
  const params = challenge.params ?? [];
  if (params.length === 0) return challenge.scheme;
  return `${challenge.scheme} ${
    params.map(([name, value]) => `${name}=${quote(value)}`).join(", ")
  }`;
}

/**
 * A challenge's parameters in the usual order: `realm` and the scheme's
 * own `leading` ones, then what `error` adds ({@link errorParams}), then
 * `resource_metadata`, so every scheme writes them the same way.
 */
export function challengeParams(
  options: ChallengeOptions,
  error: AuthError | undefined,
  leading: readonly (readonly [string, string])[] = [],
): (readonly [string, string])[] {
  return [
    ...(options.realm === undefined ? [] : [["realm", options.realm] as const]),
    ...leading,
    ...errorParams(error),
    ...(options.resourceMetadata === undefined
      ? []
      : [["resource_metadata", options.resourceMetadata] as const]),
  ];
}

/** The standard parameters an error adds to a challenge. */
export function errorParams(
  error: AuthError | undefined,
): (readonly [string, string])[] {
  if (error === undefined) return [];
  const out: (readonly [string, string])[] = [["error", error.code]];
  if (error.message !== "") {
    out.push(["error_description", describe(error.message)]);
  }
  if (error.scope !== undefined && error.scope.length > 0) {
    out.push(["scope", error.scope.join(" ")]);
  }
  return out;
}

/** `Authorization: <scheme> <credentials>`, split. */
export interface Credentials {
  /** As sent; compare it without case. */
  readonly scheme: string;
  /** Everything after the spaces following the scheme; may be empty. */
  readonly credentials: string;
}

/** The `Authorization` header split into scheme and credentials, or null when absent. */
export function parseAuthorization(header: string | null): Credentials | null {
  if (header === null) return null;
  const text = header.trim();
  const space = text.search(/[ \t]/);
  if (space === -1) return { scheme: text, credentials: "" };
  return {
    scheme: text.slice(0, space),
    credentials: text.slice(space).trim(),
  };
}

/** RFC 7235's token68, which bearer and DPoP tokens and Basic credentials are. */
export const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/** The separator of {@link Principal.key}; no part may contain it. */
const KEY_SEPARATOR = "\u0000";

/**
 * The ownership key of a principal's parts; see {@link Principal.key}.
 * Throws a `TypeError` when a part contains the separator, which would
 * let two different owners share a key.
 */
export function principalKey(parts: {
  readonly scheme: string;
  readonly issuer?: string;
  readonly tenant?: string;
  readonly clientId?: string;
  readonly subject: string;
}): string {
  const list = [
    parts.scheme,
    parts.issuer ?? "",
    parts.tenant ?? "",
    parts.clientId ?? "",
    parts.subject,
  ];
  if (
    list.some((part) =>
      typeof part !== "string" || part.length > 4096 ||
      part.includes(KEY_SEPARATOR)
    )
  ) {
    throw new TypeError(
      "a principal's scheme, issuer, tenant, clientId and subject cannot contain NUL",
    );
  }
  return list.join(KEY_SEPARATOR);
}

/**
 * Schemes whose principals carry the scheme that first authenticated them
 * (`session()`, which seals it at login); see {@link PrincipalInput.scheme}.
 * Internal: not exported from the package.
 */
const DELEGATING = new WeakSet<AuthScheme>();

/** Marks `scheme` as one whose principals may name their original scheme. */
export function markDelegating<S extends AuthScheme>(scheme: S): S {
  DELEGATING.add(scheme);
  return scheme;
}

/** Whether `scheme` was marked with {@link markDelegating}. */
export function isDelegating(scheme: AuthScheme): boolean {
  return DELEGATING.has(scheme);
}

/**
 * The frozen {@link Principal} the router makes of what `scheme` returned:
 * lists default to empty, `scheme` fills `Principal.scheme`, `key` is
 * computed, and `headers` is dropped. Throws a `TypeError` for a malformed
 * input (no subject, scopes or roles that are not strings, a `scheme`
 * other than `scheme`, a non-string `issuer`, `tenant`, `clientId` or
 * `tokenType`, an `expiresAt` that is not a finite number, or a key part
 * containing NUL). Exported for code that needs a principal as the router
 * would build it: tests, and handlers that call other code on a
 * principal's behalf.
 */
export function toPrincipal(input: PrincipalInput, scheme: string): Principal {
  strictRecord(input as unknown, [
    "subject",
    "scopes",
    "roles",
    "claims",
    "scheme",
    "clientId",
    "tenant",
    "issuer",
    "tokenType",
    "expiresAt",
    "cnf",
    "headers",
    "key",
  ], "principal");
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("principal must be an object");
  }
  if (
    typeof scheme !== "string" || scheme.length === 0 || scheme.length > 256
  ) throw new TypeError("principal scheme must be a bounded name");
  if (
    typeof input.subject !== "string" || input.subject === "" ||
    input.subject.length > 4096
  ) {
    throw new TypeError(
      `auth scheme ${scheme} returned a principal without a subject`,
    );
  }
  const strings = (list: readonly string[] | undefined, what: string) => {
    if (list === undefined) return Object.freeze([]);
    if (
      !Array.isArray(list) || list.length > 256 ||
      !list.every((item) =>
        typeof item === "string" && item.length > 0 && item.length <= 256 &&
        (what !== "scopes" || SCOPE.test(item))
      )
    ) {
      throw new TypeError(
        `auth scheme ${scheme} returned ${what} that are not strings`,
      );
    }
    return Object.freeze([...list]);
  };
  const text = (
    name: "issuer" | "tenant" | "clientId" | "tokenType" | "scheme",
  ) => {
    const value = input[name];
    if (
      value !== undefined && (typeof value !== "string" || value.length > 4096)
    ) {
      throw new TypeError(
        `auth scheme ${scheme} returned a ${name} that is not a string`,
      );
    }
    return value;
  };
  const issuer = text("issuer");
  const tenant = text("tenant");
  const clientId = text("clientId");
  const tokenType = text("tokenType");
  const named = text("scheme");
  if (named !== undefined && named !== scheme) {
    throw new TypeError(
      `auth scheme ${scheme} returned a principal naming another scheme (${named})`,
    );
  }
  const name = scheme;
  const expiresAt = input.expiresAt;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
  ) {
    throw new TypeError(
      `auth scheme ${scheme} returned an expiresAt that is not a finite number`,
    );
  }
  if (
    input.claims !== undefined &&
    (input.claims === null || typeof input.claims !== "object" ||
      Array.isArray(input.claims))
  ) throw new TypeError("principal claims must be a JSON object");
  if (input.cnf !== undefined) {
    strictRecord(input.cnf, ["jkt"], "principal confirmation");
    if (
      typeof input.cnf.jkt !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(input.cnf.jkt)
    ) throw new TypeError("principal confirmation requires a bounded jkt");
  }
  const principal: Principal = {
    subject: input.subject,
    scopes: strings(input.scopes, "scopes"),
    roles: strings(input.roles, "roles"),
    claims: jsonSnapshot(input.claims ?? {}),
    scheme: name,
    ...(clientId === undefined ? {} : { clientId }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(issuer === undefined ? {} : { issuer }),
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(input.cnf === undefined
      ? {}
      : { cnf: Object.freeze({ ...input.cnf }) }),
    key: principalKey({
      scheme: name,
      issuer,
      tenant,
      clientId,
      subject: input.subject,
    }),
  };
  return Object.freeze(principal);
}
