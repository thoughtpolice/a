// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Key sets: where {@link KeySet.resolve} finds the key for a token's `kid`
 * and `alg`. {@link localJwks} serves a JWKS held in memory;
 * {@link RemoteJwks} fetches one through `@celld/http/egress`'s bounded
 * fetch, caches it, and fetches again when a token names a key it does not
 * have (an issuer rotating keys), no more often than its cooldown allows,
 * backing off while the endpoint fails.
 *
 * @module
 */

import {
  bytes,
  finite,
  millis,
  nonNegativeMs,
  safeInt,
} from "@celld/core/bounds";
import {
  type BoundedFetch,
  boundedFetch,
  classifyHost,
  EgressError,
  type EgressPolicy,
} from "@celld/http/egress";
import type { JwtHeader } from "./decode.ts";
import { JwtError } from "./errors.ts";
import {
  importJwk,
  isHmac,
  isJwsAlgorithm,
  isPss,
  type Jwk,
  jwkFingerprint,
  jwkFits,
  type Jwks,
  type JwsAlgorithm,
  publicVerificationKeys,
} from "./keys.ts";

/** Finds verification keys for tokens. */
export interface KeySet {
  /**
   * The key for a token with this header and (already checked) `alg`;
   * throws a {@link JwtError} (`no_key`, `ambiguous_key`, or `jwks` for a
   * key set that could not be fetched) when there is none.
   */
  resolve(
    header: JwtHeader,
    alg: JwsAlgorithm,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CryptoKey>;
}

/** Fetches like the global `fetch`. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Whether a key set's `jwk` serves `alg`: {@link jwkFits}, and an RSA JWK
 * without `alg` serves RS256/384/512 only, so one key in a set is never
 * used under both RSASSA-PKCS1-v1_5 and RSA-PSS. An RSA-PSS key in a set
 * must say its `alg`.
 */
function serves(jwk: Jwk, alg: JwsAlgorithm): boolean {
  return jwkFits(jwk, alg) && !(jwk.alg === undefined && isPss(alg));
}

/**
 * The JWK in `jwks` for `kid` and `alg`: the one that serves `alg` (it
 * fits, see `jwkFits`, and an RSA JWK without `alg` is RS* only) and has
 * that `kid`; without a `kid`, the only key that serves, or none when
 * several do (guessing would let a token pick its key). Several keys with
 * the same `kid` that serve `alg` are refused as `ambiguous_key`.
 */
export function selectJwk(
  jwks: Jwks,
  kid: string | undefined,
  alg: JwsAlgorithm,
): Jwk | null {
  const candidates = jwks.keys.filter((jwk) =>
    serves(jwk, alg) && (kid === undefined || jwk.kid === kid)
  );
  if (kid === undefined) return candidates.length === 1 ? candidates[0] : null;
  if (candidates.length > 1) {
    throw new JwtError(
      "ambiguous_key",
      `${candidates.length} ${alg} keys have kid ${JSON.stringify(kid)}`,
    );
  }
  return candidates[0] ?? null;
}

/**
 * Imported keys, by the JWK's content (see `jwkFingerprint`) and `alg`, so
 * a key replaced in place is imported again. It keeps at most `limit`
 * keys (the size of the set they come from), dropping the least recently
 * used.
 */
class ImportCache {
  readonly #keys = new Map<string, Promise<CryptoKey>>();

