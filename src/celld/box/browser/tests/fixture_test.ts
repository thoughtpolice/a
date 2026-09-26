// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import {
  type BrowserFixture,
  type BrowserFixtureOptions,
  withBrowserFixture,
} from "@celld/box/browser";

const token = "browser_test_private_control_token_123456789";
type Startup =
  | "ok"
  | "status"
  | "invalid"
  | "wrong-origin"
  | "wrong-session"
  | "lost"
  | "stream";

/** Native HTTP/WebSocket stand-in for the runner, without Chromium or Docker. */
async function withRunner(
  options: {
    startup?: Startup;
    cleanupStatus?: number;
    rejectSocket?: boolean;
    holdCommands?: boolean;
  },
  run: (runner: {
    endpoint: string;
    requests: { method: string; path: string; authorization: string | null }[];
    posts: { html: string }[];
    opened: Promise<void>;
    closed: Promise<void>;
    created: Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const requests: {
    method: string;
    path: string;
    authorization: string | null;
  }[] = [];
  const posts: { html: string }[] = [];
  const created = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sockets = new Set<WebSocket>();
  const socketClosures: Promise<void>[] = [];
  const browserId = crypto.randomUUID();
  let sessionId: string | undefined;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
      });
      if (request.method === "POST") {
        sessionId = path.split("/")[2];
        posts.push(await request.json());
        created.resolve();
        if (options.startup === "lost") await release.promise;
        if (options.startup === "stream") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
                release.promise.then(() => {
                  try {
                    controller.close();
                  } catch {
                    // The canceled client may already have canceled this source.
                  }
                });
              },
            }),
          );
        }
        if (options.startup === "status") {
          return new Response(
            "startup failed",
            { status: 503 },
          );
        }
        if (options.startup === "invalid") return new Response("{");
        return Response.json({
          origin: options.startup === "wrong-origin"
            ? "http://evil.example"
            : "http://127.0.0.1:8080",
          webSocketPath: `/sessions/${
            options.startup === "wrong-session" ? "0".repeat(64) : sessionId
          }/devtools/browser/${browserId}`,
        });
      }
      if (request.method === "DELETE") {
        release.resolve();
        return new Response(null, { status: options.cleanupStatus ?? 204 });
      }
      if (path === `/sessions/${sessionId}/devtools/browser/${browserId}`) {
        if (options.rejectSocket) {
          return new Response("no WebSocket", {
            status: 409,
          });
        }
        const { socket, response } = Deno.upgradeWebSocket(request);
        sockets.add(socket);
        socketClosures.push(
          new Promise<void>((resolve) => {
            socket.addEventListener("close", () => {
              sockets.delete(socket);
              closed.resolve();
              resolve();
            }, { once: true });
          }),
        );
        socket.addEventListener("open", () => opened.resolve(), { once: true });
        socket.addEventListener("message", (event) => {
          if (options.holdCommands) return;
          const command = JSON.parse(event.data);
          socket.send(JSON.stringify({
            id: command.id,
            result: { product: "FakeChrome/1" },
            ...(command.sessionId === undefined
              ? {}
              : { sessionId: command.sessionId }),
          }));
        });
        return response;
      }
      return new Response("not found", { status: 404 });
    },
  );
  try {
    await run({
      endpoint: `http://127.0.0.1:${server.addr.port}`,
      requests,
      posts,
      opened: opened.promise,
      closed: closed.promise,
      created: created.promise,
    });
  } finally {
    release.resolve();
    for (const socket of sockets) socket.close();
    await server.shutdown();
    await Promise.all(socketClosures);
  }
}

function checkCleanup(
  requests: { method: string; path: string; authorization: string | null }[],
): void {
  const control = requests.filter(({ method }) =>
    method === "POST" || method === "DELETE"
  );
  assertEquals(control.map(({ method }) => method), ["POST", "DELETE"]);
  assert(
    /^\/sessions\/[a-f0-9]{64}$/.test(control[0].path),
    "fresh unguessable session identifier",
  );
  assertEquals(control[1].path, control[0].path);
  assertEquals(control.map(({ authorization }) => authorization), [
    `Bearer ${token}`,
    `Bearer ${token}`,
  ]);
}

