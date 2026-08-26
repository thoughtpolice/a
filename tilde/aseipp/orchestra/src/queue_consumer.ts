// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Separate celld Queue Worker. The API script owns HTTP and Workflow bindings;
 * this script consumes bounded notification batches through a named service
 * binding. Each message is independently acknowledged or retried. @module
 */
import type { Notification } from "./model.ts";
import type { Notifications } from "./notifications.ts";
/** Only the private notification capability is exposed to this Worker. */
interface ConsumerEnvironment {
  ORCHESTRA: Pick<ServiceBinding<Notifications>, "deliver">;
}
export default {
  /** Serial delivery respects celld Queue/RPC concurrency bounds. */
  async queue(
    batch: MessageBatch<Notification>,
    env: ConsumerEnvironment,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await env.ORCHESTRA.deliver(message.body);
        message.ack();
      } catch (error) {
        console.error("notification delivery failed", error);
        message.retry({ delaySeconds: 1 });
      }
    }
  },
};
