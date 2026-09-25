// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the suites.
 *
 * @module
 */

import { show } from "@celld/assert";
import type { AnySchema, Issue } from "@celld/sieve";

/** The issues of a parse that must fail. */
export function issues(schema: AnySchema, input: unknown): readonly Issue[] {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error(`expected a failure, got ${show(result.data)}`);
  }
  return result.error.issues;
}

/** The issues of an async parse that must fail. */
export async function issuesAsync(
  schema: AnySchema,
  input: unknown,
): Promise<readonly Issue[]> {
  const result = await schema.safeParseAsync(input);
  if (result.success) {
    throw new Error(`expected a failure, got ${show(result.data)}`);
  }
  return result.error.issues;
}

/** Whether two types are identical, for `const _: true = ...` assertions. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
