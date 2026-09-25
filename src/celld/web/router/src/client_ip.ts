// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link clientIp} and {@link clientIpForAuthorization}: who connected,
 * believing `X-Forwarded-For` only as far as trusted proxies vouch for it.
 *
 * @module
 */

import { type Cidr, type IpAddress, parseIp } from "@celld/core/ip";
import { type Context, requestOf, settingsOf } from "./context.ts";

/** Where the client address comes from. */
export interface ClientIpOptions {
  /**
   * The connecting peer's address, from the platform: a socket address, or
   * a header the platform sets and clients cannot. Default: the
   * `CF-Connecting-IP` header (or `peerHeader`), which is right **only on
   * Cloudflare's edge**, which overwrites it; anywhere a client can reach
   * the Worker directly (another host, a tunnel, `celld dev`) it is an
   * ordinary header the client writes. Give the platform's own source
   * there. Not with `peerHeader`.
   *
   * The default serves {@link clientIp} (logs, rate-limit keys) only.
   * Anything that grants trust on the peer, {@link clientIpForAuthorization}
   * and `publicUrl: { mode: "trusted-proxy" }`, needs the source named:
   * `peer`, or `peerHeader: "cf-connecting-ip"` on Cloudflare's edge.
   */
  readonly peer?: (c: Context) => string | null;
  /**
   * The header the default `peer` reads. Default `cf-connecting-ip`; see
   * `peer` for when a header can be trusted.
   */
  readonly peerHeader?: string;
  /**
   * Proxies (CIDR blocks) whose `X-Forwarded-For` entries are believed.
   * Default none: the forwarded header is ignored. Parsed when the router
   * is made; a block that does not parse throws then.
   */
  readonly trustedProxies?: readonly (Cidr | string)[];
  /** Default `x-forwarded-for`. */
  readonly forwardedHeader?: string;
  /**
   * Make {@link clientIp} (and `c.ip()`) null for a chain that names no
   * client: a trusted proxy that forwarded nothing, or only trusted hops.
   * Default false, where it answers with the innermost address it has.
   * {@link clientIpForAuthorization} is always strict.
   */
  readonly strict?: boolean;
}

/**
 * Whether the router names its peer source (`peer` or `peerHeader`) rather
 * than falling back to the `CF-Connecting-IP` default.
 */
export function explicitPeer(options: ClientIpOptions): boolean {
  return options.peer !== undefined || options.peerHeader !== undefined;
}

/** The connecting peer's address as text, per the router's settings. */
export function peerAddress(c: Context): string | null {
  const options = settingsOf(c).clientIp;
  if (options.peer !== undefined) {
    const peer = options.peer(c);
    if (peer !== null && typeof peer !== "string") {
      throw new TypeError("clientIp.peer must return a string or null");
    }
    return peer;
  }
  return requestOf(c).headers.get(options.peerHeader ?? "cf-connecting-ip");
}

function unmapped(address: IpAddress): IpAddress {
  return address.toIpv4() ?? address;
}

/** What the chain says: the address, and whether it names a client. */
interface Resolved {
  readonly address: IpAddress | null;
  readonly complete: boolean;
}

const NONE: Resolved = { address: null, complete: false };

function resolve(c: Context): Resolved {
  const options = settingsOf(c).clientIp;
  const proxies = (options.trustedProxies ?? []) as readonly Cidr[];
  const peerText = peerAddress(c);
  if (peerText === null) return NONE;
  const peer = parseIp(peerText.trim());
  if (peer === null) return NONE;
  let current = unmapped(peer);
  const trusted = (address: IpAddress) =>
    proxies.some((block) => block.contains(address));
  if (!trusted(current)) return { address: current, complete: true };
  const forwarded = requestOf(c).headers.get(
    options.forwardedHeader ?? "x-forwarded-for",
  );
  // A trusted proxy that says nothing about who it heard from: the
  // address is the proxy's own, not a client's.
  if (forwarded === null) return { address: current, complete: false };
  const hops = forwarded.split(",").map((hop) => hop.trim());
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i]);
    if (hop === null) return NONE;
    current = unmapped(hop);
    if (!trusted(current)) return { address: current, complete: true };
  }
  return { address: current, complete: false };
}

/**
 * The client's address, for logs, rate-limit keys and the like: the peer,
 * or, when the peer is a trusted proxy, the rightmost `X-Forwarded-For`
 * entry that is not a trusted proxy. An entry that is not an address makes
 * it null. When the chain names no client (a trusted proxy that forwarded
 * nothing, or only trusted hops) it is the innermost address seen, or null
 * with `strict`. IPv4-mapped IPv6 addresses come back as IPv4.
 *
 * Do not grant access on it; use {@link clientIpForAuthorization}.
 */
export function clientIp(c: Context): IpAddress | null {
  const { address, complete } = resolve(c);
  if (!complete && settingsOf(c).clientIp.strict === true) return null;
  return address;
}

/**
 * The client's address, for access decisions (an allow list of sender
 * networks, say): the same walk as {@link clientIp}, but null unless the
 * chain is complete, meaning the peer is not a trusted proxy, or a trusted
 * proxy named an untrusted client. It is only as good as the peer source,
 * so it is always null unless the router names one (`clientIp.peer`, or
 * `clientIp.peerHeader: "cf-connecting-ip"` on Cloudflare's edge): the
 * default header is one any client writes when it reaches the Worker
 * directly.
 */
export function clientIpForAuthorization(c: Context): IpAddress | null {
  if (!explicitPeer(settingsOf(c).clientIp)) return null;
  const { address, complete } = resolve(c);
  return complete ? address : null;
}
