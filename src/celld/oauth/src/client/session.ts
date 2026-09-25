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
 * const response = await session.fetch("https://api.example.com/v1/files");
 * ```
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
 * The parts of {@link OAuthSession.fetch}, {@link OAuthSession.headers},
 * {@link OAuthSession.challenge} and {@link OAuthSession.observe}, are
 * public so a transport with its own request loop (an MCP client, say) can
 * drive them: `headers` for every request, `observe` for every response
 * (a resource may send a new `DPoP-Nonce` with any of them), `challenge`
 * for a 401 or 403.
 *
 * @module
 */

import { resourceChallenge } from "../challenge.ts";
import type { DpopKey } from "../dpop/key.ts";
import { DpopNonceCache } from "../dpop/key.ts";
import { attemptOAuth, OAuthError, type OAuthOutcome } from "../errors.ts";
import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from "../metadata.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  parseScope,
} from "../util.ts";
import type { JwsAlgorithm, KeyLike } from "@celld/jwt";
import type { ClientAuthentication } from "./auth.ts";
import { OAuthClient, type PendingAuthorization } from "./client.ts";
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
} from "./discovery.ts";
import { type RegistrationOptions, resolveClient } from "./registration.ts";
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
      readonly alg: JwsAlgorithm;
      readonly kid?: string;
    }
  );

/** Options for {@link OAuthSession}. */
export interface OAuthSessionOptions {
  /** The protected resource's URL (or the base URL of the ones it serves). */
  readonly resource: string | URL;
  /** Where registrations and tokens are kept; default in memory. */
  readonly store?: OAuthStore;
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
    readonly alg: JwsAlgorithm;
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
  /** Refresh this long before expiry; default 60 s. */
  readonly refreshSkewMs?: number;
  /** Tries per request in {@link OAuthSession.fetch}; default 3. */
  readonly maxAttempts?: number;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
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
  /** The request's URL (a response's own `url` is empty when built by hand). */
  readonly url: string | URL;
  readonly headers: Headers;
}

/** A 401 or 403 from the resource, for {@link OAuthSession.challenge}. */
export interface ResourceResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The request's method and URL. */
  readonly method: string;
  readonly url: string | URL;
  /** 1 for the first try of a request. */
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

function union(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
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
  #sent: string | null = null;
  #refreshing: Promise<TokenSet> | null = null;

  constructor(options: OAuthSessionOptions) {
    this.#options = options;
    this.#store = options.store ?? memoryOAuthStore();
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? defaultClock;
  }

  /** What discovery found, once it ran. */
  get discovery(): SessionDiscovery | null {
    return this.#discovery;
  }

  /** The current tokens, if any. */
  async tokens(): Promise<TokenSet | undefined> {
    const found = this.#discovery;
    if (found === null) return undefined;
    return await this.#usable(
      await this.#store.getTokens(found.issuer, found.resource),
    );
  }

  /** Tokens bound to a DPoP key this session does not hold are useless. */
  async #usable(tokens: TokenSet | undefined): Promise<TokenSet | undefined> {
    if (tokens === undefined || tokens.token_type !== "DPoP") return tokens;
    if (tokens.dpop_jkt === this.#options.dpop?.jkt) return tokens;
    const found = this.#discovery!;
    await this.#store.deleteTokens(found.issuer, found.resource);
    return undefined;
  }

  /**
   * The headers for a request to the resource: `Authorization` (Bearer or
   * DPoP) and, for a DPoP token, a `DPoP` proof with `ath` and the
   * resource's nonce. A token about to expire is refreshed first.
   */
  async headers(
    request: { readonly method: string; readonly url: string | URL },
  ): Promise<Record<string, string>> {
    const found = this.#discovery;
    if (found === null) return {};
    let tokens = await this.#usable(
      await this.#store.getTokens(found.issuer, found.resource),
    );
    if (tokens === undefined) return {};
    this.#sent = tokens.access_token;
    const skew = this.#options.refreshSkewMs ?? 60_000;
    if (
      tokens.expires_at !== undefined && tokens.expires_at - skew <= this.#now()
    ) {
      try {
        if (tokens.refresh_token !== undefined) {
          tokens = await this.#refresh(found, tokens);
        } else if (this.#options.clientCredentials !== undefined) {
          tokens = await this.#clientCredentials(
            found,
            parseScope(tokens.requested_scope),
          );
        } else if (tokens.expires_at <= this.#now()) {
          return {};
        }
      } catch {
        return {};
      }
    }
    this.#sent = tokens.access_token;
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
    return this.#nonces.update(response.url, response.headers);
  }

  /**
   * Handles a 401 or 403 from the resource; true when the request should
   * be sent again (with fresh {@link headers}). See the module
   * documentation for what each answer leads to.
   */
  async challenge(response: ResourceResponse): Promise<boolean> {
    const header = response.headers.get("www-authenticate");
    const found = resourceChallenge(header);
    const nonce = this.observe(response);
    if (
      response.status === 401 && found?.error === "use_dpop_nonce" &&
      nonce !== undefined
    ) {
      return response.attempt <= 2;
    }
    const signal = response.signal;
    if (response.status === 403) {
      if (found?.error !== "insufficient_scope") return false;
      const discovery = await this.#discover(found.resourceMetadata, signal);
      const scopes = union([...this.#requested], found.scopes ?? []);
      const key = [...scopes].sort().join(" ");
      if (this.#stepUps.has(key)) {
        throw new OAuthError(
          "insufficient_scope",
          `the resource still wants more scope after authorizing "${key}"`,
          { issuer: discovery.issuer, status: 403 },
        );
      }
      this.#stepUps.add(key);
      await this.#obtain(discovery, scopes, signal);
      return true;
    }
    if (response.status !== 401) return false;
    const discovery = await this.#discover(
      found?.resourceMetadata ?? null,
      signal,
      this.#sent !== null,
    );
    const tokens = await this.#usable(
      await this.#store.getTokens(discovery.issuer, discovery.resource),
    );
    if (tokens !== undefined) {
      if (tokens.access_token !== this.#sent) return true;
      if (tokens.refresh_token !== undefined && response.attempt === 1) {
        try {
          await this.#refresh(discovery, tokens);
          return true;
        } catch {
          // A new authorization follows.
        }
      }
      await this.#store.deleteTokens(discovery.issuer, discovery.resource);
    }
    const scopes = found?.scopes ??
      discovery.protectedResource.scopes_supported ??
      this.#options.scopes ?? [];
    await this.#obtain(discovery, union([...this.#requested], scopes), signal);
    return true;
  }

  /**
   * `fetch` with authorization: sends the request with {@link headers},
   * and on a 401 or 403 lets {@link challenge} decide whether to send it
   * again, up to `maxAttempts` times. The body is buffered by `Request`
   * cloning, so a retry resends it.
   */
  async fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const request = new Request(input, init);
    const max = this.#options.maxAttempts ?? 3;
    for (let attempt = 1;; attempt++) {
      const attemptRequest = request.clone();
      const headers = await this.headers({
        method: request.method,
        url: request.url,
      });
      for (const [name, value] of Object.entries(headers)) {
        attemptRequest.headers.set(name, value);
      }
      const response = await this.#fetch(attemptRequest);
      this.observe({ url: request.url, headers: response.headers });
      if (
        (response.status !== 401 && response.status !== 403) || attempt >= max
      ) {
        return response;
      }
      const again = await this.challenge({
        status: response.status,
        headers: response.headers,
        method: request.method,
        url: request.url,
        attempt,
        signal: request.signal,
      });
      if (!again) return response;
      await response.body?.cancel();
    }
  }

  /** Runs discovery through the well-known URLs, without waiting for a challenge. */
  async discover(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SessionDiscovery> {
    return await this.#discover(null, options.signal);
  }

  /** Authorizes now, through the user agent or client credentials. */
  async authorize(
    options: {
      readonly scopes?: readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<TokenSet> {
    const found = await this.#discover(null, options.signal);
    const scopes = options.scopes ?? found.protectedResource.scopes_supported ??
      this.#options.scopes ?? [];
    return await this.#obtain(
      found,
      union([...this.#requested], scopes),
      options.signal,
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
    const found = await this.#discover(null, options.signal);
    const scopes = options.scopes ?? found.protectedResource.scopes_supported ??
      this.#options.scopes ?? [];
    return await this.#begin(
      found,
      union([...this.#requested], scopes),
      options.signal,
    );
  }

  /** Finishes a flow from the URL the user came back to, storing the tokens. */
  async completeAuthorization(
    pending: PendingAuthorization,
    callback: string | URL,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TokenSet> {
    const found = await this.#discover(null, options.signal);
    if (found.issuer !== pending.issuer) {
      throw new OAuthError(
        "state_mismatch",
        `the pending authorization is for ${pending.issuer}, not ${found.issuer}`,
        { issuer: found.issuer },
      );
    }
    const client = await this.#client(found, options.signal);
    const tokens = await client.completeAuthorization(
      pending,
      callback,
      options,
    );
    await this.#store.setTokens(found.issuer, found.resource, tokens);
    return tokens;
  }

  /** Revokes the refresh token (when the server can) and forgets the tokens. */
  async signOut(options: { readonly revoke?: boolean } = {}): Promise<void> {
    const found = this.#discovery;
    if (found !== null) {
      const tokens = await this.#store.getTokens(found.issuer, found.resource);
      if (
        options.revoke && tokens?.refresh_token !== undefined &&
        found.metadata.revocation_endpoint !== undefined
      ) {
        const client = await this.#client(found, undefined);
        await client.revoke(tokens.refresh_token, { hint: "refresh_token" })
          .catch(() => {});
      }
      await this.#store.deleteTokens(found.issuer, found.resource);
    }
    this.#sent = null;
  }

  async #discover(
    resourceMetadataUrl: string | null,
    signal: AbortSignal | undefined,
    fresh = false,
  ): Promise<SessionDiscovery> {
    const known = this.#discovery;
    if (
      known !== null && !fresh &&
      (resourceMetadataUrl === null ||
        resourceMetadataUrl === known.protectedResourceUrl)
    ) {
      return known;
    }
    const prm = await discoverProtectedResource(this.#options.resource, {
      fetch: this.#fetch,
      signal,
      resourceMetadataUrl,
      exact: this.#options.exactResource,
    });
    const issuer = this.#selectIssuer(prm.authorizationServers);
    const metadata = known?.issuer === issuer && !fresh
      ? known.metadata
      : await discoverAuthorizationServer(issuer, {
        fetch: this.#fetch,
        signal,
      });
    if (known !== null && known.issuer !== issuer) {
      this.#requested = new Set();
      this.#stepUps = new Set();
      this.#sent = null;
    }
    this.#discovery = {
      resource: prm.resource,
      protectedResource: prm.metadata,
      protectedResourceUrl: prm.url,
      issuer,
      metadata,
    };
    return this.#discovery;
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
        await resolveClient(this.#options.registration ?? {}, {
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
    const key = `${found.issuer}\n${auth.clientId}\n${auth.method}`;
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
      });
      this.#clients.set(key, client);
    }
    return client;
  }

  async #obtain(
    found: SessionDiscovery,
    scopes: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<TokenSet> {
    if (this.#options.clientCredentials !== undefined) {
      return await this.#clientCredentials(found, scopes, signal);
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
    await this.#store.setTokens(found.issuer, found.resource, tokens);
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
    for (const scope of scopes) this.#requested.add(scope);
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
    this.#refreshing = (async () => {
      const client = await this.#client(found, undefined);
      try {
        const fresh = await client.refresh(tokens.refresh_token!, {
          resource: found.resource,
        });
        const stored: TokenSet = {
          ...fresh,
          ...(tokens.requested_scope === undefined
            ? {}
            : { requested_scope: tokens.requested_scope }),
        };
        await this.#store.setTokens(found.issuer, found.resource, stored);
        return stored;
      } catch (error) {
        if (error instanceof OAuthError && error.kind === "token") {
          await this.#store.deleteTokens(found.issuer, found.resource);
        }
        throw error;
      }
    })();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  async #clientCredentials(
    found: SessionDiscovery,
    scopes: readonly string[],
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    const grants = found.metadata.grant_types_supported;
    if (grants !== undefined && !grants.includes("client_credentials")) {
      throw new OAuthError(
        "unsupported",
        `${found.issuer} does not support the client_credentials grant`,
        { issuer: found.issuer },
      );
    }
    for (const scope of scopes) this.#requested.add(scope);
    const client = await this.#client(found, signal);
    const tokens = await client.clientCredentials({
      scope: scopes,
      resource: found.resource,
      signal,
    });
    await this.#store.setTokens(found.issuer, found.resource, tokens);
    return tokens;
  }
}