  async get(jwk: Jwk, alg: JwsAlgorithm, limit: number): Promise<CryptoKey> {
    const id = `${alg} ${jwkFingerprint(jwk)}`;
    const keys = this.#keys;
    let key = keys.get(id);
    if (key === undefined) {
      const importing = importJwk(jwk, alg, "verify");
      key = importing;
      importing.catch(() => {
        if (keys.get(id) === importing) keys.delete(id);
      });
    } else {
      keys.delete(id);
    }
    keys.set(id, key);
    for (const old of keys.keys()) {
      if (keys.size <= Math.max(limit, 1)) break;
      keys.delete(old);
    }
    return await key;
  }
}

function kidOf(header: JwtHeader): string | undefined {
  const kid: unknown = header.kid;
  if (kid === undefined) return undefined;
  if (typeof kid !== "string") {
    throw new JwtError("malformed", "the header's kid must be a string");
  }
  return kid;
}

function noKey(kid: string | undefined, alg: JwsAlgorithm): JwtError {
  return new JwtError(
    "no_key",
    kid === undefined
      ? `no single ${alg} key without a kid`
      : `no ${alg} key with kid ${JSON.stringify(kid)}`,
  );
}

/** A deep copy of `value` with every object and array in it frozen. */
function frozenCopy<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? value.map(frozenCopy)
    : Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, frozenCopy(entry)]),
    );
  return Object.freeze(copy) as T;
}

/** A JWKS copied and frozen, so no one can change it afterwards. */
function snapshotJwks(jwks: Jwks): Jwks {
  if (!Array.isArray(jwks?.keys)) throw new TypeError("a JWKS needs `keys`");
  return frozenCopy({ keys: jwks.keys });
}

/**
 * A {@link KeySet} over `jwks` as it is at each lookup; imported keys are
 * cached by their content, so a key changed in place is imported again,
 * and no more are kept than the set has keys. For `verify`, which takes
 * the set on every call.
 */
export function liveJwks(jwks: Jwks): KeySet {
  const cache = new ImportCache();
  return {
    async resolve(header, alg) {
      const kid = kidOf(header);
      const jwk = selectJwk(jwks, kid, alg);
      if (jwk === null) throw noKey(kid, alg);
      return await cache.get(jwk, alg, jwks.keys.length);
    },
  };
}

/**
 * A {@link KeySet} over a JWKS in memory; imported keys are cached. The set
 * is copied now: changing `jwks` afterwards does not change the keys it
 * serves. Make a new one to change them.
 *
 * The set is the caller's configuration, so it may hold HMAC secrets
 * (`oct` keys, a keyring for rotation). A set that came from somewhere
 * public (a fetched `jwks_uri`, client metadata anyone can read) must not
 * be verified under HS* algorithms: every `oct` key in it is known to all.
 * {@link RemoteJwks} refuses them.
 */
export function localJwks(
  jwks: Jwks,
  options: {
    readonly requireKeyAlgorithm?: boolean;
    readonly algorithms?: readonly JwsAlgorithm[];
  } = {},
): KeySet {
  jwks = snapshotJwks(jwks);
  const policy = options.algorithms === undefined
    ? undefined
    : Object.freeze([...options.algorithms]);
  if (
    options.requireKeyAlgorithm === true &&
    jwks.keys.some((key) => key.alg === undefined)
  ) throw new JwtError("jwks", "all keys require explicit alg");
  if (
    policy !== undefined &&
    (policy.length === 0 || !policy.every(isJwsAlgorithm))
  ) throw new TypeError("invalid key-set algorithm policy");
  const cache = new ImportCache();
  return {
    async resolve(header, alg) {
      if (policy !== undefined && !policy.includes(alg)) {
        throw new JwtError(
          "alg_not_allowed",
          "algorithm is outside the key-set policy",
        );
      }
      const kid = kidOf(header);
      const jwk = selectJwk(jwks, kid, alg);
      if (jwk === null) throw noKey(kid, alg);
      return await cache.get(jwk, alg, jwks.keys.length);
    },
  };
}

