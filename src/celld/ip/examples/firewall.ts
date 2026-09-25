// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Allow and deny lists in front of an application, by client address.
 *
 * The client's address is `CF-Connecting-IP` when the edge set it.
 * Otherwise it comes from `X-Forwarded-For`, read from the right: each
 * proxy appends the address it received the request from, so hops in
 * `TRUSTED_PROXIES` are skipped and the first address that is not one of
 * them is the client. The leftmost entry is whatever the client claimed,
 * and trusting it would let anyone pick their address. An IPv4-mapped IPv6
 * address (`::ffff:192.0.2.1`) is unmapped first, since `@celld/ip` never
 * matches one against an IPv4 block by itself.
 *
 * The lists are Worker variables, comma-separated CIDR blocks:
 *
 * - `DENY`: refused everywhere (403);
 * - `ADMIN_ALLOW`: the only blocks that may reach `/admin/`;
 * - `TRUSTED_PROXIES`: the proxies in front of the Worker.
 *
 * They are parsed with `toCidr`, which throws on a typo, so a mistyped
 * block answers 500 instead of silently matching nothing. `GET /whoami`
 * shows how a request was seen; `GET /admin/` and anything else stand in
 * for the application.
 *
 * ```sh
 * buck2 run root//src/celld/ip/examples:firewall-dev
 * curl -sS localhost:9876/whoami -H 'x-forwarded-for: 198.51.100.7, 10.0.0.2'
 * curl -sS localhost:9876/admin/ -H 'cf-connecting-ip: 192.0.2.10'
 * ```
 *
 * @module
 */

import { type Cidr, IpError, parseIp, toCidr } from "@celld/ip";

interface Env {
  readonly DENY: string;
  readonly ADMIN_ALLOW: string;
  readonly TRUSTED_PROXIES: string;
}

interface Rules {
  readonly deny: readonly Cidr[];
  readonly admin: readonly Cidr[];
  readonly proxies: readonly Cidr[];
}

function blocks(list: string): Cidr[] {
  return list.split(",").map((item) => item.trim()).filter((item) =>
    item !== ""
  ).map(toCidr);
}

let cached: { readonly env: Env; readonly rules: Rules } | undefined;

function rules(env: Env): Rules {
  if (cached?.env !== env) {
    cached = {
      env,
      rules: {
        deny: blocks(env.DENY),
        admin: blocks(env.ADMIN_ALLOW),
        proxies: blocks(env.TRUSTED_PROXIES),
      },
    };
  }
  return cached.rules;
}

/** Where the client address came from, and the address, unmapped. */
interface Client {
  readonly address: string;
  readonly version: 4 | 6;
  readonly source: "cf-connecting-ip" | "x-forwarded-for";
  readonly hops: number;
}

function client(request: Request, proxies: readonly Cidr[]): Client | string {
  const edge = request.headers.get("cf-connecting-ip");
  let text: string | undefined;
  let source: Client["source"] = "cf-connecting-ip";
  let hops = 0;
  if (edge !== null) {
    text = edge.trim();
  } else {
    source = "x-forwarded-for";
    const chain = (request.headers.get("x-forwarded-for") ?? "").split(",")
      .map((item) => item.trim()).filter((item) => item !== "");
    for (let i = chain.length - 1; i >= 0; i--) {
      text = chain[i];
      const hop = parseIp(text);
      if (hop === null || !proxies.some((block) => block.contains(hop))) break;
      hops++;
    }
  }
  if (text === undefined) return "no client address";
  const parsed = parseIp(text);
  if (parsed === null) return `not an IP address: ${JSON.stringify(text)}`;
  const address = parsed.toIpv4() ?? parsed;
  return {
    address: address.toString(),
    version: address.version,
    source,
    hops,
  };
}

function refuse(status: number, reason: string): Response {
  return Response.json({ error: reason }, { status });
}

export default {
  fetch(request: Request, env: Env): Response {
    let current: Rules;
    try {
      current = rules(env);
    } catch (error) {
      if (error instanceof IpError) {
        return refuse(500, `firewall misconfigured: ${error.message}`);
      }
      throw error;
    }
    const seen = client(request, current.proxies);
    if (typeof seen === "string") return refuse(400, seen);
    const denied = current.deny.find((block) => block.contains(seen.address));
    if (denied !== undefined) {
      return refuse(403, `${seen.address} is in ${denied}`);
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/whoami") return Response.json(seen);
    if (pathname.startsWith("/admin/")) {
      const allowed = current.admin.find((block) =>
        block.contains(seen.address)
      );
      if (allowed === undefined) {
        return refuse(403, `${seen.address} may not reach /admin/`);
      }
      return Response.json({ admin: true, via: allowed });
    }
    return Response.json({ hello: seen.address });
  },
};
