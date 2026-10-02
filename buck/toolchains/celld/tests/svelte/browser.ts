// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import Page from "@celld/web/kit-test-page";
import { hydratePage } from "@celld/web/kit/browser";
import { createClient } from "@celld/web/router/client";
import { PageRoute, RenameRoute } from "@celld/web/kit-test-contract";
import { createNavigation, definePage } from "@celld/web/kit/navigation";
import { enhanceForm } from "@celld/web/kit/actions";
import { flushSync, tick } from "svelte";

const page = hydratePage(Page);
const api = createClient({ page: PageRoute, rename: RenameRoute }, {
  baseUrl: location.origin,
});
createNavigation({
  pages: [definePage(PageRoute, (context) => {
    const message = context.query.message;
    return api.call("page", {
      query: {
        message: typeof message === "string" || message === undefined
          ? message
          : [...message],
      },
      signal: context.signal,
    });
  })],
  onState: (state) => page.setNavigation(state),
  commit: async (data, context) => {
    if (context.signal.aborted) return;
    page.setPage(data);
    await tick();
  },
});
const form = document.querySelector<HTMLFormElement>("form")!;
enhanceForm(form, {
  route: RenameRoute,
  submit: (context, signal) => {
    const message = context.data.get("message");
    if (typeof message !== "string") {
      throw new TypeError("message must be a successful text control");
    }
    return api.call("rename", {
      body: { message },
      query: context.query,
      signal,
    });
  },
  onState: (state) => flushSync(() => page.setAction(state)),
});