/** Options for {@link RemoteJwks}. */
export interface RemoteJwksOptions {
  /** Reject keys without an explicit `alg`; default interoperable JOSE policy. */
  readonly requireKeyAlgorithm?: boolean;
  /** Optional additional per-set allowlist, applied before key lookup. */
  readonly algorithms?: readonly JwsAlgorithm[];
  /** Default the global `fetch`; every request still goes through `egress`. */
  readonly fetch?: FetchLike;
  /** Milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
  /** How long a fetched set is used before it is fetched again; default 10 minutes. */
  readonly maxAgeMs?: number;
  /**
   * The least time between fetch attempts for an unknown `kid`, so tokens
   * naming made-up keys cannot make every request fetch; default 30
   * seconds. It is also the cap of the failure backoff.
   */
  readonly cooldownMs?: number;
  /**
   * How long past `maxAgeMs` the last good set keeps serving the keys it
   * has while refreshes fail; default zero (explicit opt-in only).
   */
  readonly maxStaleMs?: number;
  /** The most keys a fetched set may have; default 64. */
  readonly maxKeys?: number;
  /** Extra request headers. */
  readonly headers?: HeadersInit;
  /**
   * The egress policy, over the default: `https:` only, no redirects, a
   * 5 second deadline for the whole fetch, 256 KiB of body, and public
   * hosts only (`network: "public"`). See `@celld/http/egress`.
   */
  readonly egress?: Partial<EgressPolicy>;
  /**
   * The development override, as `egress`'s `network: "loopback"`: allow
   * loopback hosts, over `http:` only as an IP literal
   * (`http://127.0.0.1:8080/jwks`, `http://[::1]/jwks`); `localhost`
   * names still need `https:` with `allowCleartextLoopbackForDevelopment`.
   * Never for production. (The old name,
   * `allowInsecure`, was removed and is refused.)
   */
  readonly allowLoopbackForDevelopment?: boolean;
}

/** The body cap of the default egress policy. */
export const JWKS_MAX_BYTES = 256 * 1024;
/** The deadline of the default egress policy. */
export const JWKS_TIMEOUT_MS = 5_000;
/** The default key count cap. */
export const JWKS_MAX_KEYS = 64;
/** The first failure backoff; it doubles up to the cooldown. */
const BACKOFF_MS = 1_000;

/**
 * Throws a `TypeError` for a JWKS URL the policy refuses outright, by the
 * rules the egress fetch applies to it: one with credentials or a
 * fragment, not `https:` (`http:` only to a loopback IP literal, with
 * `allowCleartextLoopbackForDevelopment` and a network that reaches
 * loopback), or a host outside `network`. The egress fetch checks every
 * request and redirect again.
 */
function checkUrl(url: URL, policy: EgressPolicy): void {
  const network = policy.network;
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`a JWKS URL may not carry credentials: ${url.origin}`);
  }
  if (url.href.includes("#")) {
    throw new TypeError(
      `a JWKS URL may not have a fragment: ${url.origin}${url.pathname}`,
    );
  }
  const kind = classifyHost(url.hostname);
  if (url.protocol !== "https:") {
    // The URL parser writes an IPv4 literal as dotted decimal and an IPv6
    // one in brackets; any other host is a name.
    const literal = /^(\d+\.){3}\d+$/.test(url.hostname) ||
      url.hostname.startsWith("[");
    if (
      !(url.protocol === "http:" && network !== "public" &&
        kind === "loopback" && literal &&
        policy.allowCleartextLoopbackForDevelopment === true)
    ) {
      throw new TypeError(
        `a JWKS URL must be https: (http: only to a loopback IP literal with allowCleartextLoopbackForDevelopment): ${url.origin}${url.pathname}`,
      );
    }
  }
  const allowed = network === "any" || kind === "public" || kind === "name" ||
    (kind === "loopback" && network === "loopback");
  if (!allowed) {
    throw new TypeError(
      `a JWKS URL's host is a ${kind} address, outside the ${network} network: ${url.hostname}`,
    );
  }
}

