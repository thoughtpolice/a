// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.1 for celld, imported as "@celld/sec/oauth": the pieces every side
 * shares. Each role is its own subpath, so a Worker carries only the side
 * it plays:
 *
 * | Import                   | What it has                                                   |
 * | ------------------------ | ------------------------------------------------------------- |
 * | `@celld/sec/oauth`           | errors, metadata types and URL rules, PKCE, challenges, scope |
 * | `@celld/sec/oauth/client`    | `OAuthClient` (one server's grants), `OAuthSession` (`resourceFetch`) |
 * | `@celld/sec/oauth/dpop`      | DPoP keys and proofs, proof verification, replay, nonces      |
 * | `@celld/sec/oauth/resource`  | `ResourceServer.verifyRequest`, JWT and introspection checks  |
 * | `@celld/sec/oauth/router`    | `@celld/web/router` schemes and metadata routes for a resource    |
 * | `@celld/sec/oauth/server`    | `AuthorizationServer`: `(Request) => Response` endpoints      |
 * | `@celld/sec/oauth/durable`   | Durable Object storage for the server and replay              |
 * | `@celld/sec/oauth/testing`   | in-process servers, a user agent, a routing `fetch`, a clock  |
 *
 * ```ts
 * import { pkcePair, ProtocolError, resourceChallenge } from "@celld/sec/oauth";
 *
 * const { verifier, challenge } = await pkcePair();
 * const found = resourceChallenge(response.headers.get("www-authenticate"));
 * throw new ProtocolError("invalid_grant", { description: "code expired" });
 * ```
 *
 * Nothing here uses Node APIs or `eval`; JWS work is `@celld/sec/jwt`'s.
 *
 * @module
 */

export { OAUTH_LIMITS } from "./limits.ts";
export {
  GRANT_TYPES,
  JWT_BEARER_ASSERTION,
  REQUEST_URI_PREFIX,
  TOKEN_TYPES,
} from "./constants.ts";
export {
  type AuthChallengeParams,
  challengeSchemes,
  formatChallenge,
  parseWwwAuthenticate,
  type ResourceChallenge,
  resourceChallenge,
} from "./challenge.ts";
export {
  attemptOAuth,
  type ErrorResponseBody,
  isOAuthError,
  OAuthError,
  type OAuthErrorCode,
  type OAuthErrorData,
  oauthErrorFromData,
  type OAuthErrorInit,
  type OAuthErrorKind,
  type OAuthOutcome,
  ProtocolError,
  type ProtocolErrorInit,
  safeDescription,
} from "./errors.ts";
export {
  type AuthorizationServerMetadata,
  authorizationServerMetadataUrls,
  canonicalResource,
  checkSecureUrl,
  type ClientMetadata,
  type IntrospectionResponse,
  isIssuer,
  isLoopbackLiteral,
  OAUTH_AUTHORIZATION_SERVER,
  OAUTH_PROTECTED_RESOURCE,
  OPENID_CONFIGURATION,
  type ProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  protectedResourceMetadataUrls,
  resourceCovers,
  secureUrlProblem,
  type TokenResponse,
} from "./metadata.ts";
export {
  isCodeVerifier,
  pkceChallenge,
  type PkcePair,
  pkcePair,
  verifyPkce,
} from "./pkce.ts";
export {
  definedEntries,
  type EgressOptions,
  type EgressUrlPolicy,
  egressUrlProblem,
  endpointEgressPolicy,
  metadataEgressPolicy,
} from "./egress.ts";
export {
  basicAuthorization,
  type Clock,
  type FetchLike,
  formatScope,
  hasScopes,
  isLoopbackHost,
  isScopeToken,
  parseBasicAuthorization,
  parseScope,
  randomToken,
  sha256,
  timingSafeEqual,
} from "./util.ts";
