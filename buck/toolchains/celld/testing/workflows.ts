// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Deno-only stand-in for celld's "cloudflare:workflows" module, which
 * `celld.test(fake_runtime = True)` maps here.
 * @module
 */

/** A step failure that bypasses retries and fails the step immediately. */
export class NonRetryableError extends Error {
  constructor(message: string, name = "NonRetryableError") {
    super(message);
    this.name = name;
  }
}
