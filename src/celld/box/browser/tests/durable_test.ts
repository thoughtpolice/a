// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects, assertThrows } from "@celld/core/assert";
import {
  BrowserSandbox,
  handleBrowserFixture,
} from "@celld/box/browser/durable";
import { FakeContainer, FakeState } from "@celld/box/container/testing";

const TOKEN = "a".repeat(43);
const ID = "b".repeat(64);
const SOCKET = "/devtools/browser/12345678-1234-1234-1234-123456789abc";

Deno.test("browser destruction persists its tombstone before awaiting launch and across isolate restart", async () => {
  const pending = Promise.withResolvers<void>();
  class HeldBrowser extends BrowserSandbox {
    override writeFile(): Promise<void> {
      return pending.promise;
    }
  }
  const container = new FakeContainer();
  const state = new FakeState(container);
  const box = new HeldBrowser(state as unknown as DurableObjectState, {});
  const opening = assertRejects(() => box.open("test"));
  assertThrows(() => box.open("second"));
  const closing = box.destroy();
  assertEquals(state.kv.get("browser:closed"), true);
  const restarted = new BrowserSandbox(
    state as unknown as DurableObjectState,
    {},
  );
  assertThrows(() => restarted.open("resurrect"));
  assertEquals(
    (await restarted.fetch(
      new Request(`http://browser.internal${SOCKET}`, {
        headers: { upgrade: "websocket" },
      }),
    )).status,
    404,
  );
  pending.resolve();
  await opening;
  await closing;
  assertEquals(state.kv.get("browser:closed"), true);
  assertEquals(container.running, false);
});

function fixture(fail = false) {
  const calls: unknown[] = [];
  const forwarded = new Response("websocket-placeholder");
  const stub = {
    open(html: string) {
      calls.push(["open", html]);
      if (fail) throw new Error("launch failed");
      return SOCKET;
    },
    destroy() {
      calls.push("destroy");
    },
    fixtureState() {
      return { closed: true, status: "stopped" };
    },
    fetch(request: Request) {
      calls.push(["fetch", request.url]);
      return forwarded;
    },
  };
  const namespace = {
    getByName(id: string) {
      calls.push(["stub", id]);
      return stub;
    },
  } as unknown as DurableObjectNamespace<BrowserSandbox>;
  function request(
    method: string,
    body?: string,
    headers: HeadersInit = {},
    suffix = "",
  ) {
    return new Request(`http://127.0.0.1/sessions/${ID}${suffix}`, {
      method,
      body,
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    });
  }
  return {
    calls,
    forwarded,
    request,
    handle: (r: Request, token = TOKEN) =>
      handleBrowserFixture(r, namespace, token),
  };
}

Deno.test("browser gateway refuses unauthorized and browser-origin traffic before resolving a sandbox", async () => {
  const f = fixture();
  assertEquals(
    (await f.handle(f.request("POST", "{}", { authorization: "bad" }))).status,
    401,
  );
  assertEquals(
    (await f.handle(f.request("POST", "{}", { origin: "http://evil.invalid" })))
      .status,
    403,
  );
  assertEquals((await f.handle(f.request("POST", "{}"), "")).status, 503);
  assertEquals(
    (await f.handle(f.request("GET", undefined, {}, "?port=8080"))).status,
    404,
  );
  assertEquals(
    (await f.handle(f.request("GET", undefined, {}, "/devtools/page/123")))
      .status,
    404,
  );
  assertEquals(
    (await f.handle(f.request("GET", undefined, {}, SOCKET))).status,
    404,
  );
  assertEquals(f.calls, []);
});

Deno.test("browser gateway starts only bounded HTML and cleans failed launches", async () => {
  const f = fixture();
  const response = await f.handle(
    f.request("POST", JSON.stringify({ html: "<title>test</title>" })),
  );
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(await response.json(), {
    origin: "http://127.0.0.1:8080",
    webSocketPath: `/sessions/${ID}${SOCKET}`,
  });
  assertEquals(f.calls, [["stub", ID], ["open", "<title>test</title>"]]);
  assertEquals((await f.handle(f.request("DELETE"))).status, 204);
  assertEquals(f.calls.at(-1), "destroy");

  for (
    const body of [
      "null",
      "{}",
      '{"html":null}',
      '{"html":"a","port":80}',
      '{"html":"a","html":"b"}',
      JSON.stringify({ html: "x".repeat(65_537) }),
    ]
  ) {
    const bad = fixture();
    assertEquals((await bad.handle(bad.request("POST", body))).status, 400);
    assertEquals(
      bad.calls.filter((c) => Array.isArray(c) && c[0] === "open"),
      [],
    );
  }
  const bad = fixture(true);
  assertEquals(
    (await bad.handle(bad.request("POST", '{"html":"a"}'))).status,
    500,
  );
  assertEquals(bad.calls.at(-1), "destroy");
});

Deno.test("browser websocket capability forwards only its fixed browser route and preserves Response", async () => {
  const f = fixture();
  const response = await f.handle(
    f.request(
      "GET",
      undefined,
      { authorization: "", upgrade: "websocket" },
      SOCKET,
    ),
  );
  assertEquals(response, f.forwarded);
  assertEquals(f.calls, [["stub", ID], [
    "fetch",
    `http://browser.internal${SOCKET}`,
  ]]);
  const bad = fixture();
  assertEquals(
    (await bad.handle(
      bad.request(
        "GET",
        undefined,
        { upgrade: "websocket", origin: "null" },
        SOCKET,
      ),
    )).status,
    403,
  );
  assertEquals(bad.calls, []);
});
