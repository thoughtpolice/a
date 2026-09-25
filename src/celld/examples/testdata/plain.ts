// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness's example without an upstream, the shape a pure library's
 * examples take: `GET /greet?name=...` answers from a spec-provided
 * variable, and `POST /sum` adds a list of numbers. Its body is read under
 * a 4 KiB cap, as every example's must be (with [`capped.ts`](capped.ts),
 * since the harness sits below `@celld/core/bounds`); anything larger is a
 * 413, and a list may hold at most 1000 numbers.
 *
 * Run it: `buck2 run root//src/celld/examples:plain-dev`.
 *
 * @module
 */

import { readCapped, TooLarge } from "./capped.ts";

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
      let numbers: unknown;
      try {
        // JSON.parse is safe on a body this small: 4 KiB bounds its work.
        numbers = JSON.parse(await readCapped(request, 4096));
      } catch (error) {
        if (error instanceof TooLarge) {
          return Response.json({ error: "too_large" }, { status: 413 });
        }
        if (!(error instanceof SyntaxError)) throw error;
        numbers = undefined;
      }
      if (
        !Array.isArray(numbers) || numbers.length > 1000 ||
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
