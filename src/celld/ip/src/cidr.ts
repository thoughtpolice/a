// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link Cidr}: an address block written `address/prefix`, and the
 * questions asked of one (does it contain an address, where does it start
 * and end, does it overlap another).
 *
 * @module
 */

import {
  IpAddress,
  IpError,
  type IpVersion,
  parseIpv4,
  parseIpv6,
  toIp,
} from "./address.ts";

/** Options for {@link parseCidr} and the `isCidr` tests. */
export interface CidrOptions {
  /**
   * Reject an address with bits set past the prefix (`10.0.0.1/8`); by
   * default the block is the address's network and the address is kept as
   * {@link Cidr.address}.
   */
  readonly strict?: boolean;
}

const PREFIX = /^(?:0|[1-9]\d{0,2})$/;

function masked(bytes: Uint8Array, prefix: number, fill: 0 | 1): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (let i = 0; i < out.length; i++) {
    const keep = Math.max(0, Math.min(8, prefix - i * 8));
    const mask = keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff;
    out[i] = fill === 0 ? out[i] & mask : out[i] | (~mask & 0xff);
  }
  return out;
}

/**
 * A CIDR block. `network` has the host bits cleared; `address` is the
 * address as written, which may have host bits set (`192.0.2.7/24` names
 * an interface's address and its network). `toString()` is the canonical
 * `network/prefix`.
 */
export class Cidr {
  /** The address as written. */
  readonly address: IpAddress;
  /** The first address of the block. */
  readonly network: IpAddress;
  readonly prefix: number;

  /** Throws {@link IpError} when `prefix` does not fit the address. */
  constructor(address: IpAddress, prefix: number) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) {
      throw new IpError(
        `a prefix for IPv${address.version} is 0 to ${address.bits}, got ${prefix}`,
      );
    }
    this.address = address;
    this.prefix = prefix;
    this.network = new IpAddress(masked(address.bytes, prefix, 0));
  }

  /** 4 or 6. */
  get version(): IpVersion {
    return this.address.version;
  }

  /** Whether the address as written has no host bits set. */
  get isNetwork(): boolean {
    return this.address.equals(this.network);
  }

  /**
   * The last address of the block: the broadcast address for IPv4 (IPv6
   * has no broadcast, but the name is kept for the common case).
   */
  get broadcast(): IpAddress {
    return new IpAddress(masked(this.address.bytes, this.prefix, 1));
  }

  /** The prefix as a mask: `255.255.255.0` for `/24`. */
  get netmask(): IpAddress {
    return new IpAddress(
      masked(new Uint8Array(this.address.bits / 8).fill(255), this.prefix, 0),
    );
  }

  /** The host bits as a mask: `0.0.0.255` for `/24`. */
  get hostmask(): IpAddress {
    return new IpAddress(
      masked(new Uint8Array(this.address.bits / 8), this.prefix, 1),
    );
  }

  /** How many addresses the block holds. */
  get size(): bigint {
    return 2n ** BigInt(this.address.bits - this.prefix);
  }

  /**
   * Whether `address` is in the block. An address of the other version is
   * not, and that includes an IPv4-mapped IPv6 address against an IPv4
   * block: unmap it with `toIpv4()` first if that is what you mean.
   */
  contains(address: IpAddress | string): boolean {
    const ip = toIp(address);
    if (ip.version !== this.version) return false;
    return new IpAddress(masked(ip.bytes, this.prefix, 0)).equals(this.network);
  }

  /** Whether every address of `other` is in this block. */
  covers(other: Cidr | string): boolean {
    const block = toCidr(other);
    return block.version === this.version && block.prefix >= this.prefix &&
      this.contains(block.network);
  }

  /** Whether the two blocks share an address. */
  overlaps(other: Cidr | string): boolean {
    const block = toCidr(other);
    return this.covers(block) || block.covers(this);
  }

  /** `network/prefix`. */
  toString(): string {
    return `${this.network}/${this.prefix}`;
  }

  /** `network/prefix`, so blocks serialize as strings. */
  toJSON(): string {
    return this.toString();
  }
}

function parseWith(
  text: string,
  parse: (text: string) => IpAddress | null,
  options: CidrOptions,
): Cidr | null {
  const slash = text.indexOf("/");
  if (slash < 0) return null;
  const digits = text.slice(slash + 1);
  if (!PREFIX.test(digits)) return null;
  const address = parse(text.slice(0, slash));
  const prefix = Number(digits);
  if (address === null || prefix > address.bits) return null;
  const block = new Cidr(address, prefix);
  return options.strict && !block.isNetwork ? null : block;
}

function eitherVersion(text: string): IpAddress | null {
  return text.includes(":") ? parseIpv6(text) : parseIpv4(text);
}

/** An IPv4 or IPv6 block, `address/prefix`, or null. */
export function parseCidr(
  text: string,
  options: CidrOptions = {},
): Cidr | null {
  return parseWith(text, eitherVersion, options);
}

/** An IPv4 block, or null. */
export function parseCidrV4(
  text: string,
  options: CidrOptions = {},
): Cidr | null {
  return parseWith(text, parseIpv4, options);
}

/** An IPv6 block, or null. */
export function parseCidrV6(
  text: string,
  options: CidrOptions = {},
): Cidr | null {
  return parseWith(text, parseIpv6, options);
}

/** Whether `text` is an IPv4 or IPv6 block. */
export function isCidr(text: string, options: CidrOptions = {}): boolean {
  return parseCidr(text, options) !== null;
}

/** Whether `text` is an IPv4 block, such as `10.0.0.0/8`. */
export function isCidrV4(text: string, options: CidrOptions = {}): boolean {
  return parseCidrV4(text, options) !== null;
}

/** Whether `text` is an IPv6 block, such as `2001:db8::/32`. */
export function isCidrV6(text: string, options: CidrOptions = {}): boolean {
  return parseCidrV6(text, options) !== null;
}

/** A block as given, or parsed from text; throws {@link IpError} when invalid. */
export function toCidr(block: Cidr | string): Cidr {
  if (block instanceof Cidr) return block;
  const parsed = parseCidr(block);
  if (parsed === null) {
    throw new IpError(`not a CIDR block: ${JSON.stringify(block)}`);
  }
  return parsed;
}

/**
 * Whether `address` is in `block`; see {@link Cidr.contains}. Text that is
 * not a block or an address throws {@link IpError}, so a typo in an allow
 * or deny list is never read as "no match".
 */
export function contains(
  block: Cidr | string,
  address: IpAddress | string,
): boolean {
  return toCidr(block).contains(address);
}
