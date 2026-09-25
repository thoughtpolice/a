// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenID Provider metadata (OpenID Connect Discovery 1.0 section 3), its
 * location (section 4: `/.well-known/openid-configuration` appended to
 * the issuer), and {@link discoverOpenIdProvider}, which checks what
 * `@celld/sec/oauth` checks of any authorization server's metadata plus the
 * members OpenID Connect requires.
 *
 * @module
 */

import {
  type AuthorizationServerMetadata,
  authorizationServerMetadataUrls,
  type EgressOptions,
  egressUrlProblem,
  type FetchLike,
  isIssuer,
  metadataEgressPolicy,
  OAuthError,
  OPENID_CONFIGURATION,
  secureUrlProblem,
} from "@celld/sec/oauth";
import { jsonSnapshot } from "@celld/core/bounds";
import { checkAuthorizationServerMetadata } from "@celld/sec/oauth/client";
import {
  boundedFetch,
  type BoundedResponse,
  EgressError,
} from "@celld/http/egress";
import { defaultFetch, isObject, isStringArray } from "./util.ts";

/** OpenID Provider metadata: authorization server metadata plus Discovery's members. */
export interface OpenIdProviderMetadata extends AuthorizationServerMetadata {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly string[];
  readonly subject_types_supported: readonly string[];
  readonly id_token_signing_alg_values_supported: readonly string[];
  readonly userinfo_endpoint?: string;
  /** RP-Initiated Logout 1.0. */
  readonly end_session_endpoint?: string;
  readonly claims_supported?: readonly string[];
  readonly claims_parameter_supported?: boolean;
  readonly acr_values_supported?: readonly string[];
  readonly request_parameter_supported?: boolean;
  readonly request_uri_parameter_supported?: boolean;
  readonly request_object_signing_alg_values_supported?: readonly string[];
  readonly prompt_values_supported?: readonly string[];
  readonly userinfo_signing_alg_values_supported?: readonly string[];
  /** OpenID Federation: `automatic`, `explicit`. */
  readonly client_registration_types_supported?: readonly string[];
  readonly federation_registration_endpoint?: string;
}

