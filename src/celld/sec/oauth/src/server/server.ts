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
 *     if (user === null) {
 *       // Response.redirect needs an absolute URL; a relative one throws.
 *       const login = new URL("/login", request.url);
 *       login.searchParams.set("i", interactionId);
 *       return Response.redirect(login.href, 303);
 *     }
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
 * secret comparison, client assertions that are used once, asymmetric
 * signing keys only, introspection that answers nothing until a policy
 * allows it, and request bodies capped while they stream.
 *
 * @module
 */

import {
  BoundsError,
  type JsonLimits,
  jsonSnapshot,
  parseJsonBounded,
  readTextBounded,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import type { EgressPolicy } from "@celld/http/egress";
import { OutboundWork } from "../work.ts";
import { GRANT_TYPES, REQUEST_URI_PREFIX, TOKEN_TYPES } from "../constants.ts";
import { DEFAULT_DPOP_ALGORITHMS, type DpopAlgorithm } from "../dpop/key.ts";
import type { DpopNonceSource } from "../dpop/nonce.ts";
import {
  DpopError,
  dpopWindow,
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
  isObject,
  isScopeToken,
  jsonResponse,
  NO_STORE,
  parseScope,
  randomToken,
  sha256,
  snapshotOptions,
  timingSafeEqual,
} from "../util.ts";
import {
  assertAlgorithmsSupported,
  type JwsAlgorithm,
  type KeySet,
} from "@celld/sec/jwt";
import {
  AUTH_METHODS,
  authenticateClient,
  type AuthMethod,
  type ClientConfig,
  clientEgressPolicy,
  clientView,
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
  checkSigningKeys,
  issueAccessToken,
  newRefreshToken,
  prepareOwnAccessTokenVerifier,
  publicJwks,
  refreshFamily,
  SIGNING_ALGORITHMS,
  type SigningAlgorithm,
  type SigningKey,
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

/** A request's verified DPoP proof, its `jti` not yet spent; see `#proof`. */
interface ProofCheck {
  readonly jkt: string | undefined;
  /** Spends the proof's `jti`; `invalid_dpop_proof` when it was spent before. */
  readonly claim: () => Promise<void>;
}

const NO_PROOF: ProofCheck = Object.freeze({
  jkt: undefined,
  claim: () => Promise.resolve(),
});

/** What a token exchange issues, or null to refuse it (`invalid_grant`). */
export type TokenExchangeHook = (
  context: TokenExchangeContext,
) => Promise<
  {
    readonly subject: string;
    /**
     * Default the request's scope. Held to the same policy as a requested
     * one: scope tokens in `scopesSupported` and the acting client's
     * `scope` allowlist, or `invalid_scope`.
     */
    readonly scope?: readonly string[];
    /** Default the request's resources. */
    readonly audience?: readonly string[];
    readonly claims?: Readonly<Record<string, unknown>>;
    /** RFC 8693 section 4.1. */
    readonly act?: Readonly<Record<string, unknown>>;
  } | null
>;

/** A verified subject and explicit source-to-target delegation decision. */
export interface TokenExchangePolicy {
  /** Exact audiences this client is allowed to exchange from. */
  readonly sourceAudiences:
    | readonly string[]
    | ((client: RegisteredClient) => readonly string[]);
  /** Pure decision only: no external side effects. Requested scope has already been attenuated. */
  readonly authorize: (
    context: TokenExchangeContext & {
      readonly subject: Readonly<Record<string, unknown>>;
    },
  ) => ReturnType<TokenExchangeHook>;
}

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
export interface TokenResponseExtensions {
  /** OIDC extension; validated by the OIDC layer before relying on its claims. */
  readonly id_token?: string;
  readonly [name: string]: unknown;
}

export type TokenResponseHook = (
  grant: IssuedGrant,
  tokens: { readonly access_token: string },
) => Promise<TokenResponseExtensions>;

/**
 * The introspection endpoint's policy (RFC 7662 section 4 leaves it to
 * the server). Only confidential clients may call the endpoint. An access
 * token is described to a client only when `audiences` names one of the
 * token's `aud` values for that client, and `authorize` (when set) says
 * yes; with neither set, nothing is. Refresh tokens are described only to
 * the client they were issued to.
 */
export interface IntrospectionPolicy {
  /** Client id to the audiences (resources) whose tokens it may introspect. */
  readonly audiences?: Readonly<Record<string, readonly string[]>>;
  /** Decides per token; runs after the `audiences` check, if any. */
  readonly authorize?: (
    client: RegisteredClient,
    claims: Readonly<Record<string, unknown>>,
  ) => boolean | Promise<boolean>;
  /**
   * More claims to include beyond the minimal set (`active`, `scope`,
   * `client_id`, `sub`, `exp`, `iat`, `aud`, `token_type`, `cnf`).
   */
  readonly claims?: readonly string[];
}

/** The claims an introspection answer carries unless `claims` widens them. */
const INTROSPECTION_CLAIMS = [
  "scope",
  "client_id",
  "sub",
  "exp",
  "iat",
  "aud",
  "cnf",
];

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
     * Default only `default`. Every extra audience needs an explicit policy.
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
    /** Dangerous: mint for arbitrary secure resource URLs. Default false. */
    readonly unsafeAllowAnyResource?: boolean;
    /** Additional pure per-client/resource/scope/grant check; only literal true permits issuance. */
    readonly authorize?: (context: {
      readonly resource: string;
      readonly client: RegisteredClient;
      readonly scope: readonly string[];
      readonly grantType: string;
    }) => boolean;
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
    /**
     * The grants a registered client may ask for, a subset of the ones the
     * server offers. Default the user-facing ones: `authorization_code`,
     * `refresh_token`, and the device grant when `device` is set. Client
     * credentials and token exchange mint tokens with no user, so a
     * registration open to anyone must not get them by default; list them
     * here to allow them.
     */
    readonly grantTypes?: readonly string[];
    /** Seconds a registered secret lasts; default never. */
    readonly secretTtlSec?: number;
    /**
     * Seconds a registered client is kept without being used, 1 to 3650
     * days; default 30 days. Each client authentication at the token,
     * PAR, device, revocation or introspection endpoint renews it (at
     * most once per half the period); a client whose secret expires is
     * kept only until then. So registrations nobody uses (an open
     * endpoint lets anyone make them) do not pile up in the store.
     */
    readonly clientTtlSec?: number;
  };
  /** Accept Client ID Metadata Documents; off by default. */
  readonly clientIdMetadataDocuments?: false | {
    /** Which URLs may be fetched; see the README on SSRF. */
    readonly allowUrl?: (url: URL) => boolean;
    /** Dangerous: allow arbitrary public metadata URLs (DNS egress controls still required). */
    readonly unsafeAllowArbitraryClientMetadataUrls?: boolean;
    /** Seconds a fetched document is reused; default 300. */
    readonly cacheSec?: number;
    /** As `registration.grantTypes`, for documents; the same default. */
    readonly grantTypes?: readonly string[];
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
  readonly tokenExchange?: TokenExchangePolicy;
  /** Dangerous custom token format/issuer boundary. Hook must validate everything and be pure. */
  readonly unsafeTokenExchange?: TokenExchangeHook;
  /** Adds members to token responses. */
  readonly tokenResponse?: TokenResponseHook;
  /**
   * Who may introspect which access tokens. Off by default: without it
   * every access token is `{ active: false }` to every client, since a
   * client able to introspect other clients' tokens is a token oracle.
   * See {@link IntrospectionPolicy}.
   */
  readonly introspection?: IntrospectionPolicy;
  /** Also accept the endpoint URL as a client assertion's `aud`; default false (issuer only). */
  readonly legacyAssertionAudience?: boolean;
  /**
   * Algorithms for `private_key_jwt` client assertions: a subset of
   * {@link SIGNING_ALGORITHMS} (no HS*, since a client's registered keys
   * are public metadata, not secrets); default RS*, PS* and ES*. The
   * constructor throws `TypeError` for any other.
   */
  readonly assertionAlgorithms?: readonly SigningAlgorithm[];
  /** Endpoint paths, appended to the issuer. */
  readonly paths?: Partial<Record<EndpointName, string>>;
  /** More metadata members (OpenID Connect's, say). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** For fetching client keys and metadata documents. */
  readonly fetch?: FetchLike;
  /**
   * The egress policy for those fetches, merged over the default: https,
   * no redirects, 5 s, 64 KiB (5 KiB for a metadata document), public
   * addresses only. See `@celld/http/egress`.
   */
  readonly egress?: Partial<EgressPolicy>;
  readonly now?: Clock;
  /** Deployment-wide admission hook, called before expensive endpoint work. Return exactly true to admit. */
  readonly limiter?: (
    endpoint: EndpointName | "device_code",
    request: Request | null,
  ) => boolean | Promise<boolean>;
  /** Additional retained authorization extensions. Authentication fields can never be retained. */
  readonly authorizationParameters?: readonly string[];
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
  readonly clientGeneration: string;
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
  /**
   * Hashes of spent tokens, kept inline by earlier versions (at most 32).
   * Spent tokens are now records of their own (`spent:`), kept for the
   * family's whole life; this is only read.
   */
  readonly previous?: readonly string[];
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

/** The record of a spent refresh token of `family`, by its hash. */
function spentKey(family: string, hash: string): string {
  return `spent:${family}:${hash}`;
}

function plain(status: number, text: string): Response {
  return new Response(safeDescription(text), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

/** Body caps per endpoint, in bytes. */
const FORM_MAX_BYTES = 16 * 1024;
const SMALL_FORM_MAX_BYTES = 4 * 1024;
const REGISTRATION_MAX_BYTES = 64 * 1024;
const REGISTRATION_JSON: JsonLimits = {
  maxDepth: 8,
  maxKeys: 256,
  maxItems: 256,
};

function tooLarge(): ProtocolError {
  return new ProtocolError("invalid_request", {
    status: 413,
    description: "the request body is too large",
  });
}

/**
 * A request body as text, read as a stream and stopped at `maxBytes`
 * (a larger `Content-Length` is refused before reading; a smaller one is
 * not trusted). Over the cap is 413 `invalid_request`.
 */
async function readBody(request: Request, maxBytes: number): Promise<string> {
  try {
    return await readTextBounded(request, { maxBytes, fatal: true });
  } catch (error) {
    if (error instanceof BoundsError && error.code === "too_large") {
      throw tooLarge();
    }
    throw new ProtocolError("invalid_request", {
      description: "the request body cannot be read",
    });
  }
}

async function readForm(
  request: Request,
  maxBytes = FORM_MAX_BYTES,
): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
    throw new ProtocolError("invalid_request", {
      description: "the body must be application/x-www-form-urlencoded",
    });
  }
  return new URLSearchParams(await readBody(request, maxBytes));
}

/** One value of a parameter; repeating one that must be single is an error. */
function single(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  if (values.length > 1) {
    throw new ProtocolError("invalid_request", {
      description: `${name} is repeated`,
    });
  }
  if (
    values[0] !== undefined &&
    values[0].length >
      (name.includes("token") || name === "client_assertion" ? 16_384 : 4096)
  ) throw tooLarge();
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

/** Every lifetime the server uses, checked, in seconds. */
interface Lifetimes {
  readonly access: number;
  readonly code: number;
  readonly refresh: number;
  readonly idle: number;
  readonly par: number;
  readonly device: number;
  readonly interval: number;
  readonly secret: number | undefined;
  readonly documents: number;
  readonly client: number;
}

const DAY = 86_400;

/** How many lost races `#revokeFamily` takes before it gives up loudly. */
const REVOKE_ATTEMPTS = 32;

/** How many lost races a device approval or poll takes before giving up. */
const DEVICE_ATTEMPTS = 16;

function lifetimes(options: AuthorizationServerOptions): Lifetimes {
  const seconds = (
    value: number | undefined,
    fallback: number,
    name: string,
    min: number,
    max: number,
  ) => safeInt(value ?? fallback, { name, min, max });
  const registration = options.registration;
  const documents = options.clientIdMetadataDocuments;
  return {
    access: seconds(
      options.accessTokenTtlSec,
      300,
      "accessTokenTtlSec",
      1,
      DAY,
    ),
    code: seconds(options.codeTtlSec, 60, "codeTtlSec", 1, 600),
    refresh: seconds(
      options.refreshTokenTtlSec,
      30 * DAY,
      "refreshTokenTtlSec",
      1,
      3650 * DAY,
    ),
    idle: seconds(
      options.refreshIdleTtlSec,
      14 * DAY,
      "refreshIdleTtlSec",
      1,
      3650 * DAY,
    ),
    par: seconds(options.parTtlSec, 60, "parTtlSec", 1, 600),
    device: seconds(options.device?.ttlSec, 600, "device.ttlSec", 1, DAY),
    interval: seconds(
      options.device?.intervalSec,
      5,
      "device.intervalSec",
      1,
      300,
    ),
    secret: registration && registration.secretTtlSec !== undefined
      ? seconds(
        registration.secretTtlSec,
        0,
        "registration.secretTtlSec",
        1,
        3650 * DAY,
      )
      : undefined,
    documents: seconds(
      documents ? documents.cacheSec : undefined,
      300,
      "clientIdMetadataDocuments.cacheSec",
      0,
      DAY,
    ),
    client: seconds(
      registration ? registration.clientTtlSec : undefined,
      30 * DAY,
      "registration.clientTtlSec",
      1,
      3650 * DAY,
    ),
  };
}

/**
 * Checks the defaults against the server's own policy: `defaultScopes`
 * well formed and in `scopesSupported`, `resources.default` secure URLs
 * and in a listed `resources.allowed`. Throws `TypeError`.
 */
function checkDefaults(options: AuthorizationServerOptions): void {
  const supported = options.scopesSupported;
  for (const scope of options.defaultScopes ?? []) {
    if (!isScopeToken(scope)) {
      throw new TypeError(
        `default scope ${JSON.stringify(scope)} is malformed`,
      );
    }
    if (supported !== undefined && !supported.includes(scope)) {
      throw new TypeError(
        `default scope ${scope} is not in scopesSupported`,
      );
    }
  }
  const allowed = options.resources?.allowed;
  if (
    allowed !== undefined && typeof allowed !== "function" &&
    !Array.isArray(allowed)
  ) throw new TypeError("resources.allowed must be a list or function");
  for (
    const list of [
      Array.isArray(allowed) ? allowed : [],
      options.resources?.default ?? [],
    ]
  ) {
    if (
      !Array.isArray(list) || list.length > 64 ||
      new Set(list).size !== list.length
    ) throw new TypeError("resources must be a unique bounded list");
    for (const resource of list) checkSecureUrl(resource, "resource");
  }
  for (const resource of options.resources?.default ?? []) {
    const problem = secureUrlProblem(resource);
    if (problem !== null) {
      throw new TypeError(`default resource ${problem}: ${resource}`);
    }
    if (Array.isArray(allowed) && !allowed.includes(resource)) {
      throw new TypeError(
        `default resource ${resource} is not in resources.allowed`,
      );
    }
  }
}

/** An OAuth 2.1 authorization server; see the module documentation. */
export class AuthorizationServer {
  readonly issuer: string;
  readonly #options: AuthorizationServerOptions;
  /** The grants a registration, or a metadata document, may ask for. */
  readonly #registrationGrants: readonly string[];
  readonly #documentGrants: readonly string[];
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
  readonly #ttl: Lifetimes;
  readonly #work: OutboundWork;
  readonly #pushedCommits = new WeakMap<object, () => Promise<boolean>>();
  readonly #verifyToken: (
    token: string,
  ) => Promise<Record<string, unknown> | null>;

  /**
   * Throws `TypeError` for an invalid issuer, no keys, a key not made by
   * `generateSigningKey`/`signingKeyFromJwk` (so never an HMAC key), a
   * bad client, or default scopes or resources the server's own policy
   * refuses, and `RangeError` for a lifetime out of range.
   */
  constructor(input: AuthorizationServerOptions) {
    strictRecord(input, [
      "issuer",
      "keys",
      "store",
      "interaction",
      "clients",
      "resolveClient",
      "scopesSupported",
      "defaultScopes",
      "resources",
      "accessTokenTtlSec",
      "codeTtlSec",
      "refreshTokenTtlSec",
      "refreshIdleTtlSec",
      "issueRefreshToken",
      "requirePar",
      "parTtlSec",
      "dpop",
      "registration",
      "clientIdMetadataDocuments",
      "device",
      "tokenExchange",
      "unsafeTokenExchange",
      "tokenResponse",
      "introspection",
      "legacyAssertionAudience",
      "assertionAlgorithms",
      "paths",
      "metadata",
      "fetch",
      "egress",
      "now",
      "limiter",
      "authorizationParameters",
    ], "AuthorizationServer options");
    for (const name of ["requirePar", "legacyAssertionAudience"] as const) {
      if (input[name] !== undefined && typeof input[name] !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
      }
    }
    if (input.resources !== undefined) {
      strictRecord(input.resources, [
        "allowed",
        "default",
        "unsafeAllowAnyResource",
        "authorize",
      ], "resources");
      if (
        input.resources.unsafeAllowAnyResource !== undefined &&
        typeof input.resources.unsafeAllowAnyResource !== "boolean"
      ) throw new TypeError("unsafeAllowAnyResource must be boolean");
      if (
        input.resources.authorize !== undefined &&
        typeof input.resources.authorize !== "function"
      ) throw new TypeError("resources.authorize must be a function");
    }
    for (
      const [name, keys] of [
        ["dpop", [
          "required",
          "algorithms",
          "nonce",
          "maxAgeSec",
          "clockToleranceSec",
        ]],
        ["registration", [
          "initialAccessToken",
          "authMethods",
          "grantTypes",
          "secretTtlSec",
          "clientTtlSec",
        ]],
        ["device", ["verificationUri", "ttlSec", "intervalSec"]],
        ["introspection", ["audiences", "authorize", "claims"]],
      ] as const
    ) {
      const value = input[name];
      if (value !== undefined && value !== false) {
        strictRecord(value, keys, name);
      }
    }
    if (
      typeof input.dpop === "object" && input.dpop.required !== undefined &&
      typeof input.dpop.required !== "boolean"
    ) throw new TypeError("dpop.required must be boolean");
    if (
      typeof input.interaction !== "function" ||
      typeof input.store?.get !== "function" ||
      typeof input.store.swap !== "function" ||
      typeof input.store.put !== "function" ||
      typeof input.store.create !== "function" ||
      typeof input.store.delete !== "function"
    ) throw new TypeError("interaction and an atomic RecordStore are required");
    const registration = input.registration;
    if (registration) {
      if (
        registration.authMethods !== undefined &&
        (!Array.isArray(registration.authMethods) ||
          registration.authMethods.length === 0 ||
          registration.authMethods.length > AUTH_METHODS.length ||
          new Set(registration.authMethods).size !==
            registration.authMethods.length ||
          registration.authMethods.some((method) =>
            !(AUTH_METHODS as readonly unknown[]).includes(method)
          ))
      ) {
        throw new TypeError(
          "registration.authMethods must be a unique known-method list",
        );
      }
      if (
        registration.initialAccessToken !== undefined &&
        (typeof registration.initialAccessToken !== "string" ||
          registration.initialAccessToken.length === 0 ||
          registration.initialAccessToken.length > 16_384)
      ) {
        throw new TypeError(
          "registration.initialAccessToken must be a bounded credential",
        );
      }
    }
    const introspection = input.introspection;
    if (introspection !== undefined) {
      if (
        introspection.authorize !== undefined &&
        typeof introspection.authorize !== "function"
      ) {
        throw new TypeError("introspection.authorize must be a function");
      }
      if (introspection.audiences !== undefined) {
        const audiences = jsonSnapshot(introspection.audiences);
        if (
          !isObject(audiences) || Object.keys(audiences).length > 256 ||
          Object.entries(audiences).some(([client, values]) =>
            client.length === 0 || client.length > 4096 ||
            !Array.isArray(values) || values.length > 64 ||
            values.some((value) =>
              typeof value !== "string" || value.length === 0 ||
              value.length > 4096
            )
          )
        ) {
          throw new TypeError(
            "introspection.audiences must map clients to bounded audience lists",
          );
        }
      }
      if (
        introspection.claims !== undefined &&
        (!Array.isArray(introspection.claims) ||
          introspection.claims.length > 64 ||
          introspection.claims.some((name) =>
            typeof name !== "string" ||
            !/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(name)
          ))
      ) {
        throw new TypeError(
          "introspection.claims must be a bounded claim-name list",
        );
      }
    }
    if (
      typeof input.dpop === "object" && input.dpop.nonce !== undefined &&
      (typeof input.dpop.nonce.current !== "function" ||
        typeof input.dpop.nonce.check !== "function")
    ) {
      throw new TypeError("dpop.nonce requires issue and check functions");
    }
    for (
      const name of [
        "resolveClient",
        "issueRefreshToken",
        "unsafeTokenExchange",
        "tokenResponse",
        "fetch",
        "now",
        "limiter",
      ] as const
    ) {
      if (
        input[name] !== undefined && typeof input[name] !== "function"
      ) throw new TypeError(`${name} must be a function`);
    }
    if (
      input.authorizationParameters !== undefined &&
      (!Array.isArray(input.authorizationParameters) ||
        input.authorizationParameters.length > 64 ||
        input.authorizationParameters.some((value) =>
          typeof value !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(value)
        ))
    ) throw new TypeError("authorizationParameters must be bounded names");
    if (input.metadata !== undefined) jsonSnapshot(input.metadata);
    clientEgressPolicy(input.egress);
    if (
      input.clientIdMetadataDocuments !== undefined &&
      input.clientIdMetadataDocuments !== false
    ) {
      strictRecord(input.clientIdMetadataDocuments, [
        "allowUrl",
        "unsafeAllowArbitraryClientMetadataUrls",
        "cacheSec",
        "grantTypes",
      ], "clientIdMetadataDocuments");
      if (
        input.clientIdMetadataDocuments
            .unsafeAllowArbitraryClientMetadataUrls !== undefined &&
        typeof input.clientIdMetadataDocuments
            .unsafeAllowArbitraryClientMetadataUrls !== "boolean"
      ) {
        throw new TypeError(
          "unsafeAllowArbitraryClientMetadataUrls must be boolean",
        );
      }
      if (
        typeof input.clientIdMetadataDocuments.allowUrl !== "function" &&
        input.clientIdMetadataDocuments
            .unsafeAllowArbitraryClientMetadataUrls !== true
      ) {
        throw new TypeError(
          "client metadata documents require an allowUrl policy",
        );
      }
    }
    if (input.paths !== undefined) {
      strictRecord(input.paths, Object.keys(DEFAULT_PATHS), "paths");
    }
    if (input.tokenExchange !== undefined) {
      strictRecord(
        input.tokenExchange,
        ["sourceAudiences", "authorize"],
        "tokenExchange",
      );
      if (
        typeof input.tokenExchange.authorize !== "function" ||
        (typeof input.tokenExchange.sourceAudiences !== "function" &&
          (!Array.isArray(input.tokenExchange.sourceAudiences) ||
            input.tokenExchange.sourceAudiences.length === 0 ||
            input.tokenExchange.sourceAudiences.length > 64 ||
            input.tokenExchange.sourceAudiences.some((value) =>
              typeof value !== "string" || value.length === 0 ||
              value.length > 4096
            )))
      ) {
        throw new TypeError(
          "tokenExchange requires sourceAudiences and authorize",
        );
      }
      if (input.unsafeTokenExchange !== undefined) {
        throw new TypeError("choose one token exchange policy");
      }
    }
    const paths = Object.values({ ...DEFAULT_PATHS, ...input.paths });
    if (
      new Set(paths).size !== paths.length ||
      paths.some((p) =>
        typeof p !== "string" || p.length > 4096 || !p.startsWith("/") ||
        p.startsWith("//") ||
        /[?#\\]/.test(p) ||
        new URL(p, "https://validation.invalid").pathname !== p
      )
    ) {
      throw new TypeError(
        "endpoint paths must be distinct absolute paths without query, fragment, or normalization",
      );
    }
    for (
      const values of [input.scopesSupported ?? [], input.defaultScopes ?? []]
    ) {
      if (
        !Array.isArray(values) || values.length > 256 ||
        new Set(values).size !== values.length ||
        values.some((s) =>
          typeof s !== "string" || !isScopeToken(s) || s.length > 256
        )
      ) throw new TypeError("scopes must be unique scope tokens");
    }
    // Read once: every list, map and flag is copied here, so changing the
    // caller's objects afterwards (scopes, audiences, keys, clients,
    // resources) changes nothing. Callbacks, stores and key objects are
    // kept as given; objects that mix data with callbacks have their data
    // members copied.
    const mixed = <T extends object>(value: T | false | undefined) =>
      typeof value === "object" && value !== null
        ? snapshotOptions(value)
        : value;
    const options = snapshotOptions({
      ...input,
      introspection: mixed(input.introspection),
      resources: mixed(input.resources),
      clientIdMetadataDocuments: mixed(input.clientIdMetadataDocuments),
      dpop: mixed(input.dpop),
    }) as AuthorizationServerOptions;
    if (!isIssuer(options.issuer)) {
      throw new TypeError(`${options.issuer} is not a valid issuer`);
    }
    checkSigningKeys(options.keys);
    if (
      options.assertionAlgorithms !== undefined &&
      (!Array.isArray(options.assertionAlgorithms) ||
        options.assertionAlgorithms.length === 0 ||
        options.assertionAlgorithms.length > SIGNING_ALGORITHMS.length ||
        new Set(options.assertionAlgorithms).size !==
          options.assertionAlgorithms.length)
    ) {
      throw new TypeError(
        "assertionAlgorithms must be a unique nonempty algorithm list",
      );
    }
    for (const alg of options.assertionAlgorithms ?? []) {
      if (!(SIGNING_ALGORITHMS as readonly string[]).includes(alg)) {
        throw new TypeError(
          `assertionAlgorithms: ${alg} is not an asymmetric signing algorithm`,
        );
      }
    }
    this.#ttl = lifetimes(options);
    checkDefaults(options);
    this.issuer = options.issuer;
    this.#options = options;
    this.#store = options.store;
    this.#replay = recordReplayStore(options.store);
    this.#now = options.now ?? defaultClock;
    this.#verifyToken = prepareOwnAccessTokenVerifier(
      options.keys,
      options.issuer,
      this.#now,
    );
    this.#work = new OutboundWork(this.#now);
    this.#fetch = options.fetch ?? defaultFetch;
    this.#remoteKeys = remoteKeyCache(
      this.#fetch,
      this.#now,
      options.egress,
    );
    this.#base = options.issuer.replace(/\/+$/, "");
    for (const config of options.clients ?? []) {
      const client = registeredClient(config);
      if (this.#clients.has(client.client_id)) {
        throw new TypeError("duplicate client_id");
      }
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
    if (typeof options.dpop === "object") {
      dpopWindow(options.dpop);
      if (
        options.dpop.algorithms !== undefined &&
        (!Array.isArray(options.dpop.algorithms) ||
          options.dpop.algorithms.length === 0 ||
          options.dpop.algorithms.length > SIGNING_ALGORITHMS.length ||
          new Set(options.dpop.algorithms).size !==
            options.dpop.algorithms.length ||
          options.dpop.algorithms.some((alg) =>
            !(SIGNING_ALGORITHMS as readonly unknown[]).includes(alg)
          ))
      ) {
        throw new TypeError(
          "dpop.algorithms must be a unique nonempty asymmetric algorithm list",
        );
      }
    }
    const offered = this.#grantTypes();
    const userFacing = offered.filter((grant) =>
      grant === GRANT_TYPES.authorizationCode ||
      grant === GRANT_TYPES.refreshToken || grant === GRANT_TYPES.deviceCode
    );
    const allowed = (list: readonly string[] | undefined, what: string) => {
      if (list === undefined) return Object.freeze(userFacing);
      for (const grant of list) {
        if (!offered.includes(grant)) {
          throw new TypeError(
            `${what}.grantTypes names ${grant}, which this server does not offer`,
          );
        }
      }
      return list;
    };
    this.#registrationGrants = allowed(
      options.registration ? options.registration.grantTypes : undefined,
      "registration",
    );
    this.#documentGrants = allowed(
      options.clientIdMetadataDocuments
        ? options.clientIdMetadataDocuments.grantTypes
        : undefined,
      "clientIdMetadataDocuments",
    );
    Object.freeze(this);
  }

  /** The URL of an endpoint. */
  endpoint(name: EndpointName): string {
    return `${this.#base}${this.#options.paths?.[name] ?? DEFAULT_PATHS[name]}`;
  }

  /** Probe all configured signing/assertion/proof algorithms before serving traffic. */
  async ready(): Promise<void> {
    await assertAlgorithmsSupported([
      ...new Set([
        ...this.#options.keys.map((key) => key.alg),
        ...(this.#options.assertionAlgorithms ?? ASSERTION_ALGORITHMS),
        ...(this.#dpop === null
          ? []
          : this.#dpop.algorithms ?? DEFAULT_DPOP_ALGORITHMS),
      ]),
    ]);
  }

  async #admit(
    endpoint: EndpointName | "device_code",
    request: Request | null,
  ): Promise<void> {
    if (request !== null && endpoint !== "device_code") {
      const actual = new URL(request.url);
      const expected = new URL(this.endpoint(endpoint));
      if (
        actual.origin !== expected.origin ||
        actual.pathname !== expected.pathname
      ) {
        throw new ProtocolError("invalid_request", {
          description: "request does not target this endpoint",
        });
      }
      if ((request.headers.get("authorization")?.length ?? 0) > 16_400) {
        throw tooLarge();
      }
    }
    if (
      this.#options.limiter !== undefined &&
      await this.#options.limiter(endpoint, request) !== true
    ) {
      throw new ProtocolError("temporarily_unavailable", {
        status: 429,
        description: "request budget exhausted",
        headers: { "retry-after": "1" },
      });
    }
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
    if (
      this.#options.tokenExchange !== undefined ||
      this.#options.unsafeTokenExchange !== undefined
    ) {
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
    if (url.origin !== new URL(this.issuer).origin) return null;
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
    const url = new URL(request.url);
    const expected = new URL(this.endpoint("jwks"));
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
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

  /**
   * The client with this id: configured, registered, or (when enabled) a
   * metadata document. It is a frozen view that never carries the
   * client's secret or its hash; only client authentication sees those.
   */
  async client(clientId: string): Promise<RegisteredClient | null> {
    const found = await this.#lookup(clientId);
    return found === null ? null : clientView(found);
  }

  /** The full client record, secrets included, for client authentication. */
  async #lookup(clientId: string): Promise<RegisteredClient | null> {
    if (
      typeof clientId !== "string" || clientId.length === 0 ||
      clientId.length > 4096
    ) return null;
    const known = this.#clients.get(clientId);
    if (known !== undefined) return known;
    const stored = await this.#store.get<RegisteredClient>(
      `client:${clientId}`,
    );
    if (stored !== null) return registeredClient(stored.value);
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
    const client = await this.#work.run(
      clientId,
      new URL(clientId).origin,
      () =>
        fetchClientMetadataDocument(clientId, {
          fetch: this.#fetch,
          policy: this.#policy(this.#documentGrants),
          allowUrl: documents.allowUrl,
          egress: this.#options.egress,
        }),
    );
    this.#documents.set(clientId, {
      until: this.#now() +
        (client === null
            ? Math.min(this.#ttl.documents, 5)
            : this.#ttl.documents) * 1000,
      client,
    });
    if (this.#documents.size > 1000) {
      this.#documents.delete(this.#documents.keys().next().value!);
    }
    return client;
  }

  #policy(grantTypes: readonly string[]): MetadataPolicy {
    const registration = this.#options.registration;
    return {
      authMethods: (registration ? registration.authMethods : undefined) ??
        AUTH_METHODS,
      grantTypes,
      scopes: this.#options.scopesSupported,
      network: this.#options.egress?.network ?? "public",
      allowCleartextLoopbackForDevelopment: this.#options.egress
        ?.allowCleartextLoopbackForDevelopment,
    };
  }

  /**
   * When a registered client's record expires: its secret's expiry when
   * it has one, else `registration.clientTtlSec` from now.
   */
  #clientExpiry(client: RegisteredClient): number {
    const secret = client.client_secret_expires_at;
    if (secret !== undefined && secret > 0) return secret * 1000;
    return this.#now() + this.#ttl.client * 1000;
  }

  /**
   * Keeps a registered client that was just used: pushes its expiry out
   * when less than half its period is left. A lost race means another
   * request renewed it.
   */
  async #renewClient(clientId: string): Promise<void> {
    const key = `client:${clientId}`;
    const stored = await this.#store.get<RegisteredClient>(key);
    if (stored === null) return;
    const until = this.#clientExpiry(stored.value);
    if (
      stored.expiresAt !== null &&
      until - stored.expiresAt < this.#ttl.client * 500
    ) return;
    await this.#store.swap(key, stored.version, stored.value, until);
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
    const client = await this.#lookup(presented.clientId);
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
    if (client.source === "dynamic") await this.#renewClient(client.client_id);
    // Everything after authentication (hooks, grants, answers) gets the
    // view without the secret.
    return clientView(client);
  }

  // Scopes and resources.

  /**
   * The scopes of a request: those asked for, or `defaultScopes` when none
   * are, and either way checked against `scopesSupported` and the
   * client's own `scope` allowlist, so a client cannot get by omission
   * what it could not ask for.
   */
  #scope(requested: string | null, client: RegisteredClient): string[] {
    let scopes = parseScope(requested);
    if (scopes.length === 0) scopes = [...(this.#options.defaultScopes ?? [])];
    return this.#checkScopes(scopes, client);
  }

  /**
   * `scopes` if each is a scope token in `scopesSupported` and the
   * client's `scope` allowlist; `invalid_scope` otherwise.
   */
  #checkScopes(
    scopes: readonly string[],
    client: RegisteredClient,
  ): string[] {
    if (
      !Array.isArray(scopes) || scopes.length > 256 ||
      scopes.some((scope) => typeof scope !== "string" || scope.length > 256)
    ) {
      throw new ProtocolError("invalid_scope", {
        description: "scope exceeds its limits",
      });
    }
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
    return [...scopes];
  }

  /**
   * The resources of a request: those named, or `resources.default` when
   * none are, and either way each a secure URL that `resources.allowed`
   * allows for this client. Without either, `invalid_target`.
   */
  #resources(values: readonly string[], client: RegisteredClient): string[] {
    const allowed = this.#options.resources?.allowed;
    let out = [...new Set(values)];
    if (out.length === 0) out = [...(this.#options.resources?.default ?? [])];
    if (out.length === 0) {
      throw new ProtocolError("invalid_target", {
        description: "a resource is required",
      });
    }
    for (const resource of out) {
      const problem = secureUrlProblem(resource);
      if (resource.length > 4096 || out.length > 64) {
        throw new ProtocolError("invalid_target", {
          description: "resource indicators exceed their bounds",
        });
      }
      if (problem !== null) {
        throw new ProtocolError("invalid_target", {
          description: `resource ${problem}`,
        });
      }
      const ok = allowed === undefined
        ? this.#options.resources?.unsafeAllowAnyResource === true ||
          (this.#options.resources?.default ?? []).includes(resource)
        : typeof allowed === "function"
        ? allowed(resource, client)
        : allowed.includes(resource);
      if (ok !== true) {
        throw new ProtocolError("invalid_target", {
          description: `tokens are not issued for ${resource}`,
        });
      }
    }
    return out;
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

  /**
   * Verifies the request's DPoP proof, if any, without spending its
   * `jti`: `claim` does that, and a caller runs it once the request has
   * passed its own checks and before it writes anything, so requests that
   * fail (a bogus code from a public client, say) leave no replay records.
   * `claim` throws `invalid_dpop_proof` for a proof used before.
   */
  async #proof(
    request: Request,
    url: string,
    client: RegisteredClient,
  ): Promise<ProofCheck> {
    const dpop = this.#dpop;
    if (dpop === null) return NO_PROOF;
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
      return NO_PROOF;
    }
    // verifyDpopProof claims last, after every other check: the claim it
    // asks for is noted here and made later by `claim`.
    const noted: { key: string; expiresAt: number }[] = [];
    const deferred: ReplayStore = {
      claim: (key, expiresAt) => {
        noted.push({ key, expiresAt });
        return Promise.resolve(true);
      },
    };
    try {
      const verified = await verifyDpopProof(proof, {
        method: "POST",
        url,
        algorithms: dpop.algorithms,
        replay: deferred,
        nonce: dpop.nonce,
        maxAgeSec: dpop.maxAgeSec,
        clockToleranceSec: dpop.clockToleranceSec,
        now: this.#now,
      });
      let claimed = false;
      return {
        jkt: verified.jkt,
        claim: async () => {
          if (claimed) return;
          claimed = true;
          for (const { key, expiresAt } of noted) {
            if (await this.#replay.claim(key, expiresAt)) continue;
            throw new ProtocolError("invalid_dpop_proof", {
              description: "the proof has been used before",
            });
          }
        },
      };
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
  async #validateAuthorization(
    form: URLSearchParams,
    client: RegisteredClient,
    pushedJkt: string | undefined,
  ): Promise<PendingRequest> {
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
        const retained = [
          "client_id",
          "response_type",
          "redirect_uri",
          "scope",
          "state",
          "code_challenge",
          "code_challenge_method",
          "dpop_jkt",
          "nonce",
          "prompt",
          "max_age",
          "claims",
          "id_token_hint",
          "acr_values",
          "login_hint",
          "ui_locales",
          ...(this.#options.authorizationParameters ?? []),
        ];
        if (
          retained.includes(name) &&
          ![
            "client_assertion",
            "client_assertion_type",
            "client_secret",
            "resource",
          ].includes(name)
        ) {
          params[name] = value;
        }
      }
      return {
        clientId: client.client_id,
        clientGeneration: await this.#clientGeneration(client),
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

  async #clientGeneration(client: RegisteredClient): Promise<string> {
    // Canonical data order avoids spurious invalidation when a resolver changes
    // object property order. Only the digest is retained with pending grants.
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, item]) => [key, canonical(item)]),
        )
        : value;
    return await sha256(JSON.stringify(canonical(client)));
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
    try {
      await this.#admit("authorization", request);
    } catch (error) {
      return this.#errorResponse(error);
    }
    if (request.url.length > 16_384) return tooLarge().toResponse();
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
    } catch (error) {
      if (error instanceof ProtocolError && error.status === 413) {
        return plain(413, "invalid_request: the request body is too large");
      }
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
        pending = await this.#validateAuthorization(form, client, undefined);
      }
    } catch (error) {
      return this.#errorRedirect(error);
    }
    const response = await this.#interact(request, client, pending);
    const commit = this.#pushedCommits.get(pending);
    if (commit !== undefined && await commit() !== true) {
      return plain(400, "invalid_request_uri: request already used");
    }
    return response;
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
      expiresAt: this.#now() + this.#ttl.code * 1000,
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
    if (
      client === null ||
      stored.value.clientGeneration !== await this.#clientGeneration(client)
    ) return null;
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
    if (stored === null) {
      return plain(
        400,
        "invalid_request: the authorization request expired or was already used",
      );
    }
    const client = await this.client(stored.value.clientId);
    if (
      client === null ||
      stored.value.clientGeneration !== await this.#clientGeneration(client)
    ) return plain(400, "invalid_request: the client registration changed");
    const response = await this.#decide(stored.value, decision);
    if (await this.#store.swap(key, stored.version, null, null) !== true) {
      return plain(400, "invalid_request: authorization request already used");
    }
    return response;
  }

  // Pushed authorization requests.

  /** The PAR endpoint (RFC 9126): authenticates the client, validates, and stores the request. */
  async pushedAuthorization(request: Request): Promise<Response> {
    try {
      await this.#admit("par", request);
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
      const proof = await this.#proof(request, url, client);
      let pending: PendingRequest;
      try {
        pending = await this.#validateAuthorization(form, client, proof.jkt);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        throw new ProtocolError(error.code, {
          description: error.description ?? undefined,
        });
      }
      await proof.claim();
      const id = randomToken(32);
      const ttl = this.#ttl.par;
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
    if (
      stored === null || stored.value.clientId !== client.client_id ||
      stored.value.clientGeneration !== await this.#clientGeneration(client)
    ) {
      throw refuse();
    }
    this.#pushedCommits.set(
      stored.value,
      () => this.#store.swap(key, stored.version, null, null),
    );
    return stored.value;
  }

  // The token endpoint.

  #errorResponse(error: unknown): Response {
    if (error instanceof ProtocolError) return error.toResponse();
    // Hooks and storage errors can embed credentials; do not log their payload.
    console.error("oauth: unexpected server error");
    return new ProtocolError("server_error", {
      status: 500,
      description: "the server failed",
    }).toResponse();
  }

  /** The token endpoint: every enabled grant. */
  async token(request: Request): Promise<Response> {
    try {
      await this.#admit("token", request);
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
      // Each grant spends the proof's jti once the request has passed its
      // checks, before its first write.
      const proof = await this.#proof(request, url, client);
      switch (grantType) {
        case GRANT_TYPES.authorizationCode:
          return await this.#codeGrant(form, client, proof);
        case GRANT_TYPES.refreshToken:
          return await this.#refreshGrant(form, client, proof);
        case GRANT_TYPES.clientCredentials:
          return await this.#clientCredentialsGrant(form, client, proof);
        case GRANT_TYPES.deviceCode:
          return await this.#deviceGrant(form, client, proof);
        default:
          return await this.#exchangeGrant(form, client, proof);
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
      /** The access token's `jti`, when it was chosen beforehand. */
      readonly jti?: string;
    } = {},
  ): Promise<{ response: Response; jti: string }> {
    const authorize = this.#options.resources?.authorize;
    if (
      authorize !== undefined && grant.resource.some((resource) =>
        authorize({
          resource,
          client: grant.client,
          scope: grant.scope,
          grantType: grant.grantType,
        }) !== true
      )
    ) {
      throw new ProtocolError("invalid_target", {
        description: "this grant is not permitted for the resource",
      });
    }
    const lifetime = this.#ttl.access;
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
      options.jti,
    );
    const extra = this.#options.tokenResponse === undefined
      ? {}
      : await this.#options.tokenResponse(grant, {
        access_token: issued.token,
      });
    const reserved = new Set([
      "access_token",
      "refresh_token",
      "token_type",
      "expires_in",
      "scope",
      "issued_token_type",
      "error",
      "error_description",
      "error_uri",
    ]);
    const extensions = Object.fromEntries(
      Object.entries(jsonSnapshot(extra)).filter(([key]) =>
        !reserved.has(key) && key !== "__proto__" && key !== "constructor" &&
        key !== "prototype"
      ),
    );
    if (
      Object.keys(extensions).some((key) =>
        !/^[A-Za-z][A-Za-z0-9_.:/-]{0,255}$/.test(key)
      ) ||
      (extensions.id_token !== undefined &&
        (typeof extensions.id_token !== "string" ||
          extensions.id_token.length === 0 ||
          extensions.id_token.length > 16_384))
    ) {
      throw new TypeError(
        "token response extensions contain invalid names or id_token",
      );
    }
    if (JSON.stringify(extensions).length > 65_536) {
      throw new TypeError("token response extensions are too large");
    }
    const body: Record<string, unknown> = {
      ...extensions,
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
    if (decide !== undefined) {
      const result = decide(client, scope);
      if (typeof result !== "boolean") {
        throw new TypeError("issueRefreshToken must return boolean");
      }
      return result;
    }
    return client.grant_types.includes(GRANT_TYPES.refreshToken);
  }

  /** Starts a refresh token family; the token is bound to `jkt` for a public client. */
  async #newFamily(
    grant: IssuedGrant,
  ): Promise<{ family: string; token: string; persist: () => Promise<void> }> {
    const family = randomToken(24);
    const token = newRefreshToken(family);
    const now = this.#now();
    const deadline = now +
      this.#ttl.refresh * 1000;
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
      revoked: false,
      deadline,
    };
    return {
      family,
      token,
      persist: () =>
        this.#store.put(
          `family:${family}`,
          record,
          this.#familyExpiry(deadline),
        ),
    };
  }

  #familyExpiry(deadline: number): number {
    const idle = this.#ttl.idle * 1000;
    return Math.min(deadline, this.#now() + idle);
  }

  /**
   * Marks a family revoked. Every lost swap means another write (a
   * rotation) made progress, so it retries; if it still loses after
   * `REVOKE_ATTEMPTS`, it throws `temporarily_unavailable` (503) rather
   * than let a caller report a revocation that did not happen.
   */
  async #revokeFamily(family: string): Promise<void> {
    for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
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
    throw new ProtocolError("temporarily_unavailable", {
      status: 503,
      description: "the token family could not be revoked; try again",
    });
  }

  async #codeGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    proof: ProofCheck,
  ): Promise<Response> {
    const jkt = proof.jkt;
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
    if (record.clientGeneration !== await this.#clientGeneration(client)) {
      throw invalid("the client registration changed after authorization");
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
    await proof.claim();
    // What the code will issue is decided, and its refresh family stored,
    // before the claim: the claim then records both in one write, so a
    // replay at any later moment (even while the tokens are still being
    // signed) finds them and revokes them.
    const refresh = this.#wantsRefresh(client, record.scope)
      ? await this.#newFamily({ ...grant, resource: record.resource })
      : undefined;
    const jti = randomToken(16);
    const used: { family?: string; jti: string } = {
      ...(refresh === undefined ? {} : { family: refresh.family }),
      jti,
    };
    // Prepare every fallible signer/hook/nonce operation before the CAS.
    const prepared = await this.#respond(grant, { refresh, jti });
    await refresh?.persist();
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
    if (!claimed) {
      if (refresh !== undefined) {
        await this.#store.delete(`family:${refresh.family}`);
      }
      throw invalid("the code was already used");
    }
    return prepared.response;
  }

  async #refreshGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    proof: ProofCheck,
  ): Promise<Response> {
    const jkt = proof.jkt;
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
      const spent = await this.#store.get(spentKey(family, hash));
      if (
        spent !== null ||
        (record.previous ?? []).some((old) => timingSafeEqual(old, hash))
      ) {
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
    await proof.claim();
    const next = newRefreshToken(family);
    const { previous: _previous, ...kept } = record;
    const rotated: FamilyRecord = { ...kept, current: await sha256(next) };
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
    // The spent token is remembered for as long as the family can live,
    // so its reuse at any point revokes the family. Written before the
    // rotation: if the rotation loses a race, the family is revoked anyway.
    await this.#store.put(spentKey(family, record.current), 1, record.deadline);
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
    return response;
  }

  async #clientCredentialsGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    proof: ProofCheck,
  ): Promise<Response> {
    const jkt = proof.jkt;
    if (!isConfidential(client)) {
      throw new ProtocolError("unauthorized_client", {
        description: "a public client cannot use client_credentials",
      });
    }
    const scope = this.#scope(single(form, "scope"), client);
    const resource = this.#resources(form.getAll("resource"), client);
    await proof.claim();
    const { response } = await this.#respond({
      grantType: GRANT_TYPES.clientCredentials,
      client,
      subject: client.client_id,
      scope,
      resource,
      params: {},
      ...(jkt === undefined ? {} : { jkt }),
    });
    return response;
  }

  async #exchangeGrant(
    form: URLSearchParams,
    client: RegisteredClient,
    proof: ProofCheck,
  ): Promise<Response> {
    const jkt = proof.jkt;
    const policy = this.#options.tokenExchange;
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
    let subject: Readonly<Record<string, unknown>> | null = null;
    if (policy !== undefined) {
      if (
        context.subjectTokenType !== TOKEN_TYPES.accessToken &&
        context.subjectTokenType !== TOKEN_TYPES.jwt
      ) {
        throw new ProtocolError("invalid_grant", {
          description: "only an access token can be exchanged",
        });
      }
      if (context.actorToken !== undefined) {
        throw new ProtocolError("invalid_grant", {
          description:
            "actor tokens require an explicit unsafe custom exchange policy",
        });
      }
      subject = await this.verifyAccessToken(context.subjectToken);
      const sources = typeof policy.sourceAudiences === "function"
        ? policy.sourceAudiences(client)
        : policy.sourceAudiences;
      const audiences = subject === null
        ? []
        : typeof subject.aud === "string"
        ? [subject.aud]
        : Array.isArray(subject.aud)
        ? subject.aud
        : [];
      if (
        subject === null || typeof subject.sub !== "string" ||
        !Array.isArray(sources) || sources.length === 0 ||
        sources.length > 64 ||
        !sources.every((value) =>
          typeof value === "string" && value.length > 0 && value.length <= 4096
        ) ||
        !audiences.some((a) => typeof a === "string" && sources.includes(a)) ||
        scope.some((s) =>
          !parseScope(
            typeof subject!.scope === "string" ? subject!.scope : undefined,
          ).includes(s)
        )
      ) {
        throw new ProtocolError("invalid_grant", {
          description: "the subject token does not authorize this delegation",
        });
      }
      const cnf = subject.cnf as { jkt?: unknown } | undefined;
      if (
        cnf?.jkt !== undefined &&
        (typeof cnf.jkt !== "string" || cnf.jkt !== jkt)
      ) {
        throw new ProtocolError("invalid_dpop_proof", {
          description: "the subject token needs its bound proof key",
        });
      }
      let actor: unknown = subject.act;
      for (let depth = 0; actor !== undefined; depth++) {
        if (
          depth >= 4 || typeof actor !== "object" || actor === null ||
          Array.isArray(actor)
        ) {
          throw new ProtocolError("invalid_grant", {
            description: "actor chain is invalid or too deep",
          });
        }
        actor = (actor as Record<string, unknown>).act;
      }
    }
    // All token/proof validation precedes the pure policy callback.
    await proof.claim();
    const decided = policy === undefined
      ? await this.#options.unsafeTokenExchange!(context)
      : await policy.authorize({ ...context, subject: subject! });
    if (decided === null) {
      throw new ProtocolError("invalid_grant", {
        description: "the subject token is not accepted",
      });
    }
    strictRecord(
      decided,
      ["subject", "scope", "audience", "claims", "act"],
      "token exchange decision",
    );
    if (
      typeof decided.subject !== "string" || decided.subject.length === 0 ||
      decided.subject.length > 4096
    ) throw new TypeError("exchange decision needs a bounded subject");
    if (decided.claims !== undefined) jsonSnapshot(decided.claims);
    if (decided.act !== undefined) {
      let actor: unknown = jsonSnapshot(decided.act);
      for (let depth = 0; actor !== undefined; depth++) {
        if (
          depth >= 4 || typeof actor !== "object" || actor === null ||
          Array.isArray(actor) ||
          typeof (actor as Record<string, unknown>).sub !== "string" ||
          ((actor as Record<string, unknown>).sub as string).length === 0 ||
          ((actor as Record<string, unknown>).sub as string).length > 4096
        ) {
          throw new ProtocolError("invalid_grant", {
            description: "actor chain is invalid or too deep",
          });
        }
        actor = (actor as Record<string, unknown>).act;
      }
    }
    // The hook's audience is held to the same policy as a requested one:
    // secure URLs that `resources.allowed` allows for this client.
    if (decided.audience !== undefined && decided.audience.length === 0) {
      throw new ProtocolError("invalid_target", {
        description: "the exchange named no audience",
      });
    }
    const audience = decided.audience !== undefined
      ? this.#resources(decided.audience, client)
      : context.resource.length > 0
      ? context.resource
      : this.#resources([], client);
    // The hook's scope is held to the same policy as a requested one.
    const issued = decided.scope === undefined
      ? scope
      : this.#checkScopes(decided.scope, client);
    if (
      policy !== undefined &&
      (decided.subject !== subject!.sub ||
        issued.some((s) => !scope.includes(s)))
    ) {
      throw new ProtocolError("invalid_grant", {
        description: "exchange policy cannot escalate subject or scope",
      });
    }
    const { response } = await this.#respond({
      grantType: GRANT_TYPES.tokenExchange,
      client,
      subject: decided.subject,
      scope: issued,
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
      await this.#admit("device", request);
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
      const ttl = this.#ttl.device;
      const interval = this.#ttl.interval;
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

  /**
   * Eight letters from `USER_CODE_ALPHABET`, uniformly: a byte is used
   * only below the largest multiple of the alphabet's length (240 for
   * 20), so no letter is likelier than another.
   */
  #userCode(): string {
    const size = USER_CODE_ALPHABET.length;
    const limit = 256 - (256 % size);
    let code = "";
    while (code.length < 8) {
      for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
        if (byte < limit && code.length < 8) {
          code += USER_CODE_ALPHABET[byte % size];
        }
      }
    }
    return code;
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
    await this.#admit("device_code", null);
    if (userCode.length > 32) return null;
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
   * once the decision is written, so a code cannot be decided twice. A
   * decision that keeps losing races with the device's polls throws
   * (`temporarily_unavailable`); the code is then still pending.
   */
  async decideDevice(
    userCode: string,
    decision: InteractionDecision,
  ): Promise<boolean> {
    await this.#admit("device_code", null);
    if (typeof userCode !== "string" || userCode.length > 32) return false;
    // The device's polls write the same record (their bookkeeping), so a
    // lost swap is retried on the reloaded record while it is pending, and
    // the user code is spent only once the decision is written.
    for (let attempt = 0; attempt < DEVICE_ATTEMPTS; attempt++) {
      const found = await this.#deviceByUserCode(userCode);
      if (found === null || found.record.status !== "pending") return false;
      if (await this.#decideDevice(found, decision)) {
        await this.#store.delete(
          `user_code:${AuthorizationServer.normalizeUserCode(userCode)}`,
        );
        return true;
      }
    }
    throw new ProtocolError("temporarily_unavailable", {
      status: 503,
      description: "the decision could not be recorded; try again",
    });
  }

  async #decideDevice(
    found: {
      key: string;
      record: DeviceRecord;
      version: number;
      expiresAt: number | null;
    },
    decision: InteractionDecision,
  ): Promise<boolean> {
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
    proof: ProofCheck,
  ): Promise<Response> {
    const jkt = proof.jkt;
    const deviceCode = required(form, "device_code");
    const key = `device:${await sha256(deviceCode)}`;
    // A poll's bookkeeping write can lose to another poll's (or to the
    // approval): it reloads and decides again, so parallel polls see each
    // other's `lastPoll` and get `slow_down`.
    for (let attempt = 0; attempt < DEVICE_ATTEMPTS; attempt++) {
      const stored = await this.#store.get<DeviceRecord>(key);
      if (stored === null || stored.value.clientId !== client.client_id) {
        throw new ProtocolError("invalid_grant", {
          description: "the device code is unknown",
        });
      }
      const record = stored.value;
      const now = this.#now();
      // The code is this client's: the proof is spent before the poll
      // writes anything (once; a retry of the loop reuses the claim).
      await proof.claim();
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
          interval: early
            ? Math.min(record.interval + 5, 300)
            : record.interval,
        };
        if (
          !(await this.#store.swap(key, stored.version, next, stored.expiresAt))
        ) {
          continue;
        }
        throw new ProtocolError(early ? "slow_down" : "authorization_pending", {
          description: early
            ? "polling too fast"
            : "the user has not decided yet",
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
      const response = (await this.#respond(grant, { refresh })).response;
      await refresh?.persist();
      if (await this.#store.swap(key, stored.version, null, null) !== true) {
        throw new ProtocolError("invalid_grant", {
          description: "the device code was already used",
        });
      }
      return response;
    }
    throw new ProtocolError("slow_down", { description: "polling too fast" });
  }

  // Revocation and introspection.

  async #revokeJti(jti: string): Promise<void> {
    const lifetime = this.#ttl.access * 1000;
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
    const claims = await this.#verifyToken(token);
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
      await this.#admit("revocation", request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request, SMALL_FORM_MAX_BYTES);
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
   * Whether `client` may see an access token's claims: an `audiences`
   * entry naming one of its `aud` values (when `audiences` is set) and
   * `authorize` saying yes (when set). With neither set, no client may.
   */
  async #mayIntrospect(
    client: RegisteredClient,
    claims: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const policy = this.#options.introspection;
    if (policy === undefined) return false;
    if (policy.audiences === undefined && policy.authorize === undefined) {
      return false;
    }
    if (policy.audiences !== undefined) {
      const mine = Object.hasOwn(policy.audiences, client.client_id)
        ? policy.audiences[client.client_id]
        : [];
      const aud = typeof claims.aud === "string"
        ? [claims.aud]
        : Array.isArray(claims.aud)
        ? claims.aud
        : [];
      if (!aud.some((item) => mine.includes(item as string))) return false;
    }
    if (policy.authorize !== undefined) {
      return (await policy.authorize(client, claims)) === true;
    }
    return true;
  }

  /**
   * The introspection endpoint (RFC 7662), for authenticated confidential
   * clients. An access token is described only as the
   * {@link IntrospectionPolicy} allows (by default never), with the
   * minimal claims plus `claims`, and `token_type` (`DPoP` when bound);
   * a refresh token only to the client it was issued to. Anything else is
   * `{ active: false }`.
   */
  async introspection(request: Request): Promise<Response> {
    try {
      await this.#admit("introspection", request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_request", {
          status: 405,
          description: "use POST",
        });
      }
      const form = await readForm(request, SMALL_FORM_MAX_BYTES);
      const client = await this.#authenticate(
        request,
        form,
        this.endpoint("introspection"),
      );
      if (!isConfidential(client)) {
        throw new ProtocolError("invalid_client", {
          status: 401,
          description: "this client may not introspect",
        });
      }
      const token = required(form, "token");
      const inactive = () => jsonResponse(200, { active: false }, NO_STORE);
      const claims = await this.verifyAccessToken(token);
      if (claims !== null) {
        if (!(await this.#mayIntrospect(client, claims))) return inactive();
        const cnf = claims.cnf as { jkt?: string } | undefined;
        const shown = new Set([
          ...INTROSPECTION_CLAIMS,
          ...(this.#options.introspection?.claims ?? []),
        ]);
        const answer: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(claims)) {
          if (shown.has(name)) answer[name] = value;
        }
        return jsonResponse(200, {
          ...answer,
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
      await this.#admit("registration", request);
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
      const text = await readBody(request, REGISTRATION_MAX_BYTES);
      let body: unknown;
      try {
        body = parseJsonBounded(text, REGISTRATION_JSON);
      } catch (error) {
        throw new ProtocolError("invalid_client_metadata", {
          description: error instanceof BoundsError && error.code !== "syntax"
            ? `the body is too complex: ${error.message}`
            : "the body is not JSON",
        });
      }
      const metadata = validateClientMetadata(
        body,
        this.#policy(this.#registrationGrants),
      );
      const clientId = randomToken(16);
      const issuedAt = Math.floor(this.#now() / 1000);
      const secret = metadata.token_endpoint_auth_method ===
            "client_secret_basic" ||
          metadata.token_endpoint_auth_method === "client_secret_post"
        ? randomToken(32)
        : undefined;
      const expiresAt = secret !== undefined && this.#ttl.secret !== undefined
        ? issuedAt + this.#ttl.secret
        : 0;
      // `metadata` holds only client metadata members: the id, the secret,
      // its expiry and the record's source are the server's.
      const record: RegisteredClient = {
        ...(metadata as ClientConfig),
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
      await this.#store.put(
        `client:${clientId}`,
        record,
        this.#clientExpiry(record),
      );
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
