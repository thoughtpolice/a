// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Test-only HTTPS-origin adapter for the loopback HTTP example harness.
 * This exercises secure-cookie policy, not TLS termination. Never deploy it.
 * The real provider independently enforces its configured canonical origin.
 */
import provider from "./provider.ts";
export { OAuthRecords } from "./provider.ts";

export default {
  fetch(
    request: Request,
    env: Parameters<typeof provider.fetch>[1],
    ctx: ExecutionContext,
  ): Promise<Response> | Response {
    const source = new URL(request.url);
    if (
      source.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(source.hostname) ||
      env.ISSUER !== "https://op.example"
    ) return new Response("test fixture origin refused", { status: 421 });
    const target = new URL(env.ISSUER);
    target.pathname = source.pathname;
    target.search = source.search;
    return provider.fetch(new Request(target, request), env, ctx);
  },
};
