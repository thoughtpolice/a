// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { initTRPC } from "@trpc/server";
import superjson from "superjson";

/**
 * If you need to add transformers for special data types like `Temporal.Instant` or `Temporal.Date`, `Decimal.js`, etc you can do so here.
 * Make sure to import this file rather than `superjson` directly.
 *
 * @see https://github.com/blitz-js/superjson#recipes
 */
export const transformer = superjson;

// Initialization of tRPC backend
// Should be done only once per backend!
const t = initTRPC.create({
  transformer,
});

/**
 * tRPC router
 */
export const router = t.router;

/**
 * Public (unauthenticated) procedure
 */
export const publicProcedure = t.procedure;
