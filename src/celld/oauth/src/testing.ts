// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/oauth/testing`: running both sides of OAuth in one process.
 *
 * ```ts
 * const clock = manualClock(Date.parse("2026-01-01T00:00:00Z"));
 * const as = await testAuthorizationServer({ issuer: "https://as.test", now: clock.now });
 * const api = testResourceServer(as, { resource: "https://api.test" });
 * const fetch = routeFetch({
 *   "https://as.test": (r) => as.server.handle(r).then((x) => x ?? notFound()),
 *   "https://api.test": serveResource(api, () => new Response("ok")),
 * });
 * const session = new OAuthSession({ resource: "https://api.test", fetch, userAgent: testUserAgent(fetch), ... });
 * ```
 *
 * - {@link testAuthorizationServer}: an {@link AuthorizationServer} with a
 *   fresh ES256 key, an in-memory store, and consent that grants at once
 *   (or as a test decides).
 * - {@link testResourceServer} and {@link serveResource}: a resource
 *   server trusting it, and a handler that serves its metadata and checks
 *   tokens.
 * - {@link testUserAgent}: follows the authorization redirects the way a
 *   browser would, without one.
 * - {@link routeFetch}: a `fetch` that sends each origin to a handler.
 * - {@link manualClock}: a clock tests move by hand.
 *
 * Everything keeps its state in memory; it is for tests and demos only.
 *
 * @module
 */

import type { AuthorizationRequest, OAuthUserAgent } from "./client/session.ts";
import { memoryReplayStore } from "./dpop/verify.ts";
import {
  type Principal,
  ResourceServer,
  type ResourceServerOptions,
} from "./resource/server.ts";
import { jwtAccessTokenVerifier } from "./resource/verifier.ts";
import {
  type AuthorizationContext,
  AuthorizationServer,
  type AuthorizationServerOptions,
  type InteractionDecision,
} from "./server/server.ts";
import { memoryRecordStore, type RecordStore } from "./server/store.ts";
import {
  generateSigningKey,
  publicJwks,
  type SigningKey,
} from "./server/tokens.ts";
import type { Clock, FetchLike } from "./util.ts";

/** A clock that moves only when told. */
export interface ManualClock {
  readonly now: Clock;
  /** Moves the clock forward by `ms`. */
  advance(ms: number): void;
  /** Sets the clock. */
  set(ms: number): void;
}

/** A {@link ManualClock} starting at `start` (epoch milliseconds). */
export function manualClock(start = Date.UTC(2026, 0, 1)): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}

/** A `fetch` that sends requests for each origin to its handler (the rest to `fallback`). */
export function routeFetch(
  routes: Readonly<
    Record<string, (request: Request) => Promise<Response> | Response>
  >,
  fallback?: FetchLike,
): FetchLike & { readonly requests: Request[] } {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const handler = routes[new URL(request.url).origin];
    if (handler !== undefined) {
      if (request.signal.aborted) throw request.signal.reason;
      return await handler(request);
    }
    if (fallback !== undefined) return await fallback(input, init);
    throw new TypeError(`no route for ${request.url}`);
  };
  return Object.assign(fetch, { requests });
}

/**
 * An {@link OAuthUserAgent} that requests the authorization URL and
 * follows redirects until one leads to the redirect URI, which it returns.
 * Each request is recorded.
 */
export function testUserAgent(
  fetch: FetchLike,
): OAuthUserAgent & { readonly requests: AuthorizationRequest[] } {
  const requests: AuthorizationRequest[] = [];
  return {
    requests,
    async authorize(request) {
      requests.push(request);
      let url = request.url.href;
      for (let hop = 0; hop < 10; hop++) {
        if (url.startsWith(request.redirectUri)) return url;
        const response = await fetch(url, {
          redirect: "manual",
          signal: request.signal,
        });
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (
          response.status < 300 || response.status >= 400 || location === null
        ) {
          throw new Error(`${url} answered ${response.status}`);
        }
        url = new URL(location, url).href;
      }
      throw new Error("too many redirects");
    },
  };
}

/** Options for {@link testAuthorizationServer}. */
export type TestAuthorizationServerOptions =
  & Partial<Omit<AuthorizationServerOptions, "interaction">>
  & {
    readonly issuer: string;
    /**
     * Decides each authorization; default grants everything asked for to
     * `user-1`.
     */
    readonly consent?: (
      context: AuthorizationContext,
    ) =>
      | InteractionDecision
      | Response
      | Promise<InteractionDecision | Response>;
  };

/** An in-memory server and what it was built from. */
export interface TestAuthorizationServer {
  readonly server: AuthorizationServer;
  readonly store: RecordStore;
  readonly keys: readonly SigningKey[];
  /** Every authorization the consent hook saw. */
  readonly interactions: AuthorizationContext[];
  /** The server's handler, answering 404 for paths it does not serve. */
  readonly handle: (request: Request) => Promise<Response>;
}

/** An {@link AuthorizationServer} for tests; see the module documentation. */
export async function testAuthorizationServer(
  options: TestAuthorizationServerOptions,
): Promise<TestAuthorizationServer> {
  const keys = options.keys ?? [await generateSigningKey("ES256", "test-key")];
  const store = options.store ?? memoryRecordStore({ now: options.now });
  const interactions: AuthorizationContext[] = [];
  const consent = options.consent ??
    (() => ({ grant: { subject: "user-1" } }));
  const server = new AuthorizationServer({
    ...options,
    keys,
    store,
    resources: options.resources ?? {},
    interaction: (context) => {
      interactions.push(context);
      return consent(context);
    },
  });
  return {
    server,
    store,
    keys,
    interactions,
    handle: async (request) =>
      await server.handle(request) ??
        new Response("not found", { status: 404 }),
  };
}

/**
 * A {@link ResourceServer} trusting a test server's keys, with DPoP
 * accepted and an in-memory replay store unless `dpop` says otherwise.
 */
export function testResourceServer(
  as: TestAuthorizationServer,
  options:
    & Partial<Omit<ResourceServerOptions, "resource">>
    & { readonly resource: string },
): ResourceServer {
  return new ResourceServer({
    authorizationServers: [as.server.issuer],
    verifier: jwtAccessTokenVerifier({
      issuer: as.server.issuer,
      audience: options.resource,
      keys: publicJwks(as.keys),
      now: options.now,
    }),
    dpop: { replay: memoryReplayStore({ now: options.now }) },
    ...options,
  });
}

/**
 * A handler for a resource: serves its metadata, refuses requests without
 * a valid token, and calls `serve` with the principal otherwise.
 */
export function serveResource(
  resource: ResourceServer,
  serve: (
    request: Request,
    principal: Principal,
  ) => Response | Promise<Response>,
  options: { readonly scopes?: readonly string[] } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const metadata = resource.handleMetadata(request);
    if (metadata !== null) return metadata;
    const result = await resource.verifyRequest(request, options);
    if (!result.ok) return result.challenge.toResponse();
    const response = await serve(request, result.principal);
    for (const [name, value] of Object.entries(result.headers)) {
      response.headers.set(name, value);
    }
    return response;
  };
}
