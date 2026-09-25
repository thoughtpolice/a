// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/server`: authorization server building blocks.
 *
 * - {@link AuthorizationServer}: metadata (RFC 8414), authorize (code +
 *   PKCE S256, exact redirect URIs, `iss`, PAR), PAR (RFC 9126), token
 *   (code, refresh with rotation and reuse detection, client credentials,
 *   token exchange, device code), revocation (RFC 7009), introspection
 *   (RFC 7662), JWKS, Dynamic Client Registration (RFC 7591), device
 *   authorization (RFC 8628), Client ID Metadata Documents; RFC 9068
 *   access tokens, DPoP-bound when a proof is sent (RFC 9449).
 * - {@link RecordStore}: what it keeps things in;
 *   {@link memoryRecordStore} here, `durableRecordStore` in
 *   `@celld/oauth/durable`.
 * - Signing keys ({@link generateSigningKey}, {@link signingKeyFromJwk}),
 *   client records and validation.
 *
 * Every endpoint is `(Request) => Promise<Response>`, and
 * {@link AuthorizationServer.handle} routes by path, so any router works.
 *
 * @module
 */

export {
  AUTH_METHODS,
  type AuthMethod,
  type ClientConfig,
  isConfidential,
  redirectUriMatches,
  redirectUriProblem,
  type RegisteredClient,
  registeredClient,
  validateClientMetadata,
} from "./clients.ts";
export {
  type AuthorizationContext,
  AuthorizationServer,
  type AuthorizationServerOptions,
  type DeviceRequest,
  type EndpointName,
  type InteractionDecision,
  type InteractionHook,
  type IssuedGrant,
  type TokenExchangeContext,
  type TokenExchangeHook,
  type TokenResponseHook,
} from "./server.ts";
export {
  memoryRecordStore,
  type MemoryRecordStoreOptions,
  recordReplayStore,
  type RecordStore,
  type StoredRecord,
} from "./store.ts";
export {
  type AccessTokenGrant,
  generateSigningKey,
  issueAccessToken,
  publicJwks,
  type SigningKey,
  signingKeyFromJwk,
  verifyOwnAccessToken,
} from "./tokens.ts";
