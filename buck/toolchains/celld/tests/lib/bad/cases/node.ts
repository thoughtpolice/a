// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Only the runtime's cloudflare:* builtins exist in a Worker.
import { readFileSync } from "node:fs";

export const VALUE = readFileSync;