Deno.test("browser fixture rejects malformed configuration before any network request", async () => {
  await withRunner({}, async ({ endpoint, requests }) => {
    let invoked = false;
    const body = () => {
      invoked = true;
      return Promise.resolve();
    };
    const base = { endpoint, token };
    for (
      const patch of [
        { endpoint: "https://127.0.0.1" },
        { endpoint: "http://localhost" },
        { endpoint: `${endpoint}/extra` },
        { endpoint: `${endpoint}/?secret=1` },
        { token: "short" },
        { token: `${token}\n` },
        { html: "x".repeat(65_537) },
        { html: null },
        { timeoutMs: null },
        { timeoutMs: 0 },
        { timeoutMs: 300_001 },
        { timeoutMs: 1.5 },
        { signal: {} },
        { unexpected: true },
      ]
    ) {
      await assertRejects(
        withBrowserFixture(
          { ...base, ...patch } as BrowserFixtureOptions,
          body,
        ),
      );
    }
    let getterCalled = false;
    await assertRejects(withBrowserFixture({
      ...base,
      get html() {
        getterCalled = true;
        return "";
      },
    }, body));
    await assertRejects(
      withBrowserFixture(base, undefined as unknown as typeof body),
    );
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);
    assertEquals(
      await assertRejects(
        withBrowserFixture({ ...base, signal: controller.signal }, body),
      ),
      reason,
    );
    assertEquals(requests, []);
    assertEquals(invoked, false);
    assertEquals(getterCalled, false);
  });
});

Deno.test("browser fixture returns callback result and closes CDP before completing cleanup", async () => {
  await withRunner({}, async ({ endpoint, requests, posts, closed }) => {
    const marker = { complete: true };
    let captured: BrowserFixture | undefined;
    const result = await withBrowserFixture({
      endpoint,
      token,
      html: "<title>owned</title>",
    }, async (fixture) => {
      captured = fixture;
      assert(
        Object.isFrozen(fixture),
        "fixture capability record is immutable",
      );
      assertEquals(fixture.origin, "http://127.0.0.1:8080");
      assertEquals(await fixture.cdp.send("Browser.getVersion"), {
        product: "FakeChrome/1",
      });
      assertEquals(
        new URL(fixture.webSocketUrl).pathname.split("/")[2],
        fixture.sessionId,
      );
      return marker;
    });
    assert(result === marker, "callback result identity is preserved");
    await closed;
    await assertRejects(
      captured!.cdp.send("Browser.getVersion"),
      Error,
      "closed",
    );
    assertEquals(posts, [{ html: "<title>owned</title>" }]);
    checkCleanup(requests);
  });
});

Deno.test("browser fixture preserves the callback's original error after successful cleanup", async () => {
  await withRunner({}, async ({ endpoint, requests, closed }) => {
    const sentinel = new Error("callback failed");
    const error = await assertRejects(
      withBrowserFixture({ endpoint, token }, async (fixture) => {
        await fixture.cdp.send("Browser.getVersion");
        throw sentinel;
      }),
    );
    assert(error === sentinel, "original error identity is preserved");
    await closed;
    checkCleanup(requests);
  });
});

Deno.test("browser fixture deletes its chosen session after each setup response failure", async () => {
  for (
    const startup of [
      "status",
      "invalid",
      "wrong-origin",
      "wrong-session",
    ] as const
  ) {
    await withRunner({ startup }, async ({ endpoint, requests }) => {
      let called = false;
      await assertRejects(withBrowserFixture({ endpoint, token }, () => {
        called = true;
        return Promise.resolve();
      }));
      assertEquals(called, false);
      assertEquals(requests.length, 2);
      checkCleanup(requests);
    });
  }
  await withRunner({ rejectSocket: true }, async ({ endpoint, requests }) => {
    await assertRejects(
      withBrowserFixture({ endpoint, token }, () => {
        throw new Error("callback must not run");
      }),
      Error,
      "WebSocket failed",
    );
    checkCleanup(requests);
  });
});

