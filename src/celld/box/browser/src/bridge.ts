// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { utf8Length } from "@celld/core/bounds";

type Socket = Pick<WebSocket, "send" | "close" | "accept" | "addEventListener">;

/** Internal, text-only relay. Bounds apply after the native frame arrives. */
export function bridgeSockets(
  server: Socket,
  upstream: Socket,
  signal: AbortSignal,
): () => void {
  let closed = false;
  let messages = 0;
  let bytes = 0;
  const timer = setTimeout(close, 300_000);
  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
    for (const socket of [server, upstream]) {
      try {
        socket.close(1000, "fixture closed");
      } catch { /* already gone */ }
    }
  }
  for (const [source, target] of [[server, upstream], [upstream, server]]) {
    source.addEventListener("message", (event: MessageEvent) => {
      if (closed) return;
      // celld has no bufferedAmount and uses host-side writer queues.
      // Limit total forwarded traffic as well as individual frames, so even
      // a fast sender cannot enqueue an unbounded test session in the host.
      if (typeof event.data !== "string") {
        close();
        return;
      }
      const size = utf8Length(event.data);
      bytes += size;
      if (size > 1_048_576 || bytes > 16_777_216 || ++messages > 4096) {
        close();
        return;
      }
      try {
        target.send(event.data);
      } catch {
        close();
      }
    });
    source.addEventListener("close", close);
    source.addEventListener("error", close);
  }
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
    return close;
  }
  try {
    server.accept();
    upstream.accept();
  } catch (error) {
    close();
    throw error;
  }
  return close;
}
