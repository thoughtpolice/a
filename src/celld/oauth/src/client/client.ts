// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link OAuthClient}: every grant and endpoint of one authorization
 * server, for one client identity, without any storage of its own.
 *
 * ```ts
 * const client = new OAuthClient({
 *   issuer: "https://auth.example.com",
 *   client: { method: "none", clientId: "my-app" },
 *   redirectUri: "http://127.0.0.1:8765/callback",
 *   dpop: await DpopKey.generate(),
 * });
 * const pending = await client.authorizationUrl({
 *   scope: ["files:read"],
 *   resource: "https://api.example.com",
 * });
 * // ...send the user to pending.url; they come back to the redirect URI...
 * const tokens = await client.completeAuthorization(pending, callbackUrl);
 * const fresh = await client.refresh(tokens.refresh_token!);
 * ```
 *
 * Secure defaults: PKCE S256 on every authorization request, and a
 * server whose metadata does not list S256 is refused (`assumePkce`
 * overrides); a fresh 128-bit `state`; RFC 9207 `iss` checked before
 * anything else in the response is read; pushed authorization requests
 * whenever the server offers them; with a DPoP key, every token request
 * carries a proof, codes are bound with `dpop_jkt`, and a server that
 * answers with a Bearer token is refused.
 *
 * @module
 */

import { GRANT_TYPES, REQUEST_URI_PREFIX } from "../constants.ts";
import {
  checkDpopAlgorithm,
  type DpopKey,
  DpopNonceCache,
} from "../dpop/key.ts";
import { OAuthError } from "../errors.ts";
import type {
  AuthorizationServerMetadata,
  IntrospectionResponse,
} from "../metadata.ts";
import { pkcePair } from "../pkce.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  formatScope,
  isObject,
  randomToken,
} from "../util.ts";
import type { ClientAuthentication } from "./auth.ts";
import { discoverAuthorizationServer } from "./discovery.ts";
import {
  type EndpointContext,
  expectJson,
  failure,
  type FormParams,
  parseTokenResponse,
  postForm,
} from "./http.ts";
import type { TokenSet } from "./store.ts";

/** Options for {@link OAuthClient}. */
export interface OAuthClientOptions {
  /** The authorization server's issuer identifier. */
  readonly issuer: string;
  /** Its metadata, when already known; otherwise it is discovered. */
  readonly metadata?: AuthorizationServerMetadata;
  /** How this client authenticates. */
  readonly client: ClientAuthentication;
  /** The redirect URI, for the authorization code grant. */
  readonly redirectUri?: string;
  /** Binds tokens to this key with DPoP (RFC 9449). */
  readonly dpop?: DpopKey;
  /**
   * Accept a Bearer token when a DPoP proof was sent (the server does not
   * support DPoP); default false.
   */
  readonly allowBearerFallback?: boolean;
  /**
   * Push authorization requests (RFC 9126): `auto` (the default) when the
   * server has a PAR endpoint, `always` (fail without one), or `never`
   * (fails when the server requires them).
   */
  readonly par?: "auto" | "always" | "never";
  /** Authorize at a server whose metadata omits S256; default false. */
  readonly assumePkce?: boolean;
  /** Also try OpenID Connect Discovery locations; default true. */
  readonly oidcDiscovery?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
}

/** What {@link OAuthClient.authorizationUrl} is asked for. */
export interface AuthorizationUrlOptions {
  readonly scope?: readonly string[];
  /** RFC 8707 resource indicators. */
  readonly resource?: string | readonly string[];
  /** Default a fresh random value. */
  readonly state?: string;
  /** Bind the code to the DPoP key with `dpop_jkt`; default true with a key. */
  readonly dpopJkt?: boolean;
  /** More parameters, such as OpenID Connect's `nonce` or `prompt`. */
  readonly extra?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * A started authorization, as plain data a host can keep until the
 * callback arrives. It holds the PKCE verifier: keep it private.
 */
export interface PendingAuthorization {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly scope: string;
  readonly resource: readonly string[];
  /** Whether the server promised `iss` in the response (RFC 9207). */
  readonly issRequired: boolean;
  /** The DPoP key thumbprint the code is bound to, if any. */
  readonly dpopJkt?: string;
  /** Any `extra` parameters, for a layer above (an OpenID `nonce`). */
  readonly extra?: Readonly<Record<string, string>>;
}

/** A device authorization response (RFC 8628 section 3.2). */
export interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  /** Epoch milliseconds. */
  readonly expires_at: number;
  /** Seconds between polls. */
  readonly interval: number;
}

