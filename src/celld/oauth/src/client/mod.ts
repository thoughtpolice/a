// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/client`: the client side of OAuth 2.1.
 *
 * - {@link OAuthClient}: one authorization server, one client identity,
 *   every grant: authorization code with PKCE (and PAR, `iss` checks,
 *   `dpop_jkt`), refresh, client credentials, token exchange (RFC 8693),
 *   device authorization (RFC 8628), revocation (RFC 7009) and
 *   introspection (RFC 7662), with DPoP proofs and nonce retries when it
 *   has a key.
 * - {@link OAuthSession}: calling a protected resource, discovering what
 *   it needs from its challenges (RFC 9728), registering (Client ID
 *   Metadata Documents, RFC 7591), and keeping tokens in an
 *   {@link OAuthStore}; the user's part goes through an
 *   {@link OAuthUserAgent} the host provides.
 * - Discovery ({@link discoverAuthorizationServer},
 *   {@link discoverProtectedResource}), registration
 *   ({@link registerClient}, {@link clientMetadataDocument}) and client
 *   authentication ({@link ClientAuthentication}: `none`,
 *   `client_secret_basic`, `client_secret_post`, `private_key_jwt`).
 *
 * `fetch` and the clock are options everywhere.
 *
 * @module
 */

export {
  type AppliedAuthentication,
  applyClientAuthentication,
  type ClientAuthentication,
} from "./auth.ts";
export {
  type AuthorizationUrlOptions,
  type DeviceAuthorization,
  OAuthClient,
  type OAuthClientOptions,
  type PendingAuthorization,
  type TokenExchangeRequest,
} from "./client.ts";
export {
  checkAuthorizationServerMetadata,
  discoverAuthorizationServer,
  type DiscoveredResource,
  discoverProtectedResource,
  type DiscoveryOptions,
  ENDPOINT_MEMBERS,
} from "./discovery.ts";
export { parseTokenResponse } from "./http.ts";
export {
  applicationTypeFor,
  checkClientIdUrl,
  clientMetadataDocument,
  registerClient,
  type RegisterOptions,
  type RegistrationOptions,
  resolveClient,
  type ResolveContext,
} from "./registration.ts";
export {
  type AuthorizationRequest,
  type ClientCredentials,
  OAuthSession,
  type OAuthSessionOptions,
  type OAuthUserAgent,
  type ObservedResponse,
  type ResourceResponse,
  type SessionDiscovery,
} from "./session.ts";
export {
  type ClientInformation,
  memoryOAuthStore,
  type OAuthStore,
  type TokenSet,
} from "./store.ts";
