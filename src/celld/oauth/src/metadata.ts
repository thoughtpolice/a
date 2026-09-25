// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The documents OAuth parties publish about themselves, and the URL rules
 * around them:
 *
 * - {@link AuthorizationServerMetadata} (RFC 8414, plus the members later
 *   RFCs register), and where to find it: {@link authorizationServerMetadataUrls}.
 * - {@link ProtectedResourceMetadata} (RFC 9728), and
 *   {@link protectedResourceMetadataUrl}.
 * - {@link ClientMetadata} (RFC 7591), which Dynamic Client Registration
 *   and Client ID Metadata Documents carry.
 * - {@link TokenResponse} and {@link IntrospectionResponse}.
 * - {@link checkSecureUrl}: every endpoint is `https:`, except loopback
 *   `http:` for development; {@link canonicalResource} and
 *   {@link resourceCovers} for RFC 8707 resource identifiers.
 *
 * @module
 */

import type { Jwks } from "@celld/jwt";
import { isLoopbackHost } from "./util.ts";

/** Authorization server metadata (RFC 8414; OpenID provider metadata is a superset). */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly jwks_uri?: string;
  readonly registration_endpoint?: string;
  readonly scopes_supported?: readonly string[];
  readonly response_types_supported?: readonly string[];
  readonly response_modes_supported?: readonly string[];
  readonly grant_types_supported?: readonly string[];
  readonly token_endpoint_auth_methods_supported?: readonly string[];
  readonly token_endpoint_auth_signing_alg_values_supported?: readonly string[];
  readonly service_documentation?: string;
  readonly revocation_endpoint?: string;
  readonly revocation_endpoint_auth_methods_supported?: readonly string[];
  readonly introspection_endpoint?: string;
  readonly introspection_endpoint_auth_methods_supported?: readonly string[];
  readonly code_challenge_methods_supported?: readonly string[];
  /** RFC 8628. */
  readonly device_authorization_endpoint?: string;
  /** RFC 9126. */
  readonly pushed_authorization_request_endpoint?: string;
  /** RFC 9126: every authorization request must be pushed first. */
  readonly require_pushed_authorization_requests?: boolean;
  /** RFC 9207: the authorization response carries `iss`. */
  readonly authorization_response_iss_parameter_supported?: boolean;
  /** RFC 9449: the JWS algorithms accepted in DPoP proofs. */
  readonly dpop_signing_alg_values_supported?: readonly string[];
  /** Client ID Metadata Documents are accepted as client ids. */
  readonly client_id_metadata_document_supported?: boolean;
  readonly [key: string]: unknown;
}

/** Protected Resource Metadata (RFC 9728 section 2). */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers?: readonly string[];
  readonly jwks_uri?: string;
  readonly scopes_supported?: readonly string[];
  /** How a token may be sent: `header`, `body`, `query`. */
  readonly bearer_methods_supported?: readonly string[];
  readonly resource_signing_alg_values_supported?: readonly string[];
  readonly resource_name?: string;
  readonly resource_documentation?: string;
  readonly resource_policy_uri?: string;
  readonly resource_tos_uri?: string;
  readonly tls_client_certificate_bound_access_tokens?: boolean;
  readonly authorization_details_types_supported?: readonly string[];
  /** The JWS algorithms accepted in DPoP proofs. */
  readonly dpop_signing_alg_values_supported?: readonly string[];
  /** Every access token must be DPoP-bound. */
  readonly dpop_bound_access_tokens_required?: boolean;
  readonly [key: string]: unknown;
}

/** Client metadata (RFC 7591 section 2, with registered extensions). */
export interface ClientMetadata {
  readonly redirect_uris?: readonly string[];
  readonly token_endpoint_auth_method?: string;
  readonly grant_types?: readonly string[];
  readonly response_types?: readonly string[];
  readonly client_name?: string;
  readonly client_uri?: string;
  readonly logo_uri?: string;
  readonly scope?: string;
  readonly contacts?: readonly string[];
  readonly tos_uri?: string;
  readonly policy_uri?: string;
  readonly jwks_uri?: string;
  readonly jwks?: Jwks;
  readonly software_id?: string;
  readonly software_version?: string;
  readonly token_endpoint_auth_signing_alg?: string;
  /** OpenID Connect Dynamic Client Registration: `web` or `native`. */
  readonly application_type?: "web" | "native";
  /** RFC 9449 section 5.2: this client always uses DPoP. */
  readonly dpop_bound_access_tokens?: boolean;
  /** RFC 9126 section 6. */
  readonly require_pushed_authorization_requests?: boolean;
  readonly [key: string]: unknown;
}

/** A successful token response (RFC 6749 section 5.1). */
export interface TokenResponse {
  readonly access_token: string;
  /** `Bearer`, or `DPoP` for a DPoP-bound token (RFC 9449 section 5). */
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
  /** RFC 8693: the type of the issued token. */
  readonly issued_token_type?: string;
  /** OpenID Connect. */
  readonly id_token?: string;
  readonly [key: string]: unknown;
}

