// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link OidcClient}: an OpenID Connect relying party at one provider.
 * It drives `@celld/oauth`'s `OAuthClient` for the protocol (PKCE, `state`,
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
 * - RP-Initiated Logout URLs.
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
  type FetchLike,
  formatScope,
  OAuthError,
  randomToken,
  resourceChallenge,
} from "@celld/oauth";
import {
  type ClientAuthentication,
  OAuthClient,
  type PendingAuthorization,
  type TokenSet,
} from "@celld/oauth/client";
import {
  checkDpopAlgorithm,
  type DpopKey,
  DpopNonceCache,
} from "@celld/oauth/dpop";
import { type JwsAlgorithm, type KeySet, RemoteJwks, verify } from "@celld/jwt";
import {
  type ClaimsRequest,
  type IdTokenClaims,
  OPENID_SCOPE,
  requestedAcrValues,
} from "../claims.ts";
import { IdTokenError } from "../errors.ts";
import {
  discoverOpenIdProvider,
  type OpenIdProviderMetadata,
} from "../metadata.ts";
import {
  defaultClock,
  defaultFetch,
  isMediaType,
  isObject,
  rethrowRuntimeUnsupported,
} from "../util.ts";
import { DEFAULT_ID_TOKEN_ALGORITHMS, validateIdToken } from "./validate.ts";

/** Options for {@link OidcClient}. */
export interface OidcClientOptions {
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
   * The ID token algorithms accepted; default the client's registered
   * `id_token_signed_response_alg` when it has one, else
   * {@link DEFAULT_ID_TOKEN_ALGORITHMS}.
   */
  readonly idTokenAlgorithms?: readonly JwsAlgorithm[];
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
  readonly idTokenHint?: string;
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
  readonly tokens: TokenSet;
  /** The ID token, validated. */
  readonly idToken: string;
  readonly claims: IdTokenClaims;
  /** `claims.sub`. */
  readonly subject: string;
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

  constructor(options: OidcClientOptions) {
    this.issuer = options.issuer;
    this.#options = options;
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? defaultClock;
    if (options.metadata !== undefined) {
      if (options.metadata.issuer !== options.issuer) {
        throw new TypeError(
          `metadata is for ${options.metadata.issuer}, not ${options.issuer}`,
        );
      }
      this.#metadata = Promise.resolve(options.metadata);
    }
    this.#keys = options.keys ?? null;
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
    this.#metadata ??= discoverOpenIdProvider(this.issuer, {
      fetch: this.#fetch,
      signal: options.signal,
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
    });
    return this.#oauth;
  }

  async #keySet(): Promise<KeySet> {
    if (this.#keys !== null) return this.#keys;
    const metadata = await this.metadata();
    this.#keys = new RemoteJwks(metadata.jwks_uri, {
      fetch: this.#fetch,
      now: this.#now,
      allowInsecure: true,
    });
    return this.#keys;
  }

  #algorithms(): readonly JwsAlgorithm[] {
    return this.#options.idTokenAlgorithms ?? DEFAULT_ID_TOKEN_ALGORITHMS;
  }

  /**
   * Starts a login: the authorization request with `openid`, a fresh
   * `nonce` and the OpenID parameters asked for, pushed when the provider
   * has PAR. Keep the result for {@link completeLogin}.
   */
  async authorizationUrl(options: LoginOptions = {}): Promise<PendingLogin> {
    const metadata = await this.metadata({ signal: options.signal });
    const oauth = await this.oauth();
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
    if (options.idTokenHint !== undefined) {
      extra.id_token_hint = options.idTokenHint;
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
    return {
      authorization,
      nonce,
      ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
      ...(acr.essential ? { requiredAcr: acr.values } : {}),
      ...(authTimeRequested ? { requireAuthTime: true } : {}),
    };
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
    const oauth = await this.oauth();
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
    const claims = await validateIdToken(idToken, {
      issuer: this.issuer,
      clientId: this.clientId,
      keys: await this.#keySet(),
      algorithms: this.#algorithms(),
      nonce: pending.nonce,
      maxAge: pending.maxAge,
      requireAuthTime: pending.requireAuthTime,
      acrValues: pending.requiredAcr,
      accessToken: tokens.access_token,
      clockToleranceSec: this.#options.clockToleranceSec,
      now: this.#now,
    });
    return { tokens, idToken, claims, subject: claims.sub };
  }

  /**
   * Refreshes the tokens. A new ID token, if the provider sends one, must
   * be about the same user from the same authentication (OpenID Connect
   * Core section 12.2): same `iss`, `sub` and `aud`, and `auth_time`
   * unchanged.
   */
  async refresh(
    refreshToken: string,
    previous: IdTokenClaims,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    { readonly tokens: TokenSet; readonly claims?: IdTokenClaims }
  > {
    const oauth = await this.oauth();
    const tokens = await oauth.refresh(refreshToken, options);
    if (tokens.id_token === undefined) return { tokens };
    const claims = await validateIdToken(tokens.id_token, {
      issuer: this.issuer,
      clientId: this.clientId,
      keys: await this.#keySet(),
      algorithms: this.#algorithms(),
      subject: previous.sub,
      ...(previous.auth_time === undefined
        ? {}
        : { authTime: previous.auth_time }),
      accessToken: tokens.access_token,
      clockToleranceSec: this.#options.clockToleranceSec,
      now: this.#now,
    });
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
    tokens: TokenSet,
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
    const response = await this.fetchResource(endpoint, tokens, {
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
      const text = await response.text();
      try {
        ({ payload: claims } = await verify(text, await this.#keySet(), {
          algorithms: this.#algorithms().filter((alg) => !alg.startsWith("HS")),
          issuer: this.issuer,
          audience: this.clientId,
          now: this.#now,
        }));
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
      const body = await response.json().catch(() => null);
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
    return claims;
  }

  /**
   * Calls a protected resource with `tokens`: `Authorization: Bearer`, or
   * `DPoP` with a fresh proof for the method and URL, retried once when
   * the resource asks for a nonce (a 401 `use_dpop_nonce` challenge).
   */
  async fetchResource(
    url: string,
    tokens: TokenSet,
    init: RequestInit = {},
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
        response = await this.#fetch(url, { ...init, method, headers });
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
   * as a hint, this client's id, and where to come back to.
   */
  async logoutUrl(
    options: {
      readonly idTokenHint?: string;
      readonly postLogoutRedirectUri?: string;
      readonly state?: string;
      readonly logoutHint?: string;
      readonly uiLocales?: readonly string[];
    } = {},
  ): Promise<string> {
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
    set("id_token_hint", options.idTokenHint);
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
