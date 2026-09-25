// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/resource`: the resource server side.
 *
 * - {@link ResourceServer}: `verifyRequest(request)` to a
 *   {@link Principal} or a {@link Challenge}, Bearer and DPoP (RFC 9449)
 *   with downgrade protection, scope checks, `WWW-Authenticate` with
 *   `resource_metadata`, and the Protected Resource Metadata document
 *   (RFC 9728) it serves.
 * - {@link jwtAccessTokenVerifier} (RFC 9068) and
 *   {@link introspectionVerifier} (RFC 7662), or any
 *   {@link AccessTokenVerifier}.
 *
 * Nothing here depends on a router: {@link ResourceServer.verify} takes
 * the method, the URL and the two headers, so a framework adapter is a
 * few lines.
 *
 * @module
 */

export {
  type AuthResult,
  type Challenge,
  type Principal,
  type RequestParts,
  type ResourceDpopOptions,
  ResourceServer,
  type ResourceServerOptions,
  type VerifyRequestOptions,
} from "./server.ts";
export {
  type AccessTokenVerifier,
  DEFAULT_ACCESS_TOKEN_ALGORITHMS,
  introspectionVerifier,
  type IntrospectionVerifierOptions,
  jwtAccessTokenVerifier,
  type JwtAccessTokenVerifierOptions,
  scopesOf,
  type VerifiedToken,
} from "./verifier.ts";
