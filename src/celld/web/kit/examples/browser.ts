// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import Page from "@celld/web/fieldnotes/views";
import {
  AddNoteRoute,
  GuideRoute,
  NotesRoute,
  routes,
} from "@celld/web/fieldnotes/contracts";
import type { App } from "@celld/web/fieldnotes/server";
import { hydratePage } from "@celld/web/kit/browser";
import { createNavigation, definePage } from "@celld/web/kit/navigation";
import { enhanceForm } from "@celld/web/kit/actions";
import { createClient } from "@celld/web/router/client";
import { flushSync, tick } from "svelte";

const page = hydratePage(Page);
const api = createClient<App>()(routes, { baseUrl: location.origin });
let enhanced: { destroy(): void } | undefined;
let enhancedNode: HTMLFormElement | null = null;

function attachForm(): void {
  const form = document.querySelector<HTMLFormElement>("#add-note");
  if (form === enhancedNode) return;
  enhanced?.destroy();
  enhanced = undefined;
  enhancedNode = form;
  if (!form) return;
  enhanced = enhanceForm(form, {
    route: AddNoteRoute,
    submit: (context, signal) => {
      const title = context.data.get("title");
      const body = context.data.get("body");
      if (typeof title !== "string" || typeof body !== "string") {
        throw new TypeError("note fields must be successful text controls");
      }
      return api.call("add", { body: { title, body }, signal });
    },
    onState: (state) => flushSync(() => page.setAction(state)),
  });
}

const navigation = createNavigation({
  pages: [
    definePage(
      NotesRoute,
      (context) => api.call("notes", { signal: context.signal }),
    ),
    definePage(
      GuideRoute,
      (context) => api.call("guide", { signal: context.signal }),
    ),
  ],
  onState: (state) => page.setNavigation(state),
  commit: async (data, context) => {
    if (context.signal.aborted) return;
    page.setPage(data);
    await tick();
    if (context.signal.aborted) return;
    attachForm();
    document.title = data.view === "guide"
      ? "Fieldnotes — Guide"
      : "Fieldnotes";
  },
});
attachForm();
globalThis.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  navigation.destroy();
  enhanced?.destroy();
});
