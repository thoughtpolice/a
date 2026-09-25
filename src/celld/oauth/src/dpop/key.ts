// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The client half of DPoP (RFC 9449 sections 4 and 7): {@link DpopKey}
 * holds the key pair a client proves possession of and signs proofs with,
 * and {@link DpopNonceCache} remembers the nonces servers hand out.
 *
 * @module
 */

import {
  generateKeyPair,
  importJwk,
  isJwsAlgorithm,
  type Jwk,
  jwkThumbprint,
  publicJwk,
  sign,
} from "@celld/jwt";
import { OAuthError } from "../errors.ts";
import { type Clock, defaultClock, randomToken, sha256 } from "../util.ts";
import { normalizeHtu } from "./htu.ts";

/**
 * The asymmetric algorithms a DPoP proof may use. Symmetric algorithms
 * cannot prove possession to a server that does not share the key, and
 * `none` is never a signature.
 */
export const DPOP_ALGORITHMS = [
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "RS256",
  "RS384",
  "RS512",
  "EdDSA",
  "Ed25519",
] as const;

/** A DPoP proof algorithm; see {@link DPOP_ALGORITHMS}. */
export type DpopAlgorithm = typeof DPOP_ALGORITHMS[number];

/**
 * What servers accept unless configured otherwise: ECDSA, RSA-PSS and
 * RS256. Ed25519 is left out because celld's WebCrypto cannot verify it;
 * a server running elsewhere can add `EdDSA`.
 */
export const DEFAULT_DPOP_ALGORITHMS: readonly DpopAlgorithm[] = [
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "RS256",
];

/** Whether `alg` is a DPoP proof algorithm. */
export function isDpopAlgorithm(alg: unknown): alg is DpopAlgorithm {
  return typeof alg === "string" &&
    (DPOP_ALGORITHMS as readonly string[]).includes(alg);
}

/** RFC 9449 section 4.2: the `ath` of an access token, base64url(SHA-256(token)). */
export async function accessTokenHash(accessToken: string): Promise<string> {
  return await sha256(accessToken);
}

/** What a proof is for. */
export interface DpopProofOptions {
  /** The request's method (`htm`). */
  readonly method: string;
  /** The request's URL; the query and fragment are dropped (`htu`). */
  readonly url: string | URL;
  /** The access token sent with the request, which the proof then hashes (`ath`). */
  readonly accessToken?: string;
  /** The server's most recent `DPoP-Nonce`. */
  readonly nonce?: string;
  /** More claims, which cannot replace the ones above. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /** Default the key's clock. */
  readonly now?: Clock;
}

/** How {@link DpopKey.generate} makes a key. */
export interface DpopKeyOptions {
  /** Default ES256. */
  readonly alg?: DpopAlgorithm;
  /**
   * Whether the private key can be exported with
   * {@link DpopKey.exportPrivateJwk}, to keep a key (and the tokens bound
   * to it) across restarts; default false.
   */
  readonly extractable?: boolean;
  /** Default `Date.now`. */
  readonly now?: Clock;
}

const PRIVATE = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** Whether a JWK has any private or symmetric key member. */
export function hasPrivateMembers(jwk: object): boolean {
  return PRIVATE.some((member) => member in jwk);
}

/**
 * A client's DPoP key pair. The public key goes in every proof's header;
 * its RFC 7638 thumbprint ({@link DpopKey.jkt}) is what the server binds
 * tokens to, and what the client sends as `dpop_jkt` to bind an
 * authorization code.
 */
export class DpopKey {
  readonly alg: DpopAlgorithm;
  /** The public key, with only the members a thumbprint needs plus `kty`/`crv`. */
  readonly publicJwk: Jwk;
  /** The RFC 7638 SHA-256 thumbprint of the public key. */
  readonly jkt: string;
  readonly #privateKey: CryptoKey;
  readonly #now: Clock;

  private constructor(
    alg: DpopAlgorithm,
    privateKey: CryptoKey,
    jwk: Jwk,
    jkt: string,
    now: Clock,
  ) {
    this.alg = alg;
    this.#privateKey = privateKey;
    this.publicJwk = jwk;
    this.jkt = jkt;
    this.#now = now;
  }

