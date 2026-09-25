// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Key sets: where {@link KeySet.resolve} finds the key for a token's `kid`
 * and `alg`. {@link localJwks} serves a JWKS held in memory;
 * {@link RemoteJwks} fetches one, caches it, and fetches again when a token
 * names a key it does not have (an issuer rotating keys), no more often
 * than its cooldown allows.
 *
 * @module
 */

import type { JwtHeader } from "./decode.ts";
import { JwtError } from "./errors.ts";
import {
  importJwk,
  type Jwk,
  jwkFits,
  type Jwks,
  type JwsAlgorithm,
} from "./keys.ts";

/** Finds verification keys for tokens. */
export interface KeySet {
  /**
   * The key for a token with this header and (already checked) `alg`;
   * throws a {@link JwtError} (`no_key`, or `jwks` for a failed fetch) when
   * there is none.
   */
  resolve(header: JwtHeader, alg: JwsAlgorithm): Promise<CryptoKey>;
}

/** Fetches like the global `fetch`. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The JWK in `jwks` for `kid` and `alg`: one that fits `alg` and has that
 * `kid`; without a `kid`, the only key that fits, or none when several do
 * (guessing would let a token pick its key).
 */
export function selectJwk(
  jwks: Jwks,
  kid: string | undefined,
  alg: JwsAlgorithm,
): Jwk | null {
  const candidates = jwks.keys.filter((jwk) =>
    jwkFits(jwk, alg) && (kid === undefined || jwk.kid === kid)
  );
  if (kid === undefined && candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

class ImportCache {
  readonly #keys = new Map<Jwk, Map<JwsAlgorithm, Promise<CryptoKey>>>();

  async get(jwk: Jwk, alg: JwsAlgorithm): Promise<CryptoKey> {
    let byAlg = this.#keys.get(jwk);
    if (byAlg === undefined) {
      byAlg = new Map();
      this.#keys.set(jwk, byAlg);
    }
    let key = byAlg.get(alg);
    if (key === undefined) {
      key = importJwk(jwk, alg, "verify");
      byAlg.set(alg, key);
      key.catch(() => byAlg.delete(alg));
    }
    return await key;
  }
}

function kidOf(header: JwtHeader): string | undefined {
  return typeof header.kid === "string" ? header.kid : undefined;
}

function noKey(kid: string | undefined, alg: JwsAlgorithm): JwtError {
  return new JwtError(
    "no_key",
    kid === undefined
      ? `no single ${alg} key without a kid`
      : `no ${alg} key with kid ${JSON.stringify(kid)}`,
  );
}

/** A {@link KeySet} over a JWKS in memory. */
export function localJwks(jwks: Jwks): KeySet {
  const cache = new ImportCache();
  return {
    async resolve(header, alg) {
      const kid = kidOf(header);
      const jwk = selectJwk(jwks, kid, alg);
      if (jwk === null) throw noKey(kid, alg);
      return await cache.get(jwk, alg);
    },
  };
}

/** Options for {@link RemoteJwks}. */
export interface RemoteJwksOptions {
  /** Default the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
  /** How long a fetched set is used before it is fetched again; default 10 minutes. */
  readonly maxAgeMs?: number;
  /**
   * The least time between fetches for an unknown `kid`, so tokens naming
   * made-up keys cannot make every request fetch; default 30 seconds.
   */
  readonly cooldownMs?: number;
  /** Extra request headers. */
  readonly headers?: HeadersInit;
  /** Allow `http:` URLs other than loopback ones; default false. */
  readonly allowInsecure?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws unless a set may be fetched from `url`. */
function checkUrl(url: URL, allowInsecure: boolean): void {
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" && (allowInsecure || LOOPBACK.has(url.hostname))
  ) {
    return;
  }
  throw new TypeError(`a JWKS URL must be https: ${url}`);
}

function isJwks(value: unknown): value is Jwks {
  return typeof value === "object" && value !== null &&
    Array.isArray((value as { keys?: unknown }).keys) &&
    (value as { keys: unknown[] }).keys.every((key) =>
      typeof key === "object" && key !== null && !Array.isArray(key)
    );
}

/**
 * A JWKS fetched from a URL (an issuer's `jwks_uri`) and cached for
 * `maxAgeMs`. A token whose key is not in the cached set makes it fetch
 * again, at most once per `cooldownMs`; concurrent resolutions share one
 * fetch. Imported keys are cached with the set.
 */
export class RemoteJwks implements KeySet {
  readonly url: URL;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  readonly #cooldownMs: number;
  readonly #headers: HeadersInit | undefined;
  #jwks: Jwks | null = null;
  #fetchedAt = -Infinity;
  #loading: Promise<Jwks> | null = null;
  #imports = new ImportCache();

  /** Throws a `TypeError` for a URL that is not `https:` (or loopback `http:`). */
  constructor(url: string | URL, options: RemoteJwksOptions = {}) {
    this.url = new URL(url);
    checkUrl(this.url, options.allowInsecure ?? false);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#maxAgeMs = options.maxAgeMs ?? 600_000;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#headers = options.headers;
  }

  /** The set as last fetched, or null before the first fetch. */
  get jwks(): Jwks | null {
    return this.#jwks;
  }

  /** Fetches the set now (sharing a fetch already running) and returns it. */
  async refresh(): Promise<Jwks> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = null;
    });
    return await this.#loading;
  }

  async #load(): Promise<Jwks> {
    const headers = new Headers(this.#headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    let body: unknown;
    let status = 0;
    try {
      const response = await this.#fetch(this.url.href, { headers });
      status = response.status;
      body = response.ok ? await response.json() : undefined;
    } catch (cause) {
      throw new JwtError("jwks", `fetching ${this.url} failed`, { cause });
    }
    if (!isJwks(body)) {
      throw new JwtError(
        "jwks",
        `${this.url} did not return a JWKS (${status})`,
      );
    }
    this.#jwks = body;
    this.#fetchedAt = this.#now();
    this.#imports = new ImportCache();
    return body;
  }

  async #current(): Promise<Jwks> {
    if (this.#jwks !== null && this.#now() - this.#fetchedAt < this.#maxAgeMs) {
      return this.#jwks;
    }
    return await this.refresh();
  }

  /** See {@link KeySet.resolve}. */
  async resolve(header: JwtHeader, alg: JwsAlgorithm): Promise<CryptoKey> {
    const kid = kidOf(header);
    let jwk = selectJwk(await this.#current(), kid, alg);
    if (jwk === null && this.#now() - this.#fetchedAt >= this.#cooldownMs) {
      jwk = selectJwk(await this.refresh(), kid, alg);
    }
    if (jwk === null) throw noKey(kid, alg);
    return await this.#imports.get(jwk, alg);
  }
}
