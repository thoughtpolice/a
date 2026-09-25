// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link clientIp}: who connected, believing `X-Forwarded-For` only as far
 * as trusted proxies vouch for it.
 *
 * @module
 */

import { type Cidr, type IpAddress, parseIp, toCidr } from "@celld/ip";

/** Where the client address comes from. */
export interface ClientIpOptions {
  /**
   * The header the platform sets to the connecting peer's address, which
   * clients cannot set themselves. Default `cf-connecting-ip`.
   */
  readonly peerHeader?: string;
  /**
   * Proxies (CIDR blocks) whose `X-Forwarded-For` entries are believed.
   * Default none: the forwarded header is ignored.
   */
  readonly trustedProxies?: readonly (Cidr | string)[];
  /** Default `x-forwarded-for`. */
  readonly forwardedHeader?: string;
}

const parsedProxies = new WeakMap<
  readonly (Cidr | string)[],
  readonly Cidr[]
>();

function proxiesOf(
  list: readonly (Cidr | string)[] | undefined,
): readonly Cidr[] {
  if (list === undefined) return [];
  let parsed = parsedProxies.get(list);
  if (parsed === undefined) {
    parsed = list.map(toCidr);
    parsedProxies.set(list, parsed);
  }
  return parsed;
}

function unmapped(address: IpAddress): IpAddress {
  return address.toIpv4() ?? address;
}

/**
 * The client's address, or null when it cannot be told.
 *
 * The peer header names who connected. If that peer is not a trusted
 * proxy, it is the client and `X-Forwarded-For` is ignored: anyone can
 * write that header, and believing it would let a client pick its address.
 * If the peer is trusted, the forwarded list is read from the right (each
 * proxy appends who it heard from), skipping trusted proxies; the first
 * other address is the client. An entry that is not an address makes the
 * answer null. IPv4-mapped IPv6 addresses come back as IPv4.
 *
 * Trusted proxies are CIDR blocks, parsed with `@celld/ip`'s `toCidr`, so a
 * typo throws instead of trusting nothing (or everything).
 */
export function clientIp(
  request: Request,
  options: ClientIpOptions = {},
): IpAddress | null {
  const proxies = proxiesOf(options.trustedProxies);
  const peerText = request.headers.get(
    options.peerHeader ?? "cf-connecting-ip",
  );
  if (peerText === null) return null;
  const peer = parseIp(peerText.trim());
  if (peer === null) return null;
  let current = unmapped(peer);
  const trusted = (address: IpAddress) =>
    proxies.some((block) => block.contains(address));
  if (!trusted(current)) return current;
  const forwarded = request.headers.get(
    options.forwardedHeader ?? "x-forwarded-for",
  );
  if (forwarded === null) return current;
  const hops = forwarded.split(",").map((hop) => hop.trim());
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i]);
    if (hop === null) return null;
    current = unmapped(hop);
    if (!trusted(current)) return current;
  }
  return current;
}
