// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A router for celld Workers that is secure by default, imported as
 * "@celld/router".
 *
 * ```ts
 * import { jwtBearer, router } from "@celld/router";
 * import { RemoteJwks } from "@celld/jwt";
 * import { v } from "@celld/sieve";
 *
 * const app = router<Env>({
 *   auth: jwtBearer({
 *     keys: new RemoteJwks("https://auth.example.com/.well-known/jwks.json"),
 *     issuer: "https://auth.example.com",
 *     audience: "https://api.example.com",
 *     algorithms: ["ES256"],
 *   }),
 * });
 *
 * app.get("/health", { public: true }, (c) => c.text("ok"));
 * app.post(
 *   "/notes",
 *   { scopes: ["notes:write"], body: v.object({ text: v.string().min(1) }) },
 *   (c) => c.json({ by: c.principal.subject, text: c.body.text }, 201),
 * );
 *
 * export default { fetch: app.fetch };
 * ```
 *
 * Every route needs a principal unless it says `public: true` (or the
 * router says `auth: "none"`), and a route that is neither is an error
 * when it is added. Responses get security headers, `no-store` when
 * authenticated, and opaque 500s; bodies have size, depth and key limits;
 * cookie credentials get CSRF checks; CORS is off until configured. The
 * matcher walks a segment trie: no `eval` or `new Function`. OpenAPI
 * export lives in "@celld/router/openapi".
 *
 * @module
 */

export {
  apiKey,
  type ApiKeyOptions,
  hashApiKey,
  hashedKeys,
} from "./api_key.ts";
export {
  AuthError,
  type AuthErrorOptions,
  type AuthOutcome,
  type AuthScheme,
  type Challenge,
  type ChallengeOptions,
  challengeParams,
  type Credentials,
  describe,
  errorParams,
  formatChallenge,
  parseAuthorization,
  type Principal,
  type PrincipalInput,
  TOKEN68,
  toPrincipal,
} from "./auth.ts";
export { basic, type BasicOptions } from "./basic.ts";
export {
  bearer,
  type BearerOptions,
  dpop,
  type DpopOptions,
  type TokenRequest,
  type TokenVerifier,
} from "./bearer.ts";
export { DEFAULT_LIMITS, type Limits, scanJson, toRecord } from "./body.ts";
export { clientIp, type ClientIpOptions } from "./client_ip.ts";
export {
  type AnyContextTypes,
  Context,
  type ContextTypes,
  type Init,
} from "./context.ts";
export {
  type CookieKey,
  CookieKeyring,
  cookieKeys,
  type CookieOptions,
  type OpenedCookie,
  parseCookies,
  serializeCookie,
} from "./cookies.ts";
export { cors, type CorsOptions } from "./cors.ts";
export {
  type CsrfOptions,
  csrfToken,
  type CsrfTokenOptions,
  SAFE_METHODS,
} from "./csrf.ts";
export type { Duration } from "./duration.ts";
export { HttpError, type HttpErrorOptions, RouterError } from "./errors.ts";
export {
  jwtBearer,
  type JwtBearerOptions,
  jwtVerifier,
  type JwtVerifierOptions,
  principalFromClaims,
} from "./jwt_bearer.ts";
export {
  type AddsAll,
  type AddsOf,
  type Empty,
  type Middleware,
  middleware,
  type MiddlewareContext,
  type Next,
} from "./middleware.ts";
export { type ParamNames, type PathParams, type Segment } from "./path.ts";
export {
  type AuthConfig,
  type ErrorMapper,
  type ErrorReporter,
  type Handler,
  type RouteContext,
  type RouteInfo,
  type RouteLimits,
  type RouteMethod,
  type RouteOptions,
  Router,
  router,
  type RouterOptions,
  type RouteTypes,
} from "./router.ts";
export { API_CSP, HSTS, HTML_CSP, type SecurityHeaders } from "./security.ts";
export { session, type SessionOptions, type SessionScheme } from "./session.ts";
export { secretEquals, timingSafeEqual } from "./timing.ts";
