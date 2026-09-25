// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Registered URNs and names the grants use.
 *
 * @module
 */

/** The token type URIs of RFC 8693 section 3. */
export const TOKEN_TYPES = {
  accessToken: "urn:ietf:params:oauth:token-type:access_token",
  refreshToken: "urn:ietf:params:oauth:token-type:refresh_token",
  idToken: "urn:ietf:params:oauth:token-type:id_token",
  jwt: "urn:ietf:params:oauth:token-type:jwt",
  saml1: "urn:ietf:params:oauth:token-type:saml1",
  saml2: "urn:ietf:params:oauth:token-type:saml2",
} as const;

/** Grant type URIs beyond the RFC 6749 names. */
export const GRANT_TYPES = {
  authorizationCode: "authorization_code",
  refreshToken: "refresh_token",
  clientCredentials: "client_credentials",
  /** RFC 8628. */
  deviceCode: "urn:ietf:params:oauth:grant-type:device_code",
  /** RFC 8693. */
  tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange",
  /** RFC 7523. */
  jwtBearer: "urn:ietf:params:oauth:grant-type:jwt-bearer",
} as const;

/** RFC 7523 section 2.2: the `client_assertion_type` of `private_key_jwt`. */
export const JWT_BEARER_ASSERTION =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** RFC 9126 section 2.2: the prefix of a pushed request's `request_uri`. */
export const REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";
