// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The two things every client here takes as parameters so that tests need no
 * network and no waiting: a `fetch`, and a clock with randomness. Both are
 * `@celld/http`'s, re-exported so callers of this library need not import it.
 *
 * @module
 */

export {
  defaultRuntime,
  type FetchLike,
  globalFetch,
  rejectOnAbort,
  type Runtime,
} from "@celld/http";
