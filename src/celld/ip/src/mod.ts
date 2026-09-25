// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * IP addresses and CIDR blocks, imported as "@celld/ip".
 *
 * ```ts
 * import { contains, parseCidr, parseIp } from "@celld/ip";
 *
 * parseIp("2001:DB8:0:0:0:0:0:1")?.toString(); // "2001:db8::1"
 * parseIp("::ffff:192.0.2.1")?.toIpv4()?.toString(); // "192.0.2.1"
 * const block = parseCidr("10.1.2.3/8")!;
 * block.network.toString(); // "10.0.0.0"
 * block.broadcast.toString(); // "10.255.255.255"
 * parseCidr("10.1.2.3/8", { strict: true }); // null: host bits are set
 * contains("10.0.0.0/8", "10.200.0.1"); // true
 * ```
 *
 * Parsers return null for text that is not an address or block; the
 * helpers that take text (`contains`, `toIp`, `toCidr`) throw `IpError`
 * instead, so bad configuration is loud. IPv4 octets may not have leading
 * zeros (`010` is ambiguous), and IPv6 zone indices are not accepted.
 * `./patterns` has regular expression sources for the same languages.
 *
 * @module
 */

export {
  compareIp,
  formatIp,
  IpAddress,
  IpError,
  type IpVersion,
  isIp,
  isIpv4,
  isIpv6,
  parseIp,
  parseIpv4,
  parseIpv6,
  toIp,
} from "./address.ts";
export {
  Cidr,
  type CidrOptions,
  contains,
  isCidr,
  isCidrV4,
  isCidrV6,
  parseCidr,
  parseCidrV4,
  parseCidrV6,
  toCidr,
} from "./cidr.ts";
