// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link IpAddress}: parsing IPv4 and IPv6 text, and writing the canonical
 * RFC 5952 form.
 *
 * @module
 */

/** 4 or 6. */
export type IpVersion = 4 | 6;

/** Invalid text, bytes or arguments. */
export class IpError extends Error {
  override name = "IpError";
}

const OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const GROUP = /^[0-9a-fA-F]{1,4}$/;

/**
 * An IPv4 or IPv6 address. `toString()` is the canonical text: dotted
 * decimal, or RFC 5952 for IPv6 (lower case, no leading zeros, the longest
 * run of two or more zero groups as `::`, and IPv4-mapped addresses as
 * `::ffff:a.b.c.d`). Structured clone drops the class; send the string.
 */
export class IpAddress {
  readonly version: IpVersion;
  readonly #bytes: Uint8Array<ArrayBuffer>;

  /** Takes 4 bytes (IPv4) or 16 (IPv6), copied. */
  constructor(bytes: Uint8Array) {
    if (bytes.length !== 4 && bytes.length !== 16) {
      throw new IpError(`an IP address is 4 or 16 bytes, got ${bytes.length}`);
    }
    this.version = bytes.length === 4 ? 4 : 6;
    this.#bytes = Uint8Array.from(bytes);
  }

  /** A copy of the address's bytes, in network order. */
  get bytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#bytes);
  }

  /** The number of bits: 32 or 128. */
  get bits(): 32 | 128 {
    return this.version === 4 ? 32 : 128;
  }

  /** Whether this is an IPv6 address in `::ffff:0:0/96`. */
  isIpv4Mapped(): boolean {
    const b = this.#bytes;
    return this.version === 6 && b.subarray(0, 10).every((x) => x === 0) &&
      b[10] === 0xff && b[11] === 0xff;
  }

  /**
   * The IPv4 address itself, or the one an IPv4-mapped IPv6 address holds;
   * null for any other IPv6 address.
   */
  toIpv4(): IpAddress | null {
    if (this.version === 4) return this;
    return this.isIpv4Mapped() ? new IpAddress(this.#bytes.subarray(12)) : null;
  }

  /** The IPv6 address itself, or an IPv4 address mapped to `::ffff:a.b.c.d`. */
  toIpv6(): IpAddress {
    if (this.version === 6) return this;
    const bytes = new Uint8Array(16);
    bytes[10] = bytes[11] = 0xff;
    bytes.set(this.#bytes, 12);
    return new IpAddress(bytes);
  }

  /** Same version and bytes. */
  equals(other: IpAddress): boolean {
    return compareIp(this, other) === 0;
  }

  /** The canonical text. */
  toString(): string {
    return this.version === 4
      ? this.#bytes.join(".")
      : formatIpv6(this.#bytes, this.isIpv4Mapped());
  }

  /** The canonical text, so addresses serialize as strings. */
  toJSON(): string {
    return this.toString();
  }
}

function formatIpv6(bytes: Uint8Array, mapped: boolean): string {
  const count = mapped ? 6 : 8;
  const groups: number[] = [];
  for (let i = 0; i < count; i++) {
    groups.push(bytes[2 * i] << 8 | bytes[2 * i + 1]);
  }
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < count;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < count && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (list: number[]) => list.map((group) => group.toString(16));
  const tail = mapped ? [Array.from(bytes.subarray(12)).join(".")] : [];
  if (bestStart < 0) return [...hex(groups), ...tail].join(":");
  const head = hex(groups.slice(0, bestStart)).join(":");
  const rest = [...hex(groups.slice(bestStart + bestLength)), ...tail].join(
    ":",
  );
  return `${head}::${rest}`;
}

/** Orders by version (IPv4 first), then by value. */
export function compareIp(a: IpAddress, b: IpAddress): number {
  if (a.version !== b.version) return a.version - b.version;
  const x = a.bytes;
  const y = b.bytes;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

function ipv4Bytes(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => OCTET.test(part))) {
    return null;
  }
  return parts.map(Number);
}

function groupsOf(text: string): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  if (!parts.every((part) => GROUP.test(part))) return null;
  return parts.map((part) => parseInt(part, 16));
}

function ipv6Bytes(text: string): number[] | null {
  if (text.length > 45 || !text.includes(":")) return null;
  let body = text;
  let v4: number[] = [];
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const tail = ipv4Bytes(text.slice(cut + 1));
    if (tail === null) return null;
    v4 = tail;
    body = text.slice(0, cut + 1);
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head === null || tail === null) return null;
  const count = head.length + tail.length + v4.length / 2;
  if (halves.length === 2 ? count > 7 : count !== 8) return null;
  const groups = [
    ...head,
    ...new Array(8 - count).fill(0),
    ...tail,
  ];
  return [...groups.flatMap((group) => [group >> 8, group & 255]), ...v4];
}

/** A dotted-quad IPv4 address (no leading zeros), or null. */
export function parseIpv4(text: string): IpAddress | null {
  const bytes = ipv4Bytes(text);
  return bytes === null ? null : new IpAddress(Uint8Array.from(bytes));
}

/**
 * An IPv6 address in any RFC 4291 text form (`::`, an IPv4 tail, either
 * case), or null. Zone indices (`%eth0`) are not accepted.
 */
export function parseIpv6(text: string): IpAddress | null {
  const bytes = ipv6Bytes(text);
  return bytes === null ? null : new IpAddress(Uint8Array.from(bytes));
}

/** An IPv4 or IPv6 address, or null. */
export function parseIp(text: string): IpAddress | null {
  return text.includes(":") ? parseIpv6(text) : parseIpv4(text);
}

/** Whether `text` is an IPv4 address. */
export function isIpv4(text: string): boolean {
  return ipv4Bytes(text) !== null;
}

/** Whether `text` is an IPv6 address. */
export function isIpv6(text: string): boolean {
  return ipv6Bytes(text) !== null;
}

/** Whether `text` is an IPv4 or IPv6 address. */
export function isIp(text: string): boolean {
  return parseIp(text) !== null;
}

/** An address as given, or parsed from text; throws {@link IpError} when invalid. */
export function toIp(address: IpAddress | string): IpAddress {
  if (address instanceof IpAddress) return address;
  const parsed = parseIp(address);
  if (parsed === null) {
    throw new IpError(`not an IP address: ${JSON.stringify(address)}`);
  }
  return parsed;
}

/** The canonical text of an address, or of an address given as text. */
export function formatIp(address: IpAddress | string): string {
  return toIp(address).toString();
}