/** An introspection response (RFC 7662 section 2.2). */
export interface IntrospectionResponse {
  readonly active: boolean;
  readonly scope?: string;
  readonly client_id?: string;
  readonly username?: string;
  readonly token_type?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  readonly jti?: string;
  /** RFC 9449 section 6.2: the DPoP key's thumbprint. */
  readonly cnf?: { readonly jkt?: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** RFC 8414 section 3: the well-known suffix for authorization server metadata. */
export const OAUTH_AUTHORIZATION_SERVER = "oauth-authorization-server";
/** OpenID Connect Discovery's well-known suffix. */
export const OPENID_CONFIGURATION = "openid-configuration";
/** RFC 9728 section 3: the well-known suffix for protected resource metadata. */
export const OAUTH_PROTECTED_RESOURCE = "oauth-protected-resource";

/**
 * Why `value` is not a URL an OAuth party may serve from, or null when it
 * is: absolute, `https:` (or `http:` on a loopback host), no fragment and
 * no user information.
 */
export function secureUrlProblem(value: unknown): string | null {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return "is not an absolute URL";
  }
  if (
    !(url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHost(url.hostname)))
  ) {
    return "must use https (http only on loopback)";
  }
  if (url.hash !== "" || String(value).includes("#")) {
    return "must not have a fragment";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not carry user information";
  }
  return null;
}

/** {@link secureUrlProblem} as a check that throws a `TypeError`, for configuration. */
export function checkSecureUrl(value: unknown, what: string): URL {
  const problem = secureUrlProblem(value);
  if (problem !== null) {
    throw new TypeError(`${what} ${problem}: ${String(value)}`);
  }
  return new URL(String(value));
}

/**
 * Whether an issuer identifier is valid (RFC 8414 section 2): a secure
 * URL (see {@link secureUrlProblem}) with no query or fragment.
 */
export function isIssuer(value: string): boolean {
  if (secureUrlProblem(value) !== null) return false;
  return !value.includes("?");
}

/**
 * The canonical form of a resource identifier (RFC 8707 section 2):
 * lowercase scheme and host, no fragment, and no trailing slash unless the
 * path is only `/` (which is then dropped). Throws `TypeError` for an
 * identifier that is not a secure URL.
 */
export function canonicalResource(resource: string | URL): string {
  const url = checkSecureUrl(String(resource), "a resource identifier");
  let path = url.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * Whether the resource identifier `resource` covers the URL `target`: the
 * same origin, and `target`'s path equal to `resource`'s or under it at a
 * `/` boundary. With `exact`, the two must be the same after
 * {@link canonicalResource}.
 */
export function resourceCovers(
  resource: string,
  target: string | URL,
  options: { readonly exact?: boolean } = {},
): boolean {
  let parsed: URL;
  let url: URL;
  try {
    parsed = new URL(resource);
    url = new URL(String(target));
  } catch {
    return false;
  }
  if (parsed.origin !== url.origin || parsed.hash !== "") return false;
  const base = parsed.pathname.replace(/\/+$/, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (options.exact) return path === base && parsed.search === url.search;
  return path === base || path.startsWith(base + "/");
}

function wellKnown(url: URL, suffix: string, path: string): string {
  return `${url.origin}/.well-known/${suffix}${path}`;
}

/**
 * The URLs to try for an issuer's metadata, in order: RFC 8414's
 * `/.well-known/oauth-authorization-server{path}`, then (unless `oidc` is
 * false) OpenID Connect's `/.well-known/openid-configuration{path}` and
 * `{path}/.well-known/openid-configuration`. For an issuer without a path
 * the last two are the same URL, which appears once.
 */
export function authorizationServerMetadataUrls(
  issuer: string,
  options: { readonly oidc?: boolean } = {},
): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = [wellKnown(url, OAUTH_AUTHORIZATION_SERVER, path)];
  if (options.oidc ?? true) {
    urls.push(wellKnown(url, OPENID_CONFIGURATION, path));
    if (path !== "") {
      urls.push(`${url.origin}${path}/.well-known/${OPENID_CONFIGURATION}`);
    }
  }
  return urls;
}

/**
 * The Protected Resource Metadata URL of a resource identifier (RFC 9728
 * section 3.1): the well-known suffix inserted between the host and the
 * path, a trailing slash removed, the query kept.
 */
export function protectedResourceMetadataUrl(resource: string | URL): string {
  const url = new URL(String(resource));
  const path = url.pathname.replace(/\/+$/, "");
  return `${wellKnown(url, OAUTH_PROTECTED_RESOURCE, path)}${url.search}`;
}

/**
 * The Protected Resource Metadata URLs to try for a request URL, when no
 * challenge named one: the one derived from the URL's path, then the
 * origin's (a resource identified by its origin).
 */
export function protectedResourceMetadataUrls(target: string | URL): string[] {
  const url = new URL(String(target));
  const urls = [protectedResourceMetadataUrl(`${url.origin}${url.pathname}`)];
  const root = protectedResourceMetadataUrl(url.origin);
  if (!urls.includes(root)) urls.push(root);
  return urls;
}
