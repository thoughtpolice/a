// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link OAuthSession}: calling one protected resource, getting and
 * keeping the tokens it wants on the way.
 *
 * ```ts
 * const session = new OAuthSession({
 *   resource: "https://api.example.com/v1",
 *   redirectUri: "http://127.0.0.1:8765/callback",
 *   registration: { dynamic: { client_name: "My tool" } },
 *   userAgent, // opens the URL, returns the callback URL
 *   store,     // your encrypted OAuthStore; default in memory
 *   dpop: await DpopKey.generate(),
 * });
 * const response = await session.resourceFetch("https://api.example.com/v1/files");
 * ```
 *
 * Tokens only ever go to the resource: {@link OAuthSession.resourceFetch}
 * and {@link OAuthSession.resourceHeaders} refuse (`target`) a URL that
 * is not `https:`, carries user information, or is not covered by the
 * resource (the same origin, and a path at or under the resource's at a
 * `/` boundary, after dot segments are resolved, with no escaped `/`, `\`
 * or `.` in the path; see `resourceCovers`), before any credential
 * exists, and `resourceFetch` never follows a redirect
 * (`redirect: "error"`). {@link OAuthSession.unsafeHeaders} and
 * {@link OAuthSession.unsafeFetch} are the raw forms, which attach the
 * tokens to whatever URL they are given.
 *
 * On a 401 it discovers the Protected Resource Metadata (the challenge's
 * `resource_metadata`, else the well-known URLs) and the authorization
 * server's metadata, gets a client id (pre-registered, Client ID Metadata
 * Document, or Dynamic Client Registration), sends the user through the
 * {@link OAuthUserAgent} (PKCE, `state`, `resource`, `dpop_jkt`, PAR when
 * offered), checks `iss` and `state`, and redeems the code. Tokens are
 * kept per issuer and resource and refreshed before they expire; a 401
 * `invalid_token` refreshes once before starting over; a 403
 * `insufficient_scope` authorizes again with the union of the scopes so
 * far and the challenge's (a step-up), once per scope set. A resource's
 * `use_dpop_nonce` is retried with its new nonce.
 *
 * With `clientCredentials` there is no user: the client credentials grant
 * runs instead, with the credentials only ever sent to the issuer they
 * name.
 *
 * The parts of {@link OAuthSession.resourceFetch},
 * {@link OAuthSession.resourceHeaders}, {@link OAuthSession.challenge} and
 * {@link OAuthSession.observe}, are public so a transport with its own
 * request loop (an MCP client, say) can drive them: `resourceHeaders` for
 * every request, `observe` for every response (a resource may send a new
 * `DPoP-Nonce` with any of them), `challenge` for a 401 or 403;
 * {@link OAuthSession.httpAuth} bundles them as `headers`, `challenge`
 * and `observe`. `challenge` ignores a response from a URL the resource
 * does not cover, and discovery never moves a session to another
 * authorization server or another resource: a document that starts
 * naming another is an error, not a silent switch. A challenge's
 * `resource_metadata` on another origin than the configured resource must
 * name exactly that resource.
 *
 * @module
 */

import {
  jsonSnapshot,
  nonNegativeMs,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import { resourceChallenge } from "../challenge.ts";
import { type DpopAlgorithm, DpopKey, DpopNonceCache } from "../dpop/key.ts";
import { attemptOAuth, OAuthError, type OAuthOutcome } from "../errors.ts";
import {
  egressFetch,
  type EgressOptions,
  metadataEgressPolicy,
} from "../egress.ts";
import {
  type AuthorizationServerMetadata,
  isIssuer,
  isLoopbackLiteral,
  type ProtectedResourceMetadata,
  redirectUriProblem,
  resourceCovers,
} from "../metadata.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  parseScope,
  sha256,
  snapshotOptions,
} from "../util.ts";
import type { KeyLike } from "@celld/sec/jwt";
import {
  checkClientAuthentication,
  type ClientAuthentication,
} from "./auth.ts";
import {
  isPendingAuthorization,
  OAuthClient,
  type PendingAuthorization,
} from "./client.ts";
import { assertAuthorizedGrant, type AuthorizedGrant } from "./grant.ts";
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
} from "./discovery.ts";
import {
  checkRegistrationOptions,
  type RegistrationOptions,
  resolveClient,
} from "./registration.ts";
import {
  type ClientInformation,
  memoryOAuthStore,
  type OAuthStore,
  type TokenSet,
} from "./store.ts";

/** What a user agent is asked to do: send the user to `url`. */
export interface AuthorizationRequest {
  /** The authorization URL, with every parameter set. */
  readonly url: URL;
  /** Where the authorization server will send the user back. */
  readonly redirectUri: string;
  readonly state: string;
  readonly issuer: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly signal: AbortSignal;
}

/**
 * The redirect-and-consent step, which the host drives: a CLI opens a
 * browser and listens on its loopback redirect URI; a test follows the
 * redirect itself. It resolves with the URL the user came back to. A host
 * that cannot hold the flow in one call (a Worker, whose callback is
 * another request) uses {@link OAuthSession.beginAuthorization} and
 * {@link OAuthSession.completeAuthorization} instead.
 */
export interface OAuthUserAgent {
  authorize(request: AuthorizationRequest): Promise<string | URL>;
}

/** Credentials for the client credentials grant, bound to one authorization server. */
export type ClientCredentials =
  & {
    /** The issuer that registered the client; credentials are never sent elsewhere. */
    readonly issuer: string;
    readonly clientId: string;
  }
  & (
    | { readonly clientSecret: string }
    | {
      readonly privateKey: KeyLike;
      readonly alg: DpopAlgorithm;
      readonly kid?: string;
    }
  );

/** Options for {@link OAuthSession}. */
export interface OAuthSessionOptions extends EgressOptions {
  /** The protected resource's URL (or the base URL of the ones it serves). */
  readonly resource: string | URL;
  /** Where registrations and tokens are kept; default in memory. */
  readonly store?: OAuthStore;
  /** Unsafe single-owner migration only. Shared stores must provide an atomic lock. */
  readonly unsafeAllowUnlockedStore?: boolean;
  /** The redirect URI, for the authorization code grant. */
  readonly redirectUri?: string;
  /** How to get a client id; see `resolveClient`. */
  readonly registration?: RegistrationOptions;
  /** Drives the user through authorization. */
  readonly userAgent?: OAuthUserAgent;
  /** Use the client credentials grant instead of a user. */
  readonly clientCredentials?: ClientCredentials;
  /** A signing key for a registered client that uses `private_key_jwt`. */
  readonly signingKey?: {
    readonly privateKey: KeyLike;
    readonly alg: DpopAlgorithm;
    readonly kid?: string;
  };
  /** Bind tokens to this key with DPoP. */
  readonly dpop?: DpopKey;
  /** Accept Bearer tokens from a server that ignores DPoP; default false. */
  readonly allowBearerFallback?: boolean;
  /** Scopes when neither the challenge nor the metadata names any. */
  readonly scopes?: readonly string[];
  /** Also ask for `offline_access` when the server lists it; default false. */
  readonly offlineAccess?: boolean;
  /** Picks one of the resource's authorization servers; default the first usable. */
  readonly selectAuthorizationServer?: (issuers: readonly string[]) => string;
  /** Require the metadata's `resource` to be exactly the resource URL; default false. */
  readonly exactResource?: boolean;
  /** Refresh this long before expiry, in milliseconds; default 60 000. */
  readonly refreshSkewMs?: number;
  /** Tries per request in {@link OAuthSession.resourceFetch}, 1 to 10; default 3. */
  readonly maxAttempts?: number;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/** What {@link OAuthSession.signOut} did at the server. */
export interface SignOutResult {
  /** The refresh token was revoked at the server. */
  readonly revoked: boolean;
  /** Why it was not, when revocation was asked for and failed. */
  readonly error?: unknown;
}

/** What discovery found. */
export interface SessionDiscovery {
  readonly resource: string;
  readonly protectedResource: ProtectedResourceMetadata;
  readonly protectedResourceUrl: string;
  readonly issuer: string;
  readonly metadata: AuthorizationServerMetadata;
}

/** A response from the resource, for {@link OAuthSession.observe}. */
export interface ObservedResponse {
  /** The exact headers object returned for this request; an opaque request context. */
  readonly authContext: object;
  /** The request's URL (a response's own `url` is empty when built by hand). */
  readonly url: string | URL;
  readonly headers: Headers;
}

/**
 * The session as an HTTP transport's credential provider (`@celld/mcp`'s
 * `HttpAuthProvider`): `headers` is {@link OAuthSession.resourceHeaders}.
 */
export interface SessionHttpAuth {
  headers(
    request: {
      readonly method: string;
      readonly url: string | URL;
      readonly signal?: AbortSignal;
    },
  ): Promise<Record<string, string>>;
  challenge(response: ResourceResponse): Promise<boolean>;
  observe(response: ObservedResponse): string | undefined;
}

/** A 401 or 403 from the resource, for {@link OAuthSession.challenge}. */
export interface ResourceResponse {
  /** The exact headers object returned for this request, never another request's. */
  readonly authContext: object;
  readonly status: number;
  readonly headers: Headers;
  /** The request's method and URL. */
  readonly method: string;
  readonly url: string | URL;
  /** 1 for the first try of a request. */
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function union(...lists: readonly (readonly string[])[]): string[] {
  if (lists.some((list) => !Array.isArray(list) || list.length > 256)) {
    throw new TypeError("scopes must be a bounded array");
  }
  const result = [...new Set(lists.flat())];
  if (
    result.length > 256 ||
    result.some((scope) =>
      typeof scope !== "string" || scope.length > 256 ||
      !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)
    )
  ) {
    throw new TypeError("scopes must be a bounded list of OAuth scope tokens");
  }
  return result;
}

/** One waiter's cancellation never cancels work shared by other requests. */
function waitFor<T>(run: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return run;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    run.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** A client of one protected resource; see the module documentation. */
export class OAuthSession {
  readonly #options: OAuthSessionOptions;
  readonly #store: OAuthStore;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #nonces = new DpopNonceCache();
  #discovery: SessionDiscovery | null = null;
  #clients = new Map<string, OAuthClient>();
  #requested = new Set<string>();
  #stepUps = new Set<string>();
  #knownGeneration: string | undefined;
  #epoch = 0;
  #lifetime = new AbortController();
  #discovering: Promise<SessionDiscovery> | null = null;
  #tokenWrites: Promise<unknown> = Promise.resolve();
  #credentialIds = new WeakMap<object, number>();
  #nextCredentialId = 0;
  readonly #contexts = new WeakMap<
    object,
    { token: string | null; url: string; method: string; epoch: number }
  >();
  readonly #obtaining = new Map<string, Promise<TokenSet>>();
  #refreshing: Promise<TokenSet> | null = null;

  /** Throws `RangeError` for a `refreshSkewMs` or `maxAttempts` out of range. */
  constructor(options: OAuthSessionOptions) {
    strictRecord(options as unknown, [
      "resource",
      "store",
      "unsafeAllowUnlockedStore",
      "redirectUri",
      "registration",
      "userAgent",
      "clientCredentials",
      "signingKey",
      "dpop",
      "allowBearerFallback",
      "scopes",
      "offlineAccess",
      "selectAuthorizationServer",
      "exactResource",
      "refreshSkewMs",
      "maxAttempts",
      "fetch",
      "now",
      "egress",
      "allowLoopbackForDevelopment",
    ], "OAuthSession options");
    for (
      const field of [
        "unsafeAllowUnlockedStore",
        "allowBearerFallback",
        "offlineAccess",
        "exactResource",
        "allowLoopbackForDevelopment",
      ] as const
    ) {
      if (options[field] !== undefined && typeof options[field] !== "boolean") {
        throw new TypeError(`${field} must be boolean`);
      }
    }
    for (
      const field of ["fetch", "now", "selectAuthorizationServer"] as const
    ) {
      if (
        options[field] !== undefined && typeof options[field] !== "function"
      ) throw new TypeError(`${field} must be a function`);
    }
    if (options.scopes !== undefined) {
      if (!Array.isArray(options.scopes)) {
        throw new TypeError("scopes must be an array");
      }
      union(options.scopes);
    }
    if (
      !(typeof options.resource === "string" || options.resource instanceof URL)
    ) throw new TypeError("resource must be a URL");
    if (
      options.userAgent !== undefined &&
      typeof options.userAgent.authorize !== "function"
    ) throw new TypeError("userAgent.authorize must be a function");
    if (
      options.redirectUri !== undefined &&
      redirectUriProblem(options.redirectUri, "native") !== null
    ) {
      throw new TypeError(
        "redirectUri must be a safe native or HTTPS redirect",
      );
    }
    if (options.dpop !== undefined && !(options.dpop instanceof DpopKey)) {
      throw new TypeError("dpop must be a prepared DpopKey");
    }
    const credentials = options.clientCredentials;
    if (credentials !== undefined) {
      strictRecord(credentials as unknown, [
        "issuer",
        "clientId",
        ...("clientSecret" in credentials
          ? ["clientSecret"]
          : ["privateKey", "alg", "kid"]),
      ], "clientCredentials");
      if (!isIssuer(credentials.issuer)) {
        throw new TypeError(
          "clientCredentials.issuer must be a secure issuer URL",
        );
      }
      const { issuer: _issuer, ...auth } = credentials;
      checkClientAuthentication(
        {
          ...auth,
          method: "clientSecret" in credentials
            ? "client_secret_basic"
            : "private_key_jwt",
        } as ClientAuthentication,
      );
    }
    if (options.signingKey !== undefined) {
      strictRecord(
        options.signingKey as unknown,
        ["privateKey", "alg", "kid"],
        "signingKey",
      );
      checkClientAuthentication({
        method: "private_key_jwt",
        clientId: "session-signing-key",
        ...options.signingKey,
      });
    }
    if (options.registration !== undefined) {
      checkRegistrationOptions(options.registration);
    }
    // Validate the merged transport policy now, without performing a request.
    egressFetch(metadataEgressPolicy(options), options.fetch ?? defaultFetch);
    nonNegativeMs(options.refreshSkewMs ?? 60_000, { name: "refreshSkewMs" });
    safeInt(options.maxAttempts ?? 3, { name: "maxAttempts", min: 1, max: 10 });
    // Read once: `resource` and `allowLoopbackForDevelopment` decide where
    // tokens may go, so changing `options` afterwards changes nothing.
    this.#options = snapshotOptions({
      ...options,
      resource: String(options.resource),
    });
    this.#store = this.#options.store ?? memoryOAuthStore();
    for (
      const field of [
        "getClient",
        "setClient",
        "deleteClient",
        "getTokens",
        "setTokens",
        "deleteTokens",
      ] as const
    ) {
      if (typeof this.#store[field] !== "function") {
        throw new TypeError(`store.${field} must be a function`);
      }
    }
    if (
      typeof this.#store.lock !== "function" &&
      options.unsafeAllowUnlockedStore !== true
    ) {
      throw new TypeError(
        "OAuthSession requires an atomic store.lock; unsafeAllowUnlockedStore is only for single-owner migrations",
      );
    }
    this.#fetch = this.#options.fetch ?? defaultFetch;
    const clock = this.#options.now ?? defaultClock;
    this.#now = () => {
      const now = clock();
      if (!Number.isFinite(now) || now < 0 || now > 8.64e15) {
        throw new TypeError("now must return finite epoch milliseconds");
      }
      return now;
    };
    this.#now();
    this.#target(this.#options.resource);
  }

  /** What discovery found, once it ran. */
  get discovery(): SessionDiscovery | null {
    return this.#discovery;
  }

  /** The current tokens, if any. */
  async tokens(): Promise<TokenSet | undefined> {
    const epoch = this.#epoch;
    const found = this.#discovery;
    if (found === null) return undefined;
    return await this.#usable(
      await this.#store.getTokens(found.issuer, found.resource),
      epoch,
    );
  }

  /** Tokens bound to a DPoP key this session does not hold are useless. */
  async #usable(
    tokens: TokenSet | undefined,
    epoch = this.#epoch,
  ): Promise<AuthorizedGrant | undefined> {
    this.#checkEpoch(epoch);
    if (tokens === undefined) return undefined;
    const found = this.#discovery!;
    if (
      tokens.token_type === "DPoP" &&
      tokens.dpop_jkt !== this.#options.dpop?.jkt
    ) return undefined;
    const client = await this.#client(found, undefined);
    this.#checkEpoch(epoch);
    const grant = client.unsafeRestoreGrant(tokens);
    await client.validateGrant(grant);
    this.#checkEpoch(epoch);
    assertAuthorizedGrant(grant, {
      issuer: found.issuer,
      clientId: client.clientId,
      dpopJkt: this.#options.dpop?.jkt,
      resource: found.resource,
    });
    if (this.#knownGeneration !== grant.provenance.generation) {
      this.#knownGeneration = grant.provenance.generation;
      this.#stepUps.clear();
      this.#requested = new Set(grant.provenance.requestedScopes);
    }
    return grant;
  }

  #checkEpoch(epoch: number): void {
    if (epoch !== this.#epoch) {
      throw new OAuthError("token", "the operation was cancelled by sign-out");
    }
  }

  #operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.#lifetime.signal
      : AbortSignal.any([this.#lifetime.signal, signal]);
  }

  async #write<T>(found: SessionDiscovery, work: () => Promise<T>): Promise<T> {
    const run = () =>
      this.#store.lock === undefined ? work() : this.#store.lock(
        JSON.stringify(["tokens", found.issuer, found.resource]),
        work,
      );
    const pending = this.#tokenWrites.then(run, run);
    this.#tokenWrites = pending.then(() => {}, () => {});
    return await pending;
  }

  async #commit(
    found: SessionDiscovery,
    tokens: TokenSet,
    epoch: number,
  ): Promise<void> {
    await this.#write(found, async () => {
      if (epoch !== this.#epoch) {
        throw new OAuthError(
          "token",
          "the authorization was cancelled by sign-out",
        );
      }
      await this.#store.setTokens(found.issuer, found.resource, tokens);
      this.#checkEpoch(epoch);
      this.#knownGeneration = (tokens as AuthorizedGrant).provenance.generation;
      this.#requested = new Set(
        (tokens as AuthorizedGrant).provenance.requestedScopes,
      );
    });
  }

  /**
   * Whether `url` is one the session's tokens may go to: `https:` (or,
   * with `allowLoopbackForDevelopment`, `http:` to a loopback IP literal),
   * no user information, and covered by the configured resource and, once
   * discovered, the resource its metadata names. Throws `target`.
   */
  #target(input: string | URL): URL {
    const refuse = (why: string) =>
      new OAuthError(
        "target",
        `the session's credential destination was refused: ${why}`,
      );
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw refuse("it is not an absolute URL");
    }
    if (url.username !== "" || url.password !== "") {
      throw refuse("it carries user information");
    }
    if (url.hash !== "") throw refuse("it carries a fragment");
    const loopback = this.#options.allowLoopbackForDevelopment === true &&
      url.protocol === "http:" && isLoopbackLiteral(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
      throw refuse("it is not https");
    }
    if (!this.#covers(url)) {
      throw refuse(
        `it is not under the resource ${
          this.#discovery?.resource ?? String(this.#options.resource)
        }`,
      );
    }
    return url;
  }

  #covers(url: URL): boolean {
    const found = this.#discovery;
    return resourceCovers(String(this.#options.resource), url) &&
      (found === null || resourceCovers(found.resource, url));
  }

  /**
   * The headers for a request to the resource: `Authorization` (Bearer or
   * DPoP) and, for a DPoP token, a `DPoP` proof with `ath` and the
   * resource's nonce. A token about to expire is refreshed first. Throws
   * the {@link OAuthError} `target`, before any token is loaded, for a URL
   * the resource does not cover (see the module documentation).
   */
  async resourceHeaders(
    request: {
      readonly method: string;
      readonly url: string | URL;
      readonly signal?: AbortSignal;
    },
  ): Promise<Record<string, string>> {
    strictRecord(request, ["method", "url", "signal"], "resource request");
    const url = this.#target(request.url);
    return await this.unsafeHeaders({ ...request, url });
  }

  /**
   * Raw header construction: {@link resourceHeaders} without the URL
   * check, so it puts the session's access token (and a proof) on a
   * request to any URL at all. Only for a caller that has made sure the
   * URL belongs to the resource; prefer {@link resourceHeaders}.
   */
  async unsafeHeaders(
    request: {
      readonly method: string;
      readonly url: string | URL;
      readonly signal?: AbortSignal;
    },
  ): Promise<Record<string, string>> {
    strictRecord(request, ["method", "url", "signal"], "resource request");
    const { method, signal } = request;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError("signal must be an AbortSignal");
    }
    if (typeof request.url !== "string" && !(request.url instanceof URL)) {
      throw new TypeError("url must be a string or URL");
    }
    const url = new URL(String(request.url)).href;
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    const headers = await waitFor(
      this.#headers({ method, url }, epoch),
      signal,
    );
    if (epoch !== this.#epoch) {
      throw new OAuthError(
        "token",
        "credentials changed while preparing the request",
      );
    }
    Object.freeze(headers);
    this.#contexts.set(headers, {
      token: headers.authorization?.replace(/^[^ ]+ /, "") ?? null,
      url,
      method,
      epoch,
    });
    return headers;
  }

  async #headers(
    request: { readonly method: string; readonly url: string | URL },
    epoch: number,
  ): Promise<Record<string, string>> {
    if (
      typeof request.method !== "string" || !/^[A-Z]+$/.test(request.method) ||
      request.method.length > 32
    ) throw new TypeError("method must be a bounded uppercase HTTP method");
    const found = this.#discovery;
    if (found === null) return {};
    let tokens: TokenSet | undefined = await this.#usable(
      await this.#store.getTokens(found.issuer, found.resource),
      epoch,
    );
    this.#checkEpoch(epoch);
    if (tokens === undefined) return {};
    const skew = this.#options.refreshSkewMs ?? 60_000;
    if (
      tokens.expires_at !== undefined && tokens.expires_at - skew <= this.#now()
    ) {
      try {
        if (tokens.refresh_token !== undefined) {
          tokens = await this.#refresh(found, tokens);
        } else if (this.#options.clientCredentials !== undefined) {
          tokens = await this.#obtain(
            found,
            (tokens as AuthorizedGrant).provenance.requestedScopes,
            undefined,
          );
        } else if (tokens.expires_at <= this.#now()) {
          return {};
        }
      } catch (error) {
        if (
          !(error instanceof OAuthError) || !error.retryable ||
          tokens.expires_at === undefined || tokens.expires_at <= this.#now()
        ) throw error;
      }
    }
    if (tokens.token_type === "DPoP") {
      const key = this.#options.dpop!;
      return {
        authorization: `DPoP ${tokens.access_token}`,
        dpop: await key.proof({
          method: request.method,
          url: request.url,
          accessToken: tokens.access_token,
          nonce: this.#nonces.get(request.url),
        }),
      };
    }
    return { authorization: `Bearer ${tokens.access_token}` };
  }

  /**
   * Takes what a response from the resource says about later requests:
   * its `DPoP-Nonce`, which the next proofs to that origin carry. Returns
   * the nonce, if it had a usable one. {@link fetch} and {@link challenge}
   * call it; a transport that sends its own requests calls it for every
   * response, successes included, since a resource may rotate its nonce
   * on any of them.
   */
  observe(response: ObservedResponse): string | undefined {
    let url: URL;
    try {
      url = new URL(String(response.url));
    } catch {
      return undefined;
    }
    const context = this.#contexts.get(response.authContext);
    if (
      !this.#covers(url) || context === undefined ||
      context.epoch !== this.#epoch || context.url !== url.href
    ) return undefined;
    return this.#nonces.update(response.url, response.headers);
  }

  /**
   * Handles a 401 or 403 from the resource; true when the request should
   * be sent again (with fresh {@link headers}). See the module
   * documentation for what each answer leads to.
   */
  async challenge(response: ResourceResponse): Promise<boolean> {
    response.signal?.throwIfAborted();
    const context = this.#contexts.get(response.authContext);
    if (
      context === undefined || context.epoch !== this.#epoch ||
      context.url !== String(response.url) ||
      context.method !== response.method
    ) return false;
    const sent = context?.token ?? null;
    let url: URL;
    try {
      url = new URL(String(response.url));
    } catch {
      return false;
    }
    // A response from anything the resource does not cover says nothing
    // about the resource: its challenge must not drive discovery.
    if (!this.#covers(url)) return false;
    const header = response.headers.get("www-authenticate");
    const found = resourceChallenge(header);
    const nonce = this.observe(response);
    if (
      response.status === 401 && found?.error === "use_dpop_nonce" &&
      nonce !== undefined
    ) {
      return response.attempt <= 2;
    }
    const epoch = context.epoch;
    const signal = this.#operationSignal(response.signal);
    if (response.status === 403) {
      if (found?.error !== "insufficient_scope") return false;
      const discovery = await this.#discover(found.resourceMetadata, signal);
      this.#checkEpoch(epoch);
      const scopes = union([...this.#requested], found.scopes ?? []);
      const key = [...scopes].sort().join(" ");
      if (this.#stepUps.has(key)) {
        throw new OAuthError(
          "insufficient_scope",
          `the resource still wants more scope after authorizing "${key}"`,
          { issuer: discovery.issuer, status: 403 },
        );
      }
      await this.#obtain(discovery, scopes, signal, true);
      this.#checkEpoch(epoch);
      this.#stepUps.add(key);
      return true;
    }
    if (response.status !== 401) return false;
    const discovery = await this.#discover(
      found?.resourceMetadata ?? null,
      signal,
      sent !== null,
    );
    this.#checkEpoch(epoch);
    const tokens = await this.#usable(
      await this.#store.getTokens(discovery.issuer, discovery.resource),
      epoch,
    );
    this.#checkEpoch(epoch);
    if (tokens !== undefined) {
      if (tokens.access_token !== sent) return true;
      if (tokens.refresh_token !== undefined && response.attempt === 1) {
        try {
          await this.#refresh(discovery, tokens);
          this.#checkEpoch(epoch);
          return true;
        } catch (error) {
          if (
            !(error instanceof OAuthError) ||
            (error.kind !== "token" && !error.retryable)
          ) throw error;
          // A new authorization follows.
        }
      }
      await this.#write(discovery, async () => {
        this.#checkEpoch(epoch);
        const current = await this.#store.getTokens(
          discovery.issuer,
          discovery.resource,
        );
        this.#checkEpoch(epoch);
        if (current?.access_token === sent) {
          await this.#store.deleteTokens(discovery.issuer, discovery.resource);
        }
      });
      const replacement = await this.tokens();
      this.#checkEpoch(epoch);
      if (replacement !== undefined) return true;
    }
    this.#checkEpoch(epoch);
    const scopes = found?.scopes ??
      discovery.protectedResource.scopes_supported ??
      this.#options.scopes ?? [];
    await this.#obtain(discovery, union([...this.#requested], scopes), signal);
    return true;
  }

  /**
   * `fetch` for the resource: refuses (`target`) a URL the resource does
   * not cover before any token is attached, sends the request with
   * {@link resourceHeaders} and `redirect: "error"` (a redirect fails the
   * request instead of carrying the token elsewhere), and on a 401 or 403
   * lets {@link challenge} decide whether to send it again, up to
   * `maxAttempts` times. The body is buffered by `Request` cloning, so a
   * retry resends it.
   */
  async resourceFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    this.#target(input instanceof Request ? input.url : input);
    const request = new Request(new Request(input, init), {
      redirect: "error",
    });
    return await this.#send(
      request,
      (headers) => this.resourceHeaders(headers),
    );
  }

  /**
   * Raw `fetch` with the session's credentials: {@link resourceFetch}
   * without the URL check and with the caller's redirect handling, so it
   * sends the access token to whatever URL it is given (and a followed
   * redirect's target). Prefer {@link resourceFetch}.
   */
  async unsafeFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    return await this.#send(
      new Request(input, init),
      (headers) => this.unsafeHeaders(headers),
    );
  }

  /** The session as an HTTP transport's credential provider; see {@link SessionHttpAuth}. */
  httpAuth(): SessionHttpAuth {
    return {
      headers: (request) => this.resourceHeaders(request),
      challenge: (response) => this.challenge(response),
      observe: (response) => this.observe(response),
    };
  }

  async #send(
    request: Request,
    headersFor: (
      request: {
        readonly method: string;
        readonly url: string;
        readonly signal?: AbortSignal;
      },
    ) => Promise<Record<string, string>>,
  ): Promise<Response> {
    const max = this.#options.maxAttempts ?? 3;
    for (let attempt = 1;; attempt++) {
      const attemptRequest = request.clone();
      const headers = await headersFor({
        method: request.method,
        url: request.url,
        signal: request.signal,
      });
      for (const [name, value] of Object.entries(headers)) {
        attemptRequest.headers.set(name, value);
      }
      const response = await this.#fetch(attemptRequest);
      this.observe({
        url: request.url,
        headers: response.headers,
        authContext: headers,
      });
      if (
        (response.status !== 401 && response.status !== 403) || attempt >= max
      ) {
        return response;
      }
      let again: boolean;
      try {
        again = await this.challenge({
          status: response.status,
          headers: response.headers,
          method: request.method,
          url: request.url,
          attempt,
          signal: request.signal,
          authContext: headers,
        });
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      if (!again) return response;
      await response.body?.cancel();
    }
  }

  /** Runs discovery through the well-known URLs, without waiting for a challenge. */
  async discover(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SessionDiscovery> {
    strictRecord(options as unknown, ["signal"], "discover options");
    return await this.#discover(null, options.signal);
  }

  /** Authorizes now, through the user agent or client credentials. */
  async authorize(
    options: {
      readonly scopes?: readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<TokenSet> {
    strictRecord(options as unknown, ["scopes", "signal"], "authorize options");
    const epoch = this.#epoch;
    const signal = this.#operationSignal(options.signal);
    signal.throwIfAborted();
    const found = await this.#discover(null, signal);
    this.#checkEpoch(epoch);
    const scopes = options.scopes ?? found.protectedResource.scopes_supported ??
      this.#options.scopes ?? [];
    return await this.#obtain(
      found,
      union([...this.#requested], scopes),
      signal,
    );
  }

  /** {@link authorize}, returning OAuthErrors as data. */
  tryAuthorize(
    options: {
      readonly scopes?: readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<OAuthOutcome<TokenSet>> {
    return attemptOAuth(() => this.authorize(options));
  }

  /**
   * Starts an authorization code flow and returns its pending state, for
   * hosts whose callback arrives as a separate request. Keep the result
   * private; pass it to {@link completeAuthorization}.
   */
  async beginAuthorization(
    options: {
      readonly scopes?: readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<PendingAuthorization> {
    strictRecord(
      options as unknown,
      ["scopes", "signal"],
      "beginAuthorization options",
    );
    const epoch = this.#epoch;
    const signal = this.#operationSignal(options.signal);
    const found = await this.#discover(null, signal);
    this.#checkEpoch(epoch);
    const scopes = options.scopes ?? found.protectedResource.scopes_supported ??
      this.#options.scopes ?? [];
    const pending = await this.#begin(
      found,
      union([...this.#requested], scopes),
      signal,
    );
    this.#checkEpoch(epoch);
    return pending;
  }

  /** Finishes a flow from the URL the user came back to, storing the tokens. */
  async completeAuthorization(
    pending: PendingAuthorization,
    callback: string | URL,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TokenSet> {
    const epoch = this.#epoch;
    strictRecord(
      options as unknown,
      ["signal"],
      "completeAuthorization options",
    );
    const signal = this.#operationSignal(options.signal);
    if (!isPendingAuthorization(pending)) {
      throw new OAuthError(
        "authorization",
        "pending authorization must come from this library or an authenticated store",
      );
    }
    const found = await this.#discover(null, signal);
    this.#checkEpoch(epoch);
    if (
      found.issuer !== pending.issuer ||
      !pending.resource.includes(found.resource)
    ) {
      throw new OAuthError(
        "state_mismatch",
        `the pending authorization is for ${pending.issuer}, not ${found.issuer}`,
        { issuer: found.issuer },
      );
    }
    const client = await this.#client(found, signal);
    this.#checkEpoch(epoch);
    const tokens = await client.completeAuthorization(
      client.unsafeRestorePending(pending),
      callback,
      { signal },
    );
    await this.#commit(found, tokens, epoch);
    this.#stepUps.clear();
    return tokens;
  }

  /** Restore only from a confidential, integrity-protected host store. Never from callback/query/browser JSON. */
  async unsafeRestorePending(
    value: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PendingAuthorization> {
    strictRecord(
      options as unknown,
      ["signal"],
      "unsafeRestorePending options",
    );
    const epoch = this.#epoch;
    const signal = this.#operationSignal(options.signal);
    const found = await this.#discover(null, signal);
    this.#checkEpoch(epoch);
    const client = await this.#client(found, signal);
    this.#checkEpoch(epoch);
    return client.unsafeRestorePending(value);
  }

  /**
   * Forgets the tokens and, with `revoke`, then revokes the refresh token
   * (when the server has a revocation endpoint). Local deletion is attempted
   * even when reading the tokens fails; a store failure rejects rather than
   * claiming logout succeeded. The result says whether the refresh token was
   * revoked at the server, and if not, why: a failed revocation leaves
   * it valid there until it expires.
   */
  async signOut(
    options: { readonly revoke?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<SignOutResult> {
    strictRecord(options as unknown, ["revoke", "signal"], "signOut options");
    const { revoke, signal } = options;
    if (revoke !== undefined && typeof revoke !== "boolean") {
      throw new TypeError("revoke must be boolean");
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError("signal must be an AbortSignal");
    }
    this.#epoch++;
    this.#lifetime.abort(new OAuthError("token", "the session was signed out"));
    this.#lifetime = new AbortController();
    this.#requested.clear();
    this.#stepUps.clear();
    this.#obtaining.clear();
    this.#refreshing = null;
    this.#knownGeneration = undefined;
    this.#discovering = null;
    const found = this.#discovery;
    let result: SignOutResult = { revoked: false };
    if (found !== null) {
      const tokens = await this.#write(found, async () => {
        try {
          return await this.#store.getTokens(found.issuer, found.resource);
        } finally {
          // A failed read prevents remote revocation, not local forgetting.
          await this.#store.deleteTokens(found.issuer, found.resource);
        }
      });
      if (revoke && tokens?.refresh_token !== undefined) {
        if (found.metadata.revocation_endpoint === undefined) {
          result = {
            revoked: false,
            error: new OAuthError(
              "unsupported",
              `${found.issuer} has no revocation endpoint`,
              { issuer: found.issuer },
            ),
          };
        } else {
          try {
            const client = await this.#client(found, signal);
            const grant = client.unsafeRestoreGrant(tokens);
            await client.validateGrant(grant);
            signal?.throwIfAborted();
            await client.revoke(grant.refresh_token!, {
              hint: "refresh_token",
              signal,
            });
            result = { revoked: true };
          } catch (error) {
            result = { revoked: false, error };
          }
        }
      }
    }
    return result;
  }

  async #discover(
    resourceMetadataUrl: string | null,
    signal: AbortSignal | undefined,
    fresh = false,
  ): Promise<SessionDiscovery> {
    signal?.throwIfAborted();
    // One discovery at a time also prevents two first-use responses choosing
    // different issuers before either has installed the immutable trust root.
    if (this.#discovering !== null) {
      await waitFor(this.#discovering, signal);
      return await this.#discover(resourceMetadataUrl, signal, fresh);
    }
    const epoch = this.#epoch;
    const run = this.#discoverOne(
      resourceMetadataUrl,
      this.#lifetime.signal,
      fresh,
      epoch,
    );
    this.#discovering = run;
    run.finally(() => {
      if (this.#discovering === run) this.#discovering = null;
    }).catch(() => {});
    return await waitFor(run, signal);
  }

  async #discoverOne(
    resourceMetadataUrl: string | null,
    signal: AbortSignal | undefined,
    fresh: boolean,
    epoch: number,
  ): Promise<SessionDiscovery> {
    const known = this.#discovery;
    if (
      known !== null && !fresh &&
      (resourceMetadataUrl === null ||
        resourceMetadataUrl === known.protectedResourceUrl)
    ) {
      return known;
    }
    // A challenge's resource_metadata on another origin is a document
    // anyone could have written: it must name exactly the configured
    // resource (RFC 9728 section 3.3), never a broader one.
    const configured = String(this.#options.resource);
    const foreign = resourceMetadataUrl !== null &&
      !sameOrigin(resourceMetadataUrl, configured);
    const prm = await discoverProtectedResource(configured, {
      ...this.#egress(),
      fetch: this.#fetch,
      signal,
      resourceMetadataUrl,
      exact: this.#options.exactResource === true || foreign,
    });
    // Once a session has a resource it keeps it, like its authorization
    // server: a later document naming another (broader) resource would
    // widen the audience of the tokens sent to the resource's URLs.
    if (
      known !== null &&
      !resourceCovers(known.resource, prm.resource, { exact: true })
    ) {
      throw new OAuthError(
        "discovery",
        `the resource's metadata at ${prm.url} is for ${
          JSON.stringify(prm.resource)
        }, not ${known.resource}; a session does not change resources`,
        { issuer: known.issuer },
      );
    }
    // Once a session has an authorization server it keeps it: a resource
    // (or a challenge's resource_metadata) naming another is refused, not
    // followed, so a forged document cannot move the user's login and
    // credentials to a server of its choosing.
    const issuer = known !== null &&
        prm.authorizationServers.includes(known.issuer)
      ? known.issuer
      : this.#selectIssuer(prm.authorizationServers);
    if (known !== null && known.issuer !== issuer) {
      throw new OAuthError(
        "discovery",
        `the resource's metadata at ${prm.url} names ${
          prm.authorizationServers.join(", ")
        }, not ${known.issuer}; a session does not change authorization servers`,
        { issuer: known.issuer },
      );
    }
    const metadata = known?.issuer === issuer && !fresh
      ? known.metadata
      : await discoverAuthorizationServer(issuer, {
        ...this.#egress(),
        fetch: this.#fetch,
        signal,
      });
    if (epoch !== this.#epoch) {
      throw new OAuthError("discovery", "discovery was cancelled by sign-out");
    }
    this.#discovery = jsonSnapshot({
      resource: prm.resource,
      protectedResource: prm.metadata,
      protectedResourceUrl: prm.url,
      issuer,
      metadata,
    });
    return this.#discovery;
  }

  #egress(): EgressOptions {
    return {
      ...(this.#options.egress === undefined
        ? {}
        : { egress: this.#options.egress }),
      ...(this.#options.allowLoopbackForDevelopment === undefined ? {} : {
        allowLoopbackForDevelopment: this.#options.allowLoopbackForDevelopment,
      }),
    };
  }

  #selectIssuer(issuers: readonly string[]): string {
    const credentials = this.#options.clientCredentials;
    if (credentials !== undefined) {
      if (!issuers.includes(credentials.issuer)) {
        throw new OAuthError(
          "registration",
          `the client credentials are for ${credentials.issuer}, but the resource accepts ${
            issuers.join(", ")
          }`,
          { issuer: credentials.issuer },
        );
      }
      return credentials.issuer;
    }
    const select = this.#options.selectAuthorizationServer;
    if (select !== undefined) {
      const chosen = select(issuers);
      if (!issuers.includes(chosen)) {
        throw new OAuthError(
          "discovery",
          `selectAuthorizationServer chose ${chosen}, which the resource does not list`,
        );
      }
      return chosen;
    }
    const pre = this.#options.registration?.preregistered;
    if (pre !== undefined && typeof pre !== "function") {
      const known = issuers.find((issuer) => Object.hasOwn(pre, issuer));
      if (known !== undefined) return known;
    }
    return issuers[0];
  }

  #authentication(client: ClientInformation): ClientAuthentication {
    const method = client.token_endpoint_auth_method ??
      (client.client_secret === undefined ? "none" : "client_secret_basic");
    switch (method) {
      case "none":
        return { method, clientId: client.client_id };
      case "client_secret_basic":
      case "client_secret_post":
        if (client.client_secret === undefined) {
          throw new OAuthError(
            "registration",
            `client ${client.client_id} uses ${method} but has no secret`,
          );
        }
        return {
          method,
          clientId: client.client_id,
          clientSecret: client.client_secret,
        };
      case "private_key_jwt": {
        const key = this.#options.signingKey;
        if (key === undefined) {
          throw new OAuthError(
            "registration",
            `client ${client.client_id} uses private_key_jwt but no signingKey is configured`,
          );
        }
        return { method, clientId: client.client_id, ...key };
      }
      default:
        throw new OAuthError(
          "unsupported",
          `unsupported token_endpoint_auth_method ${method}`,
        );
    }
  }

  #credentialsAuthentication(found: SessionDiscovery): ClientAuthentication {
    const credentials = this.#options.clientCredentials!;
    const methods = found.metadata.token_endpoint_auth_methods_supported ??
      ["client_secret_basic"];
    if ("clientSecret" in credentials) {
      const method = methods.includes("client_secret_basic")
        ? "client_secret_basic"
        : methods.includes("client_secret_post")
        ? "client_secret_post"
        : null;
      if (method === null) {
        throw new OAuthError(
          "unsupported",
          `${found.issuer} accepts neither client_secret_basic nor client_secret_post`,
          { issuer: found.issuer },
        );
      }
      return {
        method,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      };
    }
    if (!methods.includes("private_key_jwt")) {
      throw new OAuthError(
        "unsupported",
        `${found.issuer} does not accept private_key_jwt`,
        { issuer: found.issuer },
      );
    }
    return {
      method: "private_key_jwt",
      clientId: credentials.clientId,
      privateKey: credentials.privateKey,
      alg: credentials.alg,
      kid: credentials.kid,
    };
  }

  async #client(
    found: SessionDiscovery,
    signal: AbortSignal | undefined,
  ): Promise<OAuthClient> {
    const auth = this.#options.clientCredentials !== undefined
      ? this.#credentialsAuthentication(found)
      : this.#authentication(
        await resolveClient({
          ...this.#egress(),
          ...this.#options.registration,
        }, {
          metadata: found.metadata,
          redirectUris: this.#options.redirectUri === undefined
            ? []
            : [this.#options.redirectUri],
          store: this.#store,
          fetch: this.#fetch,
          signal,
          now: this.#now,
        }),
      );
    const credential = auth.method === "client_secret_basic" ||
        auth.method === "client_secret_post"
      ? await sha256(auth.clientSecret)
      : auth.method === "private_key_jwt"
      ? `${auth.alg}:${auth.kid ?? ""}:${this.#credentialId(auth.privateKey)}`
      : "public";
    const key = JSON.stringify([
      found.issuer,
      auth.clientId,
      auth.method,
      credential,
      found.metadata,
    ]);
    let client = this.#clients.get(key);
    if (client === undefined) {
      client = new OAuthClient({
        issuer: found.issuer,
        metadata: found.metadata,
        client: auth,
        redirectUri: this.#options.redirectUri,
        dpop: this.#options.dpop,
        allowBearerFallback: this.#options.allowBearerFallback,
        fetch: this.#fetch,
        now: this.#now,
        ...this.#egress(),
      });
      this.#clients.set(key, client);
      while (this.#clients.size > 16) {
        this.#clients.delete(this.#clients.keys().next().value!);
      }
    }
    return client;
  }

  async #obtain(
    found: SessionDiscovery,
    scopes: readonly string[],
    signal: AbortSignal | undefined,
    stepUp = false,
  ): Promise<TokenSet> {
    signal?.throwIfAborted();
    scopes = union(scopes);
    const epoch = this.#epoch;
    const key = JSON.stringify([
      found.issuer,
      found.resource,
      [...scopes].sort(),
      this.#options.dpop?.jkt ?? null,
      epoch,
    ]);
    let run = this.#obtaining.get(key);
    if (run === undefined) {
      run = this.#obtainOne(found, scopes, this.#lifetime.signal, epoch);
      this.#obtaining.set(key, run);
      const current = run;
      run.finally(() => {
        if (this.#obtaining.get(key) === current) this.#obtaining.delete(key);
      }).catch(() => {});
    }
    const tokens = await waitFor(run, signal);
    if (!stepUp) this.#stepUps.clear();
    return tokens;
  }

  #credentialId(key: KeyLike): number {
    if (typeof key !== "object" || key === null) {
      throw new TypeError("a private signing key must be an object");
    }
    let id = this.#credentialIds.get(key);
    if (id === undefined) {
      id = ++this.#nextCredentialId;
      this.#credentialIds.set(key, id);
    }
    return id;
  }

  async #obtainOne(
    found: SessionDiscovery,
    scopes: readonly string[],
    signal: AbortSignal | undefined,
    epoch: number,
  ): Promise<TokenSet> {
    if (this.#options.clientCredentials !== undefined) {
      return await this.#clientCredentials(found, scopes, signal, epoch);
    }
    const agent = this.#options.userAgent;
    if (agent === undefined) {
      throw new OAuthError(
        "interaction_required",
        `authorization at ${found.issuer} needs a user, and the session has no user agent`,
        { issuer: found.issuer },
      );
    }
    const pending = await this.#begin(found, scopes, signal);
    const callback = await agent.authorize({
      url: new URL(pending.url),
      redirectUri: pending.redirectUri,
      state: pending.state,
      issuer: pending.issuer,
      resource: found.resource,
      scopes: parseScope(pending.scope),
      signal: signal ?? new AbortController().signal,
    });
    const client = await this.#client(found, signal);
    const tokens = await client.completeAuthorization(pending, callback, {
      signal,
    });
    await this.#commit(found, tokens, epoch);
    return tokens;
  }

  async #begin(
    found: SessionDiscovery,
    scopes: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<PendingAuthorization> {
    const client = await this.#client(found, signal);
    const requested = [...scopes];
    if (
      this.#options.offlineAccess &&
      (found.metadata.scopes_supported ?? []).includes("offline_access") &&
      !requested.includes("offline_access")
    ) {
      requested.push("offline_access");
    }
    return await client.authorizationUrl({
      scope: requested,
      resource: found.resource,
      signal,
    });
  }

  async #refresh(
    found: SessionDiscovery,
    tokens: TokenSet,
  ): Promise<TokenSet> {
    if (this.#refreshing !== null) return await this.#refreshing;
    const epoch = this.#epoch;
    const signal = this.#lifetime.signal;
    const run = async (): Promise<TokenSet> => {
      // Under the store's lock another session may have refreshed first:
      // then its tokens are the ones to use, and the refresh token this
      // session holds is already spent.
      const current = await this.#store.getTokens(found.issuer, found.resource);
      if (current?.refresh_token !== tokens.refresh_token) {
        const usable = await this.#usable(current, epoch);
        if (usable !== undefined) return usable;
        throw new OAuthError(
          "token",
          "the tokens were replaced or removed while this session waited",
          { issuer: found.issuer },
        );
      }
      if (epoch !== this.#epoch) {
        throw new OAuthError("token", "refresh was cancelled by sign-out");
      }
      const client = await this.#client(found, signal);
      try {
        const grant = client.unsafeRestoreGrant(tokens);
        await client.validateGrant(grant);
        this.#checkEpoch(epoch);
        assertAuthorizedGrant(grant, {
          issuer: found.issuer,
          clientId: client.clientId,
          resource: found.resource,
          dpopJkt: this.#options.dpop?.jkt,
        });
        // Durable refresh intent: the remote server may rotate before its
        // response arrives. Remove the reusable credential under the shared
        // lock before sending it, retaining only the still-valid access token.
        // A crash/ambiguous response then requires login, never a replay of a
        // possibly spent refresh token. Successful rotation replaces this row.
        const { refresh_token: _refreshToken, ...accessOnly } = tokens;
        await this.#store.setTokens(found.issuer, found.resource, accessOnly);
        this.#checkEpoch(epoch);
        const fresh = await client.refresh(grant, {
          resource: found.resource,
          signal,
        });
        if (epoch !== this.#epoch) {
          throw new OAuthError("token", "refresh was cancelled by sign-out");
        }
        await this.#store.setTokens(found.issuer, found.resource, fresh);
        this.#checkEpoch(epoch);
        this.#knownGeneration = fresh.provenance.generation;
        this.#requested = new Set(fresh.provenance.requestedScopes);
        return fresh;
      } catch (error) {
        if (
          error instanceof OAuthError && error.kind === "token" &&
          epoch === this.#epoch
        ) {
          // Only the tokens that failed: not ones another session stored
          // meanwhile.
          const now = await this.#store.getTokens(found.issuer, found.resource);
          this.#checkEpoch(epoch);
          if (now?.refresh_token === tokens.refresh_token) {
            await this.#store.deleteTokens(found.issuer, found.resource);
          }
        }
        throw error;
      }
    };
    const refreshing = this.#write(found, run);
    this.#refreshing = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.#refreshing === refreshing) this.#refreshing = null;
    }
  }

  async #clientCredentials(
    found: SessionDiscovery,
    scopes: readonly string[],
    signal: AbortSignal | undefined,
    epoch: number,
  ): Promise<TokenSet> {
    const grants = found.metadata.grant_types_supported;
    if (grants !== undefined && !grants.includes("client_credentials")) {
      throw new OAuthError(
        "unsupported",
        `${found.issuer} does not support the client_credentials grant`,
        { issuer: found.issuer },
      );
    }
    const client = await this.#client(found, signal);
    const tokens = await client.clientCredentials({
      scope: scopes,
      resource: found.resource,
      signal,
    });
    await this.#commit(found, tokens, epoch);
    return tokens;
  }
}
