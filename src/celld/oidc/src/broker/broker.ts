// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link UpstreamBroker}: an OpenID Provider that logs its users in at
 * another provider (an upstream, found directly or through a federation)
 * and issues its own tokens downstream. {@link boundTokenExchange} is the
 * token exchange that keeps DPoP bindings intact across such a broker.
 *
 * ```ts
 * const broker = new UpstreamBroker({ upstream: rp, sealer, store, secure: false });
 * const op = new OpenIdProvider({
 *   ...,
 *   interaction: (context) => broker.begin(context.interactionId, { maxAge: context.maxAge }),
 *   claims: ({ subject, claims }) => broker.claims(subject, claims),
 *   tokenExchange: boundTokenExchange(),
 * });
 * // GET /upstream/callback
 * return await broker.finish(op, request);
 * ```
 *
 * What is bound to what:
 *
 * - The broker holds its own DPoP key (the upstream `OidcClient`'s). Its
 *   upstream code is bound to it with `dpop_jkt`, its upstream tokens
 *   carry `cnf.jkt` of that key, and only the broker calls upstream
 *   (UserInfo, APIs through {@link UpstreamBroker.fetchUpstream}) with
 *   them. They never leave the broker's store.
 * - Downstream, the broker is an ordinary provider: the client's code is
 *   bound to the client's key and its tokens carry the client's
 *   `cnf.jkt`, proven at the broker's token endpoint by the client's own
 *   proof. The two bindings are independent: a stolen downstream token is
 *   useless without the client's key and does not reach upstream, and the
 *   broker's key never signs for the client.
 * - Token exchange at the broker keeps a bound token bound to the same
 *   key: the requester must prove the key named by the subject token's
 *   `cnf.jkt`, and the new token is bound to that proof.
 *
 * @module
 */

import {
  type Clock,
  parseScope,
  ProtocolError,
  TOKEN_TYPES,
} from "@celld/oauth";
import type { TokenSet } from "@celld/oauth/client";
import type { RecordStore, TokenExchangeHook } from "@celld/oauth/server";
import type { IdTokenClaims } from "../claims.ts";
import type { OidcDecision, OpenIdProvider } from "../provider/provider.ts";
import type { LoginOptions, OidcClient, PendingLogin } from "../rp/client.ts";
import {
  clearCookie,
  type CookieSealer,
  readCookie,
  setCookie,
} from "../rp/cookies.ts";
import { defaultClock, epochSeconds, redirectResponse } from "../util.ts";

/** Options for {@link UpstreamBroker}. */
export interface UpstreamBrokerOptions {
  /** The broker's client at the upstream provider, holding the broker's DPoP key. Its redirect URI is the broker's callback. */
  readonly upstream: OidcClient;
  /** Seals the pending upstream login into a cookie. */
  readonly sealer: CookieSealer;
  /** Keeps each user's upstream tokens and claims. */
  readonly store: RecordStore;
  /** Scopes asked of the upstream besides `openid`; default `profile email`. */
  readonly scope?: readonly string[];
  /** The downstream subject for an upstream login; default the upstream `sub`. */
  readonly subject?: (claims: IdTokenClaims) => string;
  /** Default `__Host-oidc-broker`, or `oidc-broker` when not `secure`. */
  readonly cookieName?: string;
  /** Default true; false only for `http:` on loopback. */
  readonly secure?: boolean;
  /** How long upstream tokens are kept, in seconds; default 30 days. */
  readonly keepSec?: number;
  readonly now?: Clock;
}

interface PendingUpstream {
  readonly interactionId: string;
  readonly login: PendingLogin;
}

/** What the broker keeps about a user's upstream login. */
export interface UpstreamRecord {
  readonly issuer: string;
  readonly tokens: TokenSet;
  readonly idToken: IdTokenClaims;
  /** The upstream UserInfo answer, if it has one. */
  readonly userinfo: Readonly<Record<string, unknown>>;
}

/** A finished upstream login. */
export interface BrokeredLogin {
  readonly interactionId: string;
  /** The downstream subject. */
  readonly subject: string;
  readonly upstream: UpstreamRecord;
  /** A `Set-Cookie` value deleting the pending login cookie. */
  readonly clearCookie: string;
}

/** The broker between downstream clients and an upstream provider; see the module documentation. */
export class UpstreamBroker {
  readonly #options: UpstreamBrokerOptions;
  readonly #now: Clock;
  readonly cookieName: string;

  constructor(options: UpstreamBrokerOptions) {
    this.#options = options;
    this.#now = options.now ?? defaultClock;
    this.cookieName = options.cookieName ??
      ((options.secure ?? true) ? "__Host-oidc-broker" : "oidc-broker");
  }

  /** The upstream client. */
  get upstream(): OidcClient {
    return this.#options.upstream;
  }

  /**
   * Starts the upstream login for a downstream interaction: a 303 to the
   * upstream provider, with the pending login (and the interaction it
   * resumes) sealed in a cookie. `prompt` and `max_age` pass through.
   */
  async begin(
    interactionId: string,
    options: Omit<LoginOptions, "state"> = {},
  ): Promise<Response> {
    const login = await this.#options.upstream.authorizationUrl({
      scope: this.#options.scope ?? ["profile", "email"],
      ...options,
    });
    const pending: PendingUpstream = { interactionId, login };
    const sealed = await this.#options.sealer.seal(
      this.cookieName,
      pending,
      600,
    );
    return redirectResponse(login.authorization.url, {
      "set-cookie": setCookie(this.cookieName, sealed, {
        maxAgeSec: 600,
        secure: this.#options.secure ?? true,
      }),
    });
  }

  /**
   * Completes the upstream login at the broker's callback: the upstream
   * code redeemed with the broker's DPoP proof, the upstream ID token
   * validated, the upstream UserInfo read (as DPoP when the tokens are
   * bound), and the upstream record stored under the downstream subject.
   */
  async complete(request: Request): Promise<BrokeredLogin> {
    const pending = await this.#options.sealer.unseal<PendingUpstream>(
      this.cookieName,
      readCookie(request.headers.get("cookie"), this.cookieName),
    );
    if (pending === null) {
      throw new ProtocolError("access_denied", {
        description: "this browser has no pending upstream login",
      });
    }
    const upstream = this.#options.upstream;
    const login = await upstream.completeLogin(pending.login, request.url);
    const metadata = await upstream.metadata();
    const userinfo = metadata.userinfo_endpoint === undefined
      ? {}
      : await upstream.userinfo(login.tokens, login.subject);
    const record: UpstreamRecord = {
      issuer: upstream.issuer,
      tokens: login.tokens,
      idToken: login.claims,
      userinfo,
    };
    const subject = this.#options.subject?.(login.claims) ?? login.subject;
    await this.#options.store.put(
      `broker:${subject}`,
      record,
      this.#now() + (this.#options.keepSec ?? 30 * 86400) * 1000,
    );
    return {
      interactionId: pending.interactionId,
      subject,
      upstream: record,
      clearCookie: clearCookie(this.cookieName, {
        secure: this.#options.secure ?? true,
      }),
    };
  }

  /**
   * {@link complete}, then resumes the downstream authorization at
   * `provider` with the upstream's authentication (`auth_time`, `acr`,
   * `amr`) and returns the redirect to the downstream client. A failed
   * upstream login denies the downstream request (`access_denied`).
   */
  async finish(
    provider: OpenIdProvider,
    request: Request,
    options: { readonly sessionId?: string } = {},
  ): Promise<Response> {
    let brokered: BrokeredLogin;
    try {
      brokered = await this.complete(request);
    } catch (error) {
      const pending = await this.#options.sealer.unseal<PendingUpstream>(
        this.cookieName,
        readCookie(request.headers.get("cookie"), this.cookieName),
      );
      if (pending === null) throw error;
      const denied = await provider.resumeAuthorization(pending.interactionId, {
        deny: {
          error: "access_denied",
          description: "the upstream login failed",
        },
      });
      denied.headers.append(
        "set-cookie",
        clearCookie(this.cookieName, { secure: this.#options.secure ?? true }),
      );
      return denied;
    }
    const claims = brokered.upstream.idToken;
    const grant: OidcDecision = {
      grant: {
        subject: brokered.subject,
        authTime: claims.auth_time ?? epochSeconds(this.#now),
        ...(claims.acr === undefined ? {} : { acr: claims.acr }),
        ...(claims.amr === undefined ? {} : { amr: claims.amr }),
        ...(options.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
      },
    };
    const response = await provider.resumeAuthorization(
      brokered.interactionId,
      grant,
    );
    response.headers.append("set-cookie", brokered.clearCookie);
    return response;
  }

  /** What the broker keeps about `subject`, or null. */
  async record(subject: string): Promise<UpstreamRecord | null> {
    return (await this.#options.store.get<UpstreamRecord>(`broker:${subject}`))
      ?.value ?? null;
  }

  /**
   * The upstream claims of `subject`, limited to `claims`: a ready
   * `ClaimsHook` body for the broker's provider.
   */
  async claims(
    subject: string,
    claims: readonly string[],
  ): Promise<Record<string, unknown>> {
    const record = await this.record(subject);
    if (record === null) return {};
    const source: Record<string, unknown> = {
      ...record.idToken,
      ...record.userinfo,
    };
    const out: Record<string, unknown> = {};
    for (const name of claims) {
      if (Object.hasOwn(source, name)) out[name] = source[name];
    }
    return out;
  }

  /**
   * The upstream tokens of `subject`, refreshed first when they are about
   * to expire and a refresh token is at hand (the refresh is bound to the
   * broker's key like the rest). Null when none are kept.
   */
  async upstreamTokens(subject: string): Promise<TokenSet | null> {
    const key = `broker:${subject}`;
    const stored = await this.#options.store.get<UpstreamRecord>(key);
    if (stored === null) return null;
    const record = stored.value;
    const expiring = record.tokens.expires_at !== undefined &&
      record.tokens.expires_at - 30_000 <= this.#now();
    if (!expiring || record.tokens.refresh_token === undefined) {
      return record.tokens;
    }
    const refreshed = await this.#options.upstream.refresh(
      record.tokens.refresh_token,
      record.idToken,
    );
    await this.#options.store.swap(key, stored.version, {
      ...record,
      tokens: refreshed.tokens,
      ...(refreshed.claims === undefined ? {} : { idToken: refreshed.claims }),
    }, stored.expiresAt);
    return refreshed.tokens;
  }

  /**
   * Calls an upstream resource as the broker on behalf of `subject`, with
   * the upstream token and the broker's DPoP proof. Throws when the
   * broker holds no upstream tokens for the subject.
   */
  async fetchUpstream(
    subject: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const tokens = await this.upstreamTokens(subject);
    if (tokens === null) {
      throw new ProtocolError("invalid_grant", {
        description: "no upstream tokens for this user",
      });
    }
    return await this.#options.upstream.fetchResource(url, tokens, init);
  }
}