/** What {@link OAuthClient.tokenExchange} is asked for (RFC 8693 section 2.1). */
export interface TokenExchangeRequest {
  readonly subjectToken: string;
  readonly subjectTokenType: string;
  readonly actorToken?: string;
  readonly actorTokenType?: string;
  readonly requestedTokenType?: string;
  readonly resource?: string | readonly string[];
  readonly audience?: string | readonly string[];
  readonly scope?: readonly string[];
}

function list(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

/** Waits `ms`, or rejects when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One authorization server's grants for one client; see the module documentation. */
export class OAuthClient {
  readonly issuer: string;
  readonly #options: OAuthClientOptions;
  readonly #fetch: FetchLike;
  readonly #now: Clock;
  readonly #nonces = new DpopNonceCache();
  #metadata: Promise<AuthorizationServerMetadata> | null = null;

  constructor(options: OAuthClientOptions) {
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
  }

  /** The client id. */
  get clientId(): string {
    return this.#options.client.clientId;
  }

  /** The DPoP key, if any. */
  get dpop(): DpopKey | undefined {
    return this.#options.dpop;
  }

  /** The server's metadata, discovered once. */
  async metadata(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AuthorizationServerMetadata> {
    this.#metadata ??= discoverAuthorizationServer(this.issuer, {
      fetch: this.#fetch,
      signal: options.signal,
      oidc: this.#options.oidcDiscovery,
    });
    try {
      return await this.#metadata;
    } catch (error) {
      this.#metadata = null;
      throw error;
    }
  }

  #context(signal?: AbortSignal): EndpointContext {
    return {
      issuer: this.issuer,
      fetch: this.#fetch,
      now: this.#now,
      nonces: this.#nonces,
      dpop: this.#options.dpop,
      signal,
    };
  }

  async #endpoint(
    name: keyof AuthorizationServerMetadata & `${string}endpoint`,
    signal?: AbortSignal,
  ): Promise<string> {
    const metadata = await this.metadata({ signal });
    const endpoint = metadata[name];
    if (typeof endpoint !== "string") {
      throw new OAuthError("unsupported", `${this.issuer} has no ${name}`, {
        issuer: this.issuer,
      });
    }
    return endpoint;
  }

  async #checkDpop(): Promise<void> {
    const key = this.#options.dpop;
    if (key === undefined) return;
    const metadata = await this.metadata();
    checkDpopAlgorithm(
      key,
      metadata.dpop_signing_alg_values_supported,
      this.issuer,
    );
  }

  /** POSTs a grant to the token endpoint and returns the tokens. */
  async #token(
    params: FormParams,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    await this.#checkDpop();
    const endpoint = await this.#endpoint("token_endpoint", signal);
    const result = await postForm(
      endpoint,
      params,
      this.#options.client,
      this.#context(signal),
      { dpop: true },
    );
    const body = expectJson(
      result,
      `the ${params.grant_type} grant`,
      this.issuer,
    );
    return parseTokenResponse(body, {
      issuer: this.issuer,
      now: this.#now,
      dpopJkt: this.#options.dpop?.jkt,
      allowBearer: this.#options.allowBearerFallback,
    });
  }

  /**
   * Starts the authorization code flow: PKCE, `state`, the RFC 8707
   * `resource`s and `dpop_jkt`, pushed to the PAR endpoint when that
   * applies (RFC 9126), and returns the URL to send the user to with the
   * state to keep for {@link completeAuthorization}.
   */
  async authorizationUrl(
    options: AuthorizationUrlOptions = {},
  ): Promise<PendingAuthorization> {
    const metadata = await this.metadata({ signal: options.signal });
    const redirectUri = this.#options.redirectUri;
    if (redirectUri === undefined) {
      throw new OAuthError(
        "interaction_required",
        "the authorization code flow needs a redirectUri",
        { issuer: this.issuer },
      );
    }
    if (
      !this.#options.assumePkce &&
      !(metadata.code_challenge_methods_supported ?? []).includes("S256")
    ) {
      throw new OAuthError(
        "unsupported",
        `${this.issuer} does not advertise PKCE S256 (code_challenge_methods_supported), so the client refuses to authorize there`,
        { issuer: this.issuer },
      );
    }
    const types = metadata.response_types_supported;
    if (types !== undefined && !types.includes("code")) {
      throw new OAuthError(
        "unsupported",
        `${this.issuer} does not support the code response type`,
        { issuer: this.issuer },
      );
    }
    const authorize = await this.#endpoint(
      "authorization_endpoint",
      options.signal,
    );
    await this.#checkDpop();
    const { verifier, challenge } = await pkcePair();
    const state = options.state ?? randomToken(16);
    const scope = formatScope(options.scope ?? []);
    const resource = list(options.resource);
    const key = this.#options.dpop;
    const dpopJkt = key !== undefined && (options.dpopJkt ?? true)
      ? key.jkt
      : undefined;
    const params: Record<string, string | readonly string[] | undefined> = {
      ...options.extra,
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: scope === "" ? undefined : scope,
      resource: resource.length === 0 ? undefined : resource,
      dpop_jkt: dpopJkt,
    };
    const mode = this.#options.par ?? "auto";
    const parEndpoint = metadata.pushed_authorization_request_endpoint;
    const url = new URL(authorize);
    if (mode !== "never" && parEndpoint !== undefined) {
      const result = await postForm(
        parEndpoint,
        params,
        this.#options.client,
        this.#context(options.signal),
        { dpop: true },
      );
      const body = expectJson(
        result,
        "the pushed authorization request",
        this.issuer,
      );
      const requestUri = body.request_uri;
      if (
        typeof requestUri !== "string" ||
        !requestUri.startsWith(REQUEST_URI_PREFIX) &&
          !requestUri.startsWith("urn:")
      ) {
        throw new OAuthError(
          "token",
          "the pushed authorization response has no request_uri",
          { issuer: this.issuer },
        );
      }
      url.searchParams.set("client_id", this.clientId);
      url.searchParams.set("request_uri", requestUri);
    } else if (
      mode === "always" || metadata.require_pushed_authorization_requests
    ) {
      throw new OAuthError(
        "unsupported",
        mode === "always"
          ? `${this.issuer} has no pushed_authorization_request_endpoint`
          : `${this.issuer} requires pushed authorization requests`,
        { issuer: this.issuer },
      );
    } else {
      for (const [name, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (typeof value === "string") url.searchParams.set(name, value);
        else for (const item of value) url.searchParams.append(name, item);
      }
    }
    return {
      url: url.href,
      state,
      verifier,
      redirectUri,
      clientId: this.clientId,
      issuer: this.issuer,
      scope,
      resource,
      issRequired: metadata.authorization_response_iss_parameter_supported ===
        true,
      ...(dpopJkt === undefined ? {} : { dpopJkt }),
      ...(options.extra === undefined ? {} : { extra: options.extra }),
    };
  }

  /**
   * Checks an authorization response and returns its code. In order:
   * `iss` (RFC 9207: a present one must be the issuer exactly, an absent
   * one is refused when the server promised it), `state`, then `error`.
   */
  checkAuthorizationResponse(
    pending: PendingAuthorization,
    callback: string | URL,
  ): string {
    const params = new URL(String(callback)).searchParams;
    const iss = params.get("iss");
    if (iss !== null) {
      if (iss !== pending.issuer) {
        throw new OAuthError(
          "issuer_mismatch",
          `the authorization response came from ${
            JSON.stringify(iss)
          }, not ${pending.issuer}`,
          { issuer: pending.issuer },
        );
      }
    } else if (pending.issRequired) {
      throw new OAuthError(
        "issuer_mismatch",
        `the authorization response has no iss, which ${pending.issuer} promises`,
        { issuer: pending.issuer },
      );
    }
    if (params.get("state") !== pending.state) {
      throw new OAuthError(
        "state_mismatch",
        "the authorization response's state does not match",
        { issuer: pending.issuer },
      );
    }
    const error = params.get("error");
    if (error !== null) {
      const description = params.get("error_description");
      throw new OAuthError(
        "authorization",
        `authorization failed: ${error}${
          description === null ? "" : `: ${description}`
        }`,
        { error, description, issuer: pending.issuer },
      );
    }
    const code = params.get("code");
    if (code === null || code === "") {
      throw new OAuthError(
        "authorization",
        "the authorization response has no code",
        { issuer: pending.issuer },
      );
    }
    return code;
  }

  /**
   * Finishes a flow from the URL the user came back to: checks it (see
   * {@link checkAuthorizationResponse}) and redeems the code with the PKCE
   * verifier and the same `resource`s.
   */
  async completeAuthorization(
    pending: PendingAuthorization,
    callback: string | URL,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TokenSet> {
    if (pending.issuer !== this.issuer || pending.clientId !== this.clientId) {
      throw new OAuthError(
        "state_mismatch",
        "the pending authorization belongs to another server or client",
        { issuer: this.issuer },
      );
    }
    if (
      pending.dpopJkt !== undefined && pending.dpopJkt !== this.dpop?.jkt
    ) {
      throw new OAuthError(
        "dpop",
        "the code is bound to a DPoP key this client does not hold",
        { issuer: this.issuer },
      );
    }
    const code = this.checkAuthorizationResponse(pending, callback);
    const tokens = await this.#token({
      grant_type: GRANT_TYPES.authorizationCode,
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      resource: pending.resource.length === 0 ? undefined : pending.resource,
    }, options.signal);
    return pending.scope === ""
      ? tokens
      : { ...tokens, requested_scope: pending.scope };
  }

  /**
   * Uses a refresh token (RFC 6749 section 6). Servers rotate refresh
   * tokens; when this one does not, the old one is kept in the result.
   */
  async refresh(
    refreshToken: string,
    options: {
      readonly scope?: readonly string[];
      readonly resource?: string | readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<TokenSet> {
    const resource = list(options.resource);
    const tokens = await this.#token({
      grant_type: GRANT_TYPES.refreshToken,
      refresh_token: refreshToken,
      scope: options.scope === undefined
        ? undefined
        : formatScope(options.scope),
      resource: resource.length === 0 ? undefined : resource,
    }, options.signal);
    return tokens.refresh_token === undefined
      ? { ...tokens, refresh_token: refreshToken }
      : tokens;
  }

  /** The client credentials grant (RFC 6749 section 4.4); a confidential client only. */
  async clientCredentials(
    options: {
      readonly scope?: readonly string[];
      readonly resource?: string | readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<TokenSet> {
    if (this.#options.client.method === "none") {
      throw new OAuthError(
        "registration",
        "the client credentials grant needs a confidential client",
        { issuer: this.issuer },
      );
    }
    const resource = list(options.resource);
    const scope = formatScope(options.scope ?? []);
    const tokens = await this.#token({
      grant_type: GRANT_TYPES.clientCredentials,
      scope: scope === "" ? undefined : scope,
      resource: resource.length === 0 ? undefined : resource,
    }, options.signal);
    return scope === "" ? tokens : { ...tokens, requested_scope: scope };
  }

  /** Token exchange (RFC 8693). */
  async tokenExchange(
    request: TokenExchangeRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<TokenSet> {
    if (
      (request.actorToken === undefined) !==
        (request.actorTokenType === undefined)
    ) {
      throw new TypeError("actorToken and actorTokenType go together");
    }
    const resource = list(request.resource);
    const audience = list(request.audience);
    return await this.#token({
      grant_type: GRANT_TYPES.tokenExchange,
      subject_token: request.subjectToken,
      subject_token_type: request.subjectTokenType,
      actor_token: request.actorToken,
      actor_token_type: request.actorTokenType,
      requested_token_type: request.requestedTokenType,
      resource: resource.length === 0 ? undefined : resource,
      audience: audience.length === 0 ? undefined : audience,
      scope: request.scope === undefined
        ? undefined
        : formatScope(request.scope),
    }, options.signal);
  }

  /** Starts the device authorization grant (RFC 8628 section 3.1). */
  async deviceAuthorization(
    options: {
      readonly scope?: readonly string[];
      readonly resource?: string | readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DeviceAuthorization> {
    const endpoint = await this.#endpoint(
      "device_authorization_endpoint",
      options.signal,
    );
    const resource = list(options.resource);
    const scope = formatScope(options.scope ?? []);
    const result = await postForm(
      endpoint,
      {
        scope: scope === "" ? undefined : scope,
        resource: resource.length === 0 ? undefined : resource,
      },
      this.#options.client,
      this.#context(options.signal),
    );
    const body = expectJson(
      result,
      "the device authorization request",
      this.issuer,
    );
    const text = (name: string) =>
      typeof body[name] === "string" && body[name] !== ""
        ? body[name] as string
        : null;
    const deviceCode = text("device_code");
    const userCode = text("user_code");
    const uri = text("verification_uri");
    if (
      deviceCode === null || userCode === null || uri === null ||
      typeof body.expires_in !== "number"
    ) {
      throw new OAuthError(
        "token",
        "the device authorization response is incomplete",
        { issuer: this.issuer },
      );
    }
    const complete = text("verification_uri_complete");
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: uri,
      ...(complete === null ? {} : { verification_uri_complete: complete }),
      expires_at: this.#now() + body.expires_in * 1000,
      interval: typeof body.interval === "number" && body.interval > 0
        ? body.interval
        : 5,
    };
  }

  /**
   * Polls the token endpoint for a device authorization (RFC 8628 section
   * 3.4) until the user decides: waits `interval` seconds between polls,
   * five more after each `slow_down`, and stops at expiry. `access_denied`
   * and `expired_token` are `authorization` errors.
   */
  async pollDeviceToken(
    device: DeviceAuthorization,
    options: {
      readonly signal?: AbortSignal;
      /** Waits between polls; default a timer. */
      readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {},
  ): Promise<TokenSet> {
    const wait = options.sleep ?? sleep;
    let interval = device.interval;
    for (;;) {
      if (this.#now() >= device.expires_at) {
        throw new OAuthError(
          "authorization",
          "the device code expired before the user decided",
          { error: "expired_token", issuer: this.issuer },
        );
      }
      await wait(interval * 1000, options.signal);
      try {
        return await this.#token({
          grant_type: GRANT_TYPES.deviceCode,
          device_code: device.device_code,
        }, options.signal);
      } catch (error) {
        if (!(error instanceof OAuthError) || error.kind !== "token") {
          throw error;
        }
        if (error.error === "authorization_pending") continue;
        if (error.error === "slow_down") {
          interval += 5;
          continue;
        }
        if (
          error.error === "access_denied" || error.error === "expired_token"
        ) {
          throw new OAuthError("authorization", error.message, {
            error: error.error,
            description: error.description,
            status: error.status,
            issuer: this.issuer,
          });
        }
        throw error;
      }
    }
  }

  /**
   * Revokes a token (RFC 7009). The server answers 200 whether or not it
   * knew the token, so success says nothing about it.
   */
  async revoke(
    token: string,
    options: {
      readonly hint?: "access_token" | "refresh_token";
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const endpoint = await this.#endpoint(
      "revocation_endpoint",
      options.signal,
    );
    const result = await postForm(
      endpoint,
      { token, token_type_hint: options.hint },
      this.#options.client,
      this.#context(options.signal),
    );
    if (result.status !== 200) throw failure(result, "revocation", this.issuer);
  }

  /**
   * Introspects a token (RFC 7662). An inactive or unknown token is
   * `{ active: false }`, not an error.
   */
  async introspect(
    token: string,
    options: {
      readonly hint?: "access_token" | "refresh_token";
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<IntrospectionResponse> {
    const endpoint = await this.#endpoint(
      "introspection_endpoint",
      options.signal,
    );
    const result = await postForm(
      endpoint,
      { token, token_type_hint: options.hint },
      this.#options.client,
      this.#context(options.signal),
    );
    const body = expectJson(result, "introspection", this.issuer);
    if (typeof body.active !== "boolean" || !isObject(body)) {
      throw new OAuthError("token", "the introspection answer has no active", {
        issuer: this.issuer,
      });
    }
    return body as unknown as IntrospectionResponse;
  }
}
