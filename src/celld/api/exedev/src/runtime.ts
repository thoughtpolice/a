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

import { BoundsError, readBounded } from "@celld/core/bounds";
import { classifyHost } from "@celld/http/egress";

/** The default cap on a response body: 8 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The largest response cap a client accepts: 64 MiB. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Checks an origin a client sends credentials to: `https:` without
 * credentials in the URL, to a DNS name or a public address. `http:` and
 * loopback addresses are allowed only with `loopback` (development); private
 * and link-local addresses never.
 *
 * @throws {TypeError} naming `what` and the problem.
 */
export function checkCredentialedOrigin(
  url: URL,
  loopback: boolean,
  what: string,
): void {
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${what} must not carry credentials`);
  }
  const kind = classifyHost(url.hostname);
  if (kind === "local") {
    throw new TypeError(
      `${what} must not name a private or link-local address, got ${url.hostname}`,
    );
  }
  if (kind === "loopback" && !loopback) {
    throw new TypeError(
      `${what} names a loopback address; allowLoopbackForDevelopment allows it in development`,
    );
  }
  if (url.protocol === "http:" && !(loopback && kind === "loopback")) {
    throw new TypeError(
      `${what} must be https (http only to loopback, with allowLoopbackForDevelopment), got ${url.origin}`,
    );
  }
}

/**
 * Reads a response body up to `maxBytes`: the bytes, or `null` when the body
 * is larger (it is then cancelled). Other failures are thrown.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  try {
    return await readBounded(response, { maxBytes, signal });
  } catch (error) {
    if (
      error instanceof BoundsError && error.code === "too_large" &&
      !signal.aborted
    ) {
      return null;
    }
    throw error;
  }
}
