// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A subnet calculator API.
 *
 * - `GET /cidr/<address>/<prefix>` describes a block: its network, last
 *   address, netmask, hostmask and size (a string, since an IPv6 block can
 *   hold more addresses than a JSON number can count), and whether the
 *   address as written had host bits set. `?strict` refuses those.
 * - `GET /ip/<address>` gives an address's canonical text and, for an
 *   IPv4-mapped IPv6 address, the IPv4 address inside.
 * - `POST /contains` with `{"block", "addresses": [...]}` says which
 *   addresses are in the block.
 * - `POST /summarize` with `{"blocks": [...]}` returns the blocks sorted,
 *   without duplicates and without blocks another one covers, and which
 *   block covers each one dropped. (Two CIDR blocks overlap only when one
 *   covers the other.)
 *
 * Input is parsed with the `parse*` functions, which return null, so every
 * bad entry is reported instead of the first one thrown.
 *
 * ```sh
 * buck2 run root//src/celld/ip/examples:subnet-dev
 * curl -sS localhost:9876/cidr/192.0.2.77/26
 * curl -sS -X POST localhost:9876/summarize -d '{"blocks": ["10.0.0.0/8", "10.1.0.0/16"]}'
 * ```
 *
 * @module
 */

import { type Cidr, compareIp, parseCidr, parseIp } from "@celld/ip";

function error(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function describe(text: string, strict: boolean): Response {
  const block = parseCidr(text, { strict });
  if (block === null) {
    const loose = strict ? parseCidr(text) : null;
    return error(
      loose !== null
        ? `${text} has host bits set; the network is ${loose}`
        : `not a CIDR block: ${JSON.stringify(text)}`,
    );
  }
  return Response.json({
    block: block.toString(),
    version: block.version,
    address: block.address,
    network: block.network,
    last: block.broadcast,
    netmask: block.netmask,
    hostmask: block.hostmask,
    prefix: block.prefix,
    size: block.size.toString(),
    hostBitsSet: !block.isNetwork,
  });
}

function address(text: string): Response {
  const ip = parseIp(text);
  if (ip === null) return error(`not an IP address: ${JSON.stringify(text)}`);
  return Response.json({
    address: ip,
    version: ip.version,
    ipv4: ip.toIpv4(),
    ipv6: ip.toIpv6(),
  });
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

function contains(body: { block?: unknown; addresses?: unknown }): Response {
  if (typeof body.block !== "string" || !strings(body.addresses)) {
    return error("expected {block, addresses: [...]}");
  }
  const block = parseCidr(body.block);
  if (block === null) return error(`not a CIDR block: ${body.block}`);
  const bad = body.addresses.filter((text) => parseIp(text) === null);
  if (bad.length > 0) return Response.json({ invalid: bad }, { status: 400 });
  return Response.json({
    block,
    contains: Object.fromEntries(
      body.addresses.map((text) => [text, block.contains(text)]),
    ),
  });
}

function byNetwork(a: Cidr, b: Cidr): number {
  return compareIp(a.network, b.network) || a.prefix - b.prefix;
}

function summarize(body: { blocks?: unknown }): Response {
  if (!strings(body.blocks)) return error("expected {blocks: [...]}");
  const parsed = body.blocks.map((text) => parseCidr(text));
  const bad = body.blocks.filter((_, i) => parsed[i] === null);
  if (bad.length > 0) return Response.json({ invalid: bad }, { status: 400 });
  const blocks = (parsed as Cidr[]).sort(byNetwork);
  const kept: Cidr[] = [];
  const covered: { block: Cidr; by: Cidr }[] = [];
  for (const block of blocks) {
    const by = kept.find((other) => other.covers(block));
    if (by === undefined) kept.push(block);
    else if (by.toString() !== block.toString()) covered.push({ block, by });
  }
  return Response.json({ blocks: kept, covered });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (request.method === "GET" && path.startsWith("/cidr/")) {
      return describe(path.slice(6), url.searchParams.has("strict"));
    }
    if (request.method === "GET" && path.startsWith("/ip/")) {
      return address(path.slice(4));
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (typeof body !== "object" || body === null) {
        return error("expected a JSON object");
      }
      if (path === "/contains") return contains(body);
      if (path === "/summarize") return summarize(body);
    }
    return error("not found", 404);
  },
};
