// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/sec/oauth/router`: a {@link ResourceServer} behind `@celld/web/router`'s
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
 *   proof algorithms. ResourceServer alone verifies each proof and
 *   claims its replay key, with its configured nonce and replay policy.
 *   There is no public preverified-proof flag and no duplicate verification.
 * - Behind a proxy the Worker sees an internal URL, but a DPoP proof's
 *   `htu` names the one the client used. Both functions take it from the
 *   router's own public URL (`c.publicUrl`), so configure the router:
 *   `router({ publicUrl: { mode: "fixed", origin } })`, or
 *   `{ mode: "trusted-proxy", trustedProxies }` with a named peer source.
 *   There is no per-scheme override: one built from `X-Forwarded-*`
 *   headers would believe whoever sent them, and would disagree with the
 *   router's transport and CSRF checks.
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
 * subpath imports `@celld/web/router`.
 *
 * @module
 */

import {
  AuthError,
  type AuthScheme,
  bearer,
  HttpError,
  type PrincipalInput,
  type Router,
  type TokenVerifier,
} from "@celld/web/router";
import { strictRecord } from "@celld/core/bounds";
import { protectedResourceMetadataUrl } from "./metadata.ts";
import type { ResourceServer } from "./resource/server.ts";

/**
 * A router `TokenVerifier` over `resource.verify`, checking the request
 * against the router's public URL (`c.publicUrl`); see the module
 * documentation.
 */
export function resourceVerifier(resource: ResourceServer): TokenVerifier {
  return verifierFor(resource);
}

/**
 * The common verification path: token and proof are checked together.
 */
function verifierFor(
  resource: ResourceServer,
): TokenVerifier {
  return async ({ token, scheme, method, context }) => {
    const result = await resource.verify({
      method,
      url: context.publicUrl.href,
      authorization: `${scheme} ${token}`,
      dpop: context.req.headers.get("dpop"),
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
        issuer: principal.issuer,
        ...(principal.expiresAt === undefined
          ? {}
          : { expiresAt: principal.expiresAt }),
        tokenType: principal.tokenType,
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
export interface OAuthSchemesOptions {
  /** The router scheme names; default `dpop` and `bearer`. */
  readonly names?: { readonly dpop?: string; readonly bearer?: string };
}

/** The router schemes for `resource`; see the module documentation. */
export function oauthSchemes(
  resource: ResourceServer,
  options: OAuthSchemesOptions = {},
): AuthScheme[] {
  strictRecord(options as unknown, ["names"], "OAuth router scheme options");
  if (options.names !== undefined) {
    strictRecord(
      options.names as unknown,
      ["dpop", "bearer"],
      "OAuth scheme names",
    );
    if (
      Object.values(options.names).some((name) =>
        typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)
      ) ||
      (options.names.dpop !== undefined &&
        options.names.dpop === options.names.bearer)
    ) throw new TypeError("scheme names must be distinct bounded identifiers");
  }
  const verify = resourceVerifier(resource);
  const challenge = {
    resourceMetadata: resource.resourceMetadataUrl,
    ...(resource.realm === undefined ? {} : { realm: resource.realm }),
  };
  const schemes: AuthScheme[] = [];
  const policy = resource.dpop;
  if (policy !== null) {
    // ResourceServer is the sole proof verifier/claimant, including when
    // both replay and nonce are configured. No public preverified flag.
    schemes.push({
      name: options.names?.dpop ?? "dpop",
      ambient: false,
      async authenticate(context) {
        const header = context.req.headers.get("authorization");
        if (header === null || !/^DPoP(?:\s|$)/i.test(header)) return null;
        const match = /^DPoP +([^\s]+)$/i.exec(header);
        if (match === null) {
          return new AuthError(
            "invalid_request",
            "malformed DPoP authorization",
            { status: 400 },
          );
        }
        return await verify({
          token: match[1],
          scheme: "DPoP",
          request: context.req,
          method: context.req.method,
          url: context.publicUrl.href,
          context,
        });
      },
      challenge(error) {
        return {
          scheme: "DPoP",
          params: Object.entries({
            ...(resource.realm === undefined ? {} : { realm: resource.realm }),
            algs: policy.algorithms.join(" "),
            resource_metadata: resource.resourceMetadataUrl,
            ...(error === undefined
              ? {}
              : { error: error.code, error_description: error.message }),
          }),
        };
      },
      openapi: { type: "http", scheme: "DPoP" },
    });
  }
  if (policy === null || !policy.required) {
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
  strictRecord(
    options as unknown,
    ["root"],
    "protected resource routes options",
  );
  if (options.root !== undefined && typeof options.root !== "boolean") {
    throw new TypeError("root must be boolean");
  }
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
