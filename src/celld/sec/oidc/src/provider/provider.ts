// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link OpenIdProvider}: an OpenID Provider made of `@celld/sec/oauth`'s
 * `AuthorizationServer` and what OpenID Connect adds to it.
 *
 * ```ts
 * const op = new OpenIdProvider({
 *   issuer: "https://login.example.com",
 *   keys: [await generateSigningKey("ES256")],
 *   store: durableRecordStore(env.OAUTH_RECORDS),
 *   sessionSidKey: env.SESSION_SID_KEY,
 *   clients: [{ client_id: "web", redirect_uris: ["https://app.example.com/cb"],
 *               post_logout_redirect_uris: ["https://app.example.com/"] }],
 *   interaction: async (context) => {
 *     const session = await mySession(context.request);
 *     if (session === null || context.needsLogin(session.authTime)) {
 *       if (context.prompt.includes("none")) return { deny: { error: "login_required" } };
 *       // Bind the interaction to this browser (a sealed cookie naming it,
 *       // which the login page requires) so a link to the login page
 *       // opened in another browser cannot finish it; the redirect's URL
 *       // is absolute (a relative one makes Response.redirect throw).
 *       const login = new URL("/login", context.request.url);
 *       login.searchParams.set("i", context.interactionId);
 *       return new Response(null, {
 *         status: 303,
 *         headers: {
 *           location: login.href,
 *           "set-cookie": await bindInteraction(context.interactionId),
 *         },
 *       });
 *     }
 *     return { grant: { subject: session.user, authTime: session.authTime, sessionId: session.id } };
 *   },
 *   claims: ({ subject, claims }) => lookUpUser(subject, claims),
 * });
 * export default { fetch: async (r) => await op.handle(r) ?? await myPages(r) };
 * ```
 *
 * What it adds to the authorization server:
 *
 * - `/.well-known/openid-configuration` (appended to the issuer), and the
 *   same OpenID members in the RFC 8414 document;
 * - the interaction hook sees `prompt`, `max_age`, `acr_values`,
 *   `login_hint`, a verified `id_token_hint` and the `claims` request, and
 *   the grant it returns is checked against them (`max_age` and
 *   `prompt=login` against `authTime`, essential `acr`, the hinted user),
 *   so a host that forgets one gets an error, not a silent pass; an
 *   unknown `prompt` value and a repeated OpenID parameter are
 *   `invalid_request`;
 * - an `id_token_hint` counts only when it is an ID token of this
 *   provider (`typ` `JWT` and the private claim `token_use: "id"`, which
 *   access tokens never carry) issued to the requesting client, expired
 *   or not;
 * - ID tokens in token responses for `openid` grants: `iss`, `sub`, `aud`,
 *   `exp`, `iat`, `auth_time`, `nonce` (not on refresh), `acr`, `amr`,
 *   `at_hash`, `sid` (an HMAC of the host's login session id under
 *   `sessionSidKey`), `token_use: "id"`, and the claims the `claims`
 *   parameter asks for, signed with the key for the client's
 *   `id_token_signed_response_alg` (never another);
 * - UserInfo, a protected resource that takes Bearer and DPoP tokens,
 *   sees revocations, and answers the scopes' claims (`profile`, `email`,
 *   `address`, `phone`) plus requested ones, from the host's `claims`
 *   hook;
 * - RP-Initiated Logout at `end_session`, which ends the login session
 *   (`sid`) of a hint at most `endSessionHintMaxAgeSec` old unless the
 *   host's `endSession` hook answers (say, a confirmation page for a
 *   browser that is not the hint's user): its refresh tokens then get no
 *   more ID tokens and its access tokens no more UserInfo;
 * - signed request objects (`request`, RFC 9101) at the authorization
 *   endpoint when `requestObjects` is on: `iat` required, at most an
 *   hour old, and `exp` at most an hour ahead.
 *
 * @module
 */

import {
  type Clock,
  GRANT_TYPES,
  parseScope,
  ProtocolError,
  randomToken,
  sha256,
} from "@celld/sec/oauth";
import {
  AuthorizationServer,
  type AuthorizationServerOptions,
  type ClientConfig,
  type InteractionDecision,
  type IssuedGrant,
  publicJwks,
  recordReplayStore,
  type RecordStore,
  type RegisteredClient,
  type SigningKey,
} from "@celld/sec/oauth/server";
import { DEFAULT_DPOP_ALGORITHMS } from "@celld/sec/oauth/dpop";
import {
  type AccessTokenVerifier,
  ResourceServer,
} from "@celld/sec/oauth/resource";
import {
  assertAlgorithmsSupported,
  type JwsAlgorithm,
  type JwtClaims,
  type KeySet,
  localJwks,
  publicVerificationKeys,
  RemoteJwks,
  sign,
  toBase64Url,
  tryDecode,
  verify,
} from "@celld/sec/jwt";
import {
  BoundsError,
  jsonSnapshot,
  parseJsonBounded,
  readTextBounded,
  safeInt,
} from "@celld/core/bounds";
import {
  claimsForScopes,
  type ClaimsRequest,
  ID_TOKEN_PROTOCOL_CLAIMS,
  type IdTokenClaims,
  OPENID_SCOPE,
  parseClaimsRequest,
  requestedAcrValues,
  STANDARD_CLAIMS,
} from "../claims.ts";
import { tokenHash } from "../hash.ts";
import {
  openIdConfigurationUrl,
  type OpenIdProviderMetadata,
} from "../metadata.ts";
import {
  audiences,
  checkPaths,
  defaultClock,
  epochSeconds,
  isObject,
  jsonResponse,
  NO_STORE,
  postLogoutProblem,
  redirectResponse,
  rethrowRuntimeUnsupported,
  secretBytes,
  snapshotOptions,
  textResponse,
} from "../util.ts";

/** An authorization request as the OpenID interaction hook sees it. */
export interface OidcAuthorizationContext {
  /** Names the request for {@link OpenIdProvider.resumeAuthorization}. Keep it secret. */
  readonly interactionId: string;
  readonly request: Request;
  readonly client: RegisteredClient;
  readonly scope: readonly string[];
  readonly resource: readonly string[];
  readonly redirectUri: string;
  /** Every authorization parameter. */
  readonly params: Readonly<Record<string, string>>;
  /** Whether `openid` was asked for. */
  readonly openid: boolean;
  /** `prompt`, split: `none`, `login`, `consent`, `select_account`, `create`. */
  readonly prompt: readonly string[];
  /** `max_age` in seconds. */
  readonly maxAge?: number;
  /** Acceptable `acr` values, most preferred first. */
  readonly acrValues: readonly string[];
  /** Whether one of `acrValues` is required (an essential `acr` claim request). */
  readonly acrEssential: boolean;
  readonly loginHint?: string;
  /** The claims of a valid `id_token_hint` this provider issued. */
  readonly idTokenHint?: IdTokenClaims;
  readonly claims?: ClaimsRequest;
  /**
   * Whether a user who authenticated at `authTime` (epoch seconds) must
   * log in again: always with `prompt=login` (an existing session never
   * satisfies it), or when `max_age` is exceeded or no time is known.
   */
  needsLogin(authTime: number | undefined): boolean;
}

