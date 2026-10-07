// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { page } from "./ssr.ts";

Deno.test("compiled Svelte renders escaped props through the Deno library adapter", () => {
  const html = page("<Deno>");
  if (!html.includes("hello, &lt;Deno>")) throw new Error(html);
});