  static async #make(
    alg: DpopAlgorithm,
    privateKey: CryptoKey,
    jwk: Jwk,
    now: Clock | undefined,
  ): Promise<DpopKey> {
    const { kid: _kid, alg: _alg, use: _use, ...bare } = publicJwk(jwk);
    return new DpopKey(
      alg,
      privateKey,
      bare,
      await jwkThumbprint(bare),
      now ?? defaultClock,
    );
  }

  /** A new key pair; ES256 unless `alg` says otherwise. */
  static async generate(options: DpopKeyOptions = {}): Promise<DpopKey> {
    const alg = options.alg ?? "ES256";
    if (!isDpopAlgorithm(alg)) {
      throw new TypeError(`${alg} is not a DPoP algorithm`);
    }
    const pair = await generateKeyPair(alg, {
      extractable: options.extractable ?? false,
    });
    return await DpopKey.#make(
      alg,
      pair.privateKey,
      pair.publicJwk,
      options.now,
    );
  }

  /** A key from a private JWK (as {@link exportPrivateJwk} returns). */
  static async fromPrivateJwk(
    jwk: Jwk,
    alg: DpopAlgorithm,
    options: { readonly now?: Clock; readonly extractable?: boolean } = {},
  ): Promise<DpopKey> {
    if (!isDpopAlgorithm(alg) || !isJwsAlgorithm(alg)) {
      throw new TypeError(`${alg} is not a DPoP algorithm`);
    }
    const {
      kid: _kid,
      alg: _alg,
      use: _use,
      key_ops: _ops,
      ext: _ext,
      ...material
    } = jwk;
    let privateKey: CryptoKey;
    if (options.extractable) {
      const verifyable = await importJwk(material, alg, "sign");
      privateKey = await crypto.subtle.importKey(
        "jwk",
        material,
        verifyable.algorithm,
        true,
        ["sign"],
      );
    } else {
      privateKey = await importJwk(material, alg, "sign");
    }
    return await DpopKey.#make(
      alg,
      privateKey,
      publicJwk(material),
      options.now,
    );
  }

  /** A key from a `CryptoKey` private key and its public JWK. */
  static async fromKeyPair(
    privateKey: CryptoKey,
    publicKey: Jwk,
    alg: DpopAlgorithm,
    options: { readonly now?: Clock } = {},
  ): Promise<DpopKey> {
    if (!isDpopAlgorithm(alg)) {
      throw new TypeError(`${alg} is not a DPoP algorithm`);
    }
    if (hasPrivateMembers(publicKey)) {
      throw new TypeError("the public JWK has private members");
    }
    return await DpopKey.#make(alg, privateKey, publicKey, options.now);
  }

  /**
   * The private key as a JWK, to store (encrypted) and reload with
   * {@link fromPrivateJwk}. Only for keys made `extractable`.
   */
  async exportPrivateJwk(): Promise<Jwk> {
    if (!this.#privateKey.extractable) {
      throw new TypeError("this DPoP key is not extractable");
    }
    const jwk = await crypto.subtle.exportKey("jwk", this.#privateKey) as Jwk;
    const { key_ops: _ops, ext: _ext, ...rest } = jwk;
    return rest;
  }

  /**
   * A DPoP proof JWT (RFC 9449 section 4.2) for one request: header `typ`
   * `dpop+jwt`, the algorithm and the public JWK; claims a fresh 128-bit
   * `jti`, `htm`, the normalized `htu`, `iat`, and `ath` and `nonce` when
   * given.
   */
  async proof(options: DpopProofOptions): Promise<string> {
    const claims: Record<string, unknown> = {
      ...options.claims,
      jti: randomToken(16),
      htm: options.method,
      htu: normalizeHtu(options.url),
      iat: Math.floor((options.now ?? this.#now)() / 1000),
    };
    if (options.accessToken !== undefined) {
      claims.ath = await accessTokenHash(options.accessToken);
    }
    if (options.nonce !== undefined) claims.nonce = options.nonce;
    return await sign(claims, this.#privateKey, {
      alg: this.alg,
      typ: "dpop+jwt",
      header: { jwk: this.publicJwk },
    });
  }
}

/**
 * The nonces servers have handed out in `DPoP-Nonce` headers, per origin:
 * an authorization server and a resource server keep separate nonces
 * (RFC 9449 sections 8 and 9), and a proof for one never carries the
 * other's.
 */
export class DpopNonceCache {
  readonly #nonces = new Map<string, string>();

  /** The nonce to put in a proof for `url`, if its server gave one. */
  get(url: string | URL): string | undefined {
    return this.#nonces.get(new URL(String(url)).origin);
  }

  /** Remembers the `DPoP-Nonce` of a response from `url`; returns it, if any. */
  update(url: string | URL, source: Response | Headers): string | undefined {
    const headers = source instanceof Headers ? source : source.headers;
    const nonce = headers.get("dpop-nonce");
    if (nonce === null || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(nonce)) {
      return undefined;
    }
    this.#nonces.set(new URL(String(url)).origin, nonce);
    return nonce;
  }

  /** Sets a nonce directly. */
  set(url: string | URL, nonce: string): void {
    this.#nonces.set(new URL(String(url)).origin, nonce);
  }
}

/** Throws a `dpop` {@link OAuthError} unless a server offered this key's algorithm. */
export function checkDpopAlgorithm(
  key: DpopKey,
  supported: readonly string[] | undefined,
  server: string,
): void {
  if (supported !== undefined && !supported.includes(key.alg)) {
    throw new OAuthError(
      "dpop",
      `${server} accepts DPoP proofs signed with ${
        supported.join(", ")
      }, not ${key.alg}`,
    );
  }
}
