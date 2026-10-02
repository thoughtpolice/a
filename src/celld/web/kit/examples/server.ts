// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Local-only anonymous demo: one shared notebook, not per-user or private. */

import {
  AddNoteRoute,
  GuideRoute,
  NotesRoute,
} from "@celld/web/fieldnotes/contracts";
import type { PageData } from "@celld/web/fieldnotes/contracts";
import Page from "@celld/web/fieldnotes/views";
import { respondPage } from "@celld/web/kit/server";
import { router } from "@celld/web/router";
import type { Notebook } from "./notebook.ts";

/** Static assets and the single persistent Fieldnotes notebook. */
export interface Env {
  readonly ASSETS: Fetcher;
  readonly NOTEBOOK: DurableObjectNamespace<Notebook>;
}

const pageOptions = {
  title: "Fieldnotes",
  scripts: ["/app.js"],
  styles: ["/app.css"],
};

/** Shared route descriptors keep validation, SSR and browser JSON in sync. */
export const app = router<Env>({ auth: "none" })
  .register(NotesRoute, async (context) => {
    const data: PageData = {
      view: "notes",
      notes: await context.env.NOTEBOOK.getByName("fieldnotes").list(),
    };
    return respondPage(context, NotesRoute, Page, data, pageOptions);
  })
  .register(GuideRoute, async (context) => {
    const data: PageData = {
      view: "guide",
      notes: await context.env.NOTEBOOK.getByName("fieldnotes").list(),
    };
    return respondPage(context, GuideRoute, Page, data, pageOptions);
  })
  .register(AddNoteRoute, { limits: { body: 2048 } }, async (context) => {
    const data: PageData = {
      view: "notes",
      notes: await context.env.NOTEBOOK.getByName("fieldnotes").add(
        context.body.title,
        context.body.body,
      ),
    };
    return respondPage(context, AddNoteRoute, Page, data, pageOptions);
  });

/** Browser clients import this contract as a type, never the server runtime. */
export type App = typeof app;
