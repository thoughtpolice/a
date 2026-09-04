// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Declares only @bad/mid, but imports what @bad/mid depends on.
import { DEP } from "@bad/dep";

export const VALUE = DEP;
