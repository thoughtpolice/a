// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/router`: a {@link ResourceServer} behind `@celld/router`'s
 * `bearer` and `dpop` schemes.
 *
 * ```ts
 * const resource = new ResourceServer({ ... });
 * const app = router<Env>({ auth: oauthSchemes(resource) });
 * app.get("/files", { scopes: ["files:read"] }, (c) => ...);
 * ```
 *
 * - {@link resourceVerifier} is a router `TokenVerifier` that hands the
 *   token, its scheme and the `DPoP` proof to `ResourceServer.verify`
 *   (every check of RFC 6750 and RFC 9449 section 7, replay and nonces
 *   included). A success becomes a principal whose `headers` carry the
 *   fresh `DPoP-Nonce`, which the router puts on whatever the request
 *   gets; a refusal becomes an `AuthError` with the challenge's status,
 *   code, description and `DPoP-Nonce`; a 503 (an introspection endpoint
 *   that is down) becomes an `HttpError`.
 * - {@link oauthSchemes} is the schemes to give `router({ auth })`, as the
 *   resource server is configured: `dpop` when it takes DPoP, then
 *   `bearer` unless it requires DPoP. Their challenges carry the resource
 *   server's `realm` and RFC 9728 `resource_metadata`, and `dpop`'s its
 *   proof algorithms.
 * - Behind a proxy the Worker sees an internal URL, but a DPoP proof's
 *   `htu` names the one the client used: `publicUrl(c)` supplies it (from
 *   `X-Forwarded-Host`, or a fixed origin), for both functions.
 * - A `ResourceServer` is one protected resource: one identifier, which its
 *   tokens' audience and its metadata's `resource` must match (RFC 9728
 *   section 3.3 requires the metadata's `resource` to be the identifier the
 *   metadata URL was derived from). A Worker reachable at several origins
 *   that should answer as each is several resources: build one
 *   `ResourceServer` (and one set of schemes) per origin, and pick it by
 *   the request's public origin.
 * - {@link protectedResourceRoutes} serves the resource server's RFC 9728
 *   metadata document from a router, as public `GET` routes (and so
 *   `HEAD`): at `/.well-known/oauth-protected-resource{path}`, which for a
 *   resource at the origin's root is `/.well-known/oauth-protected-resource`
 *   itself, and with `root: true` at that root form too.
 *
 * Route `scopes` are checked by the router, which answers 403
 * `insufficient_scope` with the same challenge parameters. Only this
 * subpath imports `@celld/router`.
 *
 * @module
 */

import {
  AuthError,
  type AuthScheme,
  bearer,
  type Context,
  dpop,
  HttpError,
  type PrincipalInput,
  type Router,
  type TokenVerifier,
} from "@celld/router";
import { protectedResourceMetadataUrl } from "./metadata.ts";
import type { ResourceServer } from "./resource/server.ts";

/** Options for {@link resourceVerifier}. */
export interface ResourceVerifierOptions {
  /**
   * The URL the client used for this request, when the Worker sees another
   * (behind a proxy): what a DPoP proof's `htu` is checked against. Default
   * `c.req.url`. Only trust forwarded headers a proxy you control sets.
   */
  readonly publicUrl?: (c: Context) => string | URL;
}

