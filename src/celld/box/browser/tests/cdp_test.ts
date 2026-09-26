// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { CdpProtocolError, connectCdp } from "@celld/box/browser";
import type { CdpOptions, CdpSendOptions } from "@celld/box/browser";

interface Command {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

async function withPeer(
  receive: (socket: WebSocket, command: Command) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const sockets = new Set<WebSocket>();
  const shutdowns: Promise<void>[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      sockets.add(socket);
      shutdowns.push(
        new Promise<void>((resolve) => {
          socket.addEventListener("close", () => {
            sockets.delete(socket);
            resolve();
          }, { once: true });
        }),
      );
      socket.addEventListener(
        "message",
        (event) => receive(socket, JSON.parse(event.data)),
      );
      return response;
    },
  );
  try {
    await run(`ws://127.0.0.1:${server.addr.port}/devtools/browser/test`);
  } finally {
    for (const socket of sockets) socket.close();
    await server.shutdown();
    await Promise.all(shutdowns);
  }
}

function reply(socket: WebSocket, command: Command, result: object = {}): void {
  socket.send(JSON.stringify({
    id: command.id,
    result,
    ...(command.sessionId === undefined
      ? {}
      : { sessionId: command.sessionId }),
  }));
}

Deno.test("CDP correlates out-of-order replies, ignores events, and snapshots params/results", async () => {
  const received: Command[] = [];
  await withPeer((socket, command) => {
    received.push(command);
    if (received.length === 2) {
      socket.send(
        JSON.stringify({
          method: "Page.loadEventFired",
          params: { timestamp: 1 },
        }),
      );
      reply(socket, received[1], { nested: { value: 2 } });
      reply(socket, received[0], {
        nested: { value: received[0].params.value },
      });
    }
  }, async (url) => {
    const connection = await connectCdp(url);
    try {
      const params = { value: 1 };
      const first = connection.send<{ nested: { value: number } }>(
        "Runtime.evaluate",
        params,
        { sessionId: "session-1" },
      );
      params.value = 99;
      const second = connection.send("Browser.getVersion");
      assertEquals(await first, { nested: { value: 1 } });
      const result = await second;
      assertEquals(result, { nested: { value: 2 } });
      assert(
        Object.isFrozen(result) && Object.isFrozen(result.nested),
        "results are deeply immutable",
      );
      assertEquals(received.map((command) => command.sessionId), [
        "session-1",
        undefined,
      ]);
    } finally {
      connection.close();
    }
  });
});

Deno.test("CDP protocol errors reject one command and leave the connection usable", async () => {
  await withPeer((socket, command) => {
    if (command.method === "Missing.command") {
      socket.send(
        JSON.stringify({
          id: command.id,
          error: { code: -32601, message: "No such method" },
        }),
      );
    } else reply(socket, command, { ok: true });
  }, async (url) => {
    const connection = await connectCdp(url);
    try {
      const error = await assertRejects(
        connection.send("Missing.command"),
        CdpProtocolError,
      );
      assertEquals(error.code, -32601);
      assertEquals(error.method, "Missing.command");
      assertEquals(await connection.send("Browser.getVersion"), { ok: true });
    } finally {
      connection.close();
    }
  });
});

Deno.test("CDP request cancellation frees its slot and ignores the late reply", async () => {
  const seen = Promise.withResolvers<void>();
  let first: Command | undefined;
  await withPeer((socket, command) => {
    if (!first) {
      first = command;
      seen.resolve();
    } else {
      reply(socket, first, { stale: true });
      reply(socket, command, { fresh: true });
    }
  }, async (url) => {
    const connection = await connectCdp(url, { maxPending: 1 });
    try {
      const controller = new AbortController();
      const canceled = assertRejects(
        connection.send("Page.navigate", {}, { signal: controller.signal }),
        DOMException,
      );
      await seen.promise;
      await assertRejects(
        connection.send("Page.navigate"),
        Error,
        "pending command limit",
      );
      controller.abort();
      assertEquals((await canceled).name, "AbortError");
      assertEquals(await connection.send("Browser.getVersion"), {
        fresh: true,
      });
    } finally {
      connection.close();
    }
  });
});

Deno.test("CDP request deadlines free slots without replaying the command", async () => {
  let count = 0;
  await withPeer((socket, command) => {
    if (++count > 1) reply(socket, command, { ok: true });
  }, async (url) => {
    const connection = await connectCdp(url, { timeoutMs: 200, maxPending: 1 });
    try {
      const error = await assertRejects(
        connection.send("Page.navigate"),
        DOMException,
      );
      assertEquals(error.name, "TimeoutError");
      assertEquals(await connection.send("Browser.getVersion"), { ok: true });
      assertEquals(count, 2);
    } finally {
      connection.close();
    }
  });
});

Deno.test("CDP close, remote close and connection abort reject every pending command", async () => {
  for (const kind of ["local", "remote", "abort"] as const) {
    let count = 0;
    const seen = Promise.withResolvers<void>();
    await withPeer((socket) => {
      if (++count === 2) {
        seen.resolve();
        if (kind === "remote") socket.close();
      }
    }, async (url) => {
      const controller = new AbortController();
      const connection = await connectCdp(url, { signal: controller.signal });
      const first = assertRejects(connection.send("Browser.getVersion"));
      const second = assertRejects(connection.send("Browser.getVersion"));
      await seen.promise;
      if (kind === "local") connection.close();
      if (kind === "abort") controller.abort();
      await Promise.all([first, second]);
      await assertRejects(connection.send("Browser.getVersion"));
      connection.close();
    });
  }
});