function jwksOf(
  value: unknown,
  maxKeys: number,
  url: URL,
  requireAlgorithm = false,
): Jwks {
  const keys = typeof value === "object" && value !== null &&
      !Array.isArray(value)
    ? (value as { keys?: unknown }).keys
    : undefined;
  if (
    !Array.isArray(keys) ||
    !keys.every((key) =>
      typeof key === "object" && key !== null && !Array.isArray(key)
    )
  ) {
    throw new JwtError("jwks", `${url} did not return a JWKS`);
  }
  if (keys.length > maxKeys) {
    throw new JwtError(
      "jwks",
      `${url} returned ${keys.length} keys, more than ${maxKeys}`,
    );
  }
  // Encryption keys published alongside are skipped, not refused; secret
  // material anywhere refuses the set.
  const validated = publicVerificationKeys(keys);
  if (requireAlgorithm && validated.some((key) => key.alg === undefined)) {
    throw new JwtError("jwks", "public keys require an explicit alg");
  }
  return Object.freeze({ keys: Object.freeze(validated) });
}

/**
 * The seconds a response's `Cache-Control` lets it be cached: 0 for
 * `no-store` or `no-cache`, `max-age` when it is a valid delta-seconds,
 * otherwise null (the header says nothing usable).
 */
function cacheControlSeconds(header: string | null): number | null {
  if (header === null) return null;
  let seconds: number | null = null;
  for (const part of header.split(",")) {
    const directive = part.trim().toLowerCase(),
      equals = directive.indexOf("=");
    const name = (equals < 0 ? directive : directive.slice(0, equals)).trim();
    const value = equals < 0 ? undefined : directive.slice(equals + 1).trim();
    if (name === "no-store" || name === "no-cache") return 0;
    if (name === "max-age") {
      if (value === undefined) return 0;
      const bare = value.replace(/^"(.*)"$/, "$1");
      if (/^[0-9]{1,10}$/.test(bare)) {
        if (seconds !== null) return 0;
        seconds = Number(bare);
      } else return 0;
    }
  }
  return seconds;
}

function definedEntries<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

interface Current {
  readonly jwks: Jwks;
  /** Whether the set is within `maxAgeMs` of a successful fetch. */
  readonly fresh: boolean;
  /** Why the set is stale: the last refresh failure. */
  readonly error: JwtError | null;
}

/**
 * A JWKS fetched from a URL (an issuer's `jwks_uri`) and cached for
 * `maxAgeMs`, or for less when the response's `Cache-Control` says so
 * (`max-age`, or `no-store`/`no-cache` as 0). Cooldown never overrides
 * mandatory revalidation; imported keys are cached with the set. The fetched set is
 * frozen.
 *
 * - Every fetch goes through `boundedFetch` (`@celld/http/egress`): by
 *   default `https:` to public hosts, no redirects, a 5 second deadline
 *   covering the body, 256 KiB, and at most `maxKeys` keys.
 * - A token whose key is not in the set makes it fetch again, at most once
 *   per `cooldownMs` since the last attempt.
 * - After a failed fetch, no fetch is tried for a backoff that starts at
 *   one second and doubles, up to `cooldownMs`, while fetches keep
 *   failing; lookups in the meantime fail fast with the last error.
 * - Concurrent lookups share one fetch, and that fetch ends at the
 *   deadline, so a hung endpoint cannot hold callers.
 * - While refreshes fail, the last good set keeps serving the keys it has
 *   (stale-while-error) for up to `maxStaleMs` past `maxAgeMs`; a token
 *   naming a key it does not have fails with `jwks`, since the set could
 *   not be checked.
 * - A fetched set holding a symmetric key (`kty: "oct"`, or any key with a
 *   `k`) or a private member is refused (`jwks`): the set is public, so
 *   the secret is too. Encryption keys in the set are skipped (see
 *   `publicVerificationKeys`), so publishing one never breaks verification. An
 *   HMAC algorithm is never looked up (`key_mismatch`), and `verify` and
 *   `createVerifier` refuse a `RemoteJwks` with HS* in `algorithms`
 *   (`TypeError`).
 * - The clock (`now`) is read through a finiteness check: a clock that is
 *   not a function or reads a non-finite time is a `RangeError` or
 *   `TypeError`, at construction or at the lookup that reads it. A clock
 *   that steps back behind the last fetch makes the set stale, since its
 *   age is unknown.
 */
