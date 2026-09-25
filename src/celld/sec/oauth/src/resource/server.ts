// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link ResourceServer}: deciding whether a request carries a valid
 * access token, and saying what it needs when it does not.
 *
 * ```ts
 * const api = new ResourceServer({
 *   resource: "https://api.example.com",
 *   authorizationServers: ["https://auth.example.com"],
 *   verifier: jwtAccessTokenVerifier({
 *     issuer: "https://auth.example.com",
 *     audience: "https://api.example.com",
 *     keys: "https://auth.example.com/jwks",
 *   }),
 *   dpop: { replay: durableReplayStore(env.OAUTH_RECORDS) }, // or `false`
 * });
 *
 * const result = await api.verifyRequest(request, { scopes: ["files:read"] });
 * if (!result.ok) return result.challenge.toResponse();
 * result.principal.subject;
 * ```
 *
 * Tokens are read from the `Authorization` header only
 * (`bearer_methods_supported: ["header"]`), under either scheme:
 *
 * - `Bearer`: refused when the token is DPoP-bound (it has `cnf.jkt`; a
 *   stolen bound token must not work as a bearer token), and when the
 *   server requires DPoP.
 * - `DPoP`: the token must be DPoP-bound, and the request must carry
 *   exactly one `DPoP` proof that passes `verifyDpopProof` with the
 *   token's `ath` and `jkt`, the method and URL, replay prevention, and
 *   the server's nonce when it uses them.
 *
 * `dpop` has no default: it is `false` (Bearer only) or `{ replay }` with a
 * shared, atomic {@link ReplayStore}, so each proof is accepted once. A
 * server nonce may accompany the replay store as an additional defense.
 * `unsafeNoReplay: true` is the explicit opt-out for a caller that enforces
 * single use elsewhere; without it, a missing replay store is refused.
 *
 * Refusals are {@link Challenge}s with the right status and a
 * `WWW-Authenticate` naming every accepted scheme (`Bearer` with `realm`,
 * `DPoP` with `algs`), `resource_metadata` (RFC 9728), and the `error`,
 * `error_description` and `scope` on the scheme the request used.
 *
 * @module
 */

import { formatChallenge } from "../challenge.ts";
import { jsonSnapshot, strictRecord } from "@celld/core/bounds";
import { assertAlgorithmsSupported } from "@celld/sec/jwt";
import {
  DEFAULT_DPOP_ALGORITHMS,
  type DpopAlgorithm,
  isDpopAlgorithm,
} from "../dpop/key.ts";
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
  checkSecureUrl,
  isIssuer,
  type ProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  resourceCovers,
} from "../metadata.ts";
import {
  type Clock,
  defaultClock,
  isObject,
  isScopeToken,
  jsonResponse,
  NO_STORE,
  rethrowRuntimeUnsupported,
  snapshot,
  snapshotOptions,
} from "../util.ts";
import type { AccessTokenVerifier, VerifiedToken } from "./verifier.ts";

/** Who a request is from, as far as its token says. */
export interface Principal {
  /** `sub`, or the client id for a token without one. */
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
  readonly clientId?: string;
  /**
   * The authorization server that issued the token, always one of
   * `authorizationServers`: the verifier's, or the only server when the
   * verifier names none. A router principal's ownership `key` includes it.
   */
  readonly issuer: string;
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
  /** For a DPoP-bound token: the key's thumbprint. */
  readonly cnf?: { readonly jkt?: string };
  /** The scheme the token came under. */
  readonly tokenType: "Bearer" | "DPoP";
}

/** A refusal: what to answer instead of serving the request. */
export interface Challenge {
  /** 400, 401, 403 or 503. */
  readonly status: number;
  /** The OAuth error code, absent when the request had no credentials at all. */
  readonly error?: string;
  readonly description?: string;
  /** `WWW-Authenticate`, and `DPoP-Nonce` when one is due. */
  readonly headers: Readonly<Record<string, string>>;
  /** A response with an empty body (or an error body for 400 and 503). */
  toResponse(): Response;
}

