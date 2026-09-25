// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "@celld/assert";
import type { StopEvent } from "@celld/container";
import {
  Container,
  getContainer,
  getRandom,
  PORT_HEADER,
  switchPort,
} from "@celld/container/durable";
import { FakeContainer, FakeState } from "@celld/container/testing";

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

Deno.test("switchPort picks another port and the header is not forwarded", async () => {
  const { web } = make();
  const response = await web.fetch(switchPort(new Request("http://do/"), 9090));
  assertEquals(await response.text(), "9090");
  const plain = await web.fetch(new Request("http://do/x"));
  assertEquals(await plain.text(), "8080 /x null");
});

Deno.test("fetch errors become JSON answers", async () => {
  const { web, container } = make();
  container.failNextStart(new Error("no image"));
  const response = await web.fetch(new Request("http://do/"));
  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error: "start_failed",
    message: "no image",
  });
  const request = new Request("http://do/", {
    headers: { [PORT_HEADER]: "0" },
  });
  assertEquals((await web.fetch(request)).status, 400);
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
});
