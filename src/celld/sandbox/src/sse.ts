// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-sent events for sandbox streams: every event is
 * `event: <type>` plus `data: <JSON>`, so a stream can be handed straight
 * to a browser's `EventSource` or read back with {@link parseSSEStream}.
 *
 * @module
 */

import type { SandboxEvent } from "./types.ts";

const encoder = new TextEncoder();

/** One event in SSE form. */
export function encodeEvent(
  event: SandboxEvent | { type: string },
): Uint8Array {
  return encoder.encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/** The headers of an SSE response. */
export const SSE_HEADERS: HeadersInit = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * A byte stream of SSE events that `produce` emits. The stream ends when
 * `produce` returns; if it throws, an `error` event carries the message.
 */
export function eventStream(
  produce: (emit: (event: SandboxEvent) => Promise<void>) => Promise<void>,
  onError: (error: unknown) => { code: string; message: string },
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit = async (event: SandboxEvent) => {
    await writer.write(encodeEvent(event));
  };
  (async () => {
    try {
      await produce(emit);
    } catch (error) {
      try {
        await emit({ type: "error", ...onError(error) });
      } catch {
        // The reader went away.
      }
    }
    try {
      await writer.close();
    } catch {
      // Already closed or aborted by the reader.
    }
  })();
  return readable;
}

/**
 * The events of an SSE byte stream, parsed from their JSON data. Events
 * whose data is not JSON are skipped.
 */
export async function* parseSSEStream<T = SandboxEvent>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      buffer += text.replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data === "") continue;
        try {
          yield JSON.parse(data) as T;
        } catch {
          // Not one of ours.
        }
      }
      if (done) return;
    }
  } finally {
    // Stops the producer too when the consumer leaves early.
    await reader.cancel().catch(() => {});
  }
}