/** The outcome of {@link ResourceServer.verifyRequest}. */
export type AuthResult =
  | {
    readonly ok: true;
    readonly principal: Principal;
    /** Headers to add to the response (private no-store and a fresh `DPoP-Nonce`). */
    readonly headers: Readonly<Record<string, string>>;
  }
  | { readonly ok: false; readonly challenge: Challenge };

/** The request, as {@link ResourceServer.verify} needs it. */
export interface RequestParts {
  readonly method: string;
  /** The full URL the client used (the public URL behind a proxy). */
  readonly url: string | URL;
  /** The `Authorization` header, if any. */
  readonly authorization: string | null;
  /** The `DPoP` header, if any. Repeated headers joined with commas are refused. */
  readonly dpop: string | null;
}

interface ResourceDpopBase {
  /** Refuse Bearer tokens altogether; default false. */
  readonly required?: boolean;
  /** Default `DEFAULT_DPOP_ALGORITHMS`. */
  readonly algorithms?: readonly DpopAlgorithm[];
  /** How old a proof may be, in seconds (1 to 3600); default 60. */
  readonly maxAgeSec?: number;
  /** Clock skew allowed on a proof's `iat`, in seconds (0 to 300); default 5. */
  readonly clockToleranceSec?: number;
}

/**
 * How a resource server treats DPoP. Replay-safe operation requires a shared,
 * atomic `replay` store so each proof's `jti` is accepted once; `nonce` is an
 * optional additional defense against proof pre-generation. A deployment
 * that enforces single use outside this server may instead say
 * `unsafeNoReplay: true` explicitly. Server nonces are reusable and do not by
 * themselves prevent a captured proof from being replayed.
 */
export type ResourceDpopOptions =
  & ResourceDpopBase
  & (
    | {
      readonly replay: ReplayStore;
      readonly nonce?: DpopNonceSource;
      readonly unsafeNoReplay?: never;
    }
    | {
      readonly unsafeNoReplay: true;
      readonly replay?: never;
      readonly nonce?: DpopNonceSource;
    }
  );

/**
 * A resource server's validated, read-only DPoP settings. Adapters use these
 * to mirror the accepted schemes and challenge metadata; the
 * {@link ResourceServer} remains the sole proof verifier and replay claimant.
 */
export interface ResourceDpopPolicy {
  readonly required: boolean;
  readonly algorithms: readonly DpopAlgorithm[];
  readonly replay?: ReplayStore;
  readonly nonce?: DpopNonceSource;
  /** True only for an explicitly replayable policy. */
  readonly unsafeNoReplay: boolean;
  readonly maxAgeSec: number;
  readonly clockToleranceSec: number;
  /** The resource server's clock. */
  readonly now: Clock;
}

