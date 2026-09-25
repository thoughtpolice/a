// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link AuthorizationServer}: an OAuth 2.1 authorization server as a set
 * of `(Request) => Promise<Response>` endpoints over a {@link RecordStore}.
 *
 * ```ts
 * const server = new AuthorizationServer({
 *   issuer: "https://auth.example.com",
 *   keys: [await generateSigningKey()],
 *   store: durableRecordStore(env.OAUTH),
 *   clients: [{ client_id: "cli", redirect_uris: ["http://127.0.0.1/callback"] }],
 *   resources: { allowed: ["https://api.example.com"] },
 *   interaction: async ({ request, interactionId }) => {
 *     const user = await sessionUser(request);
 *     if (user === null) return Response.redirect(`/login?i=${interactionId}`, 303);
 *     return { grant: { subject: user.id } };
 *   },
 * });
 * export default { fetch: (request) => server.handle(request) ?? notFound() };
 * ```
 *
 * The library never renders a page: login and consent are the host's,
 * through the `interaction` hook, which grants, denies, or answers with
 * its own `Response` and later calls {@link AuthorizationServer.resumeAuthorization}.
 * Errors that cannot go back to the client (an unknown client or redirect
 * URI) are a plain-text 400.
 *
 * Every default is on the safe side; the README lists them all. In short:
 * PKCE S256 on every authorization (no `plain`), exact redirect URI
 * matching (loopback IP literals may vary the port), single-use codes that
 * live 60 seconds and revoke what they issued when reused, `iss` in every
 * authorization response, refresh token rotation with the whole family
 * revoked when an old token comes back, RFC 9068 access tokens for the
 * requested resources only, DPoP-bound tokens whenever a proof is sent
 * (and refresh tokens of public clients bound to the key), constant-time
 * secret comparison, and client assertions that are used once.
 *
 * @module
 */

import { GRANT_TYPES, REQUEST_URI_PREFIX, TOKEN_TYPES } from "../constants.ts";
import { DEFAULT_DPOP_ALGORITHMS, type DpopAlgorithm } from "../dpop/key.ts";
import type { DpopNonceSource } from "../dpop/nonce.ts";
import {
  DpopError,
  type ReplayStore,
  singleDpopHeader,
  verifyDpopProof,
} from "../dpop/verify.ts";
import { ProtocolError, safeDescription } from "../errors.ts";
import {
  type AuthorizationServerMetadata,
  checkSecureUrl,
  isIssuer,
  OAUTH_AUTHORIZATION_SERVER,
  secureUrlProblem,
} from "../metadata.ts";
import { isCodeVerifier, verifyPkce } from "../pkce.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  isScopeToken,
  jsonResponse,
  NO_STORE,
  parseScope,
  randomToken,
  sha256,
  timingSafeEqual,
} from "../util.ts";
import type { JwsAlgorithm, KeySet } from "@celld/jwt";
import {
  AUTH_METHODS,
  authenticateClient,
  type AuthMethod,
  type ClientConfig,
  fetchClientMetadataDocument,
  isConfidential,
  type MetadataPolicy,
  presentedCredentials,
  redirectUriMatches,
  type RegisteredClient,
  registeredClient,
  remoteKeyCache,
  validateClientMetadata,
} from "./clients.ts";
import { recordReplayStore, type RecordStore } from "./store.ts";
import {
  type AccessTokenGrant,
  issueAccessToken,
  newRefreshToken,
  publicJwks,
  refreshFamily,
  type SigningKey,
  verifyOwnAccessToken,
} from "./tokens.ts";

/** The endpoints, by name. */
export type EndpointName =
  | "authorization"
  | "token"
  | "par"
  | "revocation"
  | "introspection"
  | "jwks"
  | "registration"
  | "device";

/** A validated authorization request, handed to the interaction hook. */
export interface AuthorizationContext {
  /** Names this request for {@link AuthorizationServer.resumeAuthorization}. Keep it secret. */
  readonly interactionId: string;
  /** The HTTP request to the authorization endpoint (its cookies say who the user is). */
  readonly request: Request;
  readonly client: RegisteredClient;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
  readonly redirectUri: string;
  /** Every authorization parameter (`prompt`, `login_hint`, OpenID's `nonce`, ...). */
  readonly params: Readonly<Record<string, string>>;
}

/** What the user decided. */
export type InteractionDecision =
  | {
    readonly grant: {
      readonly subject: string;
      /** The scopes granted; default all that were asked for. At most those. */
      readonly scope?: readonly string[];
      /** Claims to put in the access tokens (not registered claim names). */
      readonly claims?: Readonly<Record<string, unknown>>;
      /** Epoch seconds the user authenticated. */
      readonly authTime?: number;
    };
  }
  | {
    readonly deny: {
      /** Default `access_denied`; OpenID adds `login_required` and others. */
      readonly error?: string;
      readonly description?: string;
    };
  };

/** The host's login and consent step; see the module documentation. */
export type InteractionHook = (
  context: AuthorizationContext,
) => Promise<InteractionDecision | Response> | InteractionDecision | Response;

/** What a token exchange asks for (RFC 8693 section 2.1). */
export interface TokenExchangeContext {
  readonly client: RegisteredClient;
  readonly subjectToken: string;
  readonly subjectTokenType: string;
  readonly actorToken?: string;
  readonly actorTokenType?: string;
  readonly requestedTokenType?: string;
  /** Validated `resource` values. */
  readonly resource: readonly string[];
  /** `audience` values, as sent. */
  readonly audience: readonly string[];
  readonly scope: readonly string[];
  /**
   * The thumbprint of the DPoP key the request proved, when it sent a
   * proof: the issued token is bound to it. A hook exchanging a bound
   * subject token should require it to be the subject token's `cnf.jkt`.
   */
  readonly jkt?: string;
  /** Checks an access token this server issued; for subject tokens of that kind. */
  readonly verifyAccessToken: (
    token: string,
  ) => Promise<Readonly<Record<string, unknown>> | null>;
}

/** What a token exchange issues, or null to refuse it (`invalid_grant`). */
export type TokenExchangeHook = (
  context: TokenExchangeContext,
) => Promise<
  {
    readonly subject: string;
    readonly scope?: readonly string[];
    /** Default the request's resources. */
    readonly audience?: readonly string[];
    readonly claims?: Readonly<Record<string, unknown>>;
    /** RFC 8693 section 4.1. */
    readonly act?: Readonly<Record<string, unknown>>;
  } | null
>;

/** A grant the server issued tokens for, as the token response hook sees it. */
export interface IssuedGrant {
  readonly grantType: string;
  readonly client: RegisteredClient;
  readonly subject: string;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
  readonly authTime?: number;
  readonly claims?: Readonly<Record<string, unknown>>;
  /** The authorization request's parameters, for code (and its refreshes) grants. */
  readonly params: Readonly<Record<string, string>>;
  readonly jkt?: string;
  /** RFC 8693 section 4.1: the acting party, for a token exchange. */
  readonly act?: Readonly<Record<string, unknown>>;
}

/**
 * Adds members to a token response, such as OpenID Connect's `id_token`.
 * It cannot replace the ones the server sets.
 */
export type TokenResponseHook = (
  grant: IssuedGrant,
  tokens: { readonly access_token: string },
) => Promise<Readonly<Record<string, unknown>>>;

