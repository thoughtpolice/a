// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regular expression sources that accept exactly what the parsers accept,
 * for places that need a pattern rather than code, such as JSON Schema's
 * `pattern`. Each is anchored (`^...$`) and uses only syntax JSON Schema's
 * ECMA-262 dialect has.
 *
 * @module
 */

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const V4 = `${OCTET}(?:\\.${OCTET}){3}`;
const H16 = "[0-9a-fA-F]{1,4}";
const LS32 = `(?:${H16}:${H16}|${V4})`;

/** At most `max` groups before a `::`. */
function head(max: number): string {
  return max === 0 ? "" : `(?:(?:${H16}:){0,${max - 1}}${H16})?`;
}

/** RFC 3986's `IPv6address`, one alternative per place `::` can go. */
function ipv6(): string {
  const forms = [`(?:${H16}:){6}${LS32}`];
  for (let after = 5; after >= 0; after--) {
    forms.push(`${head(5 - after)}::(?:${H16}:){${after}}${LS32}`);
  }
  forms.push(`${head(6)}::${H16}`, `${head(7)}::`);
  return `(?:${forms.join("|")})`;
}

const V6 = ipv6();
const PREFIX_V4 = "(?:3[0-2]|[12]?\\d)";
const PREFIX_V6 = "(?:12[0-8]|1[01]\\d|[1-9]?\\d)";

/** A dotted-quad IPv4 address. */
export const IPV4_PATTERN = `^${V4}$`;

/** An IPv6 address, without a zone index. */
export const IPV6_PATTERN = `^${V6}$`;

/** An IPv4 block, host bits allowed. */
export const CIDR_V4_PATTERN = `^${V4}/${PREFIX_V4}$`;

/** An IPv6 block, host bits allowed. */
export const CIDR_V6_PATTERN = `^${V6}/${PREFIX_V6}$`;
