// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Fieldnotes: native Svelte SSR/hydration over one persistent shared notebook.
 * Run: buck2 run root//src/celld/web/kit/examples:fieldnotes-dev
 * Local-only anonymous demo; saved notes are visible to every visitor.
 */

import { app } from "@celld/web/fieldnotes/server";
import type { Env } from "@celld/web/fieldnotes/server";

export { Notebook } from "@celld/web/fieldnotes/server/notebook";

export default {
  fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (pathname === "/app.js" || pathname === "/app.js.map" ||
        pathname === "/app.css" || pathname === "/app.css.map")
    ) {
      return env.ASSETS.fetch(request);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
