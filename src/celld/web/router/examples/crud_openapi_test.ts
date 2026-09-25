// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-CALL-005: the crud example builds its OpenAPI document once, when the
// module loads after every route is registered, and serves that same text
// on every request; no request pays for generating it.

import { assert, assertEquals } from "@celld/core/assert";
import { Router } from "@celld/web/router";

Deno.test("the crud example generates its OpenAPI document once", async () => {
  // `openapi(app)` lists the routes through `routes()`; count its calls.
  const routes = Router.prototype.routes;
  let listed = 0;
  Router.prototype.routes = function (this: Router) {
    listed++;
    return routes.call(this);
  };
  try {
    const { default: worker } = await import("./crud.ts");
    assertEquals(listed, 1, "generated when the module loaded");
    const env = { BOOKMARKS: {} };
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const answer = await worker.fetch(
        new Request("https://bookmarks.example.com/openapi.json"),
        env as never,
        ctx,
      );
      assertEquals(answer.status, 200);
      texts.push(await answer.text());
    }
    assertEquals(listed, 1, "no request generated it again");
    assertEquals(new Set(texts).size, 1, "the same text every time");
    const document = JSON.parse(texts[0]);
    // Made after the last route, and without its own route.
    assert("/bookmarks/{id}" in document.paths, "every route is in it");
    assert(!("/openapi.json" in document.paths), "its own route is not");
  } finally {
    Router.prototype.routes = routes;
  }
});
