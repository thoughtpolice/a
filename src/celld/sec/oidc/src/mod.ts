// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenID Connect for celld, imported as "@celld/sec/oidc", on top of
 * `@celld/sec/oauth`. This entry point has what every side shares; each role
 * is its own subpath:
 *
 * | Import                     | What it has                                                        |
 * | -------------------------- | ------------------------------------------------------------------ |
 * | `@celld/sec/oidc`              | claims and scopes, the `claims` parameter, `at_hash`, discovery    |
 * | `@celld/sec/oidc/rp`           | `OidcClient`, `validateIdToken`, `LoginFlow`, `CookieSealer`        |
 * | `@celld/sec/oidc/provider`     | `OpenIdProvider`: ID tokens, UserInfo, end session, request objects |
 * | `@celld/sec/oidc/federation`   | OpenID Federation 1.0: statements, trust chains, policies, marks    |
 * | `@celld/sec/oidc/broker`       | `UpstreamBroker`: an OP that logs users in at another OP, with DPoP |
 * | `@celld/sec/oidc/testing`      | in-process providers and federations for tests                     |
 *
 * ```ts
 * import { discoverOpenIdProvider, tokenHash } from "@celld/sec/oidc";
 *
 * const metadata = await discoverOpenIdProvider("https://login.example.com");
 * const atHash = await tokenHash(accessToken, "ES256");
 * ```
 *
 * @module
 */

export {
  type ClaimRequest,
  claimsForScopes,
  type ClaimsRequest,
  ClaimsRequestError,
  ID_TOKEN_PROTOCOL_CLAIMS,
  type IdTokenClaims,
  OPENID_SCOPE,
  parseClaimsRequest,
  requestedAcrValues,
  SCOPE_CLAIMS,
  STANDARD_CLAIMS,
} from "./claims.ts";
export { IdTokenError, type IdTokenErrorCode } from "./errors.ts";
export { hashForAlgorithm, tokenHash } from "./hash.ts";
export {
  checkOpenIdProviderMetadata,
  discoverOpenIdProvider,
  type DiscoveryOptions,
  openIdConfigurationUrl,
  type OpenIdProviderMetadata,
} from "./metadata.ts";
export { SECRET_MIN_DISTINCT_BYTES } from "./util.ts";
