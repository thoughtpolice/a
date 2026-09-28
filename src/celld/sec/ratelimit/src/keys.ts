// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Keys: {@link ipKey} groups client addresses into the networks one client
 * controls, and {@link storageKey} turns a limiter's key into the fixed
 * string a Durable Object stores and shards by.
 *
 * @module
 */

import { Cidr, type IpAddress, parseIp } from "@celld/core/ip";
import { checkLimiterName } from "./limiter.ts";

/** Options for {@link ipKey}. */
export interface IpKeyOptions {
  /** The IPv4 block one key covers; default 32 (one address). */
  readonly ipv4Prefix?: number;
  /**
   * The IPv6 block one key covers; default 64, the smallest a customer is
   * usually given, so a client cannot take a fresh key with each of the
   * 2^64 addresses it controls.
   */
  readonly ipv6Prefix?: number;
}

function prefix(value: unknown, max: number, what: string): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > max
  ) {
    throw new RangeError(`${what} must be a whole number from 0 to ${max}`);
  }
  return value;
}

/** Checks {@link IpKeyOptions}, filling in the defaults. */
export function ipKeyOptions(
  options: IpKeyOptions = {},
): Required<IpKeyOptions> {
  return {
    ipv4Prefix: prefix(options.ipv4Prefix ?? 32, 32, "ipv4Prefix"),
    ipv6Prefix: prefix(options.ipv6Prefix ?? 64, 128, "ipv6Prefix"),
  };
}

/**
 * The key for a client address: `ip:` and its block, such as
 * `ip:192.0.2.10/32` or `ip:2001:db8:1:2::/64`. An IPv4-mapped IPv6
 * address counts as its IPv4 address. A missing address (null) is
 * `ip:unknown`, one key that every such request shares, so a client
 * cannot escape its limit by hiding its address.
 *
 * @throws {TypeError} a string that is not an IP address.
 */
export function ipKey(
  address: IpAddress | string | null,
  options: IpKeyOptions = {},
): string {
  const { ipv4Prefix, ipv6Prefix } = ipKeyOptions(options);
  if (address === null) return "ip:unknown";
  const parsed = typeof address === "string" ? parseIp(address) : address;
  if (parsed === null) {
    throw new TypeError(`not an IP address: ${JSON.stringify(address)}`);
  }
  const ip = parsed.toIpv4() ?? parsed;
  const bits = ip.version === 4 ? ipv4Prefix : ipv6Prefix;
  const block = new Cidr(ip, bits);
  return `ip:${block.network}/${bits}`;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/**
 * Imports a secret for keyed storage keys: at least 32 bytes, as text or
 * bytes, imported as a raw HMAC-SHA-256 key.
 */
export async function importKeySecret(
  secret: string | Uint8Array,
): Promise<CryptoKey> {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) {
    throw new RangeError("a key secret must be at least 32 bytes");
  }
  return await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * The storage key for `key` in the limiter `name`: 64 hex digits of
 * SHA-256, or of HMAC-SHA-256 under `secret`, over a domain-separated
 * encoding of both. The key never reaches storage as written, and two
 * limiters never share one. Unkeyed, a stored key can still be matched
 * against guesses (every IPv4 address, say); a secret stops that.
 *
 * @throws {TypeError} a name a limiter may not have. Names cannot hold the
 * NUL that separates them from the key, which keeps the encoding
 * unambiguous.
 */
export async function storageKey(
  name: string,
  key: string,
  secret: CryptoKey | null = null,
): Promise<string> {
  checkLimiterName(name);
  const data = encoder.encode(`celld-ratelimit\u0000${name}\u0000${key}`);
  const digest = secret === null
    ? await crypto.subtle.digest("SHA-256", data)
    : await crypto.subtle.sign("HMAC", secret, data);
  return hex(digest);
}

/** Which of `shards` a storage key belongs to: its first 32 bits, modulo. */
export function shardOf(storage: string, shards: number): number {
  return Number.parseInt(storage.slice(0, 8), 16) % shards;
}