export class RemoteJwks implements KeySet {
  readonly #url: string;
  get #label(): string {
    const url = new URL(this.#url);
    return `${url.origin}${url.pathname}`;
  }
  /** A defensive URL copy. Mutating it never changes the trust authority. */
  get url(): URL {
    return new URL(this.#url);
  }
  readonly #requireAlgorithm: boolean;
  readonly #algorithms: readonly JwsAlgorithm[] | undefined;
  readonly #get: BoundedFetch;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  readonly #cooldownMs: number;
  readonly #maxStaleMs: number;
  readonly #maxKeys: number;
  readonly #headers: Headers;
  #jwks: Jwks | null = null;
  /** How long the current set is fresh: `maxAgeMs` or less. */
  #lifetimeMs = 0;
  #fetchedAt = -Infinity;
  #attemptedAt = -Infinity;
  #failures = 0;
  #error: JwtError | null = null;
  #loading: Promise<Jwks> | null = null;
  #loadController: AbortController | null = null;
  #waiters = 0;
  #imports = new ImportCache();
  #allowStale = false;
  #cacheHeaders = new Headers();

  /**
   * Throws a `TypeError` for a URL the egress policy refuses outright (see
   * {@link RemoteJwksOptions.egress}), and a `RangeError` for a bad number
   * or policy.
   */
  constructor(url: string | URL, options: RemoteJwksOptions = {}) {
    this.#url = new URL(url).href;
    this.#requireAlgorithm = options.requireKeyAlgorithm ?? false;
    if (typeof this.#requireAlgorithm !== "boolean") {
      throw new TypeError("requireKeyAlgorithm must be boolean");
    }
    this.#algorithms = options.algorithms === undefined
      ? undefined
      : Object.freeze([...options.algorithms]);
    if (
      this.#algorithms !== undefined &&
      (this.#algorithms.length === 0 ||
        !this.#algorithms.every((alg) => isJwsAlgorithm(alg) && !isHmac(alg)))
    ) throw new TypeError("remote key policy requires asymmetric algorithms");
    if (Object.hasOwn(options, "allowInsecure")) {
      throw new TypeError(
        "RemoteJwks: `allowInsecure` was removed; use " +
          "`allowLoopbackForDevelopment` for http: to a loopback IP literal",
      );
    }
    const development = options.allowLoopbackForDevelopment === true;
    this.#maxAgeMs = nonNegativeMs(options.maxAgeMs ?? 600_000, {
      name: "maxAgeMs",
    });
    this.#cooldownMs = nonNegativeMs(options.cooldownMs ?? 30_000, {
      name: "cooldownMs",
    });
    this.#maxStaleMs = nonNegativeMs(options.maxStaleMs ?? 0, {
      name: "maxStaleMs",
    });
    this.#maxKeys = safeInt(options.maxKeys ?? JWKS_MAX_KEYS, {
      name: "maxKeys",
      min: 1,
      max: 10_000,
    });
    const policy: EgressPolicy = {
      allow: () => true,
      redirects: 0,
      timeoutMs: millis(JWKS_TIMEOUT_MS),
      maxBytes: bytes(JWKS_MAX_BYTES),
      json: {
        maxDepth: 8,
        maxKeys: 64,
        maxItems: Math.max(this.#maxKeys, 16),
      },
      network: development ? "loopback" : "public",
      allowCleartextLoopbackForDevelopment: development,
      ...definedEntries(options.egress),
    };
    checkUrl(this.url, policy);
    const fetch = options.fetch;
    this.#get = boundedFetch(
      policy,
      fetch === undefined ? undefined : (input, init) => fetch(input, init),
    );
    const clock = options.now ?? Date.now;
    if (typeof clock !== "function") {
      throw new TypeError("RemoteJwks: now must be a function");
    }
    this.#now = () => finite(clock(), { name: "RemoteJwks now" });
    this.#now();
    this.#headers = new Headers(options.headers);
    if (!this.#headers.has("accept")) {
      this.#headers.set("accept", "application/json");
    }
  }

  /**
   * The last set fetched successfully, or null before the first. It is
   * frozen: the set the key lookups use cannot be changed through it.
   */
  get jwks(): Jwks | null {
    return this.#jwks;
  }

  /**
   * Fetches the set now (sharing a fetch already running) and returns it,
   * frozen. It ignores the backoff, but not the egress deadline.
   */
  async refresh(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Jwks> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (this.#loading === null) {
      this.#loadController = new AbortController();
      this.#loading = this.#load(this.#loadController.signal).finally(() => {
        this.#loading = null;
        this.#loadController = null;
      });
    }
    const loading = this.#loading;
    this.#waiters++;
    let abort: (() => void) | undefined;
    try {
      if (signal === undefined) return await loading;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return await Promise.race([loading, cancelled]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      this.#waiters--;
      if (this.#waiters === 0 && this.#loading === loading) {
        this.#loadController?.abort();
        await loading.catch(() => {});
      }
    }
  }

  async #load(signal: AbortSignal): Promise<Jwks> {
    const previousAttempt = this.#attemptedAt;
    this.#attemptedAt = this.#now();
    try {
      const headers = new Headers(this.#headers);
      if (this.#jwks !== null) {
        const etag = this.#cacheHeaders.get("etag");
        const modified = this.#cacheHeaders.get("last-modified");
        if (etag !== null) headers.set("if-none-match", etag);
        else if (modified !== null) headers.set("if-modified-since", modified);
      }
      const response = await this.#get(this.#url, {
        headers,
        signal,
      });
      if (!response.ok && !(response.status === 304 && this.#jwks !== null)) {
        await response.discard();
        throw new JwtError(
          "jwks",
          `${this.#label} did not return a JWKS (${response.status})`,
        );
      }
      const jwks = response.status === 304 ? this.#jwks! : jwksOf(
        await response.json(),
        this.#maxKeys,
        new URL(this.#label),
        this.#requireAlgorithm,
      );
      if (response.status === 304) await response.discard();
      const cacheHeaders = response.status === 304
        ? new Headers(this.#cacheHeaders)
        : new Headers();
      for (
        const name of [
          "cache-control",
          "age",
          "date",
          "expires",
          "etag",
          "last-modified",
        ]
      ) {
        const value = response.headers.get(name);
        if (value !== null) cacheHeaders.set(name, value);
      }
      const directives = (cacheHeaders.get("cache-control") ?? "")
        .toLowerCase();
      const noStore = /(?:^|,)\s*no-store\s*(?:,|$)/.test(directives);
      const mustValidate =
        /(?:^|,)\s*(?:no-cache|must-revalidate)(?:\s*=|\s*,|\s*$)/.test(
          directives,
        );
      const seconds = cacheControlSeconds(cacheHeaders.get("cache-control"));
      const ageText = cacheHeaders.get("age");
      const age = ageText === null
        ? 0
        : /^\d{1,10}$/.test(ageText)
        ? Number(ageText) * 1000
        : Infinity;
      const expires = Date.parse(cacheHeaders.get("expires") ?? "");
      const date = Date.parse(cacheHeaders.get("date") ?? "");
      const lifetime = seconds === null
        ? Number.isFinite(expires)
          ? Math.max(0, expires - (Number.isFinite(date) ? date : this.#now()))
          : this.#maxAgeMs
        : seconds * 1000;
      this.#lifetimeMs =
        noStore || /(?:^|,)\s*no-cache(?:\s*=|\s*,|\s*$)/.test(directives)
          ? 0
          : Math.max(0, Math.min(this.#maxAgeMs, lifetime - age));
      this.#allowStale = !noStore && !mustValidate;
      this.#jwks = noStore ? null : jwks;
      this.#cacheHeaders = noStore ? new Headers() : cacheHeaders;
      this.#fetchedAt = this.#now();
      this.#failures = 0;
      this.#error = null;
      if (response.status !== 304) this.#imports = new ImportCache();
      return jwks;
    } catch (cause) {
      if (signal.aborted) {
        this.#attemptedAt = previousAttempt;
        throw signal.reason;
      }
      const error = cause instanceof JwtError ? cause : new JwtError(
        "jwks",
        `fetching ${this.#label} failed`,
        {
          // A failed fetch keeps the platform's own error as the cause.
          cause: cause instanceof EgressError && cause.code === "fetch" &&
              cause.cause !== undefined
            ? cause.cause
            : cause,
        },
      );
      this.#failures++;
      this.#error = error;
      throw error;
    }
  }

  /** How long after a failed attempt no fetch is tried. */
  #backoffMs(): number {
    if (this.#failures === 0) return 0;
    return Math.min(
      BACKOFF_MS * 2 ** Math.min(this.#failures - 1, 30),
      this.#cooldownMs,
    );
  }

  #mayFetch(now: number, gap: number): boolean {
    // A clock that stepped back behind the last attempt: its wait is
    // unknown, so it is over.
    if (now < this.#attemptedAt) return true;
    return now - this.#attemptedAt >= Math.max(gap, this.#backoffMs());
  }

  async #current(signal?: AbortSignal): Promise<Current> {
    const now = this.#now();
    // The age of the set; negative when the clock stepped back behind the
    // fetch, and then unknown: the set is neither fresh nor usable stale.
    const age = now - this.#fetchedAt;
    if (this.#jwks !== null && age >= 0 && age < this.#lifetimeMs) {
      return { jwks: this.#jwks, fresh: true, error: null };
    }
    let error = this.#error;
    if (this.#loading !== null || this.#mayFetch(now, 0)) {
      try {
        return {
          jwks: await this.refresh({ signal }),
          fresh: true,
          error: null,
        };
      } catch (cause) {
        if (signal?.aborted) throw cause;
        error = cause as JwtError;
      }
    }
    if (
      this.#jwks !== null && age >= 0 &&
      this.#allowStale &&
      age < this.#lifetimeMs + this.#maxStaleMs
    ) {
      return { jwks: this.#jwks, fresh: false, error };
    }
    throw error ?? new JwtError("jwks", `no JWKS from ${this.#label}`);
  }

  /** See {@link KeySet.resolve}. */
  async resolve(
    header: JwtHeader,
    alg: JwsAlgorithm,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CryptoKey> {
    options.signal?.throwIfAborted();
    if (this.#algorithms !== undefined && !this.#algorithms.includes(alg)) {
      throw new JwtError(
        "alg_not_allowed",
        "algorithm is outside the key-set policy",
      );
    }
    if (isHmac(alg)) {
      throw new JwtError(
        "key_mismatch",
        `a remote JWKS is public and never holds ${alg} keys`,
      );
    }
    const kid = kidOf(header);
    const current = await this.#current(options.signal);
    let jwk = selectJwk(current.jwks, kid, alg);
    if (jwk === null) {
      // A set that could not be refreshed may lack a key the issuer has.
      if (!current.fresh) throw current.error ?? noKey(kid, alg);
      if (
        this.#loading !== null || this.#mayFetch(this.#now(), this.#cooldownMs)
      ) {
        jwk = selectJwk(await this.refresh(options), kid, alg);
      } else if (this.#error !== null) {
        throw this.#error;
      }
    }
    if (jwk === null) throw noKey(kid, alg);
    return await this.#imports.get(jwk, alg, this.#maxKeys);
  }
}