const DPOP_CHOICES =
  "choose dpop: false (Bearer only), dpop: { replay } (a shared atomic ReplayStore, such as durableReplayStore), or explicitly replayable dpop: { unsafeNoReplay: true }";

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/** Checks and freezes `dpop`; see {@link ResourceDpopOptions}. */
function dpopPolicy(
  dpop: unknown,
  now: Clock,
): ResourceDpopPolicy | null {
  if (dpop === false) return null;
  if (typeof dpop !== "object" || dpop === null) {
    throw new TypeError(
      `a resource server needs an explicit DPoP choice: ${DPOP_CHOICES}`,
    );
  }
  const options = dpop as Partial<ResourceDpopOptions>;
  strictRecord(dpop, [
    "required",
    "algorithms",
    "replay",
    "nonce",
    "unsafeNoReplay",
    "maxAgeSec",
    "clockToleranceSec",
  ], "dpop");
  if (options.required !== undefined && typeof options.required !== "boolean") {
    throw new TypeError("dpop.required must be boolean");
  }
  const replay = options.replay;
  const nonce = options.nonce;
  const unsafeNoReplay = options.unsafeNoReplay;
  if (unsafeNoReplay !== undefined && unsafeNoReplay !== true) {
    throw new TypeError(
      "dpop.unsafeNoReplay must be literal true when present",
    );
  }
  if (replay !== undefined && !isFunction(replay?.claim)) {
    throw new TypeError(`dpop.replay must be a ReplayStore; ${DPOP_CHOICES}`);
  }
  if (
    nonce !== undefined &&
    !(isFunction(nonce?.current) && isFunction(nonce?.check))
  ) {
    throw new TypeError(
      `dpop.nonce must be a DpopNonceSource; ${DPOP_CHOICES}`,
    );
  }
  if (replay !== undefined && unsafeNoReplay !== undefined) {
    throw new TypeError(`choose replay or unsafeNoReplay; ${DPOP_CHOICES}`);
  }
  if (replay === undefined && unsafeNoReplay !== true) {
    throw new TypeError(
      `DPoP without a replay store accepts replayed proofs; ${DPOP_CHOICES}`,
    );
  }
  const algorithms = [...(options.algorithms ?? DEFAULT_DPOP_ALGORITHMS)];
  if (algorithms.length === 0 || !algorithms.every(isDpopAlgorithm)) {
    throw new TypeError(
      "dpop.algorithms must list asymmetric JWS algorithms",
    );
  }
  const window = dpopWindow(options);
  return Object.freeze({
    required: options.required === true,
    algorithms: Object.freeze(algorithms),
    ...(replay === undefined ? {} : { replay }),
    ...(nonce === undefined ? {} : { nonce }),
    unsafeNoReplay: unsafeNoReplay === true,
    maxAgeSec: window.maxAgeSec,
    clockToleranceSec: window.clockToleranceSec,
    now,
  });
}

/** Options for {@link ResourceServer}. */
export interface ResourceServerOptions {
  /** This resource's identifier: the `resource` of its metadata and the tokens' audience. */
  readonly resource: string;
  /** The issuers whose tokens it accepts, for the metadata. */
  readonly authorizationServers: readonly string[];
  readonly verifier: AccessTokenVerifier;
  /** Scopes to advertise (never `offline_access`). */
  readonly scopesSupported?: readonly string[];
  /** Scopes every request needs. */
  readonly requiredScopes?: readonly string[];
  /**
   * DPoP handling, required: `false` accepts Bearer only; otherwise DPoP
   * is accepted alongside Bearer (or alone, with `required`), with a
   * shared replay store, optionally with server nonces. See
   * {@link ResourceDpopOptions} for the explicit unsafe opt-out.
   */
  readonly dpop: ResourceDpopOptions | false;
  /** Where the metadata is published; default RFC 9728's URL for `resource`. */
  readonly resourceMetadataUrl?: string;
  /** Explicit alternate aud values. Token claims are never URL-normalized. */
  readonly audienceAliases?: readonly string[];
  /** Permit metadata hosting outside the resource's origin. Default false. */
  readonly allowExternalMetadata?: boolean;
  /** More metadata members (`resource_name`, `resource_documentation`, ...). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** The `realm` of the challenges, if any. */
  readonly realm?: string;
  readonly now?: Clock;
}

/** Options for one {@link ResourceServer.verifyRequest}. */
export interface VerifyRequestOptions {
  /** Scopes this request needs, on top of `requiredScopes`. */
  readonly scopes?: readonly string[];
  /** The URL the client used, when `request.url` is not it (behind a proxy). */
  readonly url?: string | URL;
}

const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/** A resource server's token checks and metadata; see the module documentation. */
export class ResourceServer {
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  /** The `realm` of the challenges, if any. */
  readonly realm: string | undefined;
  readonly #options: ResourceServerOptions;
  readonly #dpop: ResourceDpopPolicy | null;
  readonly #metadata: ProtectedResourceMetadata;