/** What the user decided, in OpenID terms. */
export type OidcDecision =
  | {
    readonly grant: {
      readonly subject: string;
      /** Epoch seconds the user authenticated; required with `max_age` and `prompt=login`. */
      readonly authTime?: number;
      /** The authentication context class reached. */
      readonly acr?: string;
      /** Authentication methods (RFC 8176: `pwd`, `otp`, `hwk`, ...). */
      readonly amr?: readonly string[];
      /** The host's login session id; its hash is the `sid` claim, and logout ends it. */
      readonly sessionId?: string;
      /** Scopes granted; default all asked for. */
      readonly scope?: readonly string[];
      /** Extra access token claims. */
      readonly claims?: Readonly<Record<string, unknown>>;
    };
  }
  | {
    readonly deny: {
      /** `access_denied`, `login_required`, `consent_required`, `interaction_required`, ... */
      readonly error?: string;
      readonly description?: string;
    };
  };

/** The host's login and consent step. */
export type OidcInteractionHook = (
  context: OidcAuthorizationContext,
) => OidcDecision | Response | Promise<OidcDecision | Response>;

/** What the claims hook is asked. */
export interface ClaimsLookup {
  readonly subject: string;
  /** The claim names wanted; answer those you have, leave out the rest. */
  readonly claims: readonly string[];
  readonly client: RegisteredClient | null;
  readonly scope: readonly string[];
  readonly purpose: "id_token" | "userinfo";
}

/** Looks up a user's claims. `sub` and protocol claims in the answer are ignored. */
export type ClaimsHook = (
  lookup: ClaimsLookup,
) =>
  | Readonly<Record<string, unknown>>
  | Promise<Readonly<Record<string, unknown>>>;

/** An RP-Initiated Logout request, validated. */
export interface EndSessionContext {
  readonly request: Request;
  /** The `sub` of a valid `id_token_hint`. */
  readonly subject?: string;
  /** The `sid` of a valid `id_token_hint`. */
  readonly sid?: string;
  readonly client: RegisteredClient | null;
  /** A registered `post_logout_redirect_uri`, if one was asked for. */
  readonly postLogoutRedirectUri?: string;
  readonly state?: string;
  readonly logoutHint?: string;
}

/**
 * The host's logout step: end its own session (clear its cookie; call
 * {@link OpenIdProvider.endLoginSession} for sessions without a hint) and
 * answer nothing to let the provider finish (it then ends the hint's
 * `sid`, if the hint is at most `endSessionHintMaxAgeSec` old), or answer
 * a `Response` (a confirmation page that posts back here once the user
 * agrees), which ends nothing. A hook that answers the confirmation page
 * unless this browser's own session is the hint's `subject` makes an ID
 * token alone unable to end a session.
 */
export type EndSessionHook = (
  context: EndSessionContext,
) => Response | void | Promise<Response | void>;

