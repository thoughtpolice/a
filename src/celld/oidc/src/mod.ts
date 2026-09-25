// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenID Connect for celld, imported as "@celld/oidc", on top of
 * `@celld/oauth`. This entry point has what every side shares; each role
 * is its own subpath:
 *
 * | Import                     | What it has                                                        |
 * | -------------------------- | ------------------------------------------------------------------ |
 * | `@celld/oidc`              | claims and scopes, the `claims` parameter, `at_hash`, discovery    |
 * | `@celld/oidc/rp`           | `OidcClient`, `validateIdToken`, `LoginFlow`, `CookieSealer`        |
 * | `@celld/oidc/provider`     | `OpenIdProvider`: ID tokens, UserInfo, end session, request objects |
 * | `@celld/oidc/federation`   | OpenID Federation 1.0: statements, trust chains, policies, marks    |
 * | `@celld/oidc/broker`       | `UpstreamBroker`: an OP that logs users in at another OP, with DPoP |
 * | `@celld/oidc/testing`      | in-process providers and federations for tests                     |
 *
 * ```ts
 * import { discoverOpenIdProvider, tokenHash } from "@celld/oidc";
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
  openIdConfigurationUrl,
  type OpenIdProviderMetadata,
} from "./metadata.ts";
