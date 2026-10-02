// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import Page from "@celld/web/kit-test-page";
import { respondPage } from "@celld/web/kit/server";
import { router } from "@celld/web/router";
import { PageRoute, RenameRoute } from "@celld/web/kit-test-contract";

interface Env {
  ASSETS: Fetcher;
}

const pageOptions = {
  title: "celld hydration proof",
  scripts: ["/app.js"],
  styles: ["/app.css"],
};
const app = router<Env>({ auth: "none" })
  .register(PageRoute, (context) => {
    const message = context.query.message;
    return respondPage(context, PageRoute, Page, {
      message: Array.isArray(message)
        ? message.join(" + ")
        : message ?? "Native Svelte",
      count: 7,
    }, pageOptions);
  })
  .register(
    RenameRoute,
    (context) =>
      respondPage(context, RenameRoute, Page, {
        message: context.body.message,
        count: 7,
      }, pageOptions),
  );

export default {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    if (!["/", "/rename"].includes(new URL(request.url).pathname)) {
      return env.ASSETS.fetch(request);
    }
    return app.fetch(request, env, context);
  },
};
