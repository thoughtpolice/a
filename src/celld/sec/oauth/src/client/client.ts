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
 * const fresh = await client.refresh(tokens);
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

import {
  finite,
  jsonSnapshot,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import { assertAlgorithmsSupported } from "@celld/sec/jwt";
import { GRANT_TYPES, REQUEST_URI_PREFIX } from "../constants.ts";
import { checkDpopAlgorithm, DpopKey, DpopNonceCache } from "../dpop/key.ts";
import { OAuthError } from "../errors.ts";
import {
  type AuthorizationServerMetadata,
  checkSecureUrl,
  type IntrospectionResponse,
  isIssuer,
  redirectUriProblem,
  resourceCovers,
} from "../metadata.ts";
import { isCodeVerifier, pkcePair } from "../pkce.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  formatScope,
  isObject,
  isScopeToken,
  parseScope,
  randomToken,
  snapshot,
  snapshotOptions,
} from "../util.ts";
import {
  checkClientAuthentication,
  type ClientAuthentication,
} from "./auth.ts";
import { type EgressOptions, endpointEgressPolicy } from "../egress.ts";
import {
  checkAuthorizationServerMetadata,
  discoverAuthorizationServer,
} from "./discovery.ts";
import {
  type EndpointContext,
  expectJson,
  failure,
  type FormParams,
  parseTokenResponse,
  postForm,
} from "./http.ts";
import type { TokenSet } from "./store.ts";
import {
  assertAuthorizedGrant,
  assertGrantCapacity,
  assertGrantIdentity,
  assertRefreshable,
  type AuthorizedGrant,
  grantRefreshState,
  markRefreshUncertain,
  mintGrant,
  reserveGrantCapacity,
  retireGrant,
  unsafeRestoreGrant,
} from "./grant.ts";

const capacityReservation = Symbol("pending grant capacity");
type ReservedTokenSet = TokenSet & {
  readonly [capacityReservation]?: { release(): void };
};

/**
 * Options for {@link OAuthClient}. `egress` and
 * `allowLoopbackForDevelopment` shape metadata discovery (https, no
 * redirects, 5 s, 64 KiB, public addresses by default).
 */
export interface OAuthClientOptions extends EgressOptions {
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
  /** Legacy single-issuer provider only: accept an absent RFC 9207 iss. */
  readonly unsafeAllowMissingAuthorizationIssuer?: boolean;
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
  readonly [pendingAuthorizationBrand]: true;
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
  readonly [deviceAuthorizationBrand]: true;
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  /** Epoch milliseconds. */
  readonly expires_at: number;
  /** Seconds between polls. */
  readonly interval: number;
  readonly issuer: string;
  readonly clientId: string;
  readonly resource: readonly string[];
  readonly scope: readonly string[];
  readonly dpopJkt?: string;
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

const DAY_SEC = 86_400;
declare const pendingAuthorizationBrand: unique symbol;
declare const deviceAuthorizationBrand: unique symbol;
const authenticPending = new WeakSet<object>();

/** Whether this exact immutable object came from a client or authenticated restore. */
export function isPendingAuthorization(
  value: unknown,
): value is PendingAuthorization {
  return typeof value === "object" && value !== null &&
    authenticPending.has(value);
}

/** The longest wait between device polls the client accepts. */
const MAX_INTERVAL_SEC = 300;

/** `value` when it is whole seconds in `[min, max]`, else null. */
function boundedSeconds(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= min && value <= max
    ? value
    : null;
}

function list(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (
    typeof value !== "string" && (!Array.isArray(value) || value.length > 64)
  ) {
    throw new TypeError("identifier list exceeds its bounds");
  }
  const out = typeof value === "string"
    ? [value]
    : jsonSnapshot(value, { maxDepth: 2, maxItems: 128, maxBytes: 300_000 });
  if (
    out.length > 64 ||
    out.some((v) => typeof v !== "string" || v.length === 0 || v.length > 4096)
  ) throw new TypeError("identifier list exceeds its bounds");
  return out as string[];
}

function scopeList(
  value: unknown,
): asserts value is readonly string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError("scope exceeds its bounds");
  }
  const copy = jsonSnapshot(value, {
    maxDepth: 2,
    maxItems: 512,
    maxBytes: 131_072,
  });
  if (
    (new Set(copy).size !== copy.length ||
      copy.some((s) =>
        typeof s !== "string" || s.length > 256 || !isScopeToken(s)
      ))
  ) throw new TypeError("scope must contain unique bounded scope tokens");
}

