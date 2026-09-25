// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oidc/provider`: an OpenID Provider on `@celld/oauth`'s
 * authorization server.
 *
 * - {@link OpenIdProvider}: `/.well-known/openid-configuration`, ID
 *   tokens (standard claims, `nonce`, `auth_time`, `acr`/`amr`,
 *   `at_hash`, `sid`), the `claims` request parameter, scope-to-claims
 *   mapping, UserInfo (Bearer and DPoP), RP-Initiated Logout, and signed
 *   request objects.
 * - The host plugs in login and consent ({@link OidcInteractionHook}),
 *   claims lookup ({@link ClaimsHook}) and logout ({@link EndSessionHook}).
 *
 * @module
 */

export {
  type ClaimsHook,
  type ClaimsLookup,
  type EndSessionContext,
  type EndSessionHook,
  type OidcAuthorizationContext,
  type OidcDecision,
  type OidcInteractionHook,
  OpenIdProvider,
  type OpenIdProviderOptions,
  USERINFO_CLAIMS_CLAIM,
} from "./provider.ts";
