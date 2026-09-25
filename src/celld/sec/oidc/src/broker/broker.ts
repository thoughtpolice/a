// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link UpstreamBroker}: an OpenID Provider that logs its users in at
 * another provider (an upstream, found directly or through a federation)
 * and issues its own tokens downstream. {@link boundTokenExchange} is the
 * token exchange that keeps DPoP bindings intact across such a broker.
 *
 * ```ts
 * const secrets = await encryptedSecretStore(store, { secret: env.BROKER_SECRET });
 * const broker = new UpstreamBroker({ upstream: rp, sealer, secrets });
 * const op = new OpenIdProvider({
 *   ...,
 *   interaction: (context) => broker.begin(context.interactionId, context.request, { maxAge: context.maxAge }),
 *   claims: ({ subject, claims }) => broker.claims(subject, claims),
 *   tokenExchange: boundTokenExchange({ sourceAudiences: [API_AUDIENCE] }),
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
 *   (UserInfo, APIs through {@link UpstreamBroker.fetchUpstream}, which
 *   refuses URLs the upstream tokens are not for) with them. They are
 *   kept in the broker's {@link SecretStore}, encrypted at rest
 *   (`encryptedSecretStore`), keyed by upstream issuer and subject
 *   ({@link brokerRecordKey}), and go only to the host that asks
 *   (`record()`, `complete()`), never downstream.
 * - Refresh is singleflight locally and fenced across isolates by a durable
 *   same-record CAS intent. Only its owner contacts the upstream, and callers
 *   get committed tokens only. A crashed/uncertain rotation requires a new
 *   login: a generic store cannot prove whether the upstream consumed it.
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
  randomToken,
  TOKEN_TYPES,
} from "@celld/sec/oauth";
import { type AuthorizedGrant } from "@celld/sec/oauth/client";
import {
  finite,
  jsonSnapshot,
  opaqueIdentity,
  safeInt,
  strictRecord,
} from "@celld/core/bounds";
import type { TokenExchangePolicy } from "@celld/sec/oauth/server";
import type { IdTokenClaims } from "../claims.ts";
import type { OidcDecision, OpenIdProvider } from "../provider/provider.ts";
import type { LoginOptions, OidcClient, PendingLogin } from "../rp/client.ts";
import {
  checkPendingCookies,
  clearCookie,
  type CookieSealer,
  readCookie,
  setCookie,
  transactionCookieName,
} from "../rp/cookies.ts";
import { defaultClock, redirectResponse, snapshotOptions } from "../util.ts";
import type { SecretStore } from "./secrets.ts";

/** Options for {@link UpstreamBroker}. */
export interface UpstreamBrokerOptions {
  /** The broker's client at the upstream provider, holding the broker's DPoP key. Its redirect URI is the broker's callback. */
  readonly upstream: OidcClient;
  /** Seals the pending upstream login into a cookie. */
  readonly sealer: CookieSealer;
  /**
   * Keeps each user's upstream tokens and claims, confidential at rest:
   * `await encryptedSecretStore(recordStore, { secret })`.
   */
  readonly secrets: SecretStore;
  /** Scopes asked of the upstream besides `openid`; default `profile email`. */
  readonly scope?: readonly string[];
  /**
   * The downstream subject for an upstream login; default the upstream
   * `sub`, which is unique only within that upstream: a provider fed by
   * several brokers should give each a subject naming its upstream.
   */
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
  readonly tokens: AuthorizedGrant;
  /** Fenced durable refresh intent. An expired intent requires a fresh login. */
  readonly refreshIntent?: { readonly owner: string; readonly until: number };
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

/**
 * The key of `subject`'s record in the broker's {@link SecretStore}: the
 * upstream issuer and the subject. A subject is only unique within one
 * upstream, so brokers for several upstreams sharing one store never read
 * each other's users (or send one upstream's refresh token to another).
 */
export async function brokerRecordKey(
  issuer: string,
  subject: string,
  secret: Uint8Array | CryptoKey,
): Promise<string> {
  if (
    typeof issuer !== "string" || issuer.length === 0 || issuer.length > 2048 ||
    typeof subject !== "string" || subject.length === 0 || subject.length > 2048
  ) throw new TypeError("invalid broker identity");
  return `broker:v2:${await opaqueIdentity(
    secret,
    "@celld/sec/oidc broker identity v2",
    JSON.stringify([issuer, subject]),
  )}`;
}

/** The broker between downstream clients and an upstream provider; see the module documentation. */
export class UpstreamBroker {
  readonly #options: UpstreamBrokerOptions;
  readonly #now: Clock;
  readonly #refreshing = new Map<string, Promise<AuthorizedGrant | null>>();
  readonly cookieName: string;

  constructor(input: UpstreamBrokerOptions) {
    strictRecord(input, [
      "upstream",
      "sealer",
      "secrets",
      "scope",
      "subject",
      "cookieName",
      "secure",
      "keepSec",
      "now",
    ], "UpstreamBroker options");
    if (input.secure !== undefined && typeof input.secure !== "boolean") {
      throw new TypeError("secure must be boolean");
    }
    if (input.subject !== undefined && typeof input.subject !== "function") {
      throw new TypeError("subject must be a function");
    }
    safeInt(input.keepSec ?? 30 * 86400, {
      name: "keepSec",
      min: 1,
      max: 30 * 86400,
    });
    for (const method of ["get", "put", "swap", "identityKey"] as const) {
      if (typeof input.secrets?.[method] !== "function") {
        throw new TypeError(
          "secrets must implement the atomic confidential store contract",
        );
      }
    }
    if (
      typeof input.sealer?.seal !== "function" ||
      typeof input.sealer?.unseal !== "function"
    ) throw new TypeError("sealer must implement authenticated cookie sealing");
    if (
      input.scope !== undefined &&
      (!Array.isArray(input.scope) || input.scope.length > 64 ||
        !input.scope.every((scope) =>
          typeof scope === "string" &&
          /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(scope)
        ) || new Set(input.scope).size !== input.scope.length)
    ) throw new TypeError("scope must contain at most64 unique scope tokens");
    // Read once: `secure`, `scope`, `keepSec` and the subject mapping
    // cannot be changed on the caller's object afterwards.
    const options = snapshotOptions(input);
    this.#options = options;
    const clock = options.now ?? defaultClock;
    if (typeof clock !== "function") throw new TypeError("now must be a clock");
    this.#now = () => finite(clock(), { name: "clock", min: 0, max: 8.64e15 });
    this.#now();
    this.cookieName = options.cookieName ??
      ((options.secure ?? true) ? "__Host-oidc-broker" : "oidc-broker");
    setCookie(this.cookieName, "", { secure: options.secure ?? true });
    Object.freeze(this);
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
    request: Request,
    options: Omit<LoginOptions, "state"> = {},
  ): Promise<Response> {
    if (
      typeof interactionId !== "string" || interactionId.length === 0 ||
      interactionId.length > 2048
    ) throw new TypeError("invalid interaction id");
    checkPendingCookies(request, this.cookieName);
    const login = await this.#options.upstream.authorizationUrl({
      scope: this.#options.scope ?? ["profile", "email"],
      ...options,
    });
    const pending: PendingUpstream = { interactionId, login };
    const name = await transactionCookieName(
      this.cookieName,
      login.authorization.state,
    );
    const sealed = await this.#options.sealer.seal(
      name,
      pending,
      600,
    );
    return redirectResponse(login.authorization.url, {
      "set-cookie": setCookie(name, sealed, {
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
    const name = await transactionCookieName(
      this.cookieName,
      new URL(request.url).searchParams.get("state") ?? "",
    );
    const pending = await this.#options.sealer.unseal<PendingUpstream>(
      name,
      readCookie(request.headers.get("cookie"), name),
    );
    if (pending === null) {
      throw new ProtocolError("access_denied", {
        description: "this browser has no pending upstream login",
      });
    }
    const upstream = this.#options.upstream;
    const login = await upstream.completeLogin(
      await upstream.unsafeRestorePendingLogin(pending.login),
      request.url,
    );
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
    await this.#options.secrets.put(
      await this.#key(subject),
      record,
      this.#now() + (this.#options.keepSec ?? 30 * 86400) * 1000,
    );
    return {
      interactionId: pending.interactionId,
      subject,
      upstream: record,
      clearCookie: clearCookie(name, {
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
      const name = await transactionCookieName(
        this.cookieName,
        new URL(request.url).searchParams.get("state") ?? "",
      );
      const pending = await this.#options.sealer.unseal<PendingUpstream>(
        name,
        readCookie(request.headers.get("cookie"), name),
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
        clearCookie(name, { secure: this.#options.secure ?? true }),
      );
      return denied;
    }
    const claims = brokered.upstream.idToken;
    const grant: OidcDecision = {
      grant: {
        subject: brokered.subject,
        // Only the upstream's own word: a missing `auth_time` must not
        // look like a fresh login to `prompt=login` or `max_age`.
        ...(claims.auth_time === undefined
          ? {}
          : { authTime: claims.auth_time }),
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
    const stored = await this.#options.secrets.get<UpstreamRecord>(
      await this.#key(subject),
    );
    return stored === null || !this.#ours(stored.value)
      ? null
      : { ...stored.value, tokens: await this.#restore(stored.value.tokens) };
  }

  #key(subject: string): Promise<string> {
    return this.#options.secrets.identityKey(
      this.#options.upstream.issuer,
      subject,
    );
  }

  #restore(tokens: unknown): Promise<AuthorizedGrant> {
    const upstream = this.#options.upstream;
    return upstream.unsafeRestoreGrant(tokens);
  }

  /** Whether a stored record is this broker's upstream's. */
  #ours(record: UpstreamRecord): boolean {
    return record.issuer === this.#options.upstream.issuer;
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
    const out: Record<string, unknown> = Object.create(null);
    for (const name of claims) {
      if (Object.hasOwn(source, name)) out[name] = source[name];
    }
    return jsonSnapshot(out);
  }

  /**
   * The upstream tokens of `subject`, refreshed first when they are about
   * to expire and a refresh token is at hand (the refresh is bound to the
   * broker's key like the rest). Null when none are kept.
   *
   * Concurrent calls share one local refresh. Across isolates, only the
   * durable CAS intent owner refreshes; waiters reread the committed result.
   * A30-second intent surrounds a20-second upstream deadline. An expired or
   * uncertain intent requires re-login instead of retrying a possibly consumed
   * rotation token. The store must provide linearizable atomic CAS, not an
   * eventually consistent read-then-write emulation.
   * The refreshed tokens are committed with a compare-and-swap; when
   * another isolate committed first, the record is read again and
   * evaluated again, and the uncommitted refresh is dropped: a caller
   * never gets tokens the store does not hold. Throws a 503
   * `temporarily_unavailable` `ProtocolError` after repeated lost races.
   */
  upstreamTokens(subject: string): Promise<AuthorizedGrant | null> {
    if (
      typeof subject !== "string" || subject.length === 0 ||
      subject.length > 2048
    ) throw new TypeError("invalid broker subject");
    const running = this.#refreshing.get(subject);
    if (running !== undefined) return running;
    if (this.#refreshing.size >= 1000) {
      throw new ProtocolError("temporarily_unavailable", {
        status: 503,
        description: "upstream refresh capacity exhausted",
      });
    }
    const work = this.#committedTokens(subject).finally(() => {
      if (this.#refreshing.get(subject) === work) {
        this.#refreshing.delete(subject);
      }
    });
    this.#refreshing.set(subject, work);
    return work;
  }

  async #committedTokens(subject: string): Promise<AuthorizedGrant | null> {
    const key = await this.#key(subject);
    for (let attempt = 0; attempt < 100; attempt++) {
      const stored = await this.#options.secrets.get<UpstreamRecord>(key);
      if (stored === null || !this.#ours(stored.value)) return null;
      const record = stored.value;
      if (record.refreshIntent !== undefined) {
        if (
          !Number.isFinite(record.refreshIntent.until) ||
          record.refreshIntent.until <= this.#now()
        ) {
          throw new ProtocolError("invalid_grant", {
            description:
              "the upstream refresh outcome is uncertain; sign in again",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const expiring = record.tokens.expires_at !== undefined &&
        record.tokens.expires_at - 30_000 <= this.#now();
      if (!expiring || record.tokens.refresh_token === undefined) {
        if (
          record.tokens.expires_at !== undefined &&
          record.tokens.expires_at <= this.#now()
        ) {
          throw new ProtocolError("invalid_grant", {
            description: "the upstream token expired",
          });
        }
        return this.#restore(record.tokens);
      }
      const owner = randomToken(16);
      const acquired = await this.#options.secrets.swap(key, stored.version, {
        ...record,
        refreshIntent: { owner, until: this.#now() + 30_000 },
      }, stored.expiresAt);
      if (typeof acquired !== "boolean") {
        throw new ProtocolError("temporarily_unavailable", {
          status: 503,
          description: "the secret store violated its atomic CAS contract",
        });
      }
      if (!acquired) continue;
      const claimed = await this.#options.secrets.get<UpstreamRecord>(key);
      if (claimed?.value.refreshIntent?.owner !== owner) continue;
      let refreshed;
      try {
        refreshed = await this.#options.upstream.refresh(
          await this.#restore(record.tokens),
          record.idToken,
          { signal: AbortSignal.timeout(20_000) },
        );
      } catch (cause) {
        // Do not retry a rotation token with an unknown upstream outcome.
        // An existing valid access token remains usable; login replaces the intent.
        if ((record.tokens.expires_at ?? 0) > this.#now()) {
          return this.#restore(record.tokens);
        }
        throw new ProtocolError("temporarily_unavailable", {
          status: 503,
          description: "the upstream refresh failed; sign in again",
          cause,
        });
      }
      const committed = await this.#options.secrets.swap(key, claimed.version, {
        ...record,
        tokens: refreshed.tokens,
        ...(refreshed.claims === undefined
          ? {}
          : { idToken: refreshed.claims }),
      }, stored.expiresAt);
      if (typeof committed !== "boolean") {
        throw new ProtocolError("temporarily_unavailable", {
          status: 503,
          description: "the secret store violated its atomic CAS contract",
        });
      }
      if (committed) return refreshed.tokens;
    }
    throw new ProtocolError("temporarily_unavailable", {
      status: 503,
      description: "the upstream tokens kept changing while being refreshed",
    });
  }

  /**
   * Calls an upstream resource as the broker on behalf of `subject`, with
   * the upstream token and the broker's DPoP proof, through the upstream
   * client's `resourceFetch`: a URL the upstream tokens are not for (not
   * under the upstream `userinfo_endpoint` or the client's `resources`,
   * not https, or with user information) is refused with the `OAuthError`
   * `target` before any token is read, and redirects are never followed.
   * Throws when the broker holds no upstream tokens for the subject.
   */
  async fetchUpstream(
    subject: string,
    url: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const upstream = this.#options.upstream;
    await upstream.resourceTarget(url);
    const tokens = await this.upstreamTokens(subject);
    if (tokens === null) {
      throw new ProtocolError("invalid_grant", {
        description: "no upstream tokens for this user",
      });
    }
    return await upstream.resourceFetch(url, tokens, init);
  }

  /**
   * {@link fetchUpstream} without the URL check: the subject's upstream
   * token on a request to any URL, following redirects as `init` says.
   * Only for a caller that has made sure the URL is an upstream resource.
   */
  async unsafeFetchUpstream(
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
    return await this.#options.upstream.unsafeFetchResource(url, tokens, init);
  }
}

/** Options for {@link boundTokenExchange}. */
export interface BoundTokenExchangeOptions {
  /** Audiences from which delegation is explicitly authorized. */
  readonly sourceAudiences: readonly string[];
  /**
   * Clients that may exchange tokens issued to other clients; default
   * none: a client exchanges only its own tokens.
   */
  readonly actors?: readonly string[];
}

const MAX_ACTOR_CHAIN_DEPTH = 4;

function boundedIdentifiers(
  value: unknown,
  name: string,
  options: { readonly empty: boolean },
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) || (!options.empty && value.length === 0) ||
    value.length > 64 || new Set(value).size !== value.length ||
    value.some((item) =>
      typeof item !== "string" || item.length === 0 || item.length > 4096
    )
  ) {
    throw new TypeError(
      `${name} must be a ${
        options.empty ? "possibly empty " : ""
      }unique bounded string list`,
    );
  }
}

function actorChain(
  value: unknown,
): {
  readonly value?: Readonly<Record<string, unknown>>;
  readonly depth: number;
} {
  if (value === undefined) return { depth: 0 };
  const root = value;
  let actor: unknown = value;
  let depth = 0;
  while (actor !== undefined) {
    if (
      depth >= MAX_ACTOR_CHAIN_DEPTH || typeof actor !== "object" ||
      actor === null || Array.isArray(actor)
    ) {
      throw new ProtocolError("invalid_grant", {
        description: "the subject token's actor chain is invalid or too deep",
      });
    }
    const record = actor as Record<string, unknown>;
    if (
      typeof record.sub !== "string" || record.sub.length === 0 ||
      record.sub.length > 4096
    ) {
      throw new ProtocolError("invalid_grant", {
        description: "the subject token's actor chain is invalid or too deep",
      });
    }
    depth++;
    actor = record.act;
  }
  return { value: root as Readonly<Record<string, unknown>>, depth };
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
 *   as `act`); an existing RFC 8693 actor chain is preserved and a new
 *   actor is nested above it, up to four actors.
 */
export function boundTokenExchange(
  input: BoundTokenExchangeOptions,
): TokenExchangePolicy {
  strictRecord(
    input,
    ["sourceAudiences", "actors"],
    "bound token exchange options",
  );
  boundedIdentifiers(input.sourceAudiences, "sourceAudiences", {
    empty: false,
  });
  if (input.actors !== undefined) {
    boundedIdentifiers(input.actors, "actors", { empty: true });
  }
  const options = snapshotOptions(input);
  return {
    sourceAudiences: options.sourceAudiences,
    authorize: (context) => {
      if (
        context.subjectTokenType !== TOKEN_TYPES.accessToken &&
        context.subjectTokenType !== TOKEN_TYPES.jwt
      ) {
        throw new ProtocolError("invalid_request", {
          description: "only access tokens are exchanged",
        });
      }
      const claims = context.subject;
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
      const previous = actorChain(claims.act);
      if (owner !== actor && previous.depth >= MAX_ACTOR_CHAIN_DEPTH) {
        throw new ProtocolError("invalid_grant", {
          description: "the subject token's actor chain is too deep to extend",
        });
      }
      const act = owner === actor ? previous.value : {
        sub: actor,
        ...(previous.value === undefined ? {} : { act: previous.value }),
      };
      return Promise.resolve({
        subject: claims.sub as string,
        scope: context.scope.length > 0 ? context.scope : granted,
        ...(act === undefined ? {} : { act }),
      });
    },
  };
}