function credential(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 16_384
  ) throw new TypeError("credential must be a bounded nonempty string");
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
  readonly #pending = new WeakSet<object>();
  readonly #devices = new WeakSet<object>();
  #metadata: Promise<AuthorizationServerMetadata> | null = null;

  constructor(options: OAuthClientOptions) {
    strictRecord(options, [
      "issuer",
      "metadata",
      "client",
      "redirectUri",
      "dpop",
      "allowBearerFallback",
      "par",
      "assumePkce",
      "unsafeAllowMissingAuthorizationIssuer",
      "oidcDiscovery",
      "fetch",
      "now",
      "egress",
      "allowLoopbackForDevelopment",
    ], "OAuthClient options");
    if (!isIssuer(options.issuer)) {
      throw new TypeError(
        "issuer must be a secure issuer URL without query or fragment",
      );
    }
    if (
      options.par !== undefined &&
      !["auto", "always", "never"].includes(options.par)
    ) throw new TypeError("par must be auto, always or never");
    if (options.redirectUri !== undefined) {
      if (redirectUriProblem(options.redirectUri, "native") !== null) {
        throw new TypeError("redirectUri is not a safe client redirect");
      }
    }
    for (
      const name of [
        "allowBearerFallback",
        "assumePkce",
        "oidcDiscovery",
        "allowLoopbackForDevelopment",
        "unsafeAllowMissingAuthorizationIssuer",
      ] as const
    ) {
      if (options[name] !== undefined && typeof options[name] !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
      }
    }
    for (const name of ["fetch", "now"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new TypeError(`${name} must be a function`);
      }
    }
    if (options.dpop !== undefined && !(options.dpop instanceof DpopKey)) {
      throw new TypeError("dpop must be a DpopKey");
    }
    endpointEgressPolicy(options);
    checkClientAuthentication(options.client);
    if (options.metadata !== undefined) jsonSnapshot(options.metadata);
    this.issuer = options.issuer;
    // Read once: changing `options` afterwards (its client, DPoP key
    // choice, egress or metadata) changes nothing.
    this.#options = snapshotOptions(options);
    checkClientAuthentication(this.#options.client);
    this.#fetch = this.#options.fetch ?? defaultFetch;
    this.#now = this.#options.now ?? defaultClock;
    const metadata = this.#options.metadata;
    if (metadata !== undefined) {
      if (metadata.issuer !== options.issuer) {
        throw new TypeError(
          `metadata is for ${metadata.issuer}, not ${options.issuer}`,
        );
      }
      // Supplied metadata passes the checks discovered metadata does: its
      // endpoints are where credentials go.
      const checked = checkAuthorizationServerMetadata(
        metadata,
        options.issuer,
      );
      if (typeof checked === "string") {
        throw new TypeError(`metadata for ${options.issuer}: ${checked}`);
      }
      this.#metadata = Promise.resolve(checked);
    }
    Object.freeze(this);
  }

  /** The client id. */
  get clientId(): string {
    return this.#options.client.clientId;
  }

  /** The DPoP key, if any. */
  get dpop(): DpopKey | undefined {
    return this.#options.dpop;
  }

  /** Probe configured crypto and validate/discover metadata before accepting traffic. */
  async ready(): Promise<void> {
    const auth = this.#options.client;
    const algorithms = [
      ...(auth.method === "private_key_jwt" ? [auth.alg] : []),
      ...(this.dpop === undefined ? [] : [this.dpop.alg]),
    ];
    if (algorithms.length > 0) await assertAlgorithmsSupported(algorithms);
    await this.metadata();
    await this.#checkDpop();
  }

  /** The server's metadata, discovered once. */
  async metadata(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AuthorizationServerMetadata> {
    strictRecord(options as unknown, ["signal"], "metadata options");
    this.#metadata ??= discoverAuthorizationServer(this.issuer, {
      fetch: this.#fetch,
      signal: options.signal,
      oidc: this.#options.oidcDiscovery,
      ...(this.#options.egress === undefined
        ? {}
        : { egress: this.#options.egress }),
      ...(this.#options.allowLoopbackForDevelopment === undefined ? {} : {
        allowLoopbackForDevelopment: this.#options.allowLoopbackForDevelopment,
      }),
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
      egress: {
        ...(this.#options.egress === undefined
          ? {}
          : { egress: this.#options.egress }),
        ...(this.#options.allowLoopbackForDevelopment === undefined ? {} : {
          allowLoopbackForDevelopment:
            this.#options.allowLoopbackForDevelopment,
        }),
      },
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
  ): Promise<ReservedTokenSet> {
    const reservation = reserveGrantCapacity(this);
    try {
      return {
        ...await this.#fetchToken(params, signal),
        [capacityReservation]: reservation,
      };
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  async #fetchToken(
    params: FormParams,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    for (const [name, value] of Object.entries(params)) {
      for (const item of typeof value === "string" ? [value] : value ?? []) {
        if (item.length > (name.includes("token") ? 16_384 : 4096)) {
          throw new OAuthError(
            "token",
            "a token request field exceeds its limit",
          );
        }
        if (name === "resource") checkSecureUrl(item, "resource");
      }
    }
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
    strictRecord(options as unknown, [
      "scope",
      "resource",
      "state",
      "dpopJkt",
      "extra",
      "signal",
    ], "authorization options");
    scopeList(options.scope);
    options.signal?.throwIfAborted();
    if (options.extra !== undefined) {
      jsonSnapshot(options.extra);
      if (
        Object.keys(options.extra).length > 64 ||
        Object.entries(options.extra).some(([name, value]) =>
          name.length > 256 || typeof value !== "string" ||
          value.length > 4096 ||
          [
            "client_secret",
            "client_assertion",
            "client_assertion_type",
            "access_token",
            "refresh_token",
            "code_verifier",
            "code",
            "request_uri",
          ].includes(name)
        )
      ) {
        throw new TypeError(
          "authorization extensions must be bounded noncredential parameters",
        );
      }
    }
    if (
      (options.scope?.length ?? 0) > 256 ||
      options.scope?.some((s) =>
        typeof s !== "string" || s.length > 256 || !isScopeToken(s)
      )
    ) throw new TypeError("scope must contain bounded scope tokens");
    if (
      options.state !== undefined &&
      (typeof options.state !== "string" || options.state.length < 16 ||
        options.state.length > 4096)
    ) throw new TypeError("state must be 16..4096 characters");
    if (options.dpopJkt !== undefined && typeof options.dpopJkt !== "boolean") {
      throw new TypeError("dpopJkt must be boolean");
    }
    for (const resource of list(options.resource)) {
      checkSecureUrl(resource, "resource");
    }
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
    if (url.href.length > 16_384) {
      throw new OAuthError(
        "authorization",
        "the authorization URL exceeds its limit",
      );
    }
    const pending = snapshot({
      url: url.href,
      state,
      verifier,
      redirectUri,
      clientId: this.clientId,
      issuer: this.issuer,
      scope,
      resource,
      issRequired:
        this.#options.unsafeAllowMissingAuthorizationIssuer !== true ||
        metadata.authorization_response_iss_parameter_supported === true,
      ...(dpopJkt === undefined ? {} : { dpopJkt }),
      ...(options.extra === undefined ? {} : { extra: options.extra }),
    }) as unknown as PendingAuthorization;
    this.#pending.add(pending);
    authenticPending.add(pending);
    return pending;
  }

  /** Restores only an authenticated confidential pending-flow record. Never call on request JSON. */
  unsafeRestorePending(value: unknown): PendingAuthorization {
    value = jsonSnapshot(value);
    strictRecord(value, [
      "url",
      "state",
      "verifier",
      "redirectUri",
      "clientId",
      "issuer",
      "scope",
      "resource",
      "issRequired",
      "dpopJkt",
      "extra",
    ], "pending authorization");
    if (
      value.issuer !== this.issuer || value.clientId !== this.clientId ||
      value.redirectUri !== this.#options.redirectUri ||
      typeof value.state !== "string" || value.state.length < 16 ||
      value.state.length > 4096 || typeof value.verifier !== "string" ||
      !isCodeVerifier(value.verifier) ||
      typeof value.issRequired !== "boolean" ||
      typeof value.scope !== "string" || value.scope.length > 4096 ||
      !Array.isArray(value.resource) || value.resource.length > 64 ||
      typeof value.url !== "string" || value.url.length > 16_384 ||
      (value.dpopJkt !== undefined && value.dpopJkt !== this.dpop?.jkt)
    ) {
      throw new OAuthError(
        "authorization",
        "the persisted pending flow is invalid",
      );
    }
    for (const r of value.resource) checkSecureUrl(r, "pending resource");
    scopeList(parseScope(value.scope));
    const authorizationUrl = new URL(value.url);
    authorizationUrl.search = "";
    checkSecureUrl(authorizationUrl, "authorization URL");
    if (
      value.extra !== undefined &&
      (!isObject(value.extra) || Object.keys(value.extra).length > 64 ||
        Object.entries(value.extra).some(([name, item]) =>
          name.length > 256 || typeof item !== "string" || item.length > 4096
        ))
    ) {
      throw new OAuthError(
        "authorization",
        "the persisted pending extensions are invalid",
      );
    }
    const pending = jsonSnapshot(value) as unknown as PendingAuthorization;
    this.#pending.add(pending);
    authenticPending.add(pending);
    return pending;
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
    if (!this.#pending.has(pending)) {
      throw new OAuthError(
        "authorization",
        "the pending flow was not issued or authenticated by this client generation",
      );
    }
    if (
      String(callback).length > 16_384 || pending.issuer !== this.issuer ||
      pending.clientId !== this.clientId ||
      pending.redirectUri !== this.#options.redirectUri
    ) {
      throw new OAuthError(
        "authorization",
        "the callback or pending flow is invalid",
      );
    }
    const url = new URL(String(callback));
    const registered = new URL(pending.redirectUri);
    if (
      String(callback).split(/[?#]/, 1)[0] !==
        pending.redirectUri.split(/[?#]/, 1)[0] ||
      (registered.search !== "" && url.search !== registered.search &&
        !url.search.startsWith(registered.search + "&"))
    ) {
      throw new OAuthError(
        "authorization",
        "the callback changed the registered redirect spelling",
      );
    }
    if (
      url.origin !== registered.origin ||
      url.pathname !== registered.pathname || url.username !== "" ||
      url.password !== "" || url.hash !== ""
    ) {
      throw new OAuthError(
        "authorization",
        "the callback does not match the registered redirect URI",
      );
    }
    const params = url.searchParams;
    for (const key of ["iss", "state", "code", "error", "error_description"]) {
      if (params.getAll(key).length > 1) {
        throw new OAuthError(
          "authorization",
          "the callback repeats a singleton parameter",
        );
      }
    }
    for (const key of new Set(registered.searchParams.keys())) {
      if (
        JSON.stringify(params.getAll(key)) !==
          JSON.stringify(registered.searchParams.getAll(key))
      ) {
        throw new OAuthError(
          "authorization",
          "the callback changed a registered query parameter",
        );
      }
    }
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
    } else if (
      this.#options.unsafeAllowMissingAuthorizationIssuer !== true ||
      pending.issRequired
    ) {
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
        "authorization failed at the authorization server",
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
  ): Promise<AuthorizedGrant> {
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
    return this.#grant(
      { ...tokens, requested_scope: pending.scope },
      pending.resource,
      parseScope(pending.scope),
      GRANT_TYPES.authorizationCode,
    );
  }

  #grant(
    tokens: TokenSet,
    resources: readonly string[],
    scopes: readonly string[],
    grantType: string,
  ): AuthorizedGrant {
    const { [capacityReservation]: reservation, ...plain } =
      tokens as ReservedTokenSet;
    reservation?.release();
    return mintGrant(plain, {
      issuer: this.issuer,
      clientId: this.clientId,
      resources,
      requestedScopes: scopes,
      grantType,
      acquiredAt: this.#now(),
      ...(this.dpop === undefined ? {} : { dpopJkt: this.dpop.jkt }),
    }, this);
  }

  /** Synchronous brand/owner/key check; use validateGrant before directly using stored credentials. */
  assertGrant(grant: unknown): asserts grant is AuthorizedGrant {
    assertAuthorizedGrant(grant, {
      issuer: this.issuer,
      clientId: this.clientId,
      dpopJkt: this.dpop?.jkt,
      owner: this,
    });
  }

  /** Validates immutable generation identity as well as brand/owner/key before credential use. */
  async validateGrant(grant: AuthorizedGrant): Promise<void> {
    await assertGrantIdentity(grant);
    this.assertGrant(grant);
  }

  /** Only after reading an authenticated confidential store; transfers ownership to this client generation. */
  unsafeRestoreGrant(value: unknown): AuthorizedGrant {
    return unsafeRestoreGrant(value, {
      issuer: this.issuer,
      clientId: this.clientId,
      dpopJkt: this.dpop?.jkt,
      owner: this,
    });
  }

  /** Builds credential headers only for a destination covered by the grant. */
  async resourceHeaders(
    grant: AuthorizedGrant,
    resource: string,
    url: string | URL,
    method = "GET",
  ): Promise<Readonly<Record<string, string>>> {
    await this.validateGrant(grant);
    assertAuthorizedGrant(grant, {
      issuer: this.issuer,
      clientId: this.clientId,
      dpopJkt: this.dpop?.jkt,
      resource,
    });
    if (
      !resourceCovers(resource, url) ||
      (grant.expires_at !== undefined && grant.expires_at <= this.#now())
    ) {
      throw new OAuthError(
        "token",
        "the grant does not cover this destination or has expired",
      );
    }
    const headers: Record<string, string> = {
      authorization: `${grant.token_type} ${grant.access_token}`,
    };
    if (grant.token_type === "DPoP") {
      if (this.dpop === undefined) {
        throw new OAuthError("dpop", "the grant needs its proof key");
      }
      headers.dpop = await this.dpop.proof({
        method,
        url,
        accessToken: grant.access_token,
      });
    }
    return Object.freeze(headers);
  }

  /**
   * Uses a refresh token (RFC 6749 section 6). Servers rotate refresh
   * tokens; when this one does not, the old one is kept in the result.
   */
  async refresh(
    grant: AuthorizedGrant,
    options: {
      readonly scope?: readonly string[];
      readonly resource?: string | readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<AuthorizedGrant> {
    strictRecord(
      options as unknown,
      ["scope", "resource", "signal"],
      "refresh options",
    );
    scopeList(options.scope);
    const requestedScope = options.scope === undefined
      ? undefined
      : jsonSnapshot(options.scope);
    const requestedResource = options.resource === undefined
      ? undefined
      : list(options.resource);
    const signal = options.signal;
    signal?.throwIfAborted();
    await assertGrantIdentity(grant);
    signal?.throwIfAborted();
    this.assertGrant(grant);
    assertRefreshable(grant);
    assertAuthorizedGrant(grant, {
      issuer: this.issuer,
      clientId: this.clientId,
      dpopJkt: this.dpop?.jkt,
    });
    if (grant.refresh_token === undefined) {
      throw new OAuthError("token", "the grant has no refresh token");
    }
    const resource = requestedResource === undefined
      ? [...grant.provenance.resources]
      : requestedResource;
    const scope = requestedScope ?? grant.provenance.grantedScopes;
    if (
      resource.some((r) => !grant.provenance.resources.includes(r)) ||
      scope.some((s) => !grant.provenance.grantedScopes.includes(s))
    ) throw new OAuthError("token", "refresh cannot widen grant authority");
    const policy = JSON.stringify([resource, scope]);
    const state = grantRefreshState(grant);
    let pending = state.pending;
    if (pending !== undefined && pending.policy !== policy) {
      throw new OAuthError(
        "token",
        "concurrent refresh must request identical resource and scope attenuation",
      );
    }
    if (pending === undefined) {
      assertGrantCapacity(this);
      // A caller's cancellation only stops its own wait. Once a rotating
      // refresh is sent it must finish for other waiters, under the endpoint
      // timeout; aborting that shared request risks losing its successor.
      const promise = this.unsafeRefresh(grant.refresh_token, {
        issuer: this.issuer,
        clientId: this.clientId,
        resource,
        scope,
      }).then((next) => {
        retireGrant(grant);
        return next;
      }, (error) => {
        // A transport/server failure cannot prove the rotating credential
        // remained unspent. Keep any live access token usable, but never send
        // this refresh credential again through the safe API.
        markRefreshUncertain(grant);
        throw error;
      }).finally(() => {
        state.pending = undefined;
      });
      pending = { policy, promise };
      state.pending = pending;
    }
    if (signal === undefined) return await pending.promise;
    return await new Promise<AuthorizedGrant>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending!.promise.then(resolve, reject).finally(() =>
        signal.removeEventListener("abort", abort)
      );
      if (signal.aborted) abort();
    });
  }

  /** Raw persistence migration only; caller explicitly attests issuer/client/resource/scope. Prefer refresh(grant). */
  async unsafeRefresh(
    refreshToken: string,
    options: {
      readonly issuer: string;
      readonly clientId: string;
      readonly resource: string | readonly string[];
      readonly scope: readonly string[];
      readonly signal?: AbortSignal;
    },
  ): Promise<AuthorizedGrant> {
    strictRecord(options as unknown, [
      "issuer",
      "clientId",
      "resource",
      "scope",
      "signal",
    ], "unsafeRefresh options");
    scopeList(options.scope);
    if (
      typeof refreshToken !== "string" || refreshToken.length === 0 ||
      refreshToken.length > 16_384
    ) throw new OAuthError("token", "invalid refresh token length");
    if (options.issuer !== this.issuer || options.clientId !== this.clientId) {
      throw new OAuthError(
        "token",
        "refresh provenance does not match this client",
      );
    }
    const resource = list(options.resource);
    const tokens = await this.#token({
      grant_type: GRANT_TYPES.refreshToken,
      refresh_token: refreshToken,
      scope: options.scope === undefined
        ? undefined
        : formatScope(options.scope),
      resource: resource.length === 0 ? undefined : resource,
    }, options.signal);
    return this.#grant(
      { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken },
      resource,
      options.scope,
      GRANT_TYPES.refreshToken,
    );
  }

  /** The client credentials grant (RFC 6749 section 4.4); a confidential client only. */
  async clientCredentials(
    options: {
      readonly scope?: readonly string[];
      readonly resource?: string | readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<AuthorizedGrant> {
    strictRecord(
      options as unknown,
      ["scope", "resource", "signal"],
      "clientCredentials options",
    );
    scopeList(options.scope);
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
    return this.#grant(
      { ...tokens, requested_scope: scope },
      resource,
      options.scope ?? [],
      GRANT_TYPES.clientCredentials,
    );
  }

  /** Token exchange (RFC 8693). */
  async tokenExchange(
    request: TokenExchangeRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AuthorizedGrant> {
    strictRecord(request, [
      "subjectToken",
      "subjectTokenType",
      "actorToken",
      "actorTokenType",
      "requestedTokenType",
      "resource",
      "audience",
      "scope",
    ], "token exchange request");
    strictRecord(options as unknown, ["signal"], "token exchange options");
    scopeList(request.scope);
    credential(request.subjectToken);
    if (request.actorToken !== undefined) credential(request.actorToken);
    if (
      (request.actorToken === undefined) !==
        (request.actorTokenType === undefined)
    ) {
      throw new TypeError("actorToken and actorTokenType go together");
    }
    const resource = list(request.resource);
    const audience = list(request.audience);
    for (const target of resource.length > 0 ? resource : audience) {
      checkSecureUrl(target, "grant target (aliases need explicit resource)");
    }
    const tokens = await this.#token({
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
    return this.#grant(
      tokens,
      resource.length > 0 ? resource : audience,
      request.scope ?? [],
      GRANT_TYPES.tokenExchange,
    );
  }

  /** Starts the device authorization grant (RFC 8628 section 3.1). */
  async deviceAuthorization(
    options: {
      readonly scope?: readonly string[];
      readonly resource?: string | readonly string[];
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DeviceAuthorization> {
    strictRecord(
      options as unknown,
      ["scope", "resource", "signal"],
      "deviceAuthorization options",
    );
    scopeList(options.scope);
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
    // The server's numbers drive a timer and a deadline: whole seconds,
    // `expires_in` at most a day and `interval` at most five minutes.
    const expiresIn = boundedSeconds(body.expires_in, 1, DAY_SEC);
    const interval = body.interval === undefined
      ? 5
      : boundedSeconds(body.interval, 1, MAX_INTERVAL_SEC);
    if (
      deviceCode === null || userCode === null || uri === null ||
      expiresIn === null || interval === null
    ) {
      throw new OAuthError(
        "token",
        "the device authorization response is incomplete or out of range",
        { issuer: this.issuer },
      );
    }
    const complete = text("verification_uri_complete");
    checkSecureUrl(uri, "verification_uri");
    if (
      new URL(uri).protocol !== "https:" &&
      this.#options.allowLoopbackForDevelopment !== true
    ) throw new OAuthError("token", "verification_uri requires HTTPS");
    if (
      complete !== null &&
      (checkSecureUrl(complete, "verification_uri_complete").origin !==
        new URL(uri).origin)
    ) {
      throw new OAuthError(
        "token",
        "verification_uri_complete must share its base origin",
      );
    }
    if (
      [deviceCode, userCode, uri, complete ?? ""].some((v) => v.length > 4096)
    ) {
      throw new OAuthError(
        "token",
        "a device authorization field exceeds its limit",
      );
    }
    const device = snapshot({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: uri,
      ...(complete === null ? {} : { verification_uri_complete: complete }),
      expires_at: this.#now() + expiresIn * 1000,
      interval,
      issuer: this.issuer,
      clientId: this.clientId,
      resource,
      scope: options.scope ?? [],
      ...(this.dpop === undefined ? {} : { dpopJkt: this.dpop.jkt }),
    }) as unknown as DeviceAuthorization;
    this.#devices.add(device);
    return device;
  }

  /** Restores a device request only from authenticated confidential storage. */
  unsafeRestoreDevice(
    value: Omit<DeviceAuthorization, typeof deviceAuthorizationBrand>,
  ): DeviceAuthorization {
    value = jsonSnapshot(value);
    strictRecord(value, [
      "device_code",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
      "expires_at",
      "interval",
      "issuer",
      "clientId",
      "resource",
      "scope",
      "dpopJkt",
    ], "device authorization");
    if (
      value.issuer !== this.issuer || value.clientId !== this.clientId ||
      value.dpopJkt !== this.dpop?.jkt ||
      typeof value.device_code !== "string" || value.device_code.length === 0 ||
      value.device_code.length > 4096
    ) throw new OAuthError("token", "the persisted device flow is invalid");
    safeInt(value.interval, {
      name: "device.interval",
      min: 1,
      max: MAX_INTERVAL_SEC,
    });
    finite(value.expires_at, { name: "device.expires_at" });
    scopeList(value.scope);
    if (
      !Array.isArray(value.resource) || value.resource.length > 64 ||
      typeof value.user_code !== "string" || value.user_code.length === 0 ||
      value.user_code.length > 4096
    ) throw new OAuthError("token", "the persisted device flow is invalid");
    for (const r of value.resource) checkSecureUrl(r, "device resource");
    const uri = checkSecureUrl(value.verification_uri, "verification_uri");
    if (
      uri.protocol !== "https:" &&
      this.#options.allowLoopbackForDevelopment !== true
    ) throw new OAuthError("token", "verification_uri requires HTTPS");
    if (
      value.verification_uri_complete !== undefined &&
      checkSecureUrl(
          value.verification_uri_complete,
          "verification_uri_complete",
        ).origin !== uri.origin
    ) {
      throw new OAuthError(
        "token",
        "verification_uri_complete must share its base origin",
      );
    }
    const device = jsonSnapshot(value) as DeviceAuthorization;
    this.#devices.add(device);
    return device;
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
  ): Promise<AuthorizedGrant> {
    strictRecord(
      options as unknown,
      ["signal", "sleep"],
      "device polling options",
    );
    if (options.sleep !== undefined && typeof options.sleep !== "function") {
      throw new TypeError("sleep must be a function");
    }
    if (!this.#devices.has(device)) {
      throw new OAuthError(
        "token",
        "the device flow was not issued or authenticated by this client generation",
      );
    }
    if (
      device.issuer !== this.issuer || device.clientId !== this.clientId ||
      device.dpopJkt !== this.dpop?.jkt
    ) {
      throw new OAuthError(
        "token",
        "the device authorization belongs to another client or key",
      );
    }
    const wait = options.sleep ?? sleep;
    let interval = safeInt(device.interval, {
      name: "device.interval",
      min: 1,
      max: MAX_INTERVAL_SEC,
    });
    finite(device.expires_at, { name: "device.expires_at" });
    for (;;) {
      if (this.#now() >= device.expires_at) {
        throw new OAuthError(
          "authorization",
          "the device code expired before the user decided",
          { error: "expired_token", issuer: this.issuer },
        );
      }
      await wait(interval * 1000, options.signal);
      options.signal?.throwIfAborted();
      if (this.#now() >= device.expires_at) continue;
      try {
        const tokens = await this.#token({
          grant_type: GRANT_TYPES.deviceCode,
          device_code: device.device_code,
        }, options.signal);
        return this.#grant(
          tokens,
          device.resource,
          device.scope,
          GRANT_TYPES.deviceCode,
        );
      } catch (error) {
        if (!(error instanceof OAuthError) || error.kind !== "token") {
          throw error;
        }
        if (error.error === "authorization_pending") continue;
        if (error.error === "slow_down") {
          interval = Math.min(interval + 5, MAX_INTERVAL_SEC);
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
    strictRecord(options as unknown, ["hint", "signal"], "revocation options");
    credential(token);
    if (
      options.hint !== undefined &&
      !["access_token", "refresh_token"].includes(options.hint)
    ) throw new TypeError("invalid token type hint");
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
    strictRecord(
      options as unknown,
      ["hint", "signal"],
      "introspection options",
    );
    credential(token);
    if (
      options.hint !== undefined &&
      !["access_token", "refresh_token"].includes(options.hint)
    ) throw new TypeError("invalid token type hint");
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
    return jsonSnapshot(body) as unknown as IntrospectionResponse;
  }
}
