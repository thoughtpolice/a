// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness's example without an upstream, the shape a pure library's
 * examples take: `GET /greet?name=...` answers from a spec-provided
 * variable, and `POST /sum` adds a list of numbers.
 *
 * Run it: `buck2 run root//src/celld/examples:plain-dev`.
 *
 * @module
 */

interface Env {
  readonly GREETING: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/greet") {
      const name = url.searchParams.get("name") ?? "world";
      return Response.json({ message: `${env.GREETING}, ${name}!` });
    }
    if (request.method === "POST" && url.pathname === "/sum") {
      const numbers = await request.json() as unknown;
      if (
        !Array.isArray(numbers) ||
        !numbers.every((value) => typeof value === "number")
      ) {
        return Response.json({ error: "expected a list of numbers" }, {
          status: 400,
        });
      }
      return Response.json({ sum: numbers.reduce((a, b) => a + b, 0) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
