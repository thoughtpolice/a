// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-provided DPoP nonces (RFC 9449 section 8): a server that wants
 * proofs to be fresh hands out a nonce in `DPoP-Nonce` and refuses proofs
 * without a current one (`use_dpop_nonce`).
 * {@link DpopNonceIssuer} does it without storage: a nonce is a time slot
 * and an HMAC of it, so every isolate sharing the secret issues and
 * accepts the same nonces.
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/jwt";
import { type Clock, defaultClock, timingSafeEqual } from "../util.ts";

/** Issues and checks nonces. */
export interface DpopNonceSource {
  /** The nonce to send in `DPoP-Nonce` now. */
  current(): Promise<string>;
  /** Whether a proof's nonce is still accepted. */
  check(nonce: string): Promise<boolean>;
}

/** Options for {@link DpopNonceIssuer.create}. */
export interface DpopNonceIssuerOptions {
  /**
   * The HMAC key: at least 32 bytes, the same in every isolate that should
   * accept the same nonces. Default a random key, private to this issuer.
   */
  readonly secret?: Uint8Array | string;
  /**
   * How long a nonce is accepted, in seconds; default 300. A new nonce is
   * issued every half of this, and the previous one is still accepted.
   */
  readonly lifetimeSec?: number;
  /** Default `Date.now`. */
  readonly now?: Clock;
}

/** A stateless {@link DpopNonceSource}; see the module documentation. */
export class DpopNonceIssuer implements DpopNonceSource {
  readonly #key: CryptoKey;
  readonly #slotMs: number;
  readonly #now: Clock;

  private constructor(key: CryptoKey, slotMs: number, now: Clock) {
    this.#key = key;
    this.#slotMs = slotMs;
    this.#now = now;
  }

  /** An issuer; throws `TypeError` for a secret shorter than 32 bytes. */
  static async create(
    options: DpopNonceIssuerOptions = {},
  ): Promise<DpopNonceIssuer> {
    const secret = typeof options.secret === "string"
      ? new TextEncoder().encode(options.secret)
      : options.secret ?? crypto.getRandomValues(new Uint8Array(32));
    if (secret.length < 32) {
      throw new TypeError("a DPoP nonce secret needs at least 32 bytes");
    }
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const lifetime = options.lifetimeSec ?? 300;
    if (!(lifetime >= 2)) throw new TypeError("lifetimeSec must be at least 2");
    return new DpopNonceIssuer(
      key,
      Math.floor(lifetime * 1000 / 2),
      options.now ?? defaultClock,
    );
  }

  async #nonce(slot: number): Promise<string> {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(slot));
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", this.#key, bytes),
    );
    const out = new Uint8Array(8 + 16);
    out.set(bytes);
    out.set(mac.subarray(0, 16), 8);
    return toBase64Url(out);
  }

  #slot(): number {
    return Math.floor(this.#now() / this.#slotMs);
  }

  /** The nonce of the current slot. */
  async current(): Promise<string> {
    return await this.#nonce(this.#slot());
  }

  /** Whether `nonce` is this issuer's for the current or previous slot. */
  async check(nonce: string): Promise<boolean> {
    const bytes = fromBase64Url(nonce);
    if (bytes === null || bytes.length !== 24) return false;
    const slot = Number(new DataView(bytes.buffer).getBigUint64(0));
    const now = this.#slot();
    if (slot !== now && slot !== now - 1) return false;
    return timingSafeEqual(nonce, await this.#nonce(slot));
  }
}
