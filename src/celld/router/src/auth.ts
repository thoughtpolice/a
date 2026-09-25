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
  /**
   * The token's confirmation (RFC 7800): `jkt` is the SHA-256 thumbprint of
   * the key a DPoP-bound token (RFC 9449) is bound to.
   */
  readonly cnf?: { readonly jkt?: string };
}

/** What a scheme or verifier returns for a good credential; the router fills in the rest. */
export interface PrincipalInput {
  readonly subject: string;
  readonly scopes?: readonly string[];
  readonly roles?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Default the scheme's name. */
  readonly scheme?: string;
  readonly clientId?: string;
  readonly tenant?: string;
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
  readonly headers: Headers;

  constructor(
    code: string,
    description: string,
    options: AuthErrorOptions = {},
  ) {
    super(description);
    this.code = code;
    this.status = options.status ?? STATUS[code] ?? 401;
    this.scope = options.scope;
    this.headers = new Headers(options.headers);
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
  /** Identifies the scheme: `Principal.scheme`, and the OpenAPI security scheme's key. */
  readonly name: string;
  /**
   * Whether browsers attach the credential by themselves (cookies, Basic),
   * which makes state-changing requests authenticated by it subject to the
   * router's CSRF check.
   */
  readonly ambient?: boolean;
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

/**
 * The frozen {@link Principal} the router makes of what `scheme` returned:
 * lists default to empty, `scheme` fills `Principal.scheme` unless the input
 * names one, and `headers` is dropped. Throws a `TypeError` for a malformed
 * input (no subject, scopes or roles that are not strings). Exported for
 * code that needs a principal as the router would build it: tests, and
 * handlers that call other code on a principal's behalf.
 */
export function toPrincipal(input: PrincipalInput, scheme: string): Principal {
  if (typeof input.subject !== "string" || input.subject === "") {
    throw new TypeError(
      `auth scheme ${scheme} returned a principal without a subject`,
    );
  }
  const strings = (list: readonly string[] | undefined, what: string) => {
    if (list === undefined) return Object.freeze([]);
    if (
      !Array.isArray(list) || !list.every((item) => typeof item === "string")
    ) {
      throw new TypeError(
        `auth scheme ${scheme} returned ${what} that are not strings`,
      );
    }
    return Object.freeze([...list]);
  };
  const principal: Principal = {
    subject: input.subject,
    scopes: strings(input.scopes, "scopes"),
    roles: strings(input.roles, "roles"),
    claims: Object.freeze({ ...input.claims }),
    scheme: input.scheme ?? scheme,
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    ...(input.tenant === undefined ? {} : { tenant: input.tenant }),
    ...(input.cnf === undefined
      ? {}
      : { cnf: Object.freeze({ ...input.cnf }) }),
  };
  return Object.freeze(principal);
}