Deno.test("CDP fails closed on malformed, oversized, binary and cross-session responses", async () => {
  const messages = [
    () => "{",
    () => JSON.stringify({ id: 1, result: { value: "x".repeat(256) } }),
    () => new Uint8Array([1, 2, 3]),
    () => JSON.stringify({ id: 1, result: {}, sessionId: "different-session" }),
    () =>
      JSON.stringify({
        id: 1,
        result: {},
        error: { code: 1, message: "both" },
      }),
    () => '{"id":1,"id":1,"result":{}}',
    () => JSON.stringify({ id: 1, result: [] }),
  ];
  for (const message of messages) {
    await withPeer((socket) => socket.send(message()), async (url) => {
      const connection = await connectCdp(url, { maxMessageBytes: 256 });
      try {
        await assertRejects(
          connection.send("Browser.getVersion"),
          Error,
          "invalid or oversized",
        );
        await assertRejects(
          connection.send("Browser.getVersion"),
          Error,
          "invalid or oversized",
        );
      } finally {
        connection.close();
      }
    });
  }
});

Deno.test("CDP validates outgoing command data before writing to the socket", async () => {
  let received = 0;
  await withPeer((socket, command) => {
    received++;
    reply(socket, command);
  }, async (url) => {
    const connection = await connectCdp(url, { maxMessageBytes: 256 });
    try {
      let evaluated = false;
      const getter = {
        get value() {
          evaluated = true;
          return 1;
        },
      };
      const controller = new AbortController();
      controller.abort();
      for (
        const work of [
          () => connection.send("not-a-method"),
          () => connection.send("Page.navigate", { url: "x".repeat(256) }),
          () => connection.send("Page.navigate", getter),
          () =>
            connection.send(
              "Page.navigate",
              [] as unknown as Record<string, unknown>,
            ),
          () => connection.send("Page.navigate", {}, { sessionId: "" }),
          () =>
            connection.send(
              "Page.navigate",
              {},
              { unexpected: true } as unknown as CdpSendOptions,
            ),
          () =>
            connection.send("Page.navigate", {}, { signal: controller.signal }),
        ]
      ) await assertRejects(work);
      assertEquals(evaluated, false);
      await connection.send("Browser.getVersion");
      assertEquals(received, 1);
    } finally {
      connection.close();
    }
  });
});

Deno.test("CDP validates URLs and strict connection options before dialing", async () => {
  for (
    const url of [
      "https://127.0.0.1/",
      "ws:127.0.0.1",
      "ws://user@127.0.0.1/",
      "ws://@127.0.0.1/",
      "ws://127.0.0.1/#",
      "ws://127.0.0.1/#fragment",
      " ws://127.0.0.1/",
      "ws://127.0.0.1/\\path",
    ]
  ) await assertRejects(connectCdp(url), TypeError);
  for (
    const options of [
      { timeoutMs: 0 },
      { timeoutMs: null },
      { timeoutMs: 120_001 },
      { timeoutMs: Infinity },
      { maxPending: 0 },
      { maxPending: 4097 },
      { maxPending: 1.5 },
      { maxMessageBytes: 0 },
      { maxMessageBytes: 16_777_217 },
      { extra: true },
      { signal: {} },
      Object.create({ timeoutMs: 1 }),
    ]
  ) await assertRejects(connectCdp("ws://127.0.0.1:1/", options as CdpOptions));
  let evaluated = false;
  await assertRejects(connectCdp("ws://127.0.0.1:1/", {
    get timeoutMs() {
      evaluated = true;
      return 1;
    },
  }));
  assertEquals(evaluated, false);
  const controller = new AbortController();
  controller.abort();
  assertEquals(
    (await assertRejects(
      connectCdp("ws://127.0.0.1:1/", { signal: controller.signal }),
      DOMException,
    )).name,
    "AbortError",
  );
});

Deno.test("CDP connection deadlines, aborts and failed handshakes do not leak WebSockets", async () => {
  for (const kind of ["timeout", "abort", "http"] as const) {
    const release = Promise.withResolvers<void>();
    const seen = Promise.withResolvers<void>();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async () => {
        seen.resolve();
        await release.promise;
        return new Response("not upgraded");
      },
    );
    try {
      const controller = new AbortController();
      const failed = assertRejects(
        connectCdp(`ws://127.0.0.1:${server.addr.port}/`, {
          timeoutMs: 200,
          signal: controller.signal,
        }),
      );
      await seen.promise;
      if (kind === "abort") controller.abort();
      if (kind === "http") release.resolve();
      const error = await failed;
      assertEquals(
        error.name,
        kind === "http"
          ? "Error"
          : kind === "timeout"
          ? "TimeoutError"
          : "AbortError",
      );
    } finally {
      release.resolve();
      await server.shutdown();
    }
  }
});
