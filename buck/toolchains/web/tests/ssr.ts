// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { render } from "svelte/server";
import Page from "@fixture/views";

export function page(name: string): string {
  return render(Page, { props: { name } }).body;
}
