// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { events } from "./events.ts";
events.push("registered");
export class Token {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}