Deno.test("browser fixture deletes an allocated session even when the startup response is lost", async () => {
  await withRunner(
    { startup: "lost" },
    async ({ endpoint, requests, created }) => {
      const controller = new AbortController();
      const sentinel = new Error("startup canceled");
      const failed = assertRejects(
        withBrowserFixture(
          { endpoint, token, signal: controller.signal },
          () => {
            throw new Error("callback must not run");
          },
        ),
      );
      await created;
      controller.abort(sentinel);
      assert(
        (await failed) === sentinel,
        "setup cancellation reason is preserved",
      );
      checkCleanup(requests);
    },
  );
});

Deno.test("browser fixture deadline closes pending CDP and deletes with an independent signal", async () => {
  await withRunner(
    { holdCommands: true },
    async ({ endpoint, requests, closed }) => {
      let captured: BrowserFixture | undefined;
      await assertRejects(
        withBrowserFixture(
          { endpoint, token, timeoutMs: 200 },
          async (fixture) => {
            captured = fixture;
            await fixture.cdp.send("Page.navigate", {
              url: `${fixture.origin}/index.html`,
            });
          },
        ),
        Error,
        "timed out",
      );
      await closed;
      await assertRejects(captured!.cdp.send("Browser.getVersion"));
      checkCleanup(requests);
    },
  );
});

Deno.test("browser fixture deadline bounds a stalled startup response body and still deletes", async () => {
  await withRunner({ startup: "stream" }, async ({ endpoint, requests }) => {
    let called = false;
    await assertRejects(
      withBrowserFixture({ endpoint, token, timeoutMs: 200 }, () => {
        called = true;
        return Promise.resolve();
      }),
      Error,
      "timed out",
    );
    assertEquals(called, false);
    checkCleanup(requests);
  });
});

Deno.test("browser fixture caller abort wins over a pending callback and still cleans up", async () => {
  await withRunner({}, async ({ endpoint, requests, closed }) => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const sentinel = new Error("caller canceled");
    const failed = assertRejects(
      withBrowserFixture({ endpoint, token, signal: controller.signal }, () => {
        entered.resolve();
        return new Promise<never>(() => {});
      }),
    );
    await entered.promise;
    controller.abort(sentinel);
    assert(
      (await failed) === sentinel,
      "callback cancellation reason is preserved",
    );
    await closed;
    checkCleanup(requests);
  });
});

Deno.test("browser fixture reports cleanup failure alone or alongside the callback failure", async () => {
  for (const callbackFails of [false, true]) {
    await withRunner(
      { cleanupStatus: 503 },
      async ({ endpoint, requests, closed }) => {
        const sentinel = new Error("callback failed first");
        const error = await assertRejects(
          withBrowserFixture({ endpoint, token }, () => {
            if (callbackFails) throw sentinel;
            return Promise.resolve("success");
          }),
        );
        await closed;
        if (callbackFails) {
          assert(error instanceof AggregateError, "both errors remain visible");
          assert(
            error.errors[0] === sentinel,
            "first error identity preserved",
          );
          assertEquals(error.errors.length, 2);
          assert(
            error.errors[1].message.includes("cleanup failed (HTTP 503)"),
            "cleanup failure remains visible",
          );
        } else {
          assert(
            !(error instanceof AggregateError),
            "successful callback has no spurious aggregate error",
          );
          assert(
            error.message.includes("cleanup failed (HTTP 503)"),
            "cleanup failure is returned",
          );
        }
        checkCleanup(requests);
      },
    );
  }
});
