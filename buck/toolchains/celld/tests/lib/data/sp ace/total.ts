// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type { Row } from "@fixture/decls";

/** The sum of the rows' weights. The directory's name has a space in it. */
export function total(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => sum + row.weight, 0);
}
