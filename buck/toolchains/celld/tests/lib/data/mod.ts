// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type { Row } from "@fixture/decls";
import table from "./table.json" with { type: "json" };
import { total } from "./sp ace/total.ts";

/** The rows of table.json. */
export const ROWS: readonly Row[] = table;

/** Their total weight. */
export const TOTAL: number = total(ROWS);
