// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenID Provider metadata (OpenID Connect Discovery 1.0 section 3), its
 * location (section 4: `/.well-known/openid-configuration` appended to
 * the issuer), and {@link discoverOpenIdProvider}, which checks what
 * `@celld/oauth` checks of any authorization server's metadata plus the
 * members OpenID Connect requires.
 *
 * @module
 */

import {
  type AuthorizationServerMetadata,
  authorizationServerMetadataUrls,
  type FetchLike,
  isIssuer,
  OAuthError,
  OPENID_CONFIGURATION,
} from "@celld/oauth";
import { checkAuthorizationServerMetadata } from "@celld/oauth/client";
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
  }
  const document = checked as OpenIdProviderMetadata;
  if (!document.response_types_supported.includes("code")) {
    return "the provider does not support the code response type";
  }
  if (document.id_token_signing_alg_values_supported.includes("none")) {
    return "the provider may sign ID tokens with none";
  }
  return document;
}

/**
 * The metadata of the OpenID Provider `issuer`: Discovery's location
 * first, then the RFC 8414 ones, taking the first usable document. A
 * document for another issuer is never used.
 */
export async function discoverOpenIdProvider(
  issuer: string,
  options: { readonly fetch?: FetchLike; readonly signal?: AbortSignal } = {},
): Promise<OpenIdProviderMetadata> {
  if (!isIssuer(issuer)) {
    throw new OAuthError("discovery", `${issuer} is not a valid issuer`, {
      issuer,
    });
  }
  const fetch = options.fetch ?? defaultFetch;
  const urls = [openIdConfigurationUrl(issuer)];
  for (const url of authorizationServerMetadataUrls(issuer)) {
    if (!urls.includes(url)) urls.push(url);
  }
  const problems: string[] = [];
  for (const url of urls) {
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: options.signal,
      });
      if (response.status >= 500) {
        throw new OAuthError("network", `${url} answered ${response.status}`, {
          status: response.status,
          issuer,
        });
      }
      if (!response.ok) {
        await response.body?.cancel();
        problems.push(`${url}: ${response.status}`);
        continue;
      }
      body = await response.json().catch(() => null);
    } catch (cause) {
      if (cause instanceof OAuthError) throw cause;
      throw new OAuthError("network", `could not fetch ${url}`, {
        cause,
        issuer,
      });
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
