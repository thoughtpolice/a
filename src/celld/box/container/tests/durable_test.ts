// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/core/assert";
import {
  ContainerError,
  type StopEvent,
  uniformIndex,
} from "@celld/box/container";
import {
  Container,
  getContainer,
  getRandom,
  PORT_HEADER,
} from "@celld/box/container/durable";
import { FakeContainer, FakeState } from "@celld/box/container/testing";

class Web extends Container {
  override defaultPort = 8080;
  override sleepAfter = "1m";
  override envVars = { MODE: "test" };
  readonly log: string[] = [];

  override onStart(): void {
    this.log.push("start");
  }

  override onStop(event: StopEvent): void {
    this.log.push(`stop:${event.reason}`);
  }
}

function make(): { web: Web; container: FakeContainer; state: FakeState } {
  const container = new FakeContainer();
  container.ports.set(
    8080,
    (request) =>
      new Response(
        `8080 ${new URL(request.url).pathname} ${
          request.headers.get(PORT_HEADER)
        }`,
      ),
  );
  container.ports.set(9090, () => new Response("9090"));
  const state = new FakeState(container);
  const web = new Web(state as unknown as DurableObjectState, {});
  return { web, container, state };
}

Deno.test("fetch starts the container with the class fields", async () => {
  const { web, container } = make();
  const response = await web.fetch(new Request("http://do/hello"));
  assertEquals(await response.text(), "8080 /hello null");
  assertEquals(container.starts, [{
    env: { MODE: "test" },
    enableInternet: false,
    labels: {},
  }]);
  assertEquals(web.log, ["start"]);
  assertEquals(web.getState().status, "running");
});

// DB-SBX-001: the port header used to pick the port; a public request
// forwarded unchanged could reach any listening port.
Deno.test("fetch ignores and strips a port header", async () => {
  const { web } = make();
  const forged = await web.fetch(
    new Request("http://do/admin", { headers: { [PORT_HEADER]: "9090" } }),
  );
  assertEquals(await forged.text(), "8080 /admin null");
  const zero = await web.fetch(
    new Request("http://do/x", { headers: { [PORT_HEADER]: "0" } }),
  );
  assertEquals(await zero.text(), "8080 /x null");
});

Deno.test("fetchPort picks the port as a trusted argument", async () => {
  const { web } = make();
  const response = await web.fetchPort(new Request("http://do/"), 9090);
  assertEquals(await response.text(), "9090");
  const stripped = await web.fetchPort(
    new Request("http://do/y", { headers: { [PORT_HEADER]: "9090" } }),
    8080,
  );
  assertEquals(await stripped.text(), "8080 /y null");
  const plain = await web.fetch(new Request("http://do/x"));
  assertEquals(await plain.text(), "8080 /x null");
});

// DB-REV-SBX-7: this test asserted that a 503 carried the engine's start
// error ("no image") in its message. That was the defect: `fetch` is the
// path that may forward public requests, and the detail (the engine's
// error, `lastError`, ports and timing) is for the owner. It now asserts
// the fixed text, and the detail only with the opt-in `unsafeDetail`.
Deno.test("fetch errors become JSON answers", async () => {
  const { web, container } = make();
  container.failNextStart(new Error("no image at /secret/registry/path"));
  const response = await web.fetch(new Request("http://do/"));
  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error: "start_failed",
    message: "the container could not serve the request",
  });
  assertEquals((await web.fetchPort(new Request("http://do/"), 0)).status, 400);
  const owner = make();
  owner.web.unsafeDetail = true;
  owner.container.failNextStart(new Error("no image"));
  const detailed = await owner.web.fetchPort(new Request("http://do/"), 9090);
  assertEquals(await detailed.json(), {
    error: "start_failed",
    message: "no image",
  });
});

Deno.test("the default onActivityExpired stops with reason sleep", async () => {
  const { web, container, state } = make();
  await web.start();
  assertEquals(typeof state.alarm, "number");
  // Make the last activity older than sleepAfter.
  const record = state.kv.get<{ lastActivity: number }>(
    "celld.container/state",
  )!;
  state.kv.put("celld.container/state", {
    ...record,
    lastActivity: Date.now() - 120_000,
  });
  await web.alarm();
  assertEquals(container.running, false);
  assertEquals(web.log, ["start", "stop:sleep"]);
  assertEquals(state.alarm, null);
});

Deno.test("unsafeDetail rejects truthy configuration before starting", async () => {
  for (const flag of ["true", "false", 1, {}, null]) {
    const { web, container } = make();
    web.unsafeDetail = flag as never;
    container.failNextStart(new Error("/secret/registry"));
    const response = await web.fetch(new Request("http://do/"));
    assertEquals(response.status, 400);
    assertEquals((await response.text()).includes("/secret/registry"), false);
    assertEquals(container.starts.length, 0);
  }
});

Deno.test("stop, destroy and renew work over the class", async () => {
  const { web, container } = make();
  await web.startAndWaitForPorts();
  assertEquals(web.getState().status, "healthy");
  await web.renewActivityTimeout();
  await web.stop();
  assertEquals(container.signals, [15]);
  await web.start();
  await web.destroy();
  assertEquals(web.log, ["start", "stop:stop", "start", "stop:destroy"]);
});

Deno.test("namespace helpers pick instances by name", () => {
  const names: string[] = [];
  const namespace = {
    getByName: (name: string) => {
      names.push(name);
      return { name };
    },
  } as unknown as DurableObjectNamespace<Web>;
  getContainer(namespace);
  getContainer(namespace, "blue");
  for (let i = 0; i < 20; i++) getRandom(namespace, 2);
  assertEquals(names.slice(0, 2), ["singleton", "blue"]);
  for (const name of names.slice(2)) {
    assertEquals(["instance-0", "instance-1"].includes(name), true);
  }
  // DB-SBX-014: impractical counts are refused.
  for (const bad of [0, 1.5, 1025, 2 ** 32, Infinity]) {
    let threw = false;
    try {
      getRandom(namespace, bad);
    } catch (error) {
      threw = ContainerError.from(error)?.code === "invalid";
    }
    assertEquals(threw, true, String(bad));
  }
});

Deno.test("uniformIndex rejects the draws that would bias the pick", () => {
  // 2^32 is not a multiple of 3: draws at or above 3 * floor(2^32 / 3)
  // would make index 0 likelier, so they are drawn again.
  const limit = 3 * Math.floor(2 ** 32 / 3);
  const draws = [2 ** 32 - 1, limit, limit - 1];
  let taken = 0;
  const pick = uniformIndex(3, () => draws[taken++]);
  assertEquals(taken, 3);
  assertEquals(pick, (limit - 1) % 3);
  assertEquals(uniformIndex(1, () => 12345), 0);
});

Deno.test("uniformIndex rejects invalid and permanently biased sources", () => {
  for (
    const draw of [
      () => -1,
      () => NaN,
      () => 0.5,
      () => "1",
      () => 2 ** 32,
      () => 2 ** 32 - 1,
    ]
  ) {
    let failed = false;
    try {
      uniformIndex(3, draw as never);
    } catch (error) {
      failed = error instanceof RangeError;
    }
    assertEquals(failed, true);
  }
});