/** Where an issuer's OpenID configuration is: `{issuer}/.well-known/openid-configuration`. */
export function openIdConfigurationUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/${OPENID_CONFIGURATION}`;
}

const REQUIRED_LISTS = [
  "response_types_supported",
  "subject_types_supported",
  "id_token_signing_alg_values_supported",
] as const;

/**
 * Checks an OpenID Provider metadata document for `issuer`: everything
 * `checkAuthorizationServerMetadata` checks (types, `issuer` exactly,
 * secure endpoints), then the members Discovery requires, the code
 * response type, and no `none` among the ID token algorithms. Returns the
 * document or the reason it is unusable.
 */
export function checkOpenIdProviderMetadata(
  body: unknown,
  issuer: string,
): OpenIdProviderMetadata | string {
  try {
    if (
      isObject(body) && Object.getPrototypeOf(body) !== Object.prototype &&
      Object.getPrototypeOf(body) !== null
    ) return "metadata must be a plain data object";
    if (
      isObject(body) &&
      Object.values(Object.getOwnPropertyDescriptors(body)).every((
        descriptor,
      ) => Object.hasOwn(descriptor, "value"))
    ) {
      body = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      );
    }
    body = jsonSnapshot(body);
  } catch {
    return "metadata must be bounded JSON data";
  }
  const checked = checkAuthorizationServerMetadata(body, issuer);
  if (typeof checked === "string") return checked;
  for (const name of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof checked[name] !== "string") return `${name} is required`;
  }
  for (const name of REQUIRED_LISTS) {
    if (!isStringArray(checked[name])) return `${name} is required`;
  }
  for (const name of ["userinfo_endpoint", "end_session_endpoint"]) {
    const value = checked[name];
    if (value !== undefined && typeof value !== "string") {
      return `${name} must be a string`;
    }
    if (typeof value === "string" && secureUrlProblem(value) !== null) {
      return `${name} must be a secure endpoint URL`;
    }
  }
  for (
    const name of [
      "claims_supported",
      "acr_values_supported",
      "request_object_signing_alg_values_supported",
      "userinfo_signing_alg_values_supported",
      "client_registration_types_supported",
      "prompt_values_supported",
    ]
  ) {
    if (checked[name] !== undefined && !isStringArray(checked[name])) {
      return `${name} must be a list of strings`;
    }
  }
  for (
    const name of [
      "claims_parameter_supported",
      "request_parameter_supported",
      "request_uri_parameter_supported",
    ]
  ) {
    if (checked[name] !== undefined && typeof checked[name] !== "boolean") {
      return `${name} must be boolean`;
    }
  }
  const document = checked as OpenIdProviderMetadata;
  if (!document.response_types_supported.includes("code")) {
    return "the provider does not support the code response type";
  }
  if (document.id_token_signing_alg_values_supported.includes("none")) {
    return "the provider may sign ID tokens with none";
  }
  return jsonSnapshot(document);
}

/** Options for {@link discoverOpenIdProvider}. */
export interface DiscoveryOptions extends EgressOptions {
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

/** An egress refusal as a `discovery` error, a network failure as `network`. */
function egressError(url: string, issuer: string, cause: unknown): OAuthError {
  if (
    cause instanceof EgressError && cause.code !== "fetch" &&
    cause.code !== "timeout" && cause.code !== "aborted"
  ) {
    return new OAuthError(
      "discovery",
      `fetching ${url} was refused: ${cause.message}`,
      { cause, issuer },
    );
  }
  return new OAuthError(
    "network",
    `could not fetch ${url}: ${(cause as Error)?.message ?? cause}`,
    { cause, issuer },
  );
}

/**
 * The metadata of the OpenID Provider `issuer`: Discovery's location
 * first, then the RFC 8414 ones, taking the first usable document. A
 * document for another issuer is never used.
 *
 * Every fetch goes through `@celld/sec/oauth`'s `metadataEgressPolicy`
 * (`@celld/http/egress`): https only, no redirects, 5 seconds, 64 KiB
 * read as a stream, bounded JSON, and no private, link-local or loopback
 * address (refused before anything is sent). `allowLoopbackForDevelopment`
 * allows `http:` to a loopback IP literal for a provider on this machine;
 * `egress` adjusts the policy (`{ network: "any" }` for a provider on a
 * private network).
 */
export async function discoverOpenIdProvider(
  issuer: string,
  options: DiscoveryOptions = {},
): Promise<OpenIdProviderMetadata> {
  if (!isIssuer(issuer)) {
    throw new OAuthError("discovery", `${issuer} is not a valid issuer`, {
      issuer,
    });
  }
  const fetch = options.fetch ?? defaultFetch;
  const policy = metadataEgressPolicy(options);
  const get = boundedFetch(policy, (input, init) => fetch(input, init));
  const urls = [openIdConfigurationUrl(issuer)];
  for (const url of authorizationServerMetadataUrls(issuer)) {
    if (!urls.includes(url)) urls.push(url);
  }
  const problems: string[] = [];
  for (const url of urls) {
    const problem = egressUrlProblem(url, policy);
    if (problem !== null) {
      throw new OAuthError("discovery", `${url} ${problem}`, { issuer });
    }
    let response: BoundedResponse;
    try {
      response = await get(url, {
        headers: { accept: "application/json" },
        signal: options.signal,
      });
    } catch (cause) {
      throw egressError(url, issuer, cause);
    }
    if (response.status >= 500) {
      await response.discard();
      throw new OAuthError("network", `${url} answered ${response.status}`, {
        status: response.status,
        issuer,
      });
    }
    if (!response.ok) {
      await response.discard();
      problems.push(`${url}: ${response.status}`);
      continue;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      if (!(cause instanceof EgressError && cause.code === "json")) {
        throw egressError(url, issuer, cause);
      }
      body = null;
    }
    if (!isObject(body)) {
      problems.push(`${url}: not a JSON object`);
      continue;
    }
    const checked = checkOpenIdProviderMetadata(body, issuer);
    if (typeof checked === "string") {
      problems.push(`${url}: ${checked}`);
      continue;
    }
    return checked;
  }
  throw new OAuthError(
    "discovery",
    `no usable OpenID configuration for ${issuer} (${problems.join("; ")})`,
    { issuer },
  );
}
