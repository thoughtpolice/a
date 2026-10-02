// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { v } from "@celld/sieve";
import { defineRoute } from "@celld/web/router/client";

export const NoteSchema = v.object({
  id: v.number().int().min(1),
  title: v.string(),
  body: v.string(),
});
export type Note = v.Infer<typeof NoteSchema>;

export const PageSchema = v.object({
  view: v.union([v.literal("notes"), v.literal("guide")]),
  notes: v.array(NoteSchema),
});
export type PageData = v.Infer<typeof PageSchema>;

export const NotesRoute = defineRoute("GET", "/", { response: PageSchema });
export const GuideRoute = defineRoute("GET", "/guide", {
  response: PageSchema,
});
export const AddNoteRoute = defineRoute("POST", "/notes", {
  bodyType: "form",
  body: v.object({
    title: v.string().trim().min(3).max(80),
    body: v.string().max(400),
  }),
  response: PageSchema,
});
export const routes = {
  notes: NotesRoute,
  guide: GuideRoute,
  add: AddNoteRoute,
};
