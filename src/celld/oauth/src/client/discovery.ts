// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding and validating the documents a client relies on:
 *
 * - {@link discoverAuthorizationServer}: RFC 8414 metadata, falling back
 *   to OpenID Connect Discovery's locations (see
 *   `authorizationServerMetadataUrls`). A document whose `issuer` is not
 *   exactly the issuer asked for is never used (RFC 8414 section 3.3),
 *   and every endpoint in it must be a secure URL.
 * - {@link discoverProtectedResource}: RFC 9728 metadata, from a
 *   challenge's `resource_metadata` or the well-known URLs, whose
 *   `resource` must identify the URL the client is calling (section 3.3).
 *
 * @module
 */

import { v } from "@celld/sieve";
import { OAuthError } from "../errors.ts";
import {
  type AuthorizationServerMetadata,
  authorizationServerMetadataUrls,
  isIssuer,
  type ProtectedResourceMetadata,
  protectedResourceMetadataUrls,
  resourceCovers,
  secureUrlProblem,
} from "../metadata.ts";
import { defaultFetch, type FetchLike } from "../util.ts";
import { fetchJson } from "./http.ts";

const strings = v.array(v.string()).optional();
const flag = v.boolean().optional();
const text = v.string().optional();

const AuthorizationServerSchema = v.looseObject({
  issuer: v.string(),
  authorization_endpoint: text,
  token_endpoint: text,
  jwks_uri: text,
  registration_endpoint: text,
  revocation_endpoint: text,
  introspection_endpoint: text,
  device_authorization_endpoint: text,
  pushed_authorization_request_endpoint: text,
  scopes_supported: strings,
  response_types_supported: strings,
  grant_types_supported: strings,
  code_challenge_methods_supported: strings,
  token_endpoint_auth_methods_supported: strings,
  dpop_signing_alg_values_supported: strings,
  require_pushed_authorization_requests: flag,
  authorization_response_iss_parameter_supported: flag,
  client_id_metadata_document_supported: flag,
});

const ProtectedResourceSchema = v.looseObject({
  resource: v.string(),
  authorization_servers: strings,
  jwks_uri: text,
  scopes_supported: strings,
  bearer_methods_supported: strings,
  dpop_signing_alg_values_supported: strings,
  dpop_bound_access_tokens_required: flag,
});

/** The endpoint members that must be secure URLs when present. */
export const ENDPOINT_MEMBERS = [
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
  "registration_endpoint",
  "revocation_endpoint",
  "introspection_endpoint",
  "device_authorization_endpoint",
  "pushed_authorization_request_endpoint",
  "userinfo_endpoint",
  "end_session_endpoint",
] as const;

/** Options for the discovery functions. */
export interface DiscoveryOptions {
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

/**
 * Checks an authorization server metadata document for `issuer`: the
 * types of the registered members, `issuer` identical to the one asked
 * for, and every endpoint a secure URL. Returns the document, or the
 * reason it is unusable.
 */
export function checkAuthorizationServerMetadata(
  body: unknown,
  issuer: string,
): AuthorizationServerMetadata | string {
  const parsed = AuthorizationServerSchema.safeParse(body);
  if (!parsed.success) return parsed.error.message;
  const document = parsed.data as AuthorizationServerMetadata;
  if (document.issuer !== issuer) {
    return `issuer ${JSON.stringify(document.issuer)} is not ${issuer}`;
  }
  for (const member of ENDPOINT_MEMBERS) {
    const value = document[member];
    if (value === undefined) continue;
    const problem = secureUrlProblem(value);
    if (problem !== null) return `${member} ${problem}`;
  }
  return document;
}

/**
 * The metadata of the authorization server `issuer`, from the first
 * well-known URL that has a usable document; see the module
 * documentation. `oidc: false` skips the OpenID Connect locations.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  options: DiscoveryOptions & { readonly oidc?: boolean } = {},
): Promise<AuthorizationServerMetadata> {
  if (!isIssuer(issuer)) {
    throw new OAuthError(
      "discovery",
      `${issuer} is not a valid issuer (https, no query or fragment)`,
      { issuer },
    );
  }
  const fetch = options.fetch ?? defaultFetch;
  const problems: string[] = [];
  for (const url of authorizationServerMetadataUrls(issuer, options)) {
    const { status, body } = await fetchJson(url, fetch, options.signal);
    if (body === null) {
      problems.push(`${url}: ${status}`);
      continue;
    }
    const checked = checkAuthorizationServerMetadata(body, issuer);
    if (typeof checked === "string") {
      problems.push(`${url}: ${checked}`);
      continue;
    }
    return checked;
  }
  throw new OAuthError(
    "discovery",
    `no usable metadata for authorization server ${issuer} (${
      problems.join("; ")
    })`,
    { issuer },
  );
}

/** Protected Resource Metadata and where it came from. */
export interface DiscoveredResource {
  readonly metadata: ProtectedResourceMetadata;
  readonly url: string;
  /**
   * The resource identifier the document gives: what tokens are requested
   * for (RFC 8707 `resource`), and the audience the resource checks.
   */
  readonly resource: string;
  /** Its authorization servers; never empty. */
  readonly authorizationServers: readonly string[];
}

/**
 * The Protected Resource Metadata for requests to `target`: from
 * `resourceMetadataUrl` (a challenge's `resource_metadata`) when given,
 * otherwise the well-known URLs in order. The document's `resource` must
 * cover `target` (see `resourceCovers`; `exact` requires the same URL),
 * and it must list at least one valid authorization server. A document for
 * another resource is an error, never skipped: RFC 9728 section 3.3 says
 * it must not be used, and trying on could land on an attacker's choice.
 */
export async function discoverProtectedResource(
  target: string | URL,
  options: DiscoveryOptions & {
    readonly resourceMetadataUrl?: string | null;
    readonly exact?: boolean;
  } = {},
): Promise<DiscoveredResource> {
  const fetch = options.fetch ?? defaultFetch;
  let candidates: string[];
  if (
    options.resourceMetadataUrl !== undefined &&
    options.resourceMetadataUrl !== null
  ) {
    const problem = secureUrlProblem(options.resourceMetadataUrl);
    if (problem !== null) {
      throw new OAuthError("discovery", `resource_metadata ${problem}`);
    }
    candidates = [options.resourceMetadataUrl];
  } else {
    candidates = protectedResourceMetadataUrls(target);
  }
  const problems: string[] = [];
  for (const url of candidates) {
    const { status, body } = await fetchJson(url, fetch, options.signal);
    if (body === null) {
      problems.push(`${url}: ${status}`);
      continue;
    }
    const parsed = ProtectedResourceSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthError(
        "discovery",
        `the protected resource metadata at ${url} is malformed: ${parsed.error.message}`,
      );
    }
    const metadata = parsed.data as ProtectedResourceMetadata;
    if (!resourceCovers(metadata.resource, target, { exact: options.exact })) {
      throw new OAuthError(
        "discovery",
        `the protected resource metadata at ${url} is for ${
          JSON.stringify(metadata.resource)
        }, not ${target}`,
      );
    }
    const servers = metadata.authorization_servers ?? [];
    if (servers.length === 0 || !servers.every(isIssuer)) {
      throw new OAuthError(
        "discovery",
        `the protected resource metadata at ${url} lists no valid authorization_servers`,
      );
    }
    return {
      metadata,
      url,
      resource: metadata.resource,
      authorizationServers: servers,
    };
  }
  throw new OAuthError(
    "discovery",
    `no protected resource metadata for ${target} (${problems.join(", ")})`,
  );
}
