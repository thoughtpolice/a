// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Worker side of `McpChangeHub` (in `@celld/mcp/durable`): a
 * {@link ChangeSource} and publisher over one named hub object. Kept apart
 * from the Durable Object class so it loads without `cloudflare:workers`.
 *
 * ```ts
 * interface Env { MCP_CHANGES: DurableObjectNamespace<ChangeHubApi> }
 * const changes = durableChangeSource(env.MCP_CHANGES);
 * const server = new McpServer({ info, changes });
 * await changes.publish({ type: "tools" }); // from any request, any isolate
 * ```
 *
 * @module
 */

import {
  type ChangeBatch,
  type ChangeCursor,
  type ChangeEvent,
  type ChangePublisher,
  type ChangeSource,
  pollingChangeSource,
  type PollingOptions,
} from "./subscriptions.ts";

/** The RPC surface of `McpChangeHub`. */
export interface ChangeHubApi {
  /** Appends a change; returns its sequence number. */
  publish(event: ChangeEvent): number;
  /** Long-polls for changes after `cursor` (at most 12 s). */
  poll(cursor: ChangeCursor | null, waitMs: number): Promise<ChangeBatch>;
}

/** A change source and publisher backed by the hub object named `name`. */
export function durableChangeSource(
  namespace: DurableObjectNamespace<ChangeHubApi>,
  name = "default",
  options: PollingOptions = {},
): ChangeSource & ChangePublisher {
  const stub = () => namespace.getByName(name);
  const source = pollingChangeSource(
    (cursor, waitMs) =>
      stub().poll(cursor, waitMs) as unknown as Promise<ChangeBatch>,
    options,
  );
  return {
    listen: (signal) => source.listen(signal),
    async publish(event) {
      await stub().publish(event);
    },
  };
}
