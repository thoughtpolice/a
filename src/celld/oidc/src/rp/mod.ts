// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oidc/rp`: the relying party side of OpenID Connect.
 *
 * - {@link OidcClient}: discovery, login (code + PKCE, `nonce`, `state`,
 *   `prompt`, `max_age`, `acr_values`, `claims`), ID token validation,
 *   refresh with ID token continuity, UserInfo (Bearer or DPoP), and
 *   RP-Initiated Logout URLs.
 * - {@link validateIdToken}: OpenID Connect Core section 3.1.3.7 on its
 *   own, for tokens from anywhere.
 * - {@link LoginFlow} and {@link CookieSealer}: the redirect round trip in
 *   a Worker, with the pending login in a sealed cookie.
 *
 * @module
 */

export {
  type Login,
  type LoginOptions,
  OidcClient,
  type OidcClientOptions,
  type PendingLogin,
  type Prompt,
} from "./client.ts";
export {
  clearCookie,
  type CookieOptions,
  CookieSealer,
  type CookieSealerOptions,
  readCookie,
  setCookie,
} from "./cookies.ts";
export {
  type FinishedLogin,
  isLocalPath,
  LoginFlow,
  type LoginFlowOptions,
} from "./login.ts";
export {
  DEFAULT_ID_TOKEN_ALGORITHMS,
  type IdTokenValidationOptions,
  validateIdToken,
} from "./validate.ts";
