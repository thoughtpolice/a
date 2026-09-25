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
 *   dpop: { replay: memoryReplayStore() },
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
 * Refusals are {@link Challenge}s with the right status and a
 * `WWW-Authenticate` naming every accepted scheme (`Bearer` with `realm`,
 * `DPoP` with `algs`), `resource_metadata` (RFC 9728), and the `error`,
 * `error_description` and `scope` on the scheme the request used.
 *
 * @module
 */

import { formatChallenge } from "../challenge.ts";
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
  checkSecureUrl,
  type ProtectedResourceMetadata,
  protectedResourceMetadataUrl,
} from "../metadata.ts";
import {
  type Clock,
  defaultClock,
  jsonResponse,
  rethrowRuntimeUnsupported,
} from "../util.ts";
import type { AccessTokenVerifier, VerifiedToken } from "./verifier.ts";

/** Who a request is from, as far as its token says. */
export interface Principal {
  /** `sub`, or the client id for a token without one. */
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
  readonly clientId?: string;
  readonly issuer?: string;
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
    /** Headers to add to the response (a fresh `DPoP-Nonce`). */
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

/** How a resource server treats DPoP. */
export interface ResourceDpopOptions {
  /** Refuse Bearer tokens altogether; default false. */
  readonly required?: boolean;
  /** Default `DEFAULT_DPOP_ALGORITHMS` (no Ed25519: celld cannot verify it). */
  readonly algorithms?: readonly DpopAlgorithm[];
  /** Remembers proofs' `jti`s. Strongly recommended; see `verifyDpopProof`. */
  readonly replay?: ReplayStore;
  /** Require server nonces from this source. */
  readonly nonce?: DpopNonceSource;
  /** See `verifyDpopProof`; default 60. */
  readonly maxAgeSec?: number;
  /** See `verifyDpopProof`; default 5. */
  readonly clockToleranceSec?: number;
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
  /** DPoP handling; default accepted alongside Bearer. `false` accepts Bearer only. */
  readonly dpop?: ResourceDpopOptions | false;
  /** Where the metadata is published; default RFC 9728's URL for `resource`. */
  readonly resourceMetadataUrl?: string;
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
  readonly #dpop: ResourceDpopOptions | null;
  readonly #metadata: ProtectedResourceMetadata;

  /** Throws `TypeError` for insecure URLs, no servers, or `offline_access`. */
  constructor(options: ResourceServerOptions) {
    checkSecureUrl(options.resource, "resource");
    if (options.authorizationServers.length === 0) {
      throw new TypeError("a resource server needs an authorization server");
    }
    for (const issuer of options.authorizationServers) {
      checkSecureUrl(issuer, "authorization server");
    }
    if ((options.scopesSupported ?? []).includes("offline_access")) {
      throw new TypeError("offline_access is not a resource scope");
    }
    this.resource = options.resource;
    this.realm = options.realm;
    this.resourceMetadataUrl = options.resourceMetadataUrl ??
      protectedResourceMetadataUrl(options.resource);
    this.#options = options;
    this.#dpop = options.dpop === false ? null : options.dpop ?? {};
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
      document.dpop_signing_alg_values_supported = [
        ...(this.#dpop.algorithms ?? DEFAULT_DPOP_ALGORITHMS),
      ];
      if (this.#dpop.required) {
        document.dpop_bound_access_tokens_required = true;
      }
    }
    this.#metadata = document as ProtectedResourceMetadata;
  }

  /** The Protected Resource Metadata document (RFC 9728 section 2). */
  get metadata(): ProtectedResourceMetadata {
    return this.#metadata;
  }

  /** The path the metadata is served at. */
  get metadataPath(): string {
    return new URL(this.resourceMetadataUrl).pathname;
  }

  /** Serves the metadata for a GET of {@link metadataPath}; null for any other request. */
  handleMetadata(request: Request): Response | null {
    const url = new URL(request.url);
    if (url.pathname !== this.metadataPath) return null;
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
        algs: (dpop.algorithms ?? DEFAULT_DPOP_ALGORITHMS).join(" "),
        ...params(scheme === "DPoP" || !bearer),
      }));
    }
    const headers = { "www-authenticate": challenges.join(", "), ...extra };
    return {
      status,
      error,
      description,
      headers,
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
    const fail = (challenge: Challenge): AuthResult => ({
      ok: false,
      challenge,
    });
    const required = [
      ...(this.#options.requiredScopes ?? []),
      ...(options.scopes ?? []),
    ];
    const header = request.authorization;
    if (header === null || header.trim() === "") {
      return fail(this.#challenge(401, null, undefined, undefined, required));
    }
    const match = /^([A-Za-z]+)[ ]+(\S+)$/.exec(header.trim());
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
    const jkt = verified.cnf?.jkt;
    let headers: Record<string, string> = {};
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
          replay: dpop!.replay,
          nonce: dpop!.nonce,
          maxAgeSec: dpop!.maxAgeSec,
          clockToleranceSec: dpop!.clockToleranceSec,
          now: this.#options.now ?? defaultClock,
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
      headers = await this.#nonceHeader();
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
      principal: {
        subject: verified.subject,
        scopes: verified.scopes,
        claims: verified.claims,
        tokenType: used,
        ...(verified.clientId === undefined
          ? {}
          : { clientId: verified.clientId }),
        ...(verified.issuer === undefined ? {} : { issuer: verified.issuer }),
        ...(verified.expiresAt === undefined
          ? {}
          : { expiresAt: verified.expiresAt }),
        ...(jkt === undefined ? {} : { cnf: { jkt } }),
      },
      headers,
    };
  }
}
