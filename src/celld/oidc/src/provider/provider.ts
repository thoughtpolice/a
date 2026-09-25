// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link OpenIdProvider}: an OpenID Provider made of `@celld/oauth`'s
 * `AuthorizationServer` and what OpenID Connect adds to it.
 *
 * ```ts
 * const op = new OpenIdProvider({
 *   issuer: "https://login.example.com",
 *   keys: [await generateSigningKey("ES256")],
 *   store: durableRecordStore(env.OAUTH_RECORDS),
 *   clients: [{ client_id: "web", redirect_uris: ["https://app.example.com/cb"],
 *               post_logout_redirect_uris: ["https://app.example.com/"] }],
 *   interaction: async (context) => {
 *     const session = await mySession(context.request);
 *     if (session === null || context.needsLogin(session.authTime)) {
 *       if (context.prompt.includes("none")) return { deny: { error: "login_required" } };
 *       return Response.redirect(`/login?i=${context.interactionId}`, 303);
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
 *   so a host that forgets one gets an error, not a silent pass;
 * - ID tokens in token responses for `openid` grants: `iss`, `sub`, `aud`,
 *   `exp`, `iat`, `auth_time`, `nonce` (not on refresh), `acr`, `amr`,
 *   `at_hash`, `sid`, and the claims the `claims` parameter asks for;
 * - UserInfo, a protected resource that takes Bearer and DPoP tokens,
 *   sees revocations, and answers the scopes' claims (`profile`, `email`,
 *   `address`, `phone`) plus requested ones, from the host's `claims`
 *   hook;
 * - RP-Initiated Logout at `end_session`, which ends the login session
 *   (`sid`): its refresh tokens then get no more ID tokens and its access
 *   tokens no more UserInfo;
 * - signed request objects (`request`, RFC 9101) at the authorization
 *   endpoint when `requestObjects` is on.
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
} from "@celld/oauth";
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
} from "@celld/oauth/server";
import { DEFAULT_DPOP_ALGORITHMS } from "@celld/oauth/dpop";
import {
  type AccessTokenVerifier,
  ResourceServer,
} from "@celld/oauth/resource";
import {
  type JwsAlgorithm,
  type KeySet,
  localJwks,
  RemoteJwks,
  sign,
  tryDecode,
  verify,
} from "@celld/jwt";
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
  defaultClock,
  epochSeconds,
  isObject,
  jsonResponse,
  NO_STORE,
  redirectResponse,
  rethrowRuntimeUnsupported,
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
 * answer nothing to let the provider finish, or answer a `Response` (a
 * confirmation page that posts back here once the user agrees).
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
  /** ID token and access token signing keys; the first signs unless a client registered another `alg`. */
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
  /** How long a login session's record lasts; default 30 days. */
  readonly sessionTtlSec?: number;
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

const ASYMMETRIC: readonly JwsAlgorithm[] = [
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

const CLOCK_SKEW_SEC = 10;

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

  /** Throws `TypeError` for a bad issuer, no keys, or a bad client. */
  constructor(options: OpenIdProviderOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#now = options.now ?? defaultClock;
    const base = options.issuer.replace(/\/+$/, "");
    this.userinfoEndpoint = `${base}${
      options.oidcPaths?.userinfo ?? "/userinfo"
    }`;
    this.endSessionEndpoint = `${base}${
      options.oidcPaths?.endSession ?? "/end_session"
    }`;
    this.issuer = options.issuer;
    this.#ownKeys = localJwks(publicJwks(options.keys));
    const allowed = options.resources?.allowed;
    const userinfo = this.userinfoEndpoint;
    this.server = new AuthorizationServer({
      ...options,
      scopesSupported: [
        ...new Set([...DEFAULT_SCOPES, ...(options.scopesSupported ?? [])]),
      ],
      resources: {
        allowed: allowed === undefined
          ? undefined
          : typeof allowed === "function"
          ? (resource, client) =>
            resource === userinfo || allowed(resource, client)
          : [...allowed, userinfo],
        default: options.resources?.default ?? [userinfo],
      },
      metadata: this.#oidcMembers(),
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
    return await this.server.handle(request);
  }

  // Interaction.

  async #verifyOwnIdToken(token: string): Promise<IdTokenClaims | null> {
    const decoded = tryDecode(token);
    const iat = decoded?.payload.iat;
    if (typeof iat !== "number") return null;
    try {
      // A hint may have expired; it is checked as of when it was issued.
      const { payload } = await verify(token, this.#ownKeys, {
        algorithms: [...new Set(this.#options.keys.map((key) => key.alg))],
        issuer: this.issuer,
        requiredClaims: ["sub", "aud", "iat"],
        now: iat * 1000,
      });
      return payload as IdTokenClaims;
    } catch (cause) {
      rethrowRuntimeUnsupported(cause);
      return null;
    }
  }

  async #oidcParams(
    params: Readonly<Record<string, string>>,
  ): Promise<OidcParams> {
    const prompt = (params.prompt ?? "").split(" ").filter((item) =>
      PROMPTS.has(item)
    );
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
      } catch (error) {
        throw new Refusal("invalid_request", (error as Error).message);
      }
    }
    let idTokenHint: IdTokenClaims | undefined;
    if (params.id_token_hint !== undefined) {
      const hint = await this.#verifyOwnIdToken(params.id_token_hint);
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
    let oidc: OidcParams;
    try {
      oidc = await this.#oidcParams(context.params);
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
    if (grant.acr !== undefined) claims.acr = grant.acr;
    if (grant.amr !== undefined) claims.amr = [...grant.amr];
    if (grant.sessionId !== undefined) {
      const sid = await this.sessionSid(grant.sessionId);
      const key = `oidc-session:${sid}`;
      const existing = await this.#store.get<SessionRecord>(key);
      if (existing?.value.ended) {
        return refuse("login_required", "that login session has ended");
      }
      if (existing === null) {
        await this.#store.create<SessionRecord>(
          key,
          { subject: grant.subject, ended: false },
          this.#now() + (this.#options.sessionTtlSec ?? 30 * 86400) * 1000,
        );
      }
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

  /** The `sid` of a host login session id: a hash, so the id itself is never disclosed. */
  async sessionSid(sessionId: string): Promise<string> {
    return (await sha256(`${this.issuer}\n${sessionId}`)).slice(0, 32);
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
      oidc = await this.#oidcParams(pending.params);
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
      const oidc = await this.#oidcParams(pending.params);
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

  #signingKey(client: RegisteredClient): SigningKey {
    const wanted = client.id_token_signed_response_alg;
    return (typeof wanted === "string"
      ? this.#options.keys.find((key) => key.alg === wanted)
      : undefined) ?? this.#options.keys[0];
  }

  async #hostClaims(
    subject: string,
    names: readonly string[],
    client: RegisteredClient | null,
    scope: readonly string[],
    purpose: "id_token" | "userinfo",
  ): Promise<Record<string, unknown>> {
    if (names.length === 0) return {};
    const answer = await this.#options.claims({
      subject,
      claims: names,
      client,
      scope,
      purpose,
    });
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (ID_TOKEN_PROTOCOL_CLAIMS.has(name)) continue;
      if (Object.hasOwn(answer, name) && answer[name] !== undefined) {
        out[name] = answer[name];
      }
    }
    return out;
  }

  async #idToken(
    grant: IssuedGrant,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    if (!grant.scope.includes(OPENID_SCOPE)) return {};
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
  async endLoginSession(sessionId: string): Promise<void> {
    await this.#endSid(await this.sessionSid(sessionId));
  }

  async #endSid(sid: string): Promise<void> {
    const key = `oidc-session:${sid}`;
    for (let attempt = 0; attempt < 5; attempt++) {
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
  }

  /**
   * The end session endpoint (OpenID Connect RP-Initiated Logout 1.0):
   * GET or POST with `id_token_hint` (this provider's, expired or not),
   * `client_id`, `post_logout_redirect_uri` (which must be registered for
   * the client), `state` and `logout_hint`. After the host's hook, the
   * hinted session ends and the browser goes back to the client, or gets
   * a plain page. Anything invalid is a plain 400: logout never redirects
   * somewhere unregistered.
   */
  async endSession(request: Request): Promise<Response> {
    let params: URLSearchParams;
    if (request.method === "GET") {
      params = new URL(request.url).searchParams;
    } else if (request.method === "POST") {
      const type = request.headers.get("content-type") ?? "";
      if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
        return textResponse(400, "invalid_request: the body must be a form");
      }
      params = new URLSearchParams(await request.clone().text());
    } else {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }
    const one = (name: string) => {
      const values = params.getAll(name);
      if (values.length > 1) {
        throw new Refusal("invalid_request", `${name} is repeated`);
      }
      return values[0];
    };
    try {
      const hintText = one("id_token_hint");
      let hint: IdTokenClaims | null = null;
      if (hintText !== undefined) {
        hint = await this.#verifyOwnIdToken(hintText);
        if (hint === null) {
          throw new Refusal("invalid_request", "id_token_hint is not valid");
        }
      }
      let clientId = one("client_id");
      if (hint !== null) {
        const aud = audiences(hint.aud);
        if (clientId !== undefined && !aud.includes(clientId)) {
          throw new Refusal(
            "invalid_request",
            "client_id is not the id_token_hint's audience",
          );
        }
        clientId ??= typeof hint.azp === "string" ? hint.azp : aud[0];
      }
      const client = clientId === undefined
        ? null
        : await this.server.client(clientId);
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
      if (sid !== undefined) await this.#endSid(sid);
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

  #clientKeys(client: RegisteredClient): KeySet | null {
    if (client.jwks !== undefined) return localJwks(client.jwks);
    if (client.jwks_uri === undefined) return null;
    let keys = this.#clientKeySets.get(client.jwks_uri);
    if (keys === undefined) {
      keys = new RemoteJwks(client.jwks_uri, {
        fetch: this.#options.fetch,
        now: this.#now,
        allowInsecure: true,
      });
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
    if (
      !this.#options.requestObjects ||
      (request.method !== "GET" && request.method !== "POST")
    ) {
      return await this.server.authorize(request);
    }
    const form = request.method === "GET"
      ? new URL(request.url).searchParams
      : new URLSearchParams(await request.clone().text());
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
        algorithms: ASYMMETRIC,
        issuer: client.client_id,
        audience: this.issuer,
        requiredClaims: ["exp", "jti"],
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
    const issued = typeof claims.iat === "number"
      ? claims.iat
      : epochSeconds(this.#now);
    if (exp - issued > 3600) return refuse("the request object lives too long");
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
