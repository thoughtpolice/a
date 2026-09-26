// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "@celld/core/assert";
import { bridgeSockets } from "../src/bridge.ts";

class Socket extends EventTarget {
  accepted = false;
  closed = 0;
  sent: string[] = [];
  failSend = false;
  failAccept = false;
  accept() {
    if (this.failAccept) throw new Error("accept failed");
    this.accepted = true;
  }
  close() {
    this.closed++;
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(String(data));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function fixture() {
  const server = new Socket();
  const upstream = new Socket();
  const abort = new AbortController();
  const close = bridgeSockets(
    server as unknown as WebSocket,
    upstream as unknown as WebSocket,
    abort.signal,
  );
  return { server, upstream, abort, close };
}

Deno.test("browser bridge accepts distinct endpoints, relays text both ways and closes once", () => {
  const f = fixture();
  try {
    assertEquals([f.server.accepted, f.upstream.accepted], [true, true]);
    f.server.message('{"id":1}');
    f.upstream.message('{"id":1,"result":{}}');
    assertEquals(f.upstream.sent, ['{"id":1}']);
    assertEquals(f.server.sent, ['{"id":1,"result":{}}']);
    f.abort.abort();
    f.server.message("late");
    f.upstream.message("late");
    f.close();
    assertEquals([f.server.closed, f.upstream.closed], [1, 1]);
    assertEquals(f.upstream.sent.length, 1);
    assertEquals(f.server.sent.length, 1);
  } finally {
    f.close();
  }
});

Deno.test("browser bridge refuses binary, oversized frames, excessive traffic and queue failures", () => {
  for (
    const fault of [
      "binary",
      "oversize",
      "messages",
      "bytes",
      "send",
      "close",
      "error",
    ]
  ) {
    const f = fixture();
    try {
      if (fault === "binary") f.server.message(new Uint8Array([1]));
      if (fault === "oversize") f.upstream.message("é".repeat(524_289));
      if (fault === "messages") {
        for (let i = 0; i < 4097; i++) f.server.message("");
      }
      if (fault === "bytes") {
        for (let i = 0; i < 17; i++) {
          f.upstream.message("x".repeat(1_048_576));
        }
      }
      if (fault === "send") {
        f.upstream.failSend = true;
        f.server.message("a");
      }
      if (fault === "close" || fault === "error") {
        f.server.dispatchEvent(new Event(fault));
      }
      assertEquals([f.server.closed, f.upstream.closed], [1, 1], fault);
    } finally {
      f.close();
    }
  }
});

Deno.test("browser bridge closes both endpoints on failed accept or already-aborted lifetime", () => {
  for (const aborted of [false, true]) {
    const server = new Socket();
    const upstream = new Socket();
    upstream.failAccept = true;
    const abort = new AbortController();
    if (aborted) abort.abort();
    const start = () =>
      bridgeSockets(
        server as unknown as WebSocket,
        upstream as unknown as WebSocket,
        abort.signal,
      );
    if (aborted) start();
    else assertThrows(start);
    assertEquals([server.closed, upstream.closed], [1, 1]);
  }
});
