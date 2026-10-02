// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { v } from "@celld/sieve";
import { defineRoute } from "@celld/web/router/client";

const PageSchema = v.object({ message: v.string(), count: v.number() });

export const PageRoute = defineRoute("GET", "/", {
  query: v.object({
    message: v.union([v.string(), v.array(v.string())]).optional(),
  }),
  response: PageSchema,
});

export const RenameRoute = defineRoute("POST", "/rename", {
  bodyType: "form",
  body: v.object({ message: v.string().min(3) }),
  response: PageSchema,
});