/** Options for {@link OpenIdProvider}. */
export interface OpenIdProviderOptions extends
  Omit<
    AuthorizationServerOptions,
    "interaction" | "tokenResponse" | "metadata" | "keys" | "store"
  > {
  /**
   * ID token and access token signing keys; the first signs unless a
   * client registered another `id_token_signed_response_alg`, which must
   * then be one of theirs.
   */
  readonly keys: readonly SigningKey[];
  readonly store: RecordStore;
  readonly interaction: OidcInteractionHook;
  readonly claims: ClaimsHook;
  /** Default 600. */
  readonly idTokenTtlSec?: number;
  /** Put the scopes' claims in ID tokens too, not only in UserInfo; default false. */
  readonly scopeClaimsInIdToken?: boolean;
  readonly acrValuesSupported?: readonly string[];
  /** Claims to advertise beyond the standard ones. */
  readonly claimsSupported?: readonly string[];
  /** Accept signed request objects (`request`) at the authorization endpoint; default false. */
  readonly requestObjects?: boolean;
  readonly endSession?: EndSessionHook;
  /**
   * The oldest `id_token_hint` (seconds since its `iat`) whose `sid`
   * `end_session` ends by itself; default `sessionTtlSec`. An older hint
   * still identifies the client (its `post_logout_redirect_uri`, the
   * hook's `subject` and `sid`), but only the host's hook can end a
   * session for it. An ID token is logged, sent in URLs and held by every
   * relying party, so without a hook that checks the browser (its own
   * session is the hint's user) anyone holding one can end that session.
   */
  readonly endSessionHintMaxAgeSec?: number;
  /** How long a login session's record lasts; default 30 days. */
  readonly sessionTtlSec?: number;
  /**
   * The HMAC key (32 random bytes, base64url, kept as a secret and the
   * same in every isolate) that turns a host's login session id into the
   * `sid` claim; see {@link OpenIdProvider.sessionSid}. Shorter than 32
   * bytes, with fewer than `SECRET_MIN_DISTINCT_BYTES` distinct bytes, or
   * `@celld/sec/oidc/testing`'s public `TEST_SESSION_SID_KEY` (outside
   * `testProvider`) is a `TypeError`. Required once a grant
   * names a `sessionId`, or {@link OpenIdProvider.endLoginSession} is
   * called: without it those throw a `TypeError`.
   */
  readonly sessionSidKey?: string | Uint8Array;
  /** Paths of the OpenID endpoints, appended to the issuer. */
  readonly oidcPaths?: {
    readonly userinfo?: string;
    readonly endSession?: string;
  };
  /** More metadata members, in both documents. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const DEFAULT_SCOPES = ["openid", "profile", "email", "address", "phone"];

const PROMPTS = new Set([
  "none",
  "login",
  "consent",
  "select_account",
  "create",
]);

const ASYMMETRIC: readonly JwsAlgorithm[] = Object.freeze([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
]);

const CLOCK_SKEW_SEC = 10;

/** The longest a signed request object may live, in seconds. */
const REQUEST_OBJECT_MAX_AGE_SEC = 3600;

/** The most keys a client's own `jwks` (or `jwks_uri`) may hold. */
const MAX_CLIENT_KEYS = 64;

/**
 * The private claim, and its value, that marks every ID token this
 * provider signs, so that nothing else signed with the same keys (an
 * access token above all) passes as an `id_token_hint`. OpenID Connect
 * relying parties ignore claims they do not understand, so it costs no
 * interoperability; `typ` stays `JWT`.
 */
export const ID_TOKEN_USE_CLAIM = "token_use";
export const ID_TOKEN_USE = "id";

/**
 * The OpenID authorization parameters that must appear at most once. The
 * base OAuth parser already refuses repeated OAuth ones (`client_id`,
 * `redirect_uri`, `state`, `scope`, PKCE, ...); these would otherwise be
 * read last-wins.
 */
export const OIDC_SINGLE_PARAMETERS: readonly string[] = Object.freeze([
  "nonce",
  "prompt",
  "max_age",
  "claims",
  "id_token_hint",
  "acr_values",
  "login_hint",
  "display",
  "ui_locales",
]);

/** The largest authorization or pushed request form read for the checks here; as the server's own cap. */
const FORM_MAX_BYTES = 16 * 1024;

/** The largest registration body read to check `id_token_signed_response_alg`; as the server's own cap. */
const REGISTRATION_MAX_BYTES = 64 * 1024;

/** The first OpenID single parameter `form` repeats, or null. */
function repeatedParameter(form: URLSearchParams): string | null {
  for (const name of OIDC_SINGLE_PARAMETERS) {
    if (form.getAll(name).length > 1) return name;
  }
  return null;
}

/** The access token claim carrying the claim names a `claims` request asked UserInfo for. */
export const USERINFO_CLAIMS_CLAIM = "userinfo_claims";

interface SessionRecord {
  readonly subject: string;
  readonly ended: boolean;
}

interface InteractionRecord {
  readonly startedAt: number;
}

interface OidcParams {
  readonly prompt: string[];
  readonly maxAge?: number;
  readonly claims?: ClaimsRequest;
  readonly acr: {
    readonly values: readonly string[];
    readonly essential: boolean;
  };
  readonly idTokenHint?: IdTokenClaims;
}

const encoder = new TextEncoder();

class Refusal extends Error {
  constructor(readonly error: string, readonly description: string) {
    super(description);
  }
}

/** An OpenID Provider; see the module documentation. */
export class OpenIdProvider {
  readonly issuer: string;
  /** The authorization server underneath, for its other endpoints and methods. */
  readonly server: AuthorizationServer;
  readonly userinfoEndpoint: string;
  readonly endSessionEndpoint: string;
  readonly #options: OpenIdProviderOptions;
  readonly #store: RecordStore;
  readonly #now: Clock;
  readonly #userinfo: ResourceServer;
  readonly #ownKeys: KeySet;
  readonly #clientKeySets = new Map<string, KeySet>();
  readonly #algorithms: ReadonlySet<string>;
  readonly #sidKey: Promise<CryptoKey> | null;

  /**
   * Throws `TypeError` for a bad issuer, no keys, a bad client (one
   * asking for an `id_token_signed_response_alg` none of `keys` signs
   * with, say), or a `sessionSidKey` that is shorter than 32 bytes,
   * plainly not random, or the public test key.
   */
  constructor(input: OpenIdProviderOptions) {
    // Read once: keys, clients, switches (`requestObjects`), egress and
    // the resolver are copied here, so the authorization server, the JWKS
    // and the signing key all come from the same configuration, and
    // changing the caller's object afterwards changes nothing.
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
    }) as OpenIdProviderOptions;
    this.#options = options;
    this.#algorithms = new Set(options.keys.map((key) => key.alg));
    for (const client of options.clients ?? []) {
      const problem = this.#clientProblem(client);
      if (problem !== null) {
        throw new TypeError(`client ${client.client_id}: ${problem}`);
      }
    }
    if (options.endSessionHintMaxAgeSec !== undefined) {
      safeInt(options.endSessionHintMaxAgeSec, {
        name: "endSessionHintMaxAgeSec",
        min: 1,
      });
    }
    this.#sidKey = options.sessionSidKey === undefined
      ? null
      : sessionSidKey(options.sessionSidKey);
    this.#store = options.store;
    this.#now = options.now ?? defaultClock;
    const base = options.issuer.replace(/\/+$/, "");
    checkPaths(base, options.oidcPaths, {
      userinfo: "/userinfo",
      endSession: "/end_session",
    });
    this.userinfoEndpoint = `${base}${
      options.oidcPaths?.userinfo ?? "/userinfo"
    }`;
    this.endSessionEndpoint = `${base}${
      options.oidcPaths?.endSession ?? "/end_session"
    }`;
    this.issuer = options.issuer;
    this.#ownKeys = localJwks(publicJwks(options.keys));
    const allowed = options.resources?.allowed;
    const unsafeAllowAnyResource =
      options.resources?.unsafeAllowAnyResource === true;
    const userinfo = this.userinfoEndpoint;
    const {
      claims: _claims,
      idTokenTtlSec: _idTokenTtlSec,
      scopeClaimsInIdToken: _scopeClaims,
      acrValuesSupported: _acrValues,
      claimsSupported: _claimsSupported,
      requestObjects: _requestObjects,
      endSession: _endSession,
      endSessionHintMaxAgeSec: _hintAge,
      sessionTtlSec: _sessionTtl,
      sessionSidKey: _sidKey,
      oidcPaths: _paths,
      ...serverOptions
    } = options;
    this.server = new AuthorizationServer({
      ...serverOptions,
      scopesSupported: [
        ...new Set([...DEFAULT_SCOPES, ...(options.scopesSupported ?? [])]),
      ],
      resources: {
        ...options.resources,
        allowed: allowed === undefined
          ? unsafeAllowAnyResource ? () => true : [userinfo]
          : typeof allowed === "function"
          ? (resource, client) =>
            resource === userinfo || allowed(resource, client)
          : [...new Set([...allowed, userinfo])],
        default: options.resources?.default ?? [userinfo],
      },
      metadata: this.#oidcMembers(),
      ...(options.resolveClient === undefined ? {} : {
        resolveClient: async (clientId) => {
          const client = await options.resolveClient!(clientId);
          return client !== null && this.#clientProblem(client) !== null
            ? null
            : client;
        },
      }),
      interaction: (context) => this.#interact(context),
      tokenResponse: (grant, tokens) =>
        this.#idToken(grant, tokens.access_token),
    });
    const dpop = options.dpop;
    this.#userinfo = new ResourceServer({
      resource: userinfo,
      authorizationServers: [options.issuer],
      verifier: this.#userinfoVerifier(),
      dpop: dpop === false ? false : {
        algorithms: dpop?.algorithms,
        nonce: dpop?.nonce,
        replay: recordReplayStore(options.store, "userinfo-dpop:"),
        maxAgeSec: dpop?.maxAgeSec,
        clockToleranceSec: dpop?.clockToleranceSec,
      },
      now: this.#now,
    });
    Object.freeze(this);
  }

  /** Probe all configured signing algorithms before serving traffic. */
  async ready(): Promise<void> {
    await this.server.ready();
    await this.#userinfo.ready();
    await assertAlgorithmsSupported(this.#options.keys.map((key) => key.alg));
  }

  #oidcMembers(): Record<string, unknown> {
    const options = this.#options;
    const algs = [...new Set(options.keys.map((key) => key.alg))];
    const document: Record<string, unknown> = {
      ...options.metadata,
      userinfo_endpoint: this.userinfoEndpoint,
      end_session_endpoint: this.endSessionEndpoint,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: algs,
      claims_supported: [
        ...new Set([
          ...STANDARD_CLAIMS,
          "iss",
          "aud",
          "exp",
          "iat",
          "auth_time",
          "nonce",
          "acr",
          "amr",
          "sid",
          "at_hash",
          ...(options.claimsSupported ?? []),
        ]),
      ],
      claim_types_supported: ["normal"],
      claims_parameter_supported: true,
      request_parameter_supported: options.requestObjects ?? false,
      request_uri_parameter_supported: false,
      prompt_values_supported: [...PROMPTS],
    };
    if (options.requestObjects) {
      document.request_object_signing_alg_values_supported = [...ASYMMETRIC];
    }
    if (options.acrValuesSupported !== undefined) {
      document.acr_values_supported = [...options.acrValuesSupported];
    }
    if (options.dpop !== false) {
      document.dpop_signing_alg_values_supported = [
        ...(options.dpop?.algorithms ?? DEFAULT_DPOP_ALGORITHMS),
      ];
    }
    return document;
  }

  /** The OpenID Provider metadata document. */
  metadata(): OpenIdProviderMetadata {
    return this.server.metadata() as OpenIdProviderMetadata;
  }

  /** The path of `/.well-known/openid-configuration` under the issuer. */
  get configurationPath(): string {
    return new URL(openIdConfigurationUrl(this.issuer)).pathname;
  }

  /**
   * Routes a request: the OpenID configuration, UserInfo and its Protected
   * Resource Metadata (RFC 9728, which its challenges name), end session, the
   * authorization endpoint (with request objects), then every
   * authorization server endpoint; null for anything else.
   */
  async handle(request: Request): Promise<Response | null> {
    if (new URL(request.url).origin !== new URL(this.issuer).origin) {
      return textResponse(400, "invalid public origin");
    }
    const path = new URL(request.url).pathname;
    if (path === this.configurationPath) {
      return request.method === "GET" || request.method === "HEAD"
        ? jsonResponse(200, this.metadata(), { "cache-control": "max-age=300" })
        : new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    const resourceMetadata = this.#userinfo.handleMetadata(request);
    if (resourceMetadata !== null) return resourceMetadata;
    if (path === new URL(this.userinfoEndpoint).pathname) {
      return await this.userinfo(request);
    }
    if (path === new URL(this.endSessionEndpoint).pathname) {
      return await this.endSession(request);
    }
    if (path === new URL(this.server.endpoint("authorization")).pathname) {
      return await this.authorize(request);
    }
    if (
      request.method === "POST" &&
      path === new URL(this.server.endpoint("par")).pathname
    ) {
      const form = await readForm(request);
      const repeated = form === null ? null : repeatedParameter(form);
      if (repeated !== null) {
        return jsonResponse(400, {
          error: "invalid_request",
          error_description: `${repeated} is repeated`,
        }, NO_STORE);
      }
    }
    if (
      request.method === "POST" && this.#options.registration &&
      path === new URL(this.server.endpoint("registration")).pathname
    ) {
      const refused = await this.#checkRegistration(request);
      if (refused !== null) return refused;
    }
    return await this.server.handle(request);
  }

  /**
   * Why a client's `id_token_signed_response_alg` cannot be honoured (no
   * key signs with it), or null. There is no fallback to another key: a
   * client that asked for one algorithm must never get another.
   */
  #algorithmProblem(client: object): string | null {
    const wanted =
      (client as { readonly id_token_signed_response_alg?: unknown })
        .id_token_signed_response_alg;
    if (wanted === undefined) return null;
    if (typeof wanted !== "string" || !this.#algorithms.has(wanted)) {
      return `id_token_signed_response_alg ${
        JSON.stringify(wanted)
      } is not one this provider signs with (${
        [...this.#algorithms].join(", ")
      })`;
    }
    return null;
  }

  /**
   * Why a client cannot be served: its ID token algorithm, or a
   * `post_logout_redirect_uris` entry that the redirect URI rule refuses
   * (https, or http only to a loopback host; a private-use scheme only for
   * native clients; never `javascript:` or a fragment), since the end
   * session endpoint sends browsers there. Null when it can.
   */
  #clientProblem(client: object): string | null {
    const metadata = client as Record<string, unknown>;
    if (
      metadata.subject_type !== undefined && metadata.subject_type !== "public"
    ) return "only public subject identifiers are supported";
    for (
      const name of [
        "sector_identifier_uri",
        "id_token_encrypted_response_alg",
        "id_token_encrypted_response_enc",
        "userinfo_signed_response_alg",
        "userinfo_encrypted_response_alg",
        "userinfo_encrypted_response_enc",
        "request_object_encryption_alg",
        "request_object_encryption_enc",
        "default_max_age",
        "require_auth_time",
        "default_acr_values",
        "frontchannel_logout_uri",
        "frontchannel_logout_session_required",
        "backchannel_logout_uri",
        "backchannel_logout_session_required",
      ]
    ) {
      if (metadata[name] !== undefined) {
        return `${name} is not supported by this provider`;
      }
    }
    if (
      metadata.request_object_signing_alg !== undefined &&
      (!this.#options.requestObjects ||
        !ASYMMETRIC.includes(
          metadata.request_object_signing_alg as JwsAlgorithm,
        ))
    ) return "request_object_signing_alg is unsupported";
    const algorithm = this.#algorithmProblem(client);
    if (algorithm !== null) return algorithm;
    return postLogoutProblem(client);
  }

  /** Refuses a registration asking for an ID token algorithm without a key, or a bad post-logout redirect URI. */
  async #checkRegistration(request: Request): Promise<Response | null> {
    let body: unknown;
    try {
      body = parseJsonBounded(
        await readTextBounded(request.clone(), {
          maxBytes: REGISTRATION_MAX_BYTES,
        }),
        { maxDepth: 8, maxKeys: 256, maxItems: 256 },
      );
    } catch {
      // The server answers malformed and oversized bodies itself.
      return null;
    }
    if (!isObject(body)) return null;
    const problem = this.#clientProblem(body);
    if (problem === null) return null;
    return jsonResponse(400, {
      error: "invalid_client_metadata",
      error_description: problem,
    }, NO_STORE);
  }

  // Interaction.

  /**
   * The claims of an ID token this provider issued to `clientId`, or
   * null: signed by one of its keys, `typ` `JWT`, the ID token marker
   * ({@link ID_TOKEN_USE_CLAIM}, which access tokens never carry), `iss`,
   * `sub`, `iat` and `exp`, `aud` naming the client and `azp` (when
   * present, or with several audiences) the client. A hint may have
   * expired, so it is checked as of when it was issued.
   */
  async #verifyOwnIdToken(
    token: string,
    clientId: string,
  ): Promise<IdTokenClaims | null> {
    const decoded = tryDecode(token);
    const iat = decoded?.payload.iat;
    if (typeof iat !== "number") return null;
    try {
      const { payload } = await verify(token, this.#ownKeys, {
        algorithms: [...this.#algorithms] as JwsAlgorithm[],
        issuer: this.issuer,
        audience: clientId,
        typ: "JWT",
        requiredClaims: ["sub", "aud", "iat", "exp"],
        now: iat * 1000,
        claims: (claims: JwtClaims) => {
          if (claims[ID_TOKEN_USE_CLAIM] !== ID_TOKEN_USE) {
            throw new TypeError("not an ID token");
          }
          const azp = claims.azp;
          if (
            (azp !== undefined || audiences(claims.aud).length > 1) &&
            azp !== clientId
          ) {
            throw new TypeError("azp is not the client");
          }
          return claims as unknown as IdTokenClaims;
        },
      });
      return payload;
    } catch (cause) {
      rethrowRuntimeUnsupported(cause);
      return null;
    }
  }

  async #oidcParams(
    params: Readonly<Record<string, string>>,
    clientId: string,
  ): Promise<OidcParams> {
    const prompt = (params.prompt ?? "").split(" ").filter((item) =>
      item !== ""
    );
    for (const item of prompt) {
      if (!PROMPTS.has(item)) {
        throw new Refusal(
          "invalid_request",
          `prompt ${JSON.stringify(item)} is not supported`,
        );
      }
    }
    if (prompt.includes("none") && prompt.length > 1) {
      throw new Refusal(
        "invalid_request",
        "prompt none cannot be combined with other values",
      );
    }
    let maxAge: number | undefined;
    if (params.max_age !== undefined) {
      if (!/^\d{1,10}$/.test(params.max_age)) {
        throw new Refusal("invalid_request", "max_age must be a whole number");
      }
      maxAge = Number(params.max_age);
    }
    let claims: ClaimsRequest | undefined;
    if (params.claims !== undefined) {
      try {
        claims = parseClaimsRequest(params.claims);
        for (const [destination, requests] of Object.entries(claims)) {
          for (const [name, rule] of Object.entries(requests)) {
            if (rule === null) continue;
            const constrained = rule as {
              essential?: boolean;
              value?: unknown;
              values?: unknown;
            };
            const supported = destination === "id_token" &&
              (name === "acr" ||
                name === "auth_time" && constrained.value === undefined &&
                  constrained.values === undefined);
            if (
              !supported &&
              (constrained.essential === true ||
                constrained.value !== undefined ||
                constrained.values !== undefined)
            ) {
              throw new Error(
                "constrained claims are supported only for ID-token acr and auth_time",
              );
            }
          }
        }
      } catch (error) {
        throw new Refusal("invalid_request", (error as Error).message);
      }
    }
    let idTokenHint: IdTokenClaims | undefined;
    if (params.id_token_hint !== undefined) {
      const hint = await this.#verifyOwnIdToken(
        params.id_token_hint,
        clientId,
      );
      if (hint === null) {
        throw new Refusal("invalid_request", "id_token_hint is not valid");
      }
      idTokenHint = hint;
    }
    return {
      prompt,
      ...(maxAge === undefined ? {} : { maxAge }),
      ...(claims === undefined ? {} : { claims }),
      acr: requestedAcrValues(claims, params.acr_values),
      ...(idTokenHint === undefined ? {} : { idTokenHint }),
    };
  }

  /**
   * Whether a grant's authentication is too old for the request: with
   * `prompt=login` it must be no earlier than the request (the second it
   * arrived), with `max_age` within that many seconds (and some skew).
   */
  #stale(
    oidc: OidcParams,
    startedAt: number,
    authTime: number | undefined,
  ): boolean {
    if (oidc.prompt.includes("login")) {
      return authTime === undefined || authTime < Math.floor(startedAt / 1000);
    }
    if (oidc.maxAge !== undefined) {
      return authTime === undefined ||
        epochSeconds(this.#now) - authTime > oidc.maxAge + CLOCK_SKEW_SEC;
    }
    return false;
  }

  /** The host's advice: `prompt=login` always needs a login; `max_age` one that recent. */
  #needsLogin(
    oidc: OidcParams,
    startedAt: number,
  ): (authTime: number | undefined) => boolean {
    return (authTime) =>
      oidc.prompt.includes("login") || this.#stale(oidc, startedAt, authTime);
  }

  async #interact(
    context: Parameters<AuthorizationServerOptions["interaction"]>[0],
  ): Promise<InteractionDecision | Response> {
    const problem = this.#clientProblem(context.client);
    if (problem !== null) {
      return { deny: { error: "unauthorized_client", description: problem } };
    }
    let oidc: OidcParams;
    try {
      oidc = await this.#oidcParams(context.params, context.client.client_id);
    } catch (error) {
      if (error instanceof Refusal) {
        return { deny: { error: error.error, description: error.description } };
      }
      throw error;
    }
    const startedAt = this.#now();
    const decision = await this.#options.interaction({
      ...context,
      openid: context.scope.includes(OPENID_SCOPE),
      prompt: oidc.prompt,
      ...(oidc.maxAge === undefined ? {} : { maxAge: oidc.maxAge }),
      acrValues: oidc.acr.values,
      acrEssential: oidc.acr.essential,
      ...(context.params.login_hint === undefined
        ? {}
        : { loginHint: context.params.login_hint }),
      ...(oidc.idTokenHint === undefined
        ? {}
        : { idTokenHint: oidc.idTokenHint }),
      ...(oidc.claims === undefined ? {} : { claims: oidc.claims }),
      needsLogin: this.#needsLogin(oidc, startedAt),
    });
    if (decision instanceof Response) {
      if (oidc.prompt.includes("none")) {
        await decision.body?.cancel();
        return {
          deny: {
            error: "interaction_required",
            description: "the user must interact, and prompt is none",
          },
        };
      }
      await this.#store.put<InteractionRecord>(
        `oidc-interaction:${await sha256(context.interactionId)}`,
        { startedAt },
        this.#now() + 600_000,
      );
      return decision;
    }
    return await this.#toOAuth(decision, oidc, context.scope, startedAt);
  }

  /** Checks an OpenID decision against the request and turns it into the authorization server's. */
  async #toOAuth(
    decision: OidcDecision,
    oidc: OidcParams,
    scope: readonly string[],
    startedAt: number,
  ): Promise<InteractionDecision> {
    if ("deny" in decision) return decision;
    const grant = decision.grant;
    const refuse = (
      error: string,
      description: string,
    ): InteractionDecision => ({
      deny: { error, description },
    });
    if (this.#stale(oidc, startedAt, grant.authTime)) {
      return refuse(
        "login_required",
        oidc.prompt.includes("login")
          ? "prompt=login needs a fresh authentication"
          : "the authentication is older than max_age",
      );
    }
    const authTimeWanted = oidc.claims?.id_token?.auth_time?.essential === true;
    if (authTimeWanted && grant.authTime === undefined) {
      return refuse("login_required", "auth_time is essential and unknown");
    }
    if (
      oidc.idTokenHint !== undefined && oidc.idTokenHint.sub !== grant.subject
    ) {
      return refuse(
        "login_required",
        "the signed-in user is not the one id_token_hint names",
      );
    }
    if (
      oidc.acr.essential &&
      (grant.acr === undefined || !oidc.acr.values.includes(grant.acr))
    ) {
      return refuse(
        "unmet_authentication_requirements",
        "the essential acr was not reached",
      );
    }
    const claims: Record<string, unknown> = { ...grant.claims };
    // Access tokens must never look like ID tokens.
    delete claims[ID_TOKEN_USE_CLAIM];
    if (grant.acr !== undefined) claims.acr = grant.acr;
    if (grant.amr !== undefined) claims.amr = [...grant.amr];
    if (grant.sessionId !== undefined) {
      const sid = await this.sessionSid(grant.sessionId);
      const problem = await this.#bindSession(sid, grant.subject);
      if (problem !== null) return refuse("login_required", problem);
      claims.sid = sid;
    }
    const userinfo = Object.keys(oidc.claims?.userinfo ?? {});
    if (userinfo.length > 0) claims[USERINFO_CLAIMS_CLAIM] = userinfo;
    const granted = grant.scope === undefined
      ? scope
      : grant.scope.filter((item) => scope.includes(item));
    return {
      grant: {
        subject: grant.subject,
        scope: granted,
        ...(Object.keys(claims).length === 0 ? {} : { claims }),
        ...(grant.authTime === undefined ? {} : { authTime: grant.authTime }),
      },
    };
  }

  /**
   * Records the login session `sid` for `subject`, or says why it cannot
   * be used: it ended, or it is another user's. A lost race to create the
   * record is read again and checked again.
   */
  async #bindSession(sid: string, subject: string): Promise<string | null> {
    const key = `oidc-session:${sid}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await this.#store.get<SessionRecord>(key);
      if (existing !== null) {
        if (existing.value.ended) return "that login session has ended";
        if (existing.value.subject !== subject) {
          return "that login session is another user's";
        }
        return null;
      }
      if (
        await this.#store.create<SessionRecord>(
          key,
          { subject, ended: false },
          this.#now() + (this.#options.sessionTtlSec ?? 30 * 86400) * 1000,
        )
      ) return null;
    }
    return "the login session could not be recorded";
  }

  /**
   * The `sid` of a host login session id: an HMAC-SHA-256 under
   * `sessionSidKey` of the issuer and the id, so neither the id nor a
   * guess at it can be checked against a `sid` without the key. Throws a
   * `TypeError` when the provider has no `sessionSidKey`.
   */
  async sessionSid(sessionId: string): Promise<string> {
    if (this.#sidKey === null) {
      throw new TypeError(
        "login session ids need sessionSidKey: new OpenIdProvider({ sessionSidKey })",
      );
    }
    const mac = await crypto.subtle.sign(
      "HMAC",
      await this.#sidKey,
      encoder.encode(`${this.issuer}\n${sessionId}`),
    );
    return toBase64Url(new Uint8Array(mac).subarray(0, 24));
  }

  /**
   * The pending request of an interaction, with its OpenID parameters, for
   * the host's login or consent page; null when unknown or used.
   */
  async interaction(interactionId: string): Promise<
    | (NonNullable<Awaited<ReturnType<AuthorizationServer["interaction"]>>> & {
      readonly prompt: readonly string[];
      readonly maxAge?: number;
      readonly acrValues: readonly string[];
      readonly loginHint?: string;
    })
    | null
  > {
    const pending = await this.server.interaction(interactionId);
    if (pending === null) return null;
    let oidc: OidcParams;
    try {
      oidc = await this.#oidcParams(pending.params, pending.client.client_id);
    } catch {
      return null;
    }
    return {
      ...pending,
      prompt: oidc.prompt,
      ...(oidc.maxAge === undefined ? {} : { maxAge: oidc.maxAge }),
      acrValues: oidc.acr.values,
      ...(pending.params.login_hint === undefined
        ? {}
        : { loginHint: pending.params.login_hint }),
    };
  }

  /**
   * Finishes an authorization the interaction hook answered with its own
   * `Response`, with the same checks as a direct decision (`prompt=login`
   * counts from when the request arrived). Returns the redirect back to
   * the client. The host must make sure the decision comes from the
   * browser that started the interaction.
   */
  async resumeAuthorization(
    interactionId: string,
    decision: OidcDecision,
  ): Promise<Response> {
    const pending = await this.server.interaction(interactionId);
    const record = await this.#store.get<InteractionRecord>(
      `oidc-interaction:${await sha256(interactionId)}`,
    );
    if (pending === null || record === null) {
      return await this.server.resumeAuthorization(interactionId, {
        deny: {},
      });
    }
    let converted: InteractionDecision;
    try {
      const oidc = await this.#oidcParams(
        pending.params,
        pending.client.client_id,
      );
      converted = await this.#toOAuth(
        decision,
        oidc,
        pending.scope,
        record.value.startedAt,
      );
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      converted = {
        deny: { error: error.error, description: error.description },
      };
    }
    return await this.server.resumeAuthorization(interactionId, converted);
  }

  // ID tokens.

  async #sessionEnded(sid: unknown): Promise<boolean> {
    if (typeof sid !== "string") return false;
    const record = await this.#store.get<SessionRecord>(`oidc-session:${sid}`);
    return record === null || record.value.ended;
  }

  /** The key for the client's ID tokens; never another algorithm than it registered. */
  #signingKey(client: RegisteredClient): SigningKey {
    const wanted = client.id_token_signed_response_alg;
    if (wanted === undefined) return this.#options.keys[0];
    const key = this.#options.keys.find((item) => item.alg === wanted);
    if (key === undefined) {
      throw new ProtocolError("unauthorized_client", {
        description: this.#algorithmProblem(client) ?? "no key for the alg",
      });
    }
    return key;
  }

  async #hostClaims(
    subject: string,
    names: readonly string[],
    client: RegisteredClient | null,
    scope: readonly string[],
    purpose: "id_token" | "userinfo",
  ): Promise<Record<string, unknown>> {
    if (names.length === 0) return {};
    const answer = jsonSnapshot(
      await this.#options.claims({
        subject,
        claims: names,
        client,
        scope,
        purpose,
      }),
    );
    const out: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      if (ID_TOKEN_PROTOCOL_CLAIMS.includes(name)) continue;
      if (Object.hasOwn(answer, name) && answer[name] !== undefined) {
        out[name] = answer[name];
      }
    }
    return jsonSnapshot(out);
  }

  async #idToken(
    grant: IssuedGrant,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    if (!grant.scope.includes(OPENID_SCOPE)) return {};
    const problem = this.#clientProblem(grant.client);
    if (problem !== null) {
      throw new ProtocolError("invalid_client_metadata", {
        description: problem,
      });
    }
    const kinds: string[] = [
      GRANT_TYPES.authorizationCode,
      GRANT_TYPES.refreshToken,
      GRANT_TYPES.deviceCode,
    ];
    if (!kinds.includes(grant.grantType)) return {};
    const extra = grant.claims ?? {};
    if (extra.sid !== undefined && await this.#sessionEnded(extra.sid)) {
      throw new ProtocolError("invalid_grant", {
        description: "the login session has ended",
      });
    }
    let requested: ClaimsRequest = {};
    if (grant.params.claims !== undefined) {
      try {
        requested = parseClaimsRequest(grant.params.claims);
      } catch {
        requested = {};
      }
    }
    const names = [
      ...new Set([
        ...Object.keys(requested.id_token ?? {}),
        ...(this.#options.scopeClaimsInIdToken
          ? claimsForScopes(grant.scope)
          : []),
      ]),
    ];
    const key = this.#signingKey(grant.client);
    const iat = epochSeconds(this.#now);
    const claims: Record<string, unknown> = {
      ...await this.#hostClaims(
        grant.subject,
        names,
        grant.client,
        grant.scope,
        "id_token",
      ),
      iss: this.issuer,
      sub: grant.subject,
      aud: grant.client.client_id,
      exp: iat + (this.#options.idTokenTtlSec ?? 600),
      iat,
      at_hash: await tokenHash(accessToken, key.alg),
      [ID_TOKEN_USE_CLAIM]: ID_TOKEN_USE,
    };
    if (grant.authTime !== undefined) claims.auth_time = grant.authTime;
    const nonce = grant.params.nonce;
    if (
      grant.grantType === GRANT_TYPES.authorizationCode && nonce !== undefined
    ) {
      claims.nonce = nonce;
    }
    if (typeof extra.acr === "string") claims.acr = extra.acr;
    if (Array.isArray(extra.amr)) claims.amr = extra.amr;
    if (typeof extra.sid === "string") claims.sid = extra.sid;
    const idToken = await sign(claims, key.privateKey, {
      alg: key.alg,
      kid: key.kid,
      typ: "JWT",
    });
    return { id_token: idToken };
  }

  // UserInfo.

  #userinfoVerifier(): AccessTokenVerifier {
    return {
      verify: async (token) => {
        const invalid = (description: string) =>
          new ProtocolError("invalid_token", { status: 401, description });
        const claims = await this.server.verifyAccessToken(token);
        if (claims === null) throw invalid("the token is invalid or revoked");
        const aud = audiences(claims.aud);
        if (!aud.includes(this.userinfoEndpoint)) {
          throw invalid("the token is not for UserInfo");
        }
        if (claims.sid !== undefined && await this.#sessionEnded(claims.sid)) {
          throw invalid("the login session has ended");
        }
        const cnf = isObject(claims.cnf)
          ? claims.cnf as { jkt?: string }
          : undefined;
        return {
          subject: claims.sub as string,
          scopes: parseScope(claims.scope as string | undefined),
          clientId: claims.client_id as string,
          issuer: this.issuer,
          audience: aud,
          expiresAt: (claims.exp as number) * 1000,
          ...(cnf === undefined ? {} : { cnf }),
          claims,
        };
      },
    };
  }

  /**
   * The UserInfo endpoint (OpenID Connect Core section 5.3): GET or POST
   * with a Bearer or DPoP access token carrying `openid`, answering `sub`
   * and the claims its scopes and `claims` request ask for.
   */
  async userinfo(request: Request): Promise<Response> {
    if (new URL(request.url).origin !== new URL(this.issuer).origin) {
      return textResponse(400, "invalid public origin");
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }
    const result = await this.#userinfo.verifyRequest(request, {
      scopes: [OPENID_SCOPE],
      url: this.userinfoEndpoint,
    });
    if (!result.ok) return result.challenge.toResponse();
    const principal = result.principal;
    const extra = principal.claims[USERINFO_CLAIMS_CLAIM];
    const names = [
      ...new Set([
        ...claimsForScopes(principal.scopes),
        ...(Array.isArray(extra)
          ? extra.filter((item): item is string => typeof item === "string")
          : []),
      ]),
    ];
    const client = principal.clientId === undefined
      ? null
      : await this.server.client(principal.clientId);
    const claims = await this.#hostClaims(
      principal.subject,
      names,
      client,
      principal.scopes,
      "userinfo",
    );
    return jsonResponse(200, { ...claims, sub: principal.subject }, {
      ...NO_STORE,
      ...result.headers,
    });
  }

  // Logout.

  /**
   * Ends a login session by the host's session id: its refresh tokens get
   * no more ID tokens, and its access tokens no more UserInfo.
   */
  async endLoginSession(
    sessionId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.#endSid(await this.sessionSid(sessionId), options.signal);
  }

  async #endSid(sid: string, signal?: AbortSignal): Promise<void> {
    const key = `oidc-session:${sid}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, attempt * 5 + crypto.getRandomValues(new Uint8Array(1))[0] % 6);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      signal?.throwIfAborted();
      const stored = await this.#store.get<SessionRecord>(key);
      if (stored === null) {
        const ttl = (this.#options.sessionTtlSec ?? 30 * 86400) * 1000;
        if (
          await this.#store.create<SessionRecord>(
            key,
            { subject: "", ended: true },
            this.#now() + ttl,
          )
        ) return;
        continue;
      }
      if (stored.value.ended) return;
      if (
        await this.#store.swap(
          key,
          stored.version,
          { ...stored.value, ended: true },
          stored.expiresAt,
        )
      ) return;
    }
    throw new ProtocolError("temporarily_unavailable", {
      status: 503,
      description: "session revocation could not be committed",
    });
  }

  /**
   * The end session endpoint (OpenID Connect RP-Initiated Logout 1.0):
   * GET or POST with `id_token_hint` (this provider's, expired or not),
   * `client_id`, `post_logout_redirect_uri` (which must be registered for
   * the client), `state` and `logout_hint`. After the host's hook (unless
   * it answers), the hinted session ends when the hint is at most
   * `endSessionHintMaxAgeSec` old, and the browser goes back to the
   * client, or gets a plain page. Without a hook that is all it takes:
   * whoever holds the ID token ends the session, from any browser; a host
   * that wants the user's presence checks its own session in the hook and
   * answers a confirmation page otherwise. Anything invalid is a plain
   * 400: logout never redirects somewhere unregistered.
   */
  async endSession(request: Request): Promise<Response> {
    if (new URL(request.url).origin !== new URL(this.issuer).origin) {
      return textResponse(400, "invalid public origin");
    }
    let params: URLSearchParams;
    if (request.method === "GET") {
      params = new URL(request.url).searchParams;
    } else if (request.method === "POST") {
      const type = request.headers.get("content-type") ?? "";
      if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
        return textResponse(400, "invalid_request: the body must be a form");
      }
      try {
        params = new URLSearchParams(
          await readTextBounded(request.clone(), { maxBytes: FORM_MAX_BYTES }),
        );
      } catch (cause) {
        if (cause instanceof BoundsError && cause.code === "too_large") {
          return textResponse(413, "invalid_request: the form is too large");
        }
        return textResponse(400, "invalid_request: the body is not readable");
      }
    } else {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }
    const one = (name: string): string | undefined => {
      const values = params.getAll(name);
      if (values.length > 1) {
        throw new Refusal("invalid_request", `${name} is repeated`);
      }
      return values[0];
    };
    try {
      const hintText = one("id_token_hint");
      let clientId = one("client_id");
      let hint: IdTokenClaims | null = null;
      if (hintText !== undefined) {
        // Without client_id, the relying party is the hint's azp or its
        // one audience; either way the hint must be an ID token issued to
        // that client, which must be registered.
        if (clientId === undefined) {
          const unverified = tryDecode(hintText)?.payload;
          const aud = audiences(unverified?.aud);
          clientId = typeof unverified?.azp === "string"
            ? unverified.azp
            : aud.length === 1
            ? aud[0]
            : undefined;
        }
        hint = clientId === undefined
          ? null
          : await this.#verifyOwnIdToken(hintText, clientId);
        if (hint === null) {
          throw new Refusal(
            "invalid_request",
            "id_token_hint is not a valid ID token for the client",
          );
        }
      }
      const client = clientId === undefined
        ? null
        : await this.server.client(clientId);
      if (hint !== null && client === null) {
        throw new Refusal(
          "invalid_request",
          "id_token_hint is for a client that is not registered",
        );
      }
      const redirect = one("post_logout_redirect_uri");
      if (redirect !== undefined) {
        const registered = (client as ClientConfig | null)
          ?.post_logout_redirect_uris;
        if (
          client === null || !Array.isArray(registered) ||
          !registered.includes(redirect)
        ) {
          throw new Refusal(
            "invalid_request",
            "post_logout_redirect_uri is not registered for the client",
          );
        }
        // Stored and document clients were not checked when they came in.
        if (postLogoutProblem(client) !== null) {
          throw new Refusal(
            "invalid_request",
            "the client's post_logout_redirect_uris are not acceptable",
          );
        }
      }
      const state = one("state");
      const logoutHint = one("logout_hint");
      const sid = typeof hint?.sid === "string" ? hint.sid : undefined;
      const answer = await this.#options.endSession?.({
        request,
        ...(hint === null ? {} : { subject: hint.sub }),
        ...(sid === undefined ? {} : { sid }),
        client,
        ...(redirect === undefined ? {} : { postLogoutRedirectUri: redirect }),
        ...(state === undefined ? {} : { state }),
        ...(logoutHint === undefined ? {} : { logoutHint }),
      });
      if (answer instanceof Response) return answer;
      const maxAge = this.#options.endSessionHintMaxAgeSec ??
        this.#options.sessionTtlSec ?? 30 * 86400;
      if (
        sid !== undefined && hint !== null &&
        hint.iat >= epochSeconds(this.#now) - maxAge
      ) {
        await this.#endSid(sid, request.signal);
      }
      if (redirect === undefined) {
        return textResponse(200, "You are signed out.");
      }
      const target = new URL(redirect);
      if (state !== undefined) target.searchParams.set("state", state);
      return redirectResponse(target.href);
    } catch (error) {
      if (error instanceof Refusal) {
        return textResponse(400, `${error.error}: ${error.description}`);
      }
      throw error;
    }
  }

  // Request objects.

  /**
   * A client's keys for request objects: the verification keys of its
   * `jwks` (at most {@link MAX_CLIENT_KEYS} keys, none symmetric or
   * private: client metadata is no secret store, so a set holding an
   * `oct` key or a `k` is refused whole, as `RemoteJwks` refuses a
   * fetched one; encryption keys in it are skipped), or its `jwks_uri`
   * fetched under the server's `egress` policy (https, public addresses,
   * no redirects, bounded; see `@celld/sec/oauth`). Null when it has none
   * usable. Request objects verify under asymmetric algorithms only.
   */
  #clientKeys(client: RegisteredClient): KeySet | null {
    if (client.jwks !== undefined) {
      const keys: unknown = client.jwks.keys;
      if (!Array.isArray(keys) || keys.length > MAX_CLIENT_KEYS) return null;
      try {
        const publicKeys = publicVerificationKeys(keys);
        const identity = `inline:${JSON.stringify(publicKeys)}`;
        let prepared = this.#clientKeySets.get(identity);
        if (prepared === undefined) {
          prepared = localJwks({ keys: publicKeys });
          this.#clientKeySets.set(identity, prepared);
          if (this.#clientKeySets.size > 1000) {
            this.#clientKeySets.delete(
              this.#clientKeySets.keys().next().value!,
            );
          }
        }
        return prepared;
      } catch {
        return null;
      }
    }
    if (client.jwks_uri === undefined) return null;
    let keys = this.#clientKeySets.get(client.jwks_uri);
    if (keys === undefined) {
      try {
        keys = new RemoteJwks(client.jwks_uri, {
          fetch: this.#options.fetch,
          now: this.#now,
          maxKeys: MAX_CLIENT_KEYS,
          ...(this.#options.egress === undefined
            ? {}
            : { egress: this.#options.egress }),
        });
      } catch (error) {
        if (error instanceof TypeError) return null;
        throw error;
      }
      this.#clientKeySets.set(client.jwks_uri, keys);
      if (this.#clientKeySets.size > 1000) {
        this.#clientKeySets.delete(this.#clientKeySets.keys().next().value!);
      }
    }
    return keys;
  }

  /**
   * The authorization endpoint. With `requestObjects`, a `request`
   * parameter is a signed request object (RFC 9101): signed by the
   * client's registered keys with an asymmetric algorithm, `iss` the
   * client, `aud` this issuer, `exp` at most an hour after issue, a `jti`
   * used once, no `sub` (so it can never double as a client assertion),
   * and `typ` `oauth-authz-req+jwt` or `JWT` if present. Its claims
   * replace the query entirely; then the request goes on as any other.
   */
  async authorize(request: Request): Promise<Response> {
    if (new URL(request.url).origin !== new URL(this.issuer).origin) {
      return textResponse(400, "invalid public origin");
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return await this.server.authorize(request);
    }
    const form = request.method === "GET"
      ? new URL(request.url).searchParams
      : await readForm(request);
    // An unreadable form is the server's to refuse.
    if (form === null) return await this.server.authorize(request);
    const repeated = repeatedParameter(form);
    if (repeated !== null) {
      return textResponse(400, `invalid_request: ${repeated} is repeated`);
    }
    if (!this.#options.requestObjects) {
      return await this.server.authorize(request);
    }
    const jar = form.get("request");
    if (jar === null) return await this.server.authorize(request);
    const refuse = (description: string) =>
      textResponse(400, `invalid_request_object: ${description}`);
    if (form.has("request_uri") || form.getAll("request").length > 1) {
      return refuse("send one request object by value");
    }
    const clientId = form.get("client_id");
    const client = clientId === null
      ? null
      : await this.server.client(clientId);
    if (client === null) {
      return textResponse(400, "invalid_client: unknown client");
    }
    const keys = this.#clientKeys(client);
    if (keys === null) return refuse("the client has no keys");
    const typ = tryDecode(jar)?.header.typ;
    if (
      typ !== undefined &&
      !["jwt", "oauth-authz-req+jwt"].includes(
        String(typ).toLowerCase().replace(/^application\//, ""),
      )
    ) {
      return refuse("the request object has the wrong typ");
    }
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await verify(jar, keys, {
        algorithms: typeof client.request_object_signing_alg === "string"
          ? [client.request_object_signing_alg as JwsAlgorithm]
          : ASYMMETRIC,
        issuer: client.client_id,
        audience: this.issuer,
        requiredClaims: ["exp", "iat", "jti"],
        maxTokenAge: REQUEST_OBJECT_MAX_AGE_SEC,
        clockTolerance: CLOCK_SKEW_SEC,
        now: this.#now,
      }));
    } catch (cause) {
      rethrowRuntimeUnsupported(cause);
      return refuse("the request object does not verify");
    }
    if (claims.sub !== undefined) {
      return refuse("a request object must not have sub");
    }
    if (
      claims.client_id !== undefined && claims.client_id !== client.client_id
    ) {
      return refuse("the request object is for another client");
    }
    const exp = claims.exp as number;
    const issued = claims.iat as number;
    if (
      exp - issued > REQUEST_OBJECT_MAX_AGE_SEC ||
      exp > epochSeconds(this.#now) + REQUEST_OBJECT_MAX_AGE_SEC +
          CLOCK_SKEW_SEC
    ) {
      return refuse("the request object lives too long");
    }
    if (typeof claims.jti !== "string" || claims.jti === "") {
      return refuse("the request object has no jti");
    }
    const once = `request-object:${await sha256(
      `${client.client_id}\n${claims.jti}`,
    )}`;
    if (!(await this.#store.create(once, 1, (exp + CLOCK_SKEW_SEC) * 1000))) {
      return refuse("the request object was used before");
    }
    const target = new URL(this.server.endpoint("authorization"));
    const skip = new Set(["iss", "aud", "exp", "iat", "nbf", "jti"]);
    for (const [name, value] of Object.entries(claims)) {
      if (skip.has(name) || value === null || value === undefined) continue;
      if (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      ) {
        for (const item of value) target.searchParams.append(name, item);
      } else if (typeof value === "object") {
        target.searchParams.set(name, JSON.stringify(value));
      } else {
        target.searchParams.set(name, String(value));
      }
    }
    target.searchParams.set("client_id", client.client_id);
    const repeatedInObject = repeatedParameter(target.searchParams);
    if (repeatedInObject !== null) {
      return refuse(`${repeatedInObject} must be a single value`);
    }
    const headers = new Headers(request.headers);
    headers.delete("content-type");
    headers.delete("content-length");
    return await this.server.authorize(
      new Request(target.href, { method: "GET", headers }),
    );
  }

  /** A fresh opaque value, for hosts that need a login session id. */
  static newSessionId(): string {
    return randomToken(24);
  }
}

/**
 * The form of a POST (urlencoded, at most the server's own cap), read
 * from a copy so the server can read it again; null when it is not a
 * readable form.
 */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) return null;
  try {
    return new URLSearchParams(
      await readTextBounded(request.clone(), { maxBytes: FORM_MAX_BYTES }),
    );
  } catch {
    return null;
  }
}

/**
 * The `sessionSidKey` of `@celld/sec/oidc/testing`'s `testProvider`. It is
 * public, so {@link OpenIdProvider} refuses it unless `testProvider`
 * handed it over (as one of {@link testSidKeys}).
 */
export const TEST_SESSION_SID_KEY =
  "celld-oidc-testing-session-sid-key-not-secret";

/** Package-internal: the key instances `testProvider` made, the only way {@link TEST_SESSION_SID_KEY} is accepted. */
export const testSidKeys: WeakSet<Uint8Array> = new WeakSet();

/**
 * The HMAC key for `sid`s; throws `TypeError` below 32 bytes, for a
 * plainly non-random key, and for the public test key outside
 * `testProvider`.
 */
function sessionSidKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const bytes = secretBytes(secret, "sessionSidKey");
  const test = encoder.encode(TEST_SESSION_SID_KEY);
  if (
    bytes.length === test.length && bytes.every((b, i) => b === test[i]) &&
    !(secret instanceof Uint8Array && testSidKeys.has(secret))
  ) {
    throw new TypeError(
      "sessionSidKey is the public TEST_SESSION_SID_KEY, for testProvider only",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