  /**
   * Throws `TypeError` for insecure URLs, no servers, `offline_access`, or
   * a missing or incomplete `dpop` choice, and `RangeError` for a DPoP
   * window out of range.
   */
  constructor(input: ResourceServerOptions) {
    strictRecord(input, [
      "resource",
      "authorizationServers",
      "verifier",
      "scopesSupported",
      "requiredScopes",
      "dpop",
      "resourceMetadataUrl",
      "audienceAliases",
      "allowExternalMetadata",
      "metadata",
      "realm",
      "now",
    ], "ResourceServer options");
    if (
      input.allowExternalMetadata !== undefined &&
      typeof input.allowExternalMetadata !== "boolean"
    ) throw new TypeError("allowExternalMetadata must be boolean");
    if (
      !Array.isArray(input.authorizationServers) ||
      input.authorizationServers.length === 0 ||
      input.authorizationServers.length > 64 ||
      new Set(input.authorizationServers).size !==
        input.authorizationServers.length
    ) {
      throw new TypeError(
        "authorizationServers must be a unique bounded issuer list",
      );
    }
    if (
      typeof input.verifier?.verify !== "function" ||
      (input.now !== undefined && typeof input.now !== "function")
    ) throw new TypeError("verifier and clock must be callable");
    if (
      input.audienceAliases !== undefined &&
      (!Array.isArray(input.audienceAliases) ||
        input.audienceAliases.length > 64)
    ) throw new TypeError("audienceAliases must be a bounded list");
    if (
      input.realm !== undefined &&
      (typeof input.realm !== "string" || input.realm.length > 1024 ||
        /\p{Cc}/u.test(input.realm))
    ) throw new TypeError("realm must be bounded header text");
    if (input.metadata !== undefined) jsonSnapshot(input.metadata);
    // Read once: the verifier, required scopes, servers and realm cannot be
    // changed on the caller's object afterwards.
    const options = snapshotOptions({
      ...input,
      dpop: typeof input.dpop === "object" && input.dpop !== null
        ? snapshotOptions(input.dpop)
        : input.dpop,
    });
    checkSecureUrl(options.resource, "resource");
    if (options.authorizationServers.length === 0) {
      throw new TypeError("a resource server needs an authorization server");
    }
    for (const issuer of options.authorizationServers) {
      if (!isIssuer(issuer)) {
        throw new TypeError(
          "authorization server must be an issuer URL without query",
        );
      }
    }
    for (
      const scopes of [
        options.scopesSupported ?? [],
        options.requiredScopes ?? [],
      ]
    ) {
      if (
        !Array.isArray(scopes) || scopes.length > 256 ||
        new Set(scopes).size !== scopes.length || !scopes.every((s) =>
          typeof s === "string" && s.length <= 256 && isScopeToken(s)
        )
      ) {
        throw new TypeError(
          "scopes must be a unique bounded list of scope tokens",
        );
      }
    }
    if (
      options.scopesSupported !== undefined &&
      options.requiredScopes?.some((s) => !options.scopesSupported!.includes(s))
    ) {
      throw new TypeError(
        "requiredScopes must be advertised in scopesSupported",
      );
    }
    for (const alias of options.audienceAliases ?? []) {
      checkSecureUrl(alias, "audience alias");
    }
    if (
      [...(options.scopesSupported ?? []), ...(options.requiredScopes ?? [])]
        .includes("offline_access")
    ) {
      throw new TypeError("offline_access is not a resource scope");
    }
    this.resource = options.resource;
    this.realm = options.realm;
    this.resourceMetadataUrl = options.resourceMetadataUrl ??
      protectedResourceMetadataUrl(options.resource);
    const metadataUrl = checkSecureUrl(
      this.resourceMetadataUrl,
      "resourceMetadataUrl",
    );
    if (
      metadataUrl.origin !== new URL(this.resource).origin &&
      options.allowExternalMetadata !== true
    ) {
      throw new TypeError(
        "external resourceMetadataUrl needs allowExternalMetadata",
      );
    }
    this.#options = options;
    this.#dpop = dpopPolicy(options.dpop, options.now ?? defaultClock);
    const document: Record<string, unknown> = {
      ...options.metadata,
      resource: options.resource,
      authorization_servers: [...options.authorizationServers],
      bearer_methods_supported: ["header"],
    };
    if (options.scopesSupported !== undefined) {
      document.scopes_supported = [...options.scopesSupported];
    }
    if (this.#dpop !== null) {
      document.dpop_signing_alg_values_supported = [...this.#dpop.algorithms];
      if (this.#dpop.required) {
        document.dpop_bound_access_tokens_required = true;
      }
    }
    this.#metadata = snapshot(document) as ProtectedResourceMetadata;
    Object.freeze(this);
  }

  /** The validated DPoP settings, or null when DPoP is not accepted. */
  get dpop(): ResourceDpopPolicy | null {
    return this.#dpop;
  }

  /** The Protected Resource Metadata document (RFC 9728 section 2), frozen. */
  get metadata(): ProtectedResourceMetadata {
    return this.#metadata;
  }

  /** Call before serving traffic: probes verification/proof crypto and remote keys. */
  async ready(): Promise<void> {
    await this.#options.verifier.ready?.();
    if (this.#dpop !== null) {
      await assertAlgorithmsSupported(this.#dpop.algorithms);
    }
  }

  /** The path the metadata is served at. */
  get metadataPath(): string {
    return new URL(this.resourceMetadataUrl).pathname;
  }

  /** Serves the metadata for a GET of {@link metadataPath}; null for any other request. */
  handleMetadata(request: Request): Response | null {
    const url = new URL(request.url);
    if (
      url.origin !== new URL(this.resourceMetadataUrl).origin ||
      url.pathname !== this.metadataPath
    ) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    return this.metadataResponse();
  }

  /** The metadata as a 200 response, cacheable for five minutes, whatever the request. */
  metadataResponse(): Response {
    return jsonResponse(200, this.#metadata, {
      "cache-control": "max-age=300",
    });
  }

  #challenge(
    status: number,
    scheme: "Bearer" | "DPoP" | null,
    error?: string,
    description?: string,
    scope?: readonly string[],
    extra: Record<string, string> = {},
  ): Challenge {
    const dpop = this.#dpop;
    const bearer = dpop === null || !dpop.required;
    const params = (mine: boolean) => ({
      ...(mine && error !== undefined ? { error } : {}),
      ...(mine && description !== undefined
        ? { error_description: safeDescription(description) }
        : {}),
      ...(mine && scope !== undefined && scope.length > 0
        ? { scope: scope.join(" ") }
        : {}),
      resource_metadata: this.resourceMetadataUrl,
    });
    const challenges: string[] = [];
    if (bearer) {
      challenges.push(formatChallenge("Bearer", {
        realm: this.#options.realm,
        ...params(scheme !== "DPoP"),
      }));
    }
    if (dpop !== null) {
      challenges.push(formatChallenge("DPoP", {
        realm: this.#options.realm,
        algs: dpop.algorithms.join(" "),
        ...params(scheme === "DPoP" || !bearer),
      }));
    }
    const headers = {
      ...NO_STORE,
      "www-authenticate": challenges.join(", "),
      ...extra,
    };
    return {
      status,
      error,
      description,
      headers: Object.freeze(headers),
      toResponse: () =>
        status === 400 || status === 503
          ? new ProtocolError(error ?? "invalid_request", {
            status,
            description,
            headers,
          }).toResponse()
          : new Response(null, { status, headers }),
    };
  }