/** A router `TokenVerifier` over `resource.verify`; see the module documentation. */
export function resourceVerifier(
  resource: ResourceServer,
  options: ResourceVerifierOptions = {},
): TokenVerifier {
  const publicUrl = options.publicUrl;
  return async ({ token, scheme, proof, method, url, context }) => {
    const result = await resource.verify({
      method,
      url: publicUrl === undefined ? url : publicUrl(context),
      authorization: `${scheme} ${token}`,
      dpop: proof,
    });
    if (result.ok) {
      const { principal, headers } = result;
      const input: PrincipalInput = {
        subject: principal.subject,
        scopes: principal.scopes,
        claims: principal.claims,
        ...(principal.clientId === undefined
          ? {}
          : { clientId: principal.clientId }),
        ...(principal.cnf === undefined ? {} : { cnf: principal.cnf }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      };
      return input;
    }
    const challenge = result.challenge;
    if (challenge.status === 503) {
      throw new HttpError(
        503,
        challenge.description ?? "the token cannot be checked now",
      );
    }
    const nonce = challenge.headers["dpop-nonce"];
    return new AuthError(
      challenge.error ?? "invalid_token",
      challenge.description ?? "the access token is not valid",
      {
        status: challenge.status,
        ...(nonce === undefined ? {} : { headers: { "dpop-nonce": nonce } }),
      },
    );
  };
}

/** Options for {@link oauthSchemes}. */
export interface OAuthSchemesOptions extends ResourceVerifierOptions {
  /** The router scheme names; default `dpop` and `bearer`. */
  readonly names?: { readonly dpop?: string; readonly bearer?: string };
}

/** The router schemes for `resource`; see the module documentation. */
export function oauthSchemes(
  resource: ResourceServer,
  options: OAuthSchemesOptions = {},
): AuthScheme[] {
  const verify = resourceVerifier(resource, options);
  const metadata = resource.metadata;
  const challenge = {
    resourceMetadata: resource.resourceMetadataUrl,
    ...(resource.realm === undefined ? {} : { realm: resource.realm }),
  };
  const schemes: AuthScheme[] = [];
  const algs = metadata.dpop_signing_alg_values_supported;
  if (algs !== undefined) {
    schemes.push(dpop({
      ...challenge,
      verify,
      algs,
      ...(options.names?.dpop === undefined
        ? {}
        : { name: options.names.dpop }),
    }));
  }
  if (metadata.dpop_bound_access_tokens_required !== true) {
    schemes.push(bearer({
      ...challenge,
      verify,
      ...(options.names?.bearer === undefined
        ? {}
        : { name: options.names.bearer }),
    }));
  }
  return schemes;
}

/** Options for {@link protectedResourceRoutes}. */
export interface ProtectedResourceRoutesOptions {
  /**
   * Also serve the document at the origin's well-known URL,
   * `/.well-known/oauth-protected-resource`, for clients that only look
   * there (a resource with a path is otherwise found at
   * `/.well-known/oauth-protected-resource/path`); default false.
   */
  readonly root?: boolean;
}

/** A metadata URL's path as a router pattern of literal segments. */
function metadataPattern(url: string): string {
  const path = new URL(url).pathname;
  if (path === "/") return path;
  const segments = path.slice(1).split("/").map((segment) =>
    decodeURIComponent(segment)
  );
  for (const segment of segments) {
    if (segment.startsWith(":") || segment.startsWith("*")) {
      throw new TypeError(
        `the metadata path ${path} has a segment a router pattern cannot hold literally`,
      );
    }
  }
  return `/${segments.join("/")}`;
}

/**
 * Registers `resource`'s Protected Resource Metadata (RFC 9728) on `app`
 * as public `GET` routes: the path of `resource.resourceMetadataUrl`
 * (`/.well-known/oauth-protected-resource` followed by the resource's
 * path), and with `root` the origin's `/.well-known/oauth-protected-resource`
 * as well. The paths are absolute, so `app` is the router that serves the
 * origin, not one mounted under a prefix. Returns `app`.
 */
export function protectedResourceRoutes<
  E,
  S extends object,
  A extends boolean,
>(
  app: Router<E, S, A>,
  resource: ResourceServer,
  options: ProtectedResourceRoutesOptions = {},
): Router<E, S, A> {
  const patterns = [metadataPattern(resource.resourceMetadataUrl)];
  if (options.root) {
    const root = metadataPattern(protectedResourceMetadataUrl(
      new URL(resource.resource).origin,
    ));
    if (!patterns.includes(root)) patterns.push(root);
  }
  for (const pattern of patterns) {
    app.get(pattern, {
      public: true,
      summary: "OAuth 2.0 Protected Resource Metadata (RFC 9728)",
    }, () => resource.metadataResponse());
  }
  return app;
}
