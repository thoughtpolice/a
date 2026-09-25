// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link OidcClient}: an OpenID Connect relying party at one provider.
 * It drives `@celld/sec/oauth`'s `OAuthClient` for the protocol (PKCE, `state`,
 * RFC 9207 `iss`, PAR, DPoP with nonces and `dpop_jkt`), and adds what
 * OpenID Connect needs on top:
 *
 * - discovery of the OpenID configuration, with its required members;
 * - a `nonce` per login, and `prompt`, `max_age`, `acr_values`,
 *   `login_hint`, `id_token_hint` and `claims` in the request;
 * - full ID token validation ({@link validateIdToken}) after the code is
 *   redeemed, and again, against the first one, after a refresh;
 * - UserInfo, as Bearer or DPoP (with the endpoint's nonces), refusing an
 *   answer about another `sub`;
 * - resource calls bound to what the tokens are for
 *   ({@link OidcClient.resourceFetch}): the discovered `userinfo_endpoint`
 *   and the configured `resources`, https, no redirects;
 * - an ID token algorithm policy: `idTokenAlgorithms`, the registered
 *   `idTokenSignedResponseAlg` and the provider's
 *   `id_token_signing_alg_values_supported`, intersected once at
 *   construction or discovery; an empty result is a configuration error;
 * - RP-Initiated Logout URLs.
 *
 * Discovery and the provider's JWKS are fetched under `@celld/sec/oauth`'s
 * egress policy (https, public addresses, no redirects, bounded);
 * `allowLoopbackForDevelopment` allows `http:` to a loopback IP literal.
 *
 * ```ts
 * const rp = new OidcClient({
 *   issuer: "https://login.example.com",
 *   client: { method: "none", clientId: "web" },
 *   redirectUri: "https://app.example.com/callback",
 *   dpop: await DpopKey.generate(),
 * });
 * const pending = await rp.authorizationUrl({ scope: ["profile", "email"], maxAge: 3600 });
 * // redirect to pending.url; keep pending (sealed) until the callback
 * const login = await rp.completeLogin(pending, callbackUrl);
 * const profile = await rp.userinfo(login.tokens, login.subject);
 * ```
 *
 * @module
 */

import {
  type Clock,
  type EgressOptions,
  egressUrlProblem,
  endpointEgressPolicy,
  type FetchLike,
  formatScope,
  isLoopbackLiteral,
  OAuthError,
  randomToken,
  resourceChallenge,
  resourceCovers,
} from "@celld/sec/oauth";
import {
  assertAuthorizedGrant,
  type AuthorizedGrant,
  type ClientAuthentication,
  OAuthClient,
  type PendingAuthorization,
  type TokenSet,
} from "@celld/sec/oauth/client";
import {
  checkDpopAlgorithm,
  type DpopKey,
  DpopNonceCache,
} from "@celld/sec/oauth/dpop";
import {
  createVerifier,
  isJwsAlgorithm,
  type JwsAlgorithm,
  type JwtVerifier,
  type KeySet,
  RemoteJwks,
} from "@celld/sec/jwt";
import {
  type ClaimsRequest,
  type IdTokenClaims,
  OPENID_SCOPE,
  requestedAcrValues,
} from "../claims.ts";
import { IdTokenError } from "../errors.ts";
import {
  BoundsError,
  type JsonLimits,
  jsonSnapshot,
  parseJsonBounded,
  readTextBounded,
  strictRecord,
} from "@celld/core/bounds";
import { boundedFetch } from "@celld/http/egress";
import {
  checkOpenIdProviderMetadata,
  discoverOpenIdProvider,
  type OpenIdProviderMetadata,
} from "../metadata.ts";
import {
  defaultClock,
  defaultFetch,
  isMediaType,
  isObject,
  rethrowRuntimeUnsupported,
  snapshotOptions,
} from "../util.ts";
import {
  createIdTokenValidator,
  DEFAULT_ID_TOKEN_ALGORITHMS,
} from "./validate.ts";

/** Options for {@link OidcClient}. */
export interface OidcClientOptions extends EgressOptions {
  /** Absolute expiry of a federation/policy generation, epoch milliseconds. */
  readonly validUntil?: number;
  /** Exact registered signed UserInfo algorithm; absent means JSON only. */
  readonly userinfoSignedResponseAlg?: JwsAlgorithm;
  /** The provider's issuer identifier. */
  readonly issuer: string;
  /** Its metadata when already known (from a trust chain, say); otherwise discovered. */
  readonly metadata?: OpenIdProviderMetadata;
  readonly client: ClientAuthentication;
  readonly redirectUri: string;
  /** Binds tokens to this key with DPoP (RFC 9449). */
  readonly dpop?: DpopKey;
  /** Accept a Bearer token when a DPoP proof was sent; default false. */
  readonly allowBearerFallback?: boolean;
  /** Pushed authorization requests; see `OAuthClient`. Default `auto`. */
  readonly par?: "auto" | "always" | "never";
  /**
   * The ID token algorithms this relying party accepts; default
   * {@link DEFAULT_ID_TOKEN_ALGORITHMS}. HMAC and `none` are never
   * accepted. The policy used is this list, narrowed to
   * `idTokenSignedResponseAlg` when the client registered one, and to the
   * provider's `id_token_signing_alg_values_supported`; see
   * {@link OidcClient}.
   */
  readonly idTokenAlgorithms?: readonly JwsAlgorithm[];
  /**
   * The `id_token_signed_response_alg` this client registered (from its
   * client information or registration response): ID tokens must use
   * exactly it. Absent when the client registered none.
   */
  readonly idTokenSignedResponseAlg?: JwsAlgorithm;
  /**
   * Protected resources (RFC 8707 identifiers) this client's tokens may be
   * sent to by {@link OidcClient.resourceFetch}, besides the provider's
   * `userinfo_endpoint`: a URL is covered when it has the same origin and
   * its path is the resource's or under it. Each must be https (or, with
   * `allowLoopbackForDevelopment`, http to a loopback IP literal).
   */
  readonly resources?: readonly string[];
  /** The provider's keys; default a `RemoteJwks` on `jwks_uri`. */
  readonly keys?: KeySet;
  /**
   * When a login names resources, add the UserInfo endpoint to them so
   * the access token also works there; default true.
   */
  readonly userinfoResource?: boolean;
  /** Seconds of clock skew in ID token checks; default 30. */
  readonly clockToleranceSec?: number;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/** The `prompt` values of OpenID Connect Core section 3.1.2.1. */
export type Prompt = "none" | "login" | "consent" | "select_account" | "create";

/** What {@link OidcClient.authorizationUrl} is asked for. */
export interface LoginOptions {
  /** Scopes besides `openid`, which is always sent. */
  readonly scope?: readonly string[];
  readonly prompt?: Prompt | readonly Prompt[];
  /** Seconds: the user must have authenticated at most this long ago. */
  readonly maxAge?: number;
  /** Acceptable authentication context classes, most preferred first. */
  readonly acrValues?: readonly string[];
  readonly loginHint?: string;
  /** A previous ID token, as a hint of who is expected. */
  readonly idTokenHint?: AuthorizedGrant;
  /** The `claims` request parameter. */
  readonly claims?: ClaimsRequest;
  readonly uiLocales?: readonly string[];
  /** RFC 8707 resources for the access token. */
  readonly resource?: string | readonly string[];
  readonly state?: string;
  /** More parameters. */
  readonly extra?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * A started login, as plain data to keep privately until the callback
 * (it holds the PKCE verifier); `LoginFlow` keeps it in a sealed cookie.
 */
export interface PendingLogin {
  readonly authorization: PendingAuthorization;
  readonly nonce: string;
  readonly maxAge?: number;
  /** The `acr` values that must be met (an essential `acr` claim request). */
  readonly requiredAcr?: readonly string[];
  /** Whether `auth_time` was asked for as a claim. */
  readonly requireAuthTime?: boolean;
}

/** A finished login. */
export interface Login {
  readonly tokens: AuthorizedGrant;
  /** The ID token, validated. */
  readonly idToken: string;
  readonly claims: IdTokenClaims;
  /** `claims.sub`. */
  readonly subject: string;
}

/** The largest UserInfo answer read, JSON or JWT: 256 KiB. */
const USERINFO_MAX_BYTES = 256 * 1024;

/** How deep and wide a UserInfo JSON answer may be. */
const USERINFO_JSON: JsonLimits = {
  maxDepth: 16,
  maxKeys: 1000,
  maxItems: 1000,
};

/**
 * A UserInfo answer's body, read under {@link USERINFO_MAX_BYTES}: a
 * larger one (or one that fails while read) is the `OAuthError` `token`.
 */
async function readUserInfo(
  response: Response,
  issuer: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    return await readTextBounded(response, {
      maxBytes: USERINFO_MAX_BYTES,
      signal,
    });
  } catch (cause) {
    throw new OAuthError(
      "token",
      cause instanceof BoundsError && cause.code === "too_large"
        ? `UserInfo answered more than ${USERINFO_MAX_BYTES} bytes`
        : "UserInfo's answer could not be read",
      { issuer, cause },
    );
  }
}

/** An OpenID Connect relying party at one provider; see the module documentation. */
export class OidcClient {
  readonly issuer: string;
  readonly #options: OidcClientOptions;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #nonces = new DpopNonceCache();
  #metadata: Promise<OpenIdProviderMetadata> | null = null;
  #oauth: OAuthClient | null = null;
  #keys: KeySet | null = null;
  #validator: ReturnType<typeof createIdTokenValidator> | null = null;
  #userinfoValidator: JwtVerifier | null = null;
  /** The client's own policy: `idTokenAlgorithms` narrowed to the registered one. */
  readonly #ownAlgorithms: readonly JwsAlgorithm[];
  /** The policy after the provider's metadata, once known. */
  #idTokenAlgorithms: readonly JwsAlgorithm[] | null = null;
  readonly #resources: readonly string[];
  readonly #pending = new WeakSet<object>();

  /**
   * Throws `TypeError` for metadata about another issuer, an ID token
   * algorithm policy that is empty (after the registered algorithm and,
   * when `metadata` is given, the provider's), or a resource that is not
   * an absolute https URL without user information or fragment.
   */
  constructor(input: OidcClientOptions) {
    strictRecord(input, [
      "issuer",
      "metadata",
      "client",
      "redirectUri",
      "dpop",
      "allowBearerFallback",
      "par",
      "idTokenAlgorithms",
      "idTokenSignedResponseAlg",
      "userinfoSignedResponseAlg",
      "resources",
      "keys",
      "userinfoResource",
      "clockToleranceSec",
      "fetch",
      "now",
      "egress",
      "allowLoopbackForDevelopment",
      "validUntil",
    ], "OidcClient options");
    // Read once: `resources`, `allowLoopbackForDevelopment`, `egress` and
    // the algorithm policy decide where tokens go and what is trusted, so
    // changing the caller's object afterwards changes nothing.
    const options = snapshotOptions(input);
    for (
      const alg of [
        ...(options.idTokenAlgorithms ?? DEFAULT_ID_TOKEN_ALGORITHMS),
        ...(options.userinfoSignedResponseAlg === undefined
          ? []
          : [options.userinfoSignedResponseAlg]),
      ]
    ) {
      if (!isJwsAlgorithm(alg) || alg.startsWith("HS")) {
        throw new TypeError(
          "OIDC algorithms must be supported asymmetric JWS algorithms",
        );
      }
    }
    this.issuer = options.issuer;
    this.#options = options;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? defaultClock;
    const accepted = (options.idTokenAlgorithms ?? DEFAULT_ID_TOKEN_ALGORITHMS)
      .filter((alg) => !alg.startsWith("HS") && alg !== ("none" as string));
    const registered = options.idTokenSignedResponseAlg;
    this.#ownAlgorithms = registered === undefined
      ? accepted
      : accepted.filter((alg) => alg === registered);
    if (this.#ownAlgorithms.length === 0) {
      throw new TypeError(
        registered === undefined
          ? "idTokenAlgorithms accepts no asymmetric algorithm"
          : `the registered id_token_signed_response_alg ${registered} is not among idTokenAlgorithms`,
      );
    }
    this.#resources = (options.resources ?? []).map((resource) => {
      const problem = this.#urlProblem(resource);
      if (problem !== null) {
        throw new TypeError(`resource ${resource}: ${problem}`);
      }
      return resource;
    });
    if (options.metadata !== undefined) {
      const checked = checkOpenIdProviderMetadata(
        options.metadata,
        options.issuer,
      );
      if (typeof checked === "string") throw new TypeError(checked);
      const problem = this.#settle(checked);
      if (problem !== null) throw new TypeError(problem);
      this.#metadata = Promise.resolve(checked);
    }
    this.#keys = options.keys ?? null;
    Object.freeze(this);
  }

  /**
   * Intersects the client's algorithm policy with what the provider says
   * it signs ID tokens with; the reason it is empty, or null.
   */
  #settle(metadata: OpenIdProviderMetadata): string | null {
    for (const [name, endpoint] of Object.entries(metadata)) {
      if (
        (name.endsWith("_endpoint") || name === "jwks_uri") &&
        typeof endpoint === "string"
      ) {
        const problem = egressUrlProblem(
          endpoint,
          endpointEgressPolicy(this.#options),
        );
        if (problem !== null) return `${name} is outside the endpoint policy`;
      }
    }
    const userinfoAlg = this.#options.userinfoSignedResponseAlg;
    if (
      userinfoAlg !== undefined &&
      (userinfoAlg.startsWith("HS") ||
        !metadata.userinfo_signing_alg_values_supported?.includes(userinfoAlg))
    ) return "registered UserInfo algorithm is unsupported";
    const offered = metadata.id_token_signing_alg_values_supported;
    const policy = this.#ownAlgorithms.filter((alg) => offered.includes(alg));
    if (policy.length === 0) {
      return `${this.issuer} signs ID tokens with ${
        offered.join(", ") || "nothing"
      }, and this client accepts only ${this.#ownAlgorithms.join(", ")}`;
    }
    this.#idTokenAlgorithms = policy;
    return null;
  }

  /** Why `input` is no URL tokens may go to at all, or null. */
  #urlProblem(input: string | URL): string | null {
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      return "it is not an absolute URL";
    }
    if (url.username !== "" || url.password !== "") {
      return "it carries user information";
    }
    if (url.hash !== "" || String(input).includes("#")) {
      return "it has a fragment";
    }
    const loopback = this.#options.allowLoopbackForDevelopment === true &&
      url.protocol === "http:" && isLoopbackLiteral(url.hostname);
    if (url.protocol !== "https:" && !loopback) return "it is not https";
    return null;
  }

  /** The client id. */
  get clientId(): string {
    return this.#options.client.clientId;
  }

  /** The DPoP key, if any. */
  get dpop(): DpopKey | undefined {
    return this.#options.dpop;
  }

  /** The provider's metadata, discovered once. */
  async metadata(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<OpenIdProviderMetadata> {
    if (
      this.#options.validUntil !== undefined &&
      (!Number.isFinite(this.#options.validUntil) ||
        this.#now() >= this.#options.validUntil)
    ) {
      throw new OAuthError(
        "discovery",
        "the client policy generation has expired",
      );
    }
    this.#metadata ??= discoverOpenIdProvider(this.issuer, {
      fetch: this.#fetch,
      signal: options.signal,
      ...(this.#options.egress === undefined
        ? {}
        : { egress: this.#options.egress }),
      ...(this.#options.allowLoopbackForDevelopment === undefined ? {} : {
        allowLoopbackForDevelopment: this.#options.allowLoopbackForDevelopment,
      }),
    }).then((metadata) => {
      const problem = this.#settle(metadata);
      if (problem !== null) {
        throw new OAuthError("discovery", problem, { issuer: this.issuer });
      }
      return metadata;
    });
    try {
      return await this.#metadata;
    } catch (error) {
      this.#metadata = null;
      throw error;
    }
  }

  /** The `OAuthClient` underneath, for the grants OpenID Connect adds nothing to. */
  async oauth(): Promise<OAuthClient> {
    if (this.#oauth !== null) return this.#oauth;
    const metadata = await this.metadata();
    this.#oauth = new OAuthClient({
      issuer: this.issuer,
      metadata,
      client: this.#options.client,
      redirectUri: this.#options.redirectUri,
      dpop: this.#options.dpop,
      allowBearerFallback: this.#options.allowBearerFallback,
      par: this.#options.par,
      fetch: this.#fetch,
      now: this.#now,
      ...(this.#options.egress === undefined
        ? {}
        : { egress: this.#options.egress }),
      ...(this.#options.allowLoopbackForDevelopment === undefined ? {} : {
        allowLoopbackForDevelopment: this.#options.allowLoopbackForDevelopment,
      }),
    });
    return this.#oauth;
  }

  async #keySet(): Promise<KeySet> {
    if (this.#keys !== null) return this.#keys;
    const metadata = await this.metadata();
    this.#keys = new RemoteJwks(metadata.jwks_uri, {
      fetch: this.#fetch,
      now: this.#now,
      ...(this.#options.egress === undefined
        ? {}
        : { egress: this.#options.egress }),
      allowLoopbackForDevelopment:
        this.#options.allowLoopbackForDevelopment === true,
    });
    return this.#keys;
  }

  /** The ID token algorithm policy, settled against the provider's metadata. */
  async #algorithms(): Promise<readonly JwsAlgorithm[]> {
    await this.metadata();
    return this.#idTokenAlgorithms!;
  }

  async #idTokenValidator(): Promise<
    ReturnType<typeof createIdTokenValidator>
  > {
    this.#validator ??= createIdTokenValidator({
      issuer: this.issuer,
      clientId: this.clientId,
      keys: await this.#keySet(),
      algorithms: await this.#algorithms(),
      now: this.#now,
      clockToleranceSec: this.#options.clockToleranceSec,
    });
    return this.#validator;
  }

  /** Discover metadata, enforce trust expiry and probe configured cryptography. */
  async ready(): Promise<void> {
    await this.metadata();
    await (await this.oauth()).ready();
    await (await this.#idTokenValidator()).ready();
  }

  /**
   * The algorithms a signed UserInfo answer may use: `idTokenAlgorithms`
   * (UserInfo has its own `userinfo_signed_response_alg`), never HMAC.
   */
  #userinfoAlgorithms(): JwsAlgorithm[] {
    const alg = this.#options.userinfoSignedResponseAlg;
    if (alg === undefined) {
      throw new OAuthError("token", "unexpected signed UserInfo response");
    }
    return [alg];
  }

  /**
   * Starts a login: the authorization request with `openid`, a fresh
   * `nonce` and the OpenID parameters asked for, pushed when the provider
   * has PAR. JSON options are copied before awaiting (64 KiB, 4096 values,
   * depth 32); accessors are refused. Keep the result for {@link completeLogin}.
   */
  async authorizationUrl(options: LoginOptions = {}): Promise<PendingLogin> {
    strictRecord(options as unknown, [
      "scope",
      "resource",
      "state",
      "prompt",
      "maxAge",
      "acrValues",
      "loginHint",
      "idTokenHint",
      "claims",
      "uiLocales",
      "extra",
      "signal",
    ], "login options");
    const { idTokenHint, signal, ...data } = options;
    options = {
      ...jsonSnapshot(Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
      )),
      idTokenHint,
      signal,
    };
    for (const name of Object.keys(options.extra ?? {})) {
      if (
        [
          "nonce",
          "prompt",
          "max_age",
          "acr_values",
          "login_hint",
          "id_token_hint",
          "claims",
          "ui_locales",
        ].includes(name)
      ) {
        throw new TypeError(
          "use the named OIDC option for protocol parameters",
        );
      }
    }
    const metadata = await this.metadata({ signal: options.signal });
    const oauth: OAuthClient = await this.oauth();
    const nonce = randomToken(16);
    const prompt = typeof options.prompt === "string"
      ? [options.prompt]
      : [...(options.prompt ?? [])];
    if (prompt.includes("none") && prompt.length > 1) {
      throw new TypeError("prompt none cannot be combined with other values");
    }
    const extra: Record<string, string> = { ...options.extra, nonce };
    if (prompt.length > 0) extra.prompt = prompt.join(" ");
    if (options.maxAge !== undefined) {
      if (!Number.isInteger(options.maxAge) || options.maxAge < 0) {
        throw new TypeError("maxAge must be a non-negative integer");
      }
      extra.max_age = String(options.maxAge);
    }
    if (options.acrValues !== undefined && options.acrValues.length > 0) {
      extra.acr_values = options.acrValues.join(" ");
    }
    if (options.loginHint !== undefined) extra.login_hint = options.loginHint;
    if (idTokenHint !== undefined) {
      await oauth.validateGrant(idTokenHint);
      if (idTokenHint.id_token === undefined) {
        throw new TypeError("the grant has no ID token hint");
      }
      extra.id_token_hint = idTokenHint.id_token;
    }
    if (options.claims !== undefined) {
      extra.claims = JSON.stringify(options.claims);
    }
    if (options.uiLocales !== undefined && options.uiLocales.length > 0) {
      extra.ui_locales = options.uiLocales.join(" ");
    }
    const scope = [
      OPENID_SCOPE,
      ...(options.scope ?? []).filter((item) => item !== OPENID_SCOPE),
    ];
    let resource = options.resource === undefined
      ? []
      : typeof options.resource === "string"
      ? [options.resource]
      : [...options.resource];
    const userinfo = metadata.userinfo_endpoint;
    if (
      resource.length > 0 && userinfo !== undefined &&
      (this.#options.userinfoResource ?? true) && !resource.includes(userinfo)
    ) {
      resource = [...resource, userinfo];
    }
    const authorization = await oauth.authorizationUrl({
      scope,
      ...(resource.length === 0 ? {} : { resource }),
      ...(options.state === undefined ? {} : { state: options.state }),
      extra,
      signal: options.signal,
    });
    const acr = requestedAcrValues(options.claims, undefined);
    const authTimeRequested = options.claims?.id_token?.auth_time !== undefined;
    const pending = Object.freeze({
      authorization,
      nonce,
      ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
      ...(acr.essential ? { requiredAcr: acr.values } : {}),
      ...(authTimeRequested ? { requireAuthTime: true } : {}),
    });
    this.#pending.add(pending);
    return pending;
  }

  /** Restore a pending login only after authenticating its cookie/store envelope. */
  async unsafeRestorePendingLogin(value: unknown): Promise<PendingLogin> {
    const pending = jsonSnapshot(value, {
      maxDepth: 8,
      maxItems: 256,
      maxBytes: 8192,
    }) as PendingLogin;
    if (
      !isObject(pending) || typeof pending.nonce !== "string" ||
      pending.nonce.length < 16 || pending.nonce.length > 256 ||
      pending.maxAge !== undefined &&
        (!Number.isSafeInteger(pending.maxAge) || pending.maxAge < 0) ||
      pending.requireAuthTime !== undefined &&
        typeof pending.requireAuthTime !== "boolean" ||
      pending.requiredAcr !== undefined &&
        (!Array.isArray(pending.requiredAcr) ||
          pending.requiredAcr.length > 64 ||
          !pending.requiredAcr.every((value) =>
            typeof value === "string" && value.length <= 256
          ))
    ) throw new OAuthError("state_mismatch", "invalid stored pending login");
    const oauth = await this.oauth();
    const restored = Object.freeze({
      ...pending,
      authorization: oauth.unsafeRestorePending(pending.authorization),
    });
    this.#pending.add(restored);
    return restored;
  }

  /**
   * Finishes a login from the URL the user came back to: the
   * authorization response checks (`iss`, `state`, `error`), the code
   * redeemed with the PKCE verifier (and a DPoP proof), and the ID token
   * validated against the `nonce`, `max_age`, `acr` and access token.
   */
  async completeLogin(
    pending: PendingLogin,
    callback: string | URL,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Login> {
    if (!isObject(pending) || !this.#pending.has(pending)) {
      throw new OAuthError(
        "state_mismatch",
        "pending login belongs to another client or was not authenticated",
      );
    }
    this.#pending.delete(pending);
    const oauth = await this.oauth();
    const code = oauth.checkAuthorizationResponse(
      pending.authorization,
      callback,
    );
    const tokens = await oauth.completeAuthorization(
      pending.authorization,
      callback,
      options,
    );
    const idToken = tokens.id_token;
    if (idToken === undefined) {
      throw new OAuthError(
        "token",
        "the token response has no id_token, though openid was asked for",
        { issuer: this.issuer },
      );
    }
    const claims = await (await this.#idTokenValidator()).validate(idToken, {
      nonce: pending.nonce,
      maxAge: pending.maxAge,
      requireAuthTime: pending.requireAuthTime,
      acrValues: pending.requiredAcr,
      accessToken: tokens.access_token,
      code,
    });
    return { tokens, idToken, claims, subject: claims.sub };
  }

  /**
   * Refreshes the tokens. A new ID token, if the provider sends one, must
   * be about the same user from the same authentication (OpenID Connect
   * Core section 12.2): same `iss`, `sub` and `aud`, `auth_time`
   * unchanged, and no `nonce` or the original authentication's unchanged
   * (`previous.nonce`; any other would mean a replayed login token).
   */
  async refresh(
    refreshToken: AuthorizedGrant,
    previous: IdTokenClaims,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    { readonly tokens: AuthorizedGrant; readonly claims?: IdTokenClaims }
  > {
    if (
      previous.iss !== this.issuer ||
      (typeof previous.aud === "string"
        ? previous.aud !== this.clientId
        : !Array.isArray(previous.aud) || !previous.aud.includes(this.clientId))
    ) {
      throw new IdTokenError(
        "iss",
        "previous ID token belongs to another client or issuer",
      );
    }
    const oauth = await this.oauth();
    const tokens = await oauth.refresh(refreshToken, options);
    if (tokens.id_token === undefined) return { tokens };
    const claims = await (await this.#idTokenValidator()).validate(
      tokens.id_token,
      {
        subject: previous.sub,
        ...(typeof previous.nonce === "string"
          ? { originalNonce: previous.nonce }
          : { forbidNonce: true }),
        ...(previous.auth_time === undefined
          ? {}
          : { authTime: previous.auth_time }),
        accessToken: tokens.access_token,
      },
    );
    return { tokens, claims };
  }

  /**
   * The UserInfo claims for `tokens` (section 5.3): Bearer, or DPoP with a
   * proof bound to the token (retrying once with the endpoint's nonce). A
   * signed answer (`application/jwt`) is verified with the provider's
   * keys. The answer's `sub` must be `subject`, or it is refused: a token
   * swapped for someone else's must not change who the user is.
   */
  async userinfo(
    tokens: AuthorizedGrant,
    subject: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    const metadata = await this.metadata(options);
    const endpoint = metadata.userinfo_endpoint;
    if (endpoint === undefined) {
      throw new OAuthError("unsupported", `${this.issuer} has no UserInfo`, {
        issuer: this.issuer,
      });
    }
    const response = await this.resourceFetch(endpoint, tokens, {
      signal: options.signal,
    });
    if (!response.ok) {
      const challenge = resourceChallenge(
        response.headers.get("www-authenticate"),
      );
      await response.body?.cancel();
      throw new OAuthError(
        response.status >= 500 ? "network" : "token",
        `UserInfo answered ${response.status}${
          challenge?.error ? ` ${challenge.error}` : ""
        }`,
        {
          status: response.status,
          error: challenge?.error ?? null,
          description: challenge?.description ?? null,
          issuer: this.issuer,
        },
      );
    }
    let claims: Record<string, unknown>;
    if (
      isMediaType(response.headers.get("content-type") ?? "", "application/jwt")
    ) {
      const text = await readUserInfo(response, this.issuer, options.signal);
      try {
        this.#userinfoValidator ??= createVerifier({
          keys: await this.#keySet(),
          algorithms: this.#userinfoAlgorithms(),
          issuer: this.issuer,
          audience: this.clientId,
          requiredClaims: ["iss", "aud"],
          // Section 5.3.2 asks a signed answer for iss and aud, not exp;
          // one that is present is still checked.
          requireExpiry: false,
          now: this.#now,
        });
        ({ payload: claims } = await this.#userinfoValidator.verify(text));
      } catch (cause) {
        rethrowRuntimeUnsupported(cause);
        throw new IdTokenError(
          "signature",
          "the signed UserInfo does not verify",
          {
            cause,
          },
        );
      }
    } else {
      if (
        this.#options.userinfoSignedResponseAlg !== undefined ||
        !isMediaType(
          response.headers.get("content-type") ?? "",
          "application/json",
        )
      ) {
        await response.body?.cancel();
        throw new OAuthError(
          "token",
          "UserInfo content type does not match the registered response policy",
        );
      }
      const text = await readUserInfo(response, this.issuer, options.signal);
      let body: unknown = null;
      try {
        body = parseJsonBounded(text, USERINFO_JSON);
      } catch {
        // Not a JSON object, or too deep or wide: refused below.
      }
      if (!isObject(body)) {
        throw new OAuthError("token", "UserInfo did not answer a JSON object", {
          issuer: this.issuer,
        });
      }
      claims = body;
    }
    if (claims.sub !== subject) {
      throw new IdTokenError(
        "sub",
        "UserInfo answered about another subject than the ID token",
      );
    }
    return jsonSnapshot(claims);
  }

  /**
   * `input` as a URL, when this client's tokens may go to it: https (or, with
   * `allowLoopbackForDevelopment`, http to a loopback IP literal), no
   * user information or fragment, and covered (same origin, path at or
   * under it after dot segments are resolved) by the provider's
   * `userinfo_endpoint` or one of the configured `resources`. Throws the
   * `OAuthError` `target` otherwise.
   */
  async resourceTarget(input: string | URL): Promise<URL> {
    const refuse = (why: string) =>
      new OAuthError(
        "target",
        `this client's tokens are not sent to ${String(input)}: ${why}`,
        { issuer: this.issuer },
      );
    const problem = this.#urlProblem(input);
    if (problem !== null) throw refuse(problem);
    if (
      egressUrlProblem(String(input), endpointEgressPolicy(this.#options)) !==
        null
    ) throw refuse("outside the credential endpoint egress policy");
    const url = new URL(String(input));
    const userinfo = (await this.metadata()).userinfo_endpoint;
    const covered = [
      ...(userinfo === undefined ? [] : [userinfo]),
      ...this.#resources,
    ];
    if (!covered.some((resource) => resourceCovers(resource, url))) {
      throw refuse(
        `it is not under ${covered.join(" or ") || "any known resource"}`,
      );
    }
    return url;
  }

  /**
   * Calls a protected resource with `tokens`, as
   * {@link unsafeFetchResource} does, after refusing (with the
   * `OAuthError` `target`, before any header exists) a URL the tokens are
   * not for; see {@link OidcClient}'s `resources`. Redirects are never
   * followed (`redirect: "error"`), so the token cannot be forwarded.
   */
  async resourceFetch(
    input: string | URL,
    tokens: AuthorizedGrant,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = await this.resourceTarget(input);
    await this.#checkGrant(tokens, url);
    return await this.#fetchResource(url.href, tokens, {
      ...init,
      redirect: "error",
    }, true);
  }

  /**
   * The headers for a request to a covered resource: `Authorization`
   * (Bearer or DPoP) and, for a DPoP token, a proof for the method and
   * URL. Throws the `OAuthError` `target` for a URL the tokens are not
   * for, as {@link resourceFetch} does.
   */
  async resourceHeaders(
    request: { readonly method: string; readonly url: string | URL },
    tokens: AuthorizedGrant,
  ): Promise<Record<string, string>> {
    const url = await this.resourceTarget(request.url);
    await this.#checkGrant(tokens, url);
    const method = request.method.toUpperCase();
    const key = await this.#dpopKey(tokens);
    const headers: Record<string, string> = {
      authorization: `${tokens.token_type} ${tokens.access_token}`,
    };
    if (key !== undefined) {
      headers.dpop = await key.proof({
        method,
        url: url.href,
        accessToken: tokens.access_token,
        nonce: this.#nonces.get(url.href),
      });
    }
    return headers;
  }

  async #checkGrant(tokens: AuthorizedGrant, url: URL): Promise<void> {
    const oauth: OAuthClient = await this.oauth();
    await oauth.validateGrant(tokens);
    assertAuthorizedGrant(tokens, {
      issuer: this.issuer,
      clientId: this.clientId,
      dpopJkt: this.dpop?.jkt,
    });
    const covered = tokens.provenance.resources;
    const userinfo = (await this.metadata()).userinfo_endpoint;
    if (
      !(covered.length === 0
        ? userinfo !== undefined && url.href === userinfo
        : covered.some((resource) => resourceCovers(resource, url)))
    ) {
      throw new OAuthError(
        "target",
        "the grant does not authorize this resource",
      );
    }
  }

  /** Restore only from an authenticated confidential store, never request JSON. */
  async unsafeRestoreGrant(value: unknown): Promise<AuthorizedGrant> {
    const oauth = await this.oauth();
    const grant = oauth.unsafeRestoreGrant(value);
    await oauth.validateGrant(grant);
    return grant;
  }

  /** The DPoP key a DPoP token needs; throws when this client does not hold it. */
  async #dpopKey(tokens: TokenSet): Promise<DpopKey | undefined> {
    if (tokens.token_type !== "DPoP") return undefined;
    const key = this.#options.dpop;
    if (key === undefined || key.jkt !== tokens.dpop_jkt) {
      throw new OAuthError(
        "dpop",
        "the token is bound to a DPoP key this client does not hold",
        { issuer: this.issuer },
      );
    }
    const metadata = await this.metadata();
    checkDpopAlgorithm(
      key,
      metadata.dpop_signing_alg_values_supported,
      this.issuer,
    );
    return key;
  }

  /**
   * Raw resource call: puts `tokens` on a request to any URL at all,
   * `Authorization: Bearer`, or `DPoP` with a fresh proof for the method
   * and URL, retried once when the resource asks for a nonce (a 401
   * `use_dpop_nonce` challenge), following redirects as `init` says. Only
   * for a caller that independently authenticates the complete token record,
   * fences refresh generations, and makes sure the URL is one the tokens are
   * for. This raw escape hatch does not validate a restored grant's generation;
   * prefer {@link resourceFetch}.
   */
  async unsafeFetchResource(
    url: string,
    tokens: TokenSet,
    init: RequestInit = {},
  ): Promise<Response> {
    return await this.#fetchResource(url, tokens, init, false);
  }

  async #fetchResource(
    url: string,
    tokens: TokenSet,
    init: RequestInit,
    bounded: boolean,
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const key = this.#options.dpop;
    if (tokens.token_type === "DPoP") {
      if (key === undefined || key.jkt !== tokens.dpop_jkt) {
        throw new OAuthError(
          "dpop",
          "the token is bound to a DPoP key this client does not hold",
          { issuer: this.issuer },
        );
      }
      const metadata = await this.metadata();
      checkDpopAlgorithm(
        key,
        metadata.dpop_signing_alg_values_supported,
        this.issuer,
      );
    }
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(init.headers);
      headers.set(
        "authorization",
        `${tokens.token_type} ${tokens.access_token}`,
      );
      if (tokens.token_type === "DPoP") {
        headers.set(
          "dpop",
          await key!.proof({
            method,
            url,
            accessToken: tokens.access_token,
            nonce: this.#nonces.get(url),
          }),
        );
      }
      try {
        if (bounded) {
          const answer = await boundedFetch(
            endpointEgressPolicy(this.#options),
            this.#fetch,
          )(url, { ...init, method, headers, redirect: "error" });
          const bodyless = method === "HEAD" ||
            [204, 205, 304].includes(answer.status);
          if (bodyless) await answer.discard();
          response = new Response(bodyless ? null : answer.stream(), {
            status: answer.status,
            statusText: answer.statusText,
            headers: answer.headers,
          });
        } else response = await this.#fetch(url, { ...init, method, headers });
      } catch (cause) {
        throw new OAuthError("network", `could not reach ${url}`, {
          cause,
          issuer: this.issuer,
        });
      }
      const fresh = this.#nonces.update(url, response);
      const challenge = resourceChallenge(
        response.headers.get("www-authenticate"),
        "DPoP",
      );
      if (
        tokens.token_type !== "DPoP" || response.status !== 401 ||
        challenge?.error !== "use_dpop_nonce" || fresh === undefined ||
        attempt === 1
      ) {
        break;
      }
      await response.body?.cancel();
    }
    return response!;
  }

  /**
   * An RP-Initiated Logout URL (OpenID Connect RP-Initiated Logout 1.0
   * section 2): the provider's `end_session_endpoint` with the ID token
   * as a hint, this client's id, and where to come back to. JSON options use
   * the same bounded, pre-await snapshot as {@link authorizationUrl}.
   */
  async logoutUrl(
    options: {
      readonly idTokenHint?: AuthorizedGrant;
      readonly postLogoutRedirectUri?: string;
      readonly state?: string;
      readonly logoutHint?: string;
      readonly uiLocales?: readonly string[];
    } = {},
  ): Promise<string> {
    strictRecord(options as unknown, [
      "idTokenHint",
      "postLogoutRedirectUri",
      "state",
      "logoutHint",
      "uiLocales",
    ], "logout options");
    const { idTokenHint, ...data } = options;
    options = {
      ...jsonSnapshot(Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
      )),
      idTokenHint,
    };
    const metadata = await this.metadata();
    const endpoint = metadata.end_session_endpoint;
    if (endpoint === undefined) {
      throw new OAuthError(
        "unsupported",
        `${this.issuer} has no end_session_endpoint`,
        { issuer: this.issuer },
      );
    }
    const url = new URL(endpoint);
    const set = (name: string, value: string | undefined) => {
      if (value !== undefined) url.searchParams.set(name, value);
    };
    if (idTokenHint !== undefined) {
      const oauth: OAuthClient = await this.oauth();
      await oauth.validateGrant(idTokenHint);
      if (idTokenHint.id_token === undefined) {
        throw new TypeError("the grant has no ID token hint");
      }
      set("id_token_hint", idTokenHint.id_token);
    }
    set("client_id", this.clientId);
    set("post_logout_redirect_uri", options.postLogoutRedirectUri);
    set("state", options.state);
    set("logout_hint", options.logoutHint);
    if (options.uiLocales !== undefined) {
      set("ui_locales", formatScope(options.uiLocales));
    }
    return url.href;
  }
}
