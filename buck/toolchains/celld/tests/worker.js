// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Packaging-only fixture for the celld toolchain's binding configuration test.
 * Exports are deliberately inert: deploy --dry-run checks the generated project
 * without a fleet, storage, or any Orchestra-specific dependency.
 * @module
 */

import {
  DurableObject,
  WorkerEntrypoint,
  WorkflowEntrypoint,
} from "cloudflare:workers";

/** SQLite Durable Object export referenced by the COUNTER binding. */
export class Counter extends DurableObject {}

/** Named same-script service entrypoint referenced by OPERATIONS. */
export class Operations extends WorkerEntrypoint {}

/** Workflow export referenced by FLOW. */
export class ExampleWorkflow extends WorkflowEntrypoint {
  /** Records one memoized step when run by celld (not invoked by the dry run). */
  async run(_event, step) {
    return await step.do("example", () => "done");
  }
}

/** A queue-consumer script intentionally has no fetch handler. */
export default {
  /** Acknowledges a delivered test batch. */
  queue(batch) {
    batch.ackAll();
  },
  /** Accepts the configured cron event without side effects. */
  scheduled() {},
};