/** Options for {@link AuthorizationServer}. */
export interface AuthorizationServerOptions {
  /** The issuer identifier: https (http on loopback), no query or fragment. */
  readonly issuer: string;
  /** Access token signing keys; the first signs, all are published. */
  readonly keys: readonly SigningKey[];
  readonly store: RecordStore;
  /** Login and consent. */
  readonly interaction: InteractionHook;
  /** Clients known up front. */
  readonly clients?: readonly ClientConfig[];
  /**
   * Looks up a client id nothing else knows, after configured and
   * registered clients and before Client ID Metadata Documents: an OpenID
   * Federation layer resolves an entity identifier's trust chain here.
   * Null for an unknown client. Caching is the resolver's.
   */
  readonly resolveClient?: (clientId: string) => Promise<ClientConfig | null>;
  /** When set, the only scopes that may be asked for. */
  readonly scopesSupported?: readonly string[];
  /** Scopes for a request that names none; default none. */
  readonly defaultScopes?: readonly string[];
  /** RFC 8707 resource indicators. */
  readonly resources?: {
    /**
     * The resources tokens may be issued for: a list, or a predicate.
     * Default any secure URL.
     */
    readonly allowed?:
      | readonly string[]
      | ((resource: string, client: RegisteredClient) => boolean);
    /**
     * The audience of a request that names no resource. Without one, such
     * a request is refused with `invalid_target`: every access token
     * names its audience.
     */
    readonly default?: readonly string[];
  };
  /** Default 300 (five minutes). */
  readonly accessTokenTtlSec?: number;
  /** Default 60. */
  readonly codeTtlSec?: number;
  /** How long a refresh token family lives in all; default 30 days. */
  readonly refreshTokenTtlSec?: number;
  /** How long a refresh token lasts unused; default 14 days. */
  readonly refreshIdleTtlSec?: number;
  /** Whether a grant gets a refresh token; default when the client has the refresh grant. */
  readonly issueRefreshToken?: (
    client: RegisteredClient,
    scope: readonly string[],
  ) => boolean;
  /** Require pushed authorization requests from every client; default false. */
  readonly requirePar?: boolean;
  /** Default 60. */
  readonly parTtlSec?: number;
  /** DPoP; on by default. `false` ignores proofs and issues Bearer tokens. */
  readonly dpop?: false | {
    /** Refuse token requests without a proof; default false (per client via `dpop_bound_access_tokens`). */
    readonly required?: boolean;
    readonly algorithms?: readonly DpopAlgorithm[];
    readonly nonce?: DpopNonceSource;
    readonly maxAgeSec?: number;
    readonly clockToleranceSec?: number;
  };
  /** Dynamic Client Registration; off by default. */
  readonly registration?: false | {
    /** Required as a Bearer token when set (RFC 7591 section 3). */
    readonly initialAccessToken?: string;
    /** Default every method. */
    readonly authMethods?: readonly AuthMethod[];
    /** Seconds a registered secret lasts; default never. */
    readonly secretTtlSec?: number;
  };
  /** Accept Client ID Metadata Documents; off by default. */
  readonly clientIdMetadataDocuments?: false | {
    /** Which URLs may be fetched; see the README on SSRF. */
    readonly allowUrl?: (url: URL) => boolean;
    /** Seconds a fetched document is reused; default 300. */
    readonly cacheSec?: number;
  };
  /** The device authorization grant (RFC 8628); off unless set. */
  readonly device?: {
    /** The host's page where users enter codes. */
    readonly verificationUri: string;
    /** Default 600. */
    readonly ttlSec?: number;
    /** Default 5. */
    readonly intervalSec?: number;
  };
  /** Token exchange (RFC 8693); off unless set. */
  readonly tokenExchange?: TokenExchangeHook;
  /** Adds members to token responses. */
  readonly tokenResponse?: TokenResponseHook;
  /** Clients allowed to introspect; default any confidential client. */
  readonly introspectionClients?: readonly string[];
  /** Also accept the endpoint URL as a client assertion's `aud`; default false (issuer only). */
  readonly legacyAssertionAudience?: boolean;
  /** Algorithms for client assertions; default the asymmetric ones. */
  readonly assertionAlgorithms?: readonly JwsAlgorithm[];
  /** Endpoint paths, appended to the issuer. */
  readonly paths?: Partial<Record<EndpointName, string>>;
  /** More metadata members (OpenID Connect's, say). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** For fetching client keys and metadata documents. */
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

const DEFAULT_PATHS: Readonly<Record<EndpointName, string>> = {
  authorization: "/authorize",
  token: "/token",
  par: "/par",
  revocation: "/revoke",
  introspection: "/introspect",
  jwks: "/jwks",
  registration: "/register",
  device: "/device_authorization",
};

const ASSERTION_ALGORITHMS: readonly JwsAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

interface PendingRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
  readonly challenge: string;
  readonly dpopJkt?: string;
  readonly params: Readonly<Record<string, string>>;
}

interface CodeRecord extends PendingRequest {
  readonly subject: string;
  /** Epoch milliseconds; the stored record outlives it once spent. */
  readonly expiresAt: number;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly authTime?: number;
  readonly used?: { readonly family?: string; readonly jti?: string };
}

interface FamilyRecord {
  readonly clientId: string;
  readonly subject: string;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly authTime?: number;
  readonly params: Readonly<Record<string, string>>;
  readonly jkt?: string;
  readonly current: string;
  readonly previous: readonly string[];
  readonly revoked: boolean;
  /** Epoch milliseconds the family ends, whatever its use. */
  readonly deadline: number;
}

interface DeviceRecord {
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
  readonly userCode: string;
  readonly status: "pending" | "approved" | "denied";
  readonly subject?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly authTime?: number;
  readonly lastPoll: number;
  readonly interval: number;
  readonly deadline: number;
}

/** What the host's device page shows for a user code. */
export interface DeviceRequest {
  readonly client: RegisteredClient;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
}

function plain(status: number, text: string): Response {
  return new Response(safeDescription(text), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
    throw new ProtocolError("invalid_request", {
      description: "the body must be application/x-www-form-urlencoded",
    });
  }
  return new URLSearchParams(await request.text());
}

/** One value of a parameter; repeating one that must be single is an error. */
function single(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  if (values.length > 1) {
    throw new ProtocolError("invalid_request", {
      description: `${name} is repeated`,
    });
  }
  return values[0] ?? null;
}

function required(form: URLSearchParams, name: string): string {
  const value = single(form, name);
  if (value === null || value === "") {
    throw new ProtocolError("invalid_request", {
      description: `${name} is required`,
    });
  }
  return value;
}

/** An OAuth 2.1 authorization server; see the module documentation. */
export class AuthorizationServer {
  readonly issuer: string;
  readonly #options: AuthorizationServerOptions;
  readonly #store: RecordStore;
  readonly #replay: ReplayStore;
  readonly #now: Clock;
  readonly #fetch: FetchLike;
  readonly #clients = new Map<string, RegisteredClient>();
  readonly #documents = new Map<
    string,
    { until: number; client: RegisteredClient | null }
  >();
  readonly #remoteKeys: (uri: string) => KeySet;
  readonly #base: string;

  /** Throws `TypeError` for an invalid issuer, no keys, or a bad client. */
  constructor(options: AuthorizationServerOptions) {
    if (!isIssuer(options.issuer)) {
      throw new TypeError(`${options.issuer} is not a valid issuer`);
    }
    if (options.keys.length === 0) {
      throw new TypeError("an authorization server needs a signing key");
    }
    this.issuer = options.issuer;
    this.#options = options;
    this.#store = options.store;
    this.#replay = recordReplayStore(options.store);
    this.#now = options.now ?? defaultClock;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#remoteKeys = remoteKeyCache(this.#fetch, this.#now);
    this.#base = options.issuer.replace(/\/+$/, "");
    for (const config of options.clients ?? []) {
      const client = registeredClient(config);
      for (const uri of client.redirect_uris) {
        if (uri.includes("#")) {
          throw new TypeError(`${uri} has a fragment`);
        }
      }
      this.#clients.set(client.client_id, client);
    }
    if (options.device !== undefined) {
      checkSecureUrl(options.device.verificationUri, "verificationUri");
    }
  }

  /** The URL of an endpoint. */
  endpoint(name: EndpointName): string {
    return `${this.#base}${this.#options.paths?.[name] ?? DEFAULT_PATHS[name]}`;
  }