  async #nonceHeader(): Promise<Record<string, string>> {
    const source = this.#dpop?.nonce;
    return source === undefined ? {} : { "dpop-nonce": await source.current() };
  }

  /** {@link verify} over a `Request`'s headers. */
  async verifyRequest(
    request: Request,
    options: VerifyRequestOptions = {},
  ): Promise<AuthResult> {
    return await this.verify({
      method: request.method,
      url: options.url ?? request.url,
      authorization: request.headers.get("authorization"),
      dpop: request.headers.get("dpop"),
    }, options);
  }

  /**
   * Checks a request's credentials; see the module documentation. Never
   * throws for a bad request: every refusal is a {@link Challenge}. A
   * token signed with an algorithm the runtime cannot verify
   * (`JwtError` `runtime_unsupported`) is thrown, as a server fault.
   */
  async verify(
    request: RequestParts,
    options: VerifyRequestOptions = {},
  ): Promise<AuthResult> {
    strictRecord(
      options as unknown,
      ["url", "scopes"],
      "resource verification options",
    );
    if (
      options.scopes !== undefined &&
      (!Array.isArray(options.scopes) || options.scopes.length > 256 ||
        options.scopes.some((s) =>
          typeof s !== "string" || s.length > 256 || !isScopeToken(s)
        ))
    ) throw new TypeError("scopes must contain bounded scope tokens");
    const fail = (challenge: Challenge): AuthResult => ({
      ok: false,
      challenge,
    });
    if (
      typeof request.method !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(request.method) ||
      !resourceCovers(this.resource, request.url)
    ) {
      return fail(
        this.#challenge(
          401,
          null,
          "invalid_token",
          "the request is outside this resource",
        ),
      );
    }
    const required = [
      ...(this.#options.requiredScopes ?? []),
      ...(options.scopes ?? []),
    ];
    const header = request.authorization;
    if (header === null || header.trim() === "") {
      return fail(this.#challenge(401, null, undefined, undefined, required));
    }
    const match = header.length <= 16_400
      ? /^([A-Za-z]+)[ ]+(\S+)$/.exec(header.trim())
      : null;
    const scheme = match?.[1].toLowerCase();
    if (
      match === null || !TOKEN68.test(match[2]) ||
      (scheme !== "bearer" && scheme !== "dpop")
    ) {
      return fail(this.#challenge(
        400,
        null,
        "invalid_request",
        "the Authorization header is not a Bearer or DPoP token",
      ));
    }
    const token = match[2];
    if (token.length > 16_384) {
      return fail(
        this.#challenge(
          400,
          null,
          "invalid_request",
          "the access token exceeds its limit",
        ),
      );
    }
    const used = scheme === "dpop" ? "DPoP" : "Bearer";
    const dpop = this.#dpop;
    if (used === "DPoP" && dpop === null) {
      return fail(this.#challenge(
        401,
        null,
        "invalid_token",
        "DPoP tokens are not accepted",
      ));
    }
    if (used === "Bearer" && dpop?.required) {
      return fail(this.#challenge(
        401,
        "DPoP",
        "invalid_token",
        "this resource requires DPoP-bound tokens",
      ));
    }
    let verified: VerifiedToken;
    try {
      verified = await this.#options.verifier.verify(token);
      strictRecord(verified, [
        "subject",
        "scopes",
        "clientId",
        "issuer",
        "audience",
        "expiresAt",
        "cnf",
        "claims",
      ], "verified token");
      if (
        !isObject(verified) || typeof verified.subject !== "string" ||
        verified.subject.length === 0 || verified.subject.length > 4096 ||
        !Array.isArray(verified.audience) || verified.audience.length === 0 ||
        verified.audience.length > 64 || !verified.audience.every((a) =>
          typeof a === "string" && a.length > 0 && a.length <= 4096
        ) ||
        !verified.audience.some((audience) =>
          audience === this.resource ||
          (this.#options.audienceAliases ?? []).includes(audience)
        ) ||
        !Array.isArray(verified.scopes) || verified.scopes.length > 256 ||
        !verified.scopes.every((s) =>
          typeof s === "string" && s.length <= 256 && isScopeToken(s)
        ) ||
        !isObject(verified.claims) ||
        (verified.clientId !== undefined &&
          (typeof verified.clientId !== "string" ||
            verified.clientId.length === 0 ||
            verified.clientId.length > 4096)) ||
        (verified.expiresAt !== undefined &&
          (typeof verified.expiresAt !== "number" ||
            !Number.isFinite(verified.expiresAt) ||
            verified.expiresAt <= (this.#options.now ?? defaultClock)())) ||
        (verified.cnf !== undefined &&
          (!isObject(verified.cnf) || typeof verified.cnf.jkt !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(verified.cnf.jkt)))
      ) {
        throw new ProtocolError("invalid_token", {
          status: 401,
          description:
            "the verified token is malformed or does not authorize this resource",
        });
      }
      // Claims from custom verifiers obey the same bounded JSON contract as
      // decoded JWT/introspection claims: no getters, cycles or mutable hosts.
      verified = snapshot({
        ...verified,
        claims: jsonSnapshot(verified.claims),
        ...(verified.cnf === undefined
          ? {}
          : { cnf: jsonSnapshot(verified.cnf) }),
      });
    } catch (error) {
      // A token the runtime cannot verify is a server fault, not a bad token.
      rethrowRuntimeUnsupported(error);
      if (error instanceof ProtocolError && error.status === 503) {
        return fail(
          this.#challenge(
            503,
            used,
            error.code,
            error.description ?? undefined,
          ),
        );
      }
      const description = error instanceof ProtocolError
        ? error.description ?? undefined
        : "the token is invalid";
      return fail(this.#challenge(401, used, "invalid_token", description));
    }
    // The issuer is part of the principal's ownership key: with several
    // authorization servers, a verifier that does not name it would make
    // the same `sub` from two issuers one owner.
    const servers = this.#options.authorizationServers;
    let issuer = verified.issuer;
    if (issuer === undefined) {
      if (servers.length !== 1) {
        throw new TypeError(
          "the access token verifier must name the token's issuer when the resource trusts several authorization servers",
        );
      }
      issuer = servers[0];
    } else if (!servers.includes(issuer)) {
      return fail(this.#challenge(
        401,
        used,
        "invalid_token",
        "the token is from an issuer this resource does not trust",
      ));
    }
    const jkt = verified.cnf?.jkt;
    let headers: Record<string, string> = {
      "cache-control": "private, no-store",
    };
    if (used === "Bearer") {
      if (jkt !== undefined) {
        return fail(this.#challenge(
          401,
          "Bearer",
          "invalid_token",
          "a DPoP-bound token must be presented with the DPoP scheme",
        ));
      }
    } else {
      if (jkt === undefined) {
        return fail(this.#challenge(
          401,
          "DPoP",
          "invalid_token",
          "the token is not DPoP-bound",
        ));
      }
      {
        try {
          const proofHeaders = new Headers();
          if (request.dpop !== null) proofHeaders.set("dpop", request.dpop);
          const proof = singleDpopHeader(proofHeaders);
          if (proof === null) {
            throw new DpopError(
              "invalid_dpop_proof",
              "the request has no DPoP proof",
            );
          }
          await verifyDpopProof(proof, {
            method: request.method,
            url: request.url,
            accessToken: token,
            jkt,
            algorithms: dpop!.algorithms,
            ...(dpop!.replay === undefined
              ? { unsafeNoReplay: true as const, nonce: dpop!.nonce }
              : { replay: dpop!.replay, nonce: dpop!.nonce }),
            maxAgeSec: dpop!.maxAgeSec,
            clockToleranceSec: dpop!.clockToleranceSec,
            now: dpop!.now,
          });
        } catch (error) {
          if (!(error instanceof DpopError)) throw error;
          return fail(this.#challenge(
            401,
            "DPoP",
            error.code,
            error.message,
            undefined,
            error.code === "use_dpop_nonce" ? await this.#nonceHeader() : {},
          ));
        }
      }
      headers = { ...headers, ...await this.#nonceHeader() };
    }
    const missing = required.filter((scope) =>
      !verified.scopes.includes(scope)
    );
    if (missing.length > 0) {
      return fail(this.#challenge(
        403,
        used,
        "insufficient_scope",
        `the token lacks ${missing.join(" ")}`,
        required,
      ));
    }
    return {
      ok: true,
      principal: snapshot({
        subject: verified.subject,
        scopes: verified.scopes,
        claims: verified.claims,
        tokenType: used,
        ...(verified.clientId === undefined
          ? {}
          : { clientId: verified.clientId }),
        issuer,
        ...(verified.expiresAt === undefined
          ? {}
          : { expiresAt: verified.expiresAt }),
        ...(jkt === undefined ? {} : { cnf: { jkt } }),
      }),
      headers: Object.freeze(headers),
    };
  }
}