/** Options for {@link boundTokenExchange}. */
export interface BoundTokenExchangeOptions {
  /**
   * Clients that may exchange tokens issued to other clients; default
   * none: a client exchanges only its own tokens.
   */
  readonly actors?: readonly string[];
}

/**
 * A token exchange hook (RFC 8693) for access tokens this server issued,
 * that keeps DPoP semantics:
 *
 * - a subject token bound to a key (`cnf.jkt`) is only exchanged by a
 *   request proving that key, so a stolen bound token cannot be
 *   exchanged into a bearer token or rebound to the thief's key; the new
 *   token is bound to the same key by the server;
 * - an unbound subject token may become bound (the request's proof);
 * - the scopes are at most the subject token's, and the client must be
 *   the one it was issued to (or listed in `actors`, which then appears
 *   as `act`).
 */
export function boundTokenExchange(
  options: BoundTokenExchangeOptions = {},
): TokenExchangeHook {
  return async (context) => {
    if (
      context.subjectTokenType !== TOKEN_TYPES.accessToken &&
      context.subjectTokenType !== TOKEN_TYPES.jwt
    ) {
      throw new ProtocolError("invalid_request", {
        description: "only access tokens are exchanged",
      });
    }
    const claims = await context.verifyAccessToken(context.subjectToken);
    if (claims === null) return null;
    const cnf = claims.cnf as { jkt?: unknown } | undefined;
    const bound = typeof cnf?.jkt === "string" ? cnf.jkt : undefined;
    if (bound !== undefined && context.jkt !== bound) {
      throw new ProtocolError("invalid_grant", {
        description: context.jkt === undefined
          ? "the subject token is DPoP-bound; prove its key"
          : "the subject token is bound to another DPoP key",
      });
    }
    const owner = claims.client_id;
    const actor = context.client.client_id;
    if (owner !== actor && !(options.actors ?? []).includes(actor)) {
      throw new ProtocolError("invalid_grant", {
        description: "the subject token was issued to another client",
      });
    }
    const granted = parseScope(claims.scope as string | undefined);
    for (const scope of context.scope) {
      if (!granted.includes(scope)) {
        throw new ProtocolError("invalid_scope", {
          description: `the subject token does not carry ${scope}`,
        });
      }
    }
    return {
      subject: claims.sub as string,
      scope: context.scope.length > 0 ? context.scope : granted,
      ...(owner !== actor ? { act: { sub: actor } } : {}),
    };
  };
}