  /** The path of the RFC 8414 metadata document. */
  get metadataPath(): string {
    const path = new URL(this.issuer).pathname.replace(/\/+$/, "");
    return `/.well-known/${OAUTH_AUTHORIZATION_SERVER}${path}`;
  }

  get #dpop() {
    return this.#options.dpop === false ? null : this.#options.dpop ?? {};
  }

  #grantTypes(): string[] {
    const grants: string[] = [
      GRANT_TYPES.authorizationCode,
      GRANT_TYPES.refreshToken,
      GRANT_TYPES.clientCredentials,
    ];
    if (this.#options.device !== undefined) grants.push(GRANT_TYPES.deviceCode);
    if (this.#options.tokenExchange !== undefined) {
      grants.push(GRANT_TYPES.tokenExchange);
    }
    return grants;
  }

  /** The metadata document (RFC 8414 section 2). */
  metadata(): AuthorizationServerMetadata {
    const methods = [...AUTH_METHODS];
    const document: Record<string, unknown> = {
      ...this.#options.metadata,
      issuer: this.issuer,
      authorization_endpoint: this.endpoint("authorization"),
      token_endpoint: this.endpoint("token"),
      jwks_uri: this.endpoint("jwks"),
      pushed_authorization_request_endpoint: this.endpoint("par"),
      revocation_endpoint: this.endpoint("revocation"),
      introspection_endpoint: this.endpoint("introspection"),
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: this.#grantTypes(),
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: methods,
      token_endpoint_auth_signing_alg_values_supported: [
        ...(this.#options.assertionAlgorithms ?? ASSERTION_ALGORITHMS),
      ],
      revocation_endpoint_auth_methods_supported: methods,
      introspection_endpoint_auth_methods_supported: methods.filter((method) =>
        method !== "none"
      ),
      authorization_response_iss_parameter_supported: true,
      require_pushed_authorization_requests: this.#options.requirePar ?? false,
    };
    if (this.#options.scopesSupported !== undefined) {
      document.scopes_supported = [...this.#options.scopesSupported];
    }
    const dpop = this.#dpop;
    if (dpop !== null) {
      document.dpop_signing_alg_values_supported = [
        ...(dpop.algorithms ?? DEFAULT_DPOP_ALGORITHMS),
      ];
    }
    if (this.#options.registration) {
      document.registration_endpoint = this.endpoint("registration");
    }
    if (this.#options.clientIdMetadataDocuments) {
      document.client_id_metadata_document_supported = true;
    }
    if (this.#options.device !== undefined) {
      document.device_authorization_endpoint = this.endpoint("device");
    }
    return document as AuthorizationServerMetadata;
  }

  /**
   * Routes a request to the endpoint its path names, or null for a path
   * that is none of them (so the host can serve its own pages).
   */
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === this.metadataPath) {
      return request.method === "GET" || request.method === "HEAD"
        ? jsonResponse(200, this.metadata(), { "cache-control": "max-age=300" })
        : new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    const path = (name: EndpointName) => new URL(this.endpoint(name)).pathname;
    const routes: [EndpointName, (request: Request) => Promise<Response>][] = [
      ["authorization", (r) => this.authorize(r)],
      ["token", (r) => this.token(r)],
      ["par", (r) => this.pushedAuthorization(r)],
      ["revocation", (r) => this.revocation(r)],
      ["introspection", (r) => this.introspection(r)],
      ["jwks", (r) => this.jwks(r)],
      ["registration", (r) => this.registration(r)],
      ["device", (r) => this.deviceAuthorization(r)],
    ];
    for (const [name, handler] of routes) {
      if (url.pathname === path(name)) return await handler(request);
    }
    return null;
  }

  /** The JWKS endpoint: the public signing keys. */
  jwks(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Promise.resolve(
        new Response(null, { status: 405, headers: { allow: "GET" } }),
      );
    }
    return Promise.resolve(
      jsonResponse(200, publicJwks(this.#options.keys), {
        "cache-control": "max-age=300",
      }),
    );
  }

  // Clients.

  /** The client with this id: configured, registered, or (when enabled) a metadata document. */
  async client(clientId: string): Promise<RegisteredClient | null> {
    const known = this.#clients.get(clientId);
    if (known !== undefined) return known;
    const stored = await this.#store.get<RegisteredClient>(
      `client:${clientId}`,
    );
    if (stored !== null) return stored.value;
    if (this.#options.resolveClient !== undefined) {
      const resolved = await this.#options.resolveClient(clientId);
      if (resolved !== null && resolved.client_id === clientId) {
        return registeredClient({ source: "resolved", ...resolved });
      }
    }
    const documents = this.#options.clientIdMetadataDocuments;
    if (!documents || !clientId.startsWith("https://")) return null;
    const cached = this.#documents.get(clientId);
    if (cached !== undefined && cached.until > this.#now()) {
      return cached.client;
    }
    const client = await fetchClientMetadataDocument(clientId, {
      fetch: this.#fetch,
      policy: this.#policy(),
      allowUrl: documents.allowUrl,
    });
    this.#documents.set(clientId, {
      until: this.#now() + (documents.cacheSec ?? 300) * 1000,
      client,
    });
    if (this.#documents.size > 1000) {
      this.#documents.delete(this.#documents.keys().next().value!);
    }
    return client;
  }

  #policy(): MetadataPolicy {
    const registration = this.#options.registration;
    return {
      authMethods: (registration ? registration.authMethods : undefined) ??
        AUTH_METHODS,
      grantTypes: this.#grantTypes(),
      scopes: this.#options.scopesSupported,
    };
  }

  /** The authenticated client of a request to the token, PAR, revocation or introspection endpoint. */
  async #authenticate(
    request: Request,
    form: URLSearchParams,
    endpoint: string,
  ): Promise<RegisteredClient> {
    const presented = presentedCredentials(request, form);
    if (presented === null) {
      throw new ProtocolError("invalid_client", {
        description: "the client did not authenticate",
      });
    }
    const client = await this.client(presented.clientId);
    if (client === null) {
      throw new ProtocolError("invalid_client", {
        description: "unknown client",
        headers: presented.method === "client_secret_basic"
          ? { "www-authenticate": 'Basic realm="oauth"' }
          : {},
      });
    }
    await authenticateClient(client, presented, {
      issuer: this.issuer,
      extraAudiences: this.#options.legacyAssertionAudience
        ? [endpoint, this.endpoint("token")]
        : [],
      replay: this.#replay,
      now: this.#now,
      algorithms: this.#options.assertionAlgorithms ?? ASSERTION_ALGORITHMS,
      remoteKeys: this.#remoteKeys,
    });
    return client;
  }

  // Scopes and resources.

  #scope(requested: string | null, client: RegisteredClient): string[] {
    const scopes = parseScope(requested);
    for (const scope of scopes) {
      if (!isScopeToken(scope)) {
        throw new ProtocolError("invalid_scope", {
          description: "a scope is malformed",
        });
      }
    }
    const supported = this.#options.scopesSupported;
    const allowed = client.scope === undefined
      ? undefined
      : parseScope(client.scope);
    for (const scope of scopes) {
      if (supported !== undefined && !supported.includes(scope)) {
        throw new ProtocolError("invalid_scope", {
          description: `unknown scope ${scope}`,
        });
      }
      if (allowed !== undefined && !allowed.includes(scope)) {
        throw new ProtocolError("invalid_scope", {
          description: `the client may not ask for ${scope}`,
        });
      }
    }
    if (scopes.length > 0) return scopes;
    return [...(this.#options.defaultScopes ?? [])];
  }

  #resources(values: readonly string[], client: RegisteredClient): string[] {
    const allowed = this.#options.resources?.allowed;
    for (const resource of values) {
      const problem = secureUrlProblem(resource);
      if (problem !== null) {
        throw new ProtocolError("invalid_target", {
          description: `resource ${problem}`,
        });
      }
      const ok = allowed === undefined
        ? true
        : typeof allowed === "function"
        ? allowed(resource, client)
        : allowed.includes(resource);
      if (!ok) {
        throw new ProtocolError("invalid_target", {
          description: `tokens are not issued for ${resource}`,
        });
      }
    }
    const out = [...new Set(values)];
    if (out.length > 0) return out;
    const fallback = this.#options.resources?.default ?? [];
    if (fallback.length === 0) {
      throw new ProtocolError("invalid_target", {
        description: "a resource is required",
      });
    }
    return [...fallback];
  }

  /** The requested subset of what was granted; refuses anything more. */
  #narrow(
    requested: readonly string[],
    granted: readonly string[],
    code: "invalid_scope" | "invalid_target",
  ): string[] {
    if (requested.length === 0) return [...granted];
    for (const item of requested) {
      if (!granted.includes(item)) {
        throw new ProtocolError(code, {
          description: `${item} was not granted`,
        });
      }
    }
    return [...new Set(requested)];
  }

  // DPoP.

  async #proof(
    request: Request,
    url: string,
    client: RegisteredClient,
  ): Promise<string | undefined> {
    const dpop = this.#dpop;
    if (dpop === null) return undefined;
    let proof: string | null;
    try {
      proof = singleDpopHeader(request.headers);
    } catch (error) {
      throw new ProtocolError("invalid_dpop_proof", {
        description: (error as Error).message,
      });
    }
    if (proof === null) {
      if (dpop.required || client.dpop_bound_access_tokens) {
        throw new ProtocolError("invalid_dpop_proof", {
          description: "this client must send a DPoP proof",
        });
      }
      return undefined;
    }
    try {
      const verified = await verifyDpopProof(proof, {
        method: "POST",
        url,
        algorithms: dpop.algorithms,
        replay: this.#replay,
        nonce: dpop.nonce,
        maxAgeSec: dpop.maxAgeSec,
        clockToleranceSec: dpop.clockToleranceSec,
        now: this.#now,
      });
      return verified.jkt;
    } catch (error) {
      if (!(error instanceof DpopError)) throw error;
      throw new ProtocolError(error.code, {
        description: error.message,
        headers: error.code === "use_dpop_nonce" && dpop.nonce !== undefined
          ? { "dpop-nonce": await dpop.nonce.current() }
          : {},
      });
    }
  }

  async #nonceHeaders(): Promise<Record<string, string>> {
    const nonce = this.#dpop?.nonce;
    return nonce === undefined ? {} : { "dpop-nonce": await nonce.current() };
  }

  // The authorization endpoint.

  /**
   * Validates an authorization request (the fields of a pushed one, or
   * the query or form of a direct one) into what the interaction hook
   * sees. Errors before the redirect URI is trusted are thrown as
   * `redirectable: false`.
   */
  #validateAuthorization(
    form: URLSearchParams,
    client: RegisteredClient,
    pushedJkt: string | undefined,
  ): PendingRequest {
    const redirect = single(form, "redirect_uri") ??
      (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (
      redirect === null || !redirectUriMatches(client.redirect_uris, redirect)
    ) {
      throw Object.assign(
        new ProtocolError("invalid_request", {
          description: "redirect_uri is missing or not registered",
        }),
        { redirectable: false },
      );
    }
    const state = single(form, "state") ?? undefined;
    const fail = (error: ProtocolError) =>
      Object.assign(error, { redirectUri: redirect, state });
    try {
      if (single(form, "response_type") !== "code") {
        throw new ProtocolError("unsupported_response_type", {
          description: "response_type must be code",
        });
      }
      if (!client.grant_types.includes(GRANT_TYPES.authorizationCode)) {
        throw new ProtocolError("unauthorized_client", {
          description: "the client may not use the code grant",
        });
      }
      const challenge = single(form, "code_challenge");
      const method = single(form, "code_challenge_method");
      if (challenge === null || method !== "S256") {
        throw new ProtocolError("invalid_request", {
          description: "PKCE with code_challenge_method S256 is required",
        });
      }
      if (!isCodeVerifier(challenge) || challenge.length !== 43) {
        throw new ProtocolError("invalid_request", {
          description: "code_challenge is malformed",
        });
      }
      const mode = single(form, "response_mode");
      if (mode !== null && mode !== "query") {
        throw new ProtocolError("invalid_request", {
          description: "response_mode must be query",
        });
      }
      if (form.has("request")) {
        throw new ProtocolError("request_not_supported", {
          description: "request objects are not supported",
        });
      }
      const scope = this.#scope(single(form, "scope"), client);
      const resource = this.#resources(form.getAll("resource"), client);
      let dpopJkt = single(form, "dpop_jkt") ?? undefined;
      if (dpopJkt !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(dpopJkt)) {
        throw new ProtocolError("invalid_request", {
          description: "dpop_jkt is malformed",
        });
      }
      if (pushedJkt !== undefined) {
        if (dpopJkt !== undefined && dpopJkt !== pushedJkt) {
          throw new ProtocolError("invalid_dpop_proof", {
            description: "dpop_jkt does not match the DPoP proof",
          });
        }
        dpopJkt = pushedJkt;
      }
      const params: Record<string, string> = {};
      for (const [name, value] of form) {
        if (name !== "resource" && name !== "client_secret") {
          params[name] = value;
        }
      }
      return {
        clientId: client.client_id,
        redirectUri: redirect,
        ...(state === undefined ? {} : { state }),
        scope,
        resource,
        challenge,
        ...(dpopJkt === undefined ? {} : { dpopJkt }),
        params,
      };
    } catch (error) {
      if (error instanceof ProtocolError) throw fail(error);
      throw error;
    }
  }

  #redirect(
    redirectUri: string,
    state: string | undefined,
    values: Readonly<Record<string, string>>,
  ): Response {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(values)) {
      target.searchParams.set(name, value);
    }
    if (state !== undefined) target.searchParams.set("state", state);
    target.searchParams.set("iss", this.issuer);
    return new Response(null, {
      status: 303,
      headers: { location: target.href, ...NO_STORE },
    });
  }

  #errorRedirect(error: unknown): Response {
    if (!(error instanceof ProtocolError)) throw error;
    const where = error as ProtocolError & {
      redirectable?: boolean;
      redirectUri?: string;
      state?: string;
    };
    if (where.redirectable === false || where.redirectUri === undefined) {
      return plain(400, `${error.code}: ${error.description ?? ""}`);
    }
    return this.#redirect(where.redirectUri, where.state, {
      error: error.code,
      ...(error.description === null
        ? {}
        : { error_description: error.description }),
    });
  }

  /**
   * The authorization endpoint (GET, or POST with a form): validates the
   * request (or loads the pushed one named by `request_uri`), then asks
   * the interaction hook.
   */
  async authorize(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }
    let form: URLSearchParams;
    try {
      form = request.method === "GET"
        ? new URL(request.url).searchParams
        : await readForm(request);
    } catch {
      return plain(400, "invalid_request: the request is malformed");
    }
    let clientId: string | null;
    try {
      clientId = single(form, "client_id");
    } catch {
      return plain(400, "invalid_request: client_id is repeated");
    }
    if (clientId === null) {
      return plain(400, "invalid_request: client_id is required");
    }
    const client = await this.client(clientId);
    if (client === null) return plain(400, "invalid_client: unknown client");
    let pending: PendingRequest;
    try {
      const requestUri = single(form, "request_uri");
      if (requestUri !== null) {
        pending = await this.#takePushed(requestUri, client);
      } else {
        if (
          this.#options.requirePar ||
          client.require_pushed_authorization_requests
        ) {
          const redirect = single(form, "redirect_uri");
          if (
            redirect !== null &&
            redirectUriMatches(client.redirect_uris, redirect)
          ) {
            throw Object.assign(
              new ProtocolError("invalid_request", {
                description: "pushed authorization requests are required",
              }),
              {
                redirectUri: redirect,
                state: single(form, "state") ?? undefined,
              },
            );
          }
          return plain(
            400,
            "invalid_request: pushed authorization requests are required",
          );
        }
        pending = this.#validateAuthorization(form, client, undefined);
      }
    } catch (error) {
      return this.#errorRedirect(error);
    }
    return await this.#interact(request, client, pending);
  }

  async #interact(
    request: Request,
    client: RegisteredClient,
    pending: PendingRequest,
  ): Promise<Response> {
    const interactionId = randomToken(24);
    const decision = await this.#options.interaction({
      interactionId,
      request,
      client,
      scope: pending.scope,
      resource: pending.resource,
      redirectUri: pending.redirectUri,
      params: pending.params,
    });
    if (decision instanceof Response) {
      await this.#store.put(
        `interaction:${await sha256(interactionId)}`,
        pending,
        this.#now() + 600_000,
      );
      return decision;
    }
    return await this.#decide(pending, decision);
  }

  /** Issues the code (or the error) for a decision, as the redirect to the client. */
  async #decide(
    pending: PendingRequest,
    decision: InteractionDecision,
  ): Promise<Response> {
    if ("deny" in decision) {
      return this.#redirect(pending.redirectUri, pending.state, {
        error: decision.deny.error ?? "access_denied",
        ...(decision.deny.description === undefined
          ? {}
          : { error_description: safeDescription(decision.deny.description) }),
      });
    }
    const grant = decision.grant;
    const scope = grant.scope === undefined
      ? [...pending.scope]
      : grant.scope.filter((item) => pending.scope.includes(item));
    const code = randomToken(32);
    const record: CodeRecord = {
      ...pending,
      scope,
      subject: grant.subject,
      expiresAt: this.#now() + (this.#options.codeTtlSec ?? 60) * 1000,
      ...(grant.claims === undefined ? {} : { claims: grant.claims }),
      ...(grant.authTime === undefined ? {} : { authTime: grant.authTime }),
    };
    await this.#store.put(
      `code:${await sha256(code)}`,
      record,
      record.expiresAt,
    );
    return this.#redirect(pending.redirectUri, pending.state, { code });
  }

  /** The pending request of an interaction, for the host's login or consent page; null when unknown or used. */
  async interaction(
    interactionId: string,
  ): Promise<
    {
      readonly client: RegisteredClient;
      readonly scope: readonly string[];
      readonly resource: readonly string[];
      readonly params: Readonly<Record<string, string>>;
    } | null
  > {
    const stored = await this.#store.get<PendingRequest>(
      `interaction:${await sha256(interactionId)}`,
    );
    if (stored === null) return null;
    const client = await this.client(stored.value.clientId);
    if (client === null) return null;
    return {
      client,
      scope: stored.value.scope,
      resource: stored.value.resource,
      params: stored.value.params,
    };
  }

  /**
   * Finishes an authorization the interaction hook answered with its own
   * `Response`: the host calls this from its login or consent page with
   * the decision, and sends the returned redirect to the browser. An
   * interaction is used once and lasts ten minutes. The host must make
   * sure the decision comes from the same browser session that started
   * the interaction.
   */
  async resumeAuthorization(
    interactionId: string,
    decision: InteractionDecision,
  ): Promise<Response> {
    const key = `interaction:${await sha256(interactionId)}`;
    const stored = await this.#store.get<PendingRequest>(key);
    if (
      stored === null ||
      !(await this.#store.swap(key, stored.version, null, null))
    ) {
      return plain(
        400,
        "invalid_request: the authorization request expired or was already used",
      );
    }
    return await this.#decide(stored.value, decision);
  }

  // Pushed authorization requests.

  /** The PAR endpoint (RFC 9126): authenticates the client, validates, and stores the request. */
  async pushedAuthorization(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request);
      if (form.has("request_uri")) {
        throw new ProtocolError("invalid_request", {
          description: "request_uri cannot be pushed",
        });
      }
      const url = this.endpoint("par");
      const client = await this.#authenticate(request, form, url);
      const jkt = await this.#proof(request, url, client);
      let pending: PendingRequest;
      try {
        pending = this.#validateAuthorization(form, client, jkt);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        throw new ProtocolError(error.code, {
          description: error.description ?? undefined,
        });
      }
      const id = randomToken(32);
      const ttl = this.#options.parTtlSec ?? 60;
      await this.#store.put(
        `par:${await sha256(id)}`,
        pending,
        this.#now() + ttl * 1000,
      );
      return jsonResponse(201, {
        request_uri: `${REQUEST_URI_PREFIX}${id}`,
        expires_in: ttl,
      }, { ...NO_STORE, ...(await this.#nonceHeaders()) });
    } catch (error) {
      return this.#errorResponse(error);
    }
  }

  async #takePushed(
    requestUri: string,
    client: RegisteredClient,
  ): Promise<PendingRequest> {
    const refuse = () =>
      Object.assign(
        new ProtocolError("invalid_request_uri", {
          description: "request_uri is unknown, expired or used",
        }),
        { redirectable: false },
      );
    if (!requestUri.startsWith(REQUEST_URI_PREFIX)) throw refuse();
    const key = `par:${await sha256(
      requestUri.slice(REQUEST_URI_PREFIX.length),
    )}`;
    const stored = await this.#store.get<PendingRequest>(key);
    if (stored === null || stored.value.clientId !== client.client_id) {
      throw refuse();
    }
    if (!(await this.#store.swap(key, stored.version, null, null))) {
      throw refuse();
    }
    return stored.value;
  }

  // The token endpoint.

  #errorResponse(error: unknown): Response {
    if (error instanceof ProtocolError) return error.toResponse();
    console.error("oauth: unexpected error", error);
    return new ProtocolError("server_error", {
      status: 500,
      description: "the server failed",
    }).toResponse();
  }

  /** The token endpoint: every enabled grant. */
  async token(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request);
      const url = this.endpoint("token");
      const client = await this.#authenticate(request, form, url);
      const grantType = required(form, "grant_type");
      if (!this.#grantTypes().includes(grantType)) {
        throw new ProtocolError("unsupported_grant_type", {
          description: `${grantType} is not supported`,
        });
      }
      if (!client.grant_types.includes(grantType)) {
        throw new ProtocolError("unauthorized_client", {
          description: `the client may not use ${grantType}`,
        });
      }
      const jkt = await this.#proof(request, url, client);
      switch (grantType) {
        case GRANT_TYPES.authorizationCode:
          return await this.#codeGrant(form, client, jkt);
        case GRANT_TYPES.refreshToken:
          return await this.#refreshGrant(form, client, jkt);
        case GRANT_TYPES.clientCredentials:
          return await this.#clientCredentialsGrant(form, client, jkt);
        case GRANT_TYPES.deviceCode:
          return await this.#deviceGrant(form, client, jkt);
        default:
          return await this.#exchangeGrant(form, client, jkt);
      }
    } catch (error) {
      return this.#errorResponse(error);
    }
  }

  async #respond(
    grant: IssuedGrant,
    options: {
      readonly refresh?: {
        readonly family: string;
        readonly token: string;
      };
      readonly issuedTokenType?: string;
      readonly scopeChanged?: boolean;
    } = {},
  ): Promise<{ response: Response; jti: string }> {
    const lifetime = this.#options.accessTokenTtlSec ?? 300;
    const access: AccessTokenGrant = {
      subject: grant.subject,
      clientId: grant.client.client_id,
      scope: grant.scope,
      audience: grant.resource,
      ...(grant.jkt === undefined ? {} : { jkt: grant.jkt }),
      ...(grant.authTime === undefined ? {} : { authTime: grant.authTime }),
      ...(grant.claims === undefined ? {} : { claims: grant.claims }),
      ...(grant.act === undefined ? {} : { act: grant.act }),
    };
    const issued = await issueAccessToken(
      this.#options.keys[0],
      this.issuer,
      access,
      lifetime,
      this.#now,
    );
    const extra = this.#options.tokenResponse === undefined
      ? {}
      : await this.#options.tokenResponse(grant, {
        access_token: issued.token,
      });
    const body: Record<string, unknown> = {
      ...extra,
      access_token: issued.token,
      token_type: grant.jkt === undefined ? "Bearer" : "DPoP",
      expires_in: lifetime,
    };
    if (grant.scope.length > 0) body.scope = grant.scope.join(" ");
    if (options.refresh !== undefined) {
      body.refresh_token = options.refresh.token;
    }
    if (options.issuedTokenType !== undefined) {
      body.issued_token_type = options.issuedTokenType;
    }
    return {
      response: jsonResponse(200, body, {
        ...NO_STORE,
        ...(await this.#nonceHeaders()),
      }),
      jti: issued.jti,
    };
  }

  #wantsRefresh(client: RegisteredClient, scope: readonly string[]): boolean {
    const decide = this.#options.issueRefreshToken;
    if (decide !== undefined) return decide(client, scope);
    return client.grant_types.includes(GRANT_TYPES.refreshToken);
  }

  /** Starts a refresh token family; the token is bound to `jkt` for a public client. */
  async #newFamily(
    grant: IssuedGrant,
  ): Promise<{ family: string; token: string }> {
    const family = randomToken(24);
    const token = newRefreshToken(family);
    const now = this.#now();
    const deadline = now +
      (this.#options.refreshTokenTtlSec ?? 30 * 86400) * 1000;
    const record: FamilyRecord = {
      clientId: grant.client.client_id,
      subject: grant.subject,
      scope: grant.scope,
      resource: grant.resource,
      ...(grant.claims === undefined ? {} : { claims: grant.claims }),
      ...(grant.authTime === undefined ? {} : { authTime: grant.authTime }),
      params: grant.params,
      ...(grant.jkt !== undefined && !isConfidential(grant.client)
        ? { jkt: grant.jkt }
        : {}),
      current: await sha256(token),
      previous: [],
      revoked: false,
      deadline,
    };
    await this.#store.put(
      `family:${family}`,
      record,
      this.#familyExpiry(deadline),
    );
    return { family, token };
  }

  #familyExpiry(deadline: number): number {
    const idle = (this.#options.refreshIdleTtlSec ?? 14 * 86400) * 1000;
    return Math.min(deadline, this.#now() + idle);
  }

  async #revokeFamily(family: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const stored = await this.#store.get<FamilyRecord>(`family:${family}`);
      if (stored === null || stored.value.revoked) return;
      if (
        await this.#store.swap(
          `family:${family}`,
          stored.version,
          { ...stored.value, revoked: true },
          stored.expiresAt,
        )
      ) return;
    }
  }

  async #codeGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    jkt: string | undefined,
  ): Promise<Response> {
    const code = required(form, "code");
    const verifier = required(form, "code_verifier");
    const key = `code:${await sha256(code)}`;
    const stored = await this.#store.get<CodeRecord>(key);
    const invalid = (description: string) =>
      new ProtocolError("invalid_grant", { description });
    if (stored === null) throw invalid("the code is unknown or expired");
    const record = stored.value;
    if (record.used !== undefined) {
      if (record.used.family !== undefined) {
        await this.#revokeFamily(record.used.family);
      }
      if (record.used.jti !== undefined) await this.#revokeJti(record.used.jti);
      throw invalid("the code was already used");
    }
    if (record.clientId !== client.client_id) {
      throw invalid("the code was issued to another client");
    }
    if (this.#now() >= record.expiresAt) throw invalid("the code has expired");
    const redirect = single(form, "redirect_uri");
    if (
      redirect !== null
        ? redirect !== record.redirectUri
        : record.params.redirect_uri !== undefined
    ) {
      throw invalid("redirect_uri does not match the authorization request");
    }
    if (!(await verifyPkce(verifier, record.challenge))) {
      throw invalid("PKCE verification failed");
    }
    if (record.dpopJkt !== undefined && record.dpopJkt !== jkt) {
      throw new ProtocolError("invalid_dpop_proof", {
        description: "the code is bound to another DPoP key",
      });
    }
    const resource = this.#narrow(
      form.getAll("resource"),
      record.resource,
      "invalid_target",
    );
    const used: { family?: string; jti?: string } = {};
    const grant: IssuedGrant = {
      grantType: GRANT_TYPES.authorizationCode,
      client,
      subject: record.subject,
      scope: record.scope,
      resource,
      ...(record.authTime === undefined ? {} : { authTime: record.authTime }),
      ...(record.claims === undefined ? {} : { claims: record.claims }),
      params: record.params,
      ...(jkt === undefined ? {} : { jkt }),
    };
    // Claim the code before issuing anything: of two racing redemptions,
    // one wins and the other sees a used code. The spent code is kept for
    // an hour, so a replay within it revokes what the code issued.
    const tombstone = this.#now() + 3_600_000;
    const claimed = await this.#store.swap(
      key,
      stored.version,
      { ...record, used },
      tombstone,
    );
    if (!claimed) throw invalid("the code was already used");
    const refresh = this.#wantsRefresh(client, record.scope)
      ? await this.#newFamily({ ...grant, resource: record.resource })
      : undefined;
    const { response, jti } = await this.#respond(grant, { refresh });
    const after = await this.#store.get<CodeRecord>(key);
    if (after !== null) {
      await this.#store.swap(key, after.version, {
        ...record,
        used: { family: refresh?.family, jti },
      }, tombstone);
    }
    return response;
  }

  async #refreshGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    jkt: string | undefined,
  ): Promise<Response> {
    const token = required(form, "refresh_token");
    const invalid = (description: string) =>
      new ProtocolError("invalid_grant", { description });
    const family = refreshFamily(token);
    if (family === null) throw invalid("the refresh token is malformed");
    const key = `family:${family}`;
    const stored = await this.#store.get<FamilyRecord>(key);
    if (stored === null) {
      throw invalid("the refresh token is unknown or expired");
    }
    const record = stored.value;
    if (record.clientId !== client.client_id) {
      throw invalid("the refresh token was issued to another client");
    }
    if (record.revoked) throw invalid("the refresh token was revoked");
    const hash = await sha256(token);
    if (!timingSafeEqual(hash, record.current)) {
      if (record.previous.some((old) => timingSafeEqual(old, hash))) {
        await this.#revokeFamily(family);
        throw invalid(
          "the refresh token was already used; its family is revoked",
        );
      }
      throw invalid("the refresh token is unknown");
    }
    if (this.#now() >= record.deadline) {
      throw invalid("the refresh token has expired");
    }
    if (record.jkt !== undefined && record.jkt !== jkt) {
      throw new ProtocolError("invalid_dpop_proof", {
        description: "the refresh token is bound to another DPoP key",
      });
    }
    const scope = this.#narrow(
      parseScope(single(form, "scope")),
      record.scope,
      "invalid_scope",
    );
    const resource = this.#narrow(
      form.getAll("resource"),
      record.resource,
      "invalid_target",
    );
    const next = newRefreshToken(family);
    const rotated: FamilyRecord = {
      ...record,
      current: await sha256(next),
      previous: [...record.previous, record.current].slice(-32),
    };
    if (
      !(await this.#store.swap(
        key,
        stored.version,
        rotated,
        this.#familyExpiry(record.deadline),
      ))
    ) {
      await this.#revokeFamily(family);
      throw invalid(
        "the refresh token was used concurrently; its family is revoked",
      );
    }
    const { response } = await this.#respond({
      grantType: GRANT_TYPES.refreshToken,
      client,
      subject: record.subject,
      scope,
      resource,
      ...(record.authTime === undefined ? {} : { authTime: record.authTime }),
      ...(record.claims === undefined ? {} : { claims: record.claims }),
      params: record.params,
      ...(jkt === undefined ? {} : { jkt }),
    }, { refresh: { family, token: next } });
    return response;
  }

  async #clientCredentialsGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    jkt: string | undefined,
  ): Promise<Response> {
    if (!isConfidential(client)) {
      throw new ProtocolError("unauthorized_client", {
        description: "a public client cannot use client_credentials",
      });
    }
    const { response } = await this.#respond({
      grantType: GRANT_TYPES.clientCredentials,
      client,
      subject: client.client_id,
      scope: this.#scope(single(form, "scope"), client),
      resource: this.#resources(form.getAll("resource"), client),
      params: {},
      ...(jkt === undefined ? {} : { jkt }),
    });
    return response;
  }

  async #exchangeGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    jkt: string | undefined,
  ): Promise<Response> {
    const hook = this.#options.tokenExchange!;
    const requested = single(form, "requested_token_type") ?? undefined;
    if (
      requested !== undefined && requested !== TOKEN_TYPES.accessToken &&
      requested !== TOKEN_TYPES.jwt
    ) {
      throw new ProtocolError("invalid_request", {
        description: "only access tokens are issued",
      });
    }
    const actorToken = single(form, "actor_token") ?? undefined;
    const actorTokenType = single(form, "actor_token_type") ?? undefined;
    if ((actorToken === undefined) !== (actorTokenType === undefined)) {
      throw new ProtocolError("invalid_request", {
        description: "actor_token and actor_token_type go together",
      });
    }
    const resource = form.getAll("resource");
    const scope = this.#scope(single(form, "scope"), client);
    const context: TokenExchangeContext = {
      client,
      subjectToken: required(form, "subject_token"),
      subjectTokenType: required(form, "subject_token_type"),
      ...(actorToken === undefined ? {} : { actorToken, actorTokenType }),
      ...(requested === undefined ? {} : { requestedTokenType: requested }),
      resource: resource.length === 0 ? [] : this.#resources(resource, client),
      audience: form.getAll("audience"),
      scope,
      ...(jkt === undefined ? {} : { jkt }),
      verifyAccessToken: (token) => this.verifyAccessToken(token),
    };
    const decided = await hook(context);
    if (decided === null) {
      throw new ProtocolError("invalid_grant", {
        description: "the subject token is not accepted",
      });
    }
    const audience = decided.audience ??
      (context.resource.length > 0
        ? context.resource
        : this.#resources([], client));
    const { response } = await this.#respond({
      grantType: GRANT_TYPES.tokenExchange,
      client,
      subject: decided.subject,
      scope: decided.scope ?? scope,
      resource: audience,
      ...(decided.claims === undefined ? {} : { claims: decided.claims }),
      ...(decided.act === undefined ? {} : { act: decided.act }),
      params: {},
      ...(jkt === undefined ? {} : { jkt }),
    }, { issuedTokenType: TOKEN_TYPES.accessToken });
    return response;
  }

  // Device authorization (RFC 8628).

  /** The device authorization endpoint. */
  async deviceAuthorization(request: Request): Promise<Response> {
    try {
      const device = this.#options.device;
      if (device === undefined) {
        throw new ProtocolError("invalid_request", {
          status: 404,
          description: "device authorization is not enabled",
        });
      }
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request);
      const client = await this.#authenticate(
        request,
        form,
        this.endpoint("device"),
      );
      if (!client.grant_types.includes(GRANT_TYPES.deviceCode)) {
        throw new ProtocolError("unauthorized_client", {
          description: "the client may not use the device grant",
        });
      }
      const scope = this.#scope(single(form, "scope"), client);
      const resource = this.#resources(form.getAll("resource"), client);
      const ttl = device.ttlSec ?? 600;
      const interval = device.intervalSec ?? 5;
      const deviceCode = randomToken(32);
      const now = this.#now();
      let userCode = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        userCode = this.#userCode();
        const record: DeviceRecord = {
          clientId: client.client_id,
          scope,
          resource,
          userCode,
          status: "pending",
          lastPoll: 0,
          interval,
          deadline: now + ttl * 1000,
        };
        const deviceKey = `device:${await sha256(deviceCode)}`;
        if (
          await this.#store.create(
            `user_code:${userCode}`,
            { deviceKey },
            now + ttl * 1000,
          )
        ) {
          await this.#store.put(deviceKey, record, now + (ttl + 600) * 1000);
          const formatted = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
          const complete = new URL(device.verificationUri);
          complete.searchParams.set("user_code", formatted);
          return jsonResponse(200, {
            device_code: deviceCode,
            user_code: formatted,
            verification_uri: device.verificationUri,
            verification_uri_complete: complete.href,
            expires_in: ttl,
            interval,
          }, NO_STORE);
        }
      }
      throw new ProtocolError("temporarily_unavailable", {
        status: 503,
        description: "no free user code",
      });
    } catch (error) {
      return this.#errorResponse(error);
    }
  }

  #userCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(
      bytes,
      (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length],
    ).join("");
  }

  /** A user code as typed: upper case, without dashes or spaces. */
  static normalizeUserCode(text: string): string {
    return text.toUpperCase().replace(/[\s-]/g, "");
  }

  async #deviceByUserCode(
    userCode: string,
  ): Promise<
    {
      key: string;
      record: DeviceRecord;
      version: number;
      expiresAt: number | null;
    } | null
  > {
    const normalized = AuthorizationServer.normalizeUserCode(userCode);
    if (!/^[A-Z]{8}$/.test(normalized)) return null;
    const pointer = await this.#store.get<{ deviceKey: string }>(
      `user_code:${normalized}`,
    );
    if (pointer === null) return null;
    const stored = await this.#store.get<DeviceRecord>(pointer.value.deviceKey);
    if (stored === null || stored.value.deadline <= this.#now()) return null;
    return {
      key: pointer.value.deviceKey,
      record: stored.value,
      version: stored.version,
      expiresAt: stored.expiresAt,
    };
  }

  /** What a user code asks for, for the host's device page; null when unknown, expired or decided. */
  async device(userCode: string): Promise<DeviceRequest | null> {
    const found = await this.#deviceByUserCode(userCode);
    if (found === null || found.record.status !== "pending") return null;
    const client = await this.client(found.record.clientId);
    if (client === null) return null;
    return {
      client,
      scope: found.record.scope,
      resource: found.record.resource,
    };
  }

  /**
   * Records the user's decision on a device authorization; false when the
   * code is unknown, expired or already decided. The user code is spent
   * either way, so a guessed code cannot be tried twice.
   */
  async decideDevice(
    userCode: string,
    decision: InteractionDecision,
  ): Promise<boolean> {
    const found = await this.#deviceByUserCode(userCode);
    if (found === null || found.record.status !== "pending") return false;
    await this.#store.delete(
      `user_code:${AuthorizationServer.normalizeUserCode(userCode)}`,
    );
    const next: DeviceRecord = "deny" in decision
      ? { ...found.record, status: "denied" }
      : {
        ...found.record,
        status: "approved",
        subject: decision.grant.subject,
        scope: decision.grant.scope === undefined
          ? found.record.scope
          : decision.grant.scope.filter((item) =>
            found.record.scope.includes(item)
          ),
        ...(decision.grant.claims === undefined
          ? {}
          : { claims: decision.grant.claims }),
        ...(decision.grant.authTime === undefined
          ? {}
          : { authTime: decision.grant.authTime }),
      };
    return await this.#store.swap(
      found.key,
      found.version,
      next,
      found.expiresAt,
    );
  }

  async #deviceGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    jkt: string | undefined,
  ): Promise<Response> {
    const deviceCode = required(form, "device_code");
    const key = `device:${await sha256(deviceCode)}`;
    const stored = await this.#store.get<DeviceRecord>(key);
    if (stored === null || stored.value.clientId !== client.client_id) {
      throw new ProtocolError("invalid_grant", {
        description: "the device code is unknown",
      });
    }
    const record = stored.value;
    const now = this.#now();
    if (now >= record.deadline) {
      await this.#store.delete(key);
      throw new ProtocolError("expired_token", {
        description: "the device code has expired",
      });
    }
    if (record.status === "denied") {
      await this.#store.delete(key);
      throw new ProtocolError("access_denied", {
        description: "the user denied the request",
      });
    }
    if (record.status === "pending") {
      const early = now < record.lastPoll + record.interval * 1000;
      const next: DeviceRecord = {
        ...record,
        lastPoll: now,
        interval: early ? record.interval + 5 : record.interval,
      };
      await this.#store.swap(key, stored.version, next, stored.expiresAt);
      throw new ProtocolError(early ? "slow_down" : "authorization_pending", {
        description: early
          ? "polling too fast"
          : "the user has not decided yet",
      });
    }
    if (!(await this.#store.swap(key, stored.version, null, null))) {
      throw new ProtocolError("invalid_grant", {
        description: "the device code was already used",
      });
    }
    const grant: IssuedGrant = {
      grantType: GRANT_TYPES.deviceCode,
      client,
      subject: record.subject!,
      scope: record.scope,
      resource: record.resource,
      ...(record.authTime === undefined ? {} : { authTime: record.authTime }),
      ...(record.claims === undefined ? {} : { claims: record.claims }),
      params: {},
      ...(jkt === undefined ? {} : { jkt }),
    };
    const refresh = this.#wantsRefresh(client, record.scope)
      ? await this.#newFamily(grant)
      : undefined;
    return (await this.#respond(grant, { refresh })).response;
  }

  // Revocation and introspection.

  async #revokeJti(jti: string): Promise<void> {
    const lifetime = (this.#options.accessTokenTtlSec ?? 300) * 1000;
    await this.#store.put(`revoked:${jti}`, 1, this.#now() + lifetime + 60_000);
  }

  /**
   * The claims of a valid, unrevoked access token this server issued, or
   * null. Resource servers that verify tokens locally do not see
   * revocations; they see them through introspection.
   */
  async verifyAccessToken(
    token: string,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const claims = await verifyOwnAccessToken(
      token,
      this.#options.keys,
      this.issuer,
      this.#now,
    );
    if (claims === null) return null;
    if ((await this.#store.get(`revoked:${claims.jti}`)) !== null) return null;
    return claims;
  }

  async #refreshRecord(
    token: string,
  ): Promise<{ family: string; record: FamilyRecord } | null> {
    const family = refreshFamily(token);
    if (family === null) return null;
    const stored = await this.#store.get<FamilyRecord>(`family:${family}`);
    if (stored === null || stored.value.revoked) return null;
    if (!timingSafeEqual(await sha256(token), stored.value.current)) {
      return null;
    }
    if (this.#now() >= stored.value.deadline) return null;
    return { family, record: stored.value };
  }

  /**
   * The revocation endpoint (RFC 7009). A refresh token revokes its whole
   * family; an access token is recorded as revoked for introspection. A
   * token of another client, or an unknown one, is ignored; the answer is
   * 200 either way.
   */
  async revocation(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request);
      const client = await this.#authenticate(
        request,
        form,
        this.endpoint("revocation"),
      );
      const token = required(form, "token");
      const refresh = await this.#refreshRecord(token);
      if (refresh !== null) {
        if (refresh.record.clientId === client.client_id) {
          await this.#revokeFamily(refresh.family);
        }
      } else {
        const claims = await this.verifyAccessToken(token);
        if (claims !== null && claims.client_id === client.client_id) {
          await this.#revokeJti(claims.jti as string);
        }
      }
      return new Response(null, { status: 200, headers: NO_STORE });
    } catch (error) {
      return this.#errorResponse(error);
    }
  }

  /**
   * The introspection endpoint (RFC 7662), for authenticated confidential
   * clients (or those in `introspectionClients`). Access tokens answer
   * with their claims and `token_type` (`DPoP` when bound); refresh
   * tokens only to the client they were issued to.
   */
  async introspection(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request);
      const client = await this.#authenticate(
        request,
        form,
        this.endpoint("introspection"),
      );
      const allowed = this.#options.introspectionClients;
      if (
        allowed !== undefined
          ? !allowed.includes(client.client_id)
          : !isConfidential(client)
      ) {
        throw new ProtocolError("invalid_client", {
          status: 401,
          description: "this client may not introspect",
        });
      }
      const token = required(form, "token");
      const inactive = () => jsonResponse(200, { active: false }, NO_STORE);
      const claims = await this.verifyAccessToken(token);
      if (claims !== null) {
        const cnf = claims.cnf as { jkt?: string } | undefined;
        return jsonResponse(200, {
          ...claims,
          active: true,
          token_type: cnf?.jkt === undefined ? "Bearer" : "DPoP",
        }, NO_STORE);
      }
      const refresh = await this.#refreshRecord(token);
      if (refresh === null || refresh.record.clientId !== client.client_id) {
        return inactive();
      }
      const record = refresh.record;
      return jsonResponse(200, {
        active: true,
        token_type: "refresh_token",
        iss: this.issuer,
        sub: record.subject,
        client_id: record.clientId,
        scope: record.scope.join(" "),
        aud: record.resource.length === 1
          ? record.resource[0]
          : record.resource,
        exp: Math.floor(record.deadline / 1000),
        ...(record.jkt === undefined ? {} : { cnf: { jkt: record.jkt } }),
      }, NO_STORE);
    } catch (error) {
      return this.#errorResponse(error);
    }
  }

  // Dynamic Client Registration (RFC 7591).

  /** The registration endpoint, when enabled. */
  async registration(request: Request): Promise<Response> {
    try {
      const options = this.#options.registration;
      if (!options) {
        throw new ProtocolError("invalid_request", {
          status: 404,
          description: "registration is not enabled",
        });
      }
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      if (options.initialAccessToken !== undefined) {
        const header = request.headers.get("authorization") ?? "";
        const match = /^Bearer[ ]+(\S+)$/i.exec(header);
        if (
          match === null ||
          !timingSafeEqual(match[1], options.initialAccessToken)
        ) {
          throw new ProtocolError("invalid_token", {
            status: 401,
            description: "an initial access token is required",
            headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          });
        }
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ProtocolError("invalid_client_metadata", {
          description: "the body is not JSON",
        });
      }
      const metadata = validateClientMetadata(body, this.#policy());
      const clientId = randomToken(16);
      const issuedAt = Math.floor(this.#now() / 1000);
      const secret = metadata.token_endpoint_auth_method ===
            "client_secret_basic" ||
          metadata.token_endpoint_auth_method === "client_secret_post"
        ? randomToken(32)
        : undefined;
      const expiresAt =
        secret !== undefined && options.secretTtlSec !== undefined
          ? issuedAt + options.secretTtlSec
          : 0;
      const {
        client_secret: _secret,
        client_secret_hash: _hash,
        ...clean
      } = metadata as Record<string, unknown>;
      const record: RegisteredClient = {
        ...(clean as ClientConfig),
        client_id: clientId,
        client_id_issued_at: issuedAt,
        token_endpoint_auth_method: metadata.token_endpoint_auth_method,
        grant_types: metadata.grant_types,
        redirect_uris: metadata.redirect_uris,
        ...(secret === undefined ? {} : {
          client_secret_hash: await sha256(secret),
          client_secret_expires_at: expiresAt,
        }),
        source: "dynamic",
      };
      await this.#store.put(`client:${clientId}`, record, null);
      const { client_secret_hash: _h, source: _s, ...visible } = record;
      return jsonResponse(201, {
        ...visible,
        ...(secret === undefined
          ? {}
          : { client_secret: secret, client_secret_expires_at: expiresAt }),
      }, NO_STORE);
    } catch (error) {
      return this.#errorResponse(error);
    }
  }
}
