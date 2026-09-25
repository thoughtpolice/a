// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  ContainerController,
  ContainerError,
  STATE_KEY,
} from "@celld/container";
import { FakeState } from "@celld/container/testing";
import { rejectsWith, setup } from "./fixture.ts";

Deno.test("start passes the settings and defaults to no Internet", async () => {
  const { container, controller, recorded, state, clock } = setup({
    envVars: { A: "1" },
    entrypoint: ["/bin/app", "--serve"],
    labels: { team: "blue" },
    sleepAfter: "2m",
  });
  await controller.start({ envVars: { B: "2" } });
  assertEquals(container.starts, [{
    env: { A: "1", B: "2" },
    enableInternet: false,
    labels: { team: "blue" },
    entrypoint: ["/bin/app", "--serve"],
  }]);
  assertEquals(recorded.events, ["start"]);
  const current = controller.state();
  assertEquals(current.status, "running");
  assertEquals(current.running, true);
  assertEquals(current.generation, 1);
  assertEquals(state.alarm, clock.now() + 120_000);
});

Deno.test("a start override can enable the Internet", async () => {
  const { container, controller } = setup();
  await controller.start({ enableInternet: true });
  assertEquals(container.starts[0].enableInternet, true);
});

Deno.test("ensureRunning starts once and then only records activity", async () => {
  const { container, controller, clock } = setup();
  await controller.ensureRunning();
  clock.advance(5_000);
  await controller.ensureRunning();
  assertEquals(container.starts.length, 1);
  assertEquals(
    controller.state().lastActivity,
    new Date(clock.now()).toISOString(),
  );
});

Deno.test("concurrent callers share one start", async () => {
  const { container, controller } = setup({}, { startDelayReads: 3 });
  await Promise.all([
    controller.ensureRunning(),
    controller.ensureRunning(),
    controller.start(),
  ]);
  assertEquals(container.starts.length, 1);
});

Deno.test("a crash is noticed and restarted on the next call", async () => {
  const { container, controller, recorded } = setup();
  await controller.start();
  container.crash(2);
  await Promise.resolve();
  await controller.ensureRunning();
  assertEquals(container.starts.length, 2);
  assertEquals(controller.state().generation, 2);
  assertEquals(controller.state().restarts, 1);
  assert(recorded.events.includes("stop:crash"), recorded.events.join());
  assert(recorded.events.includes("error:not_running"), recorded.events.join());
});

Deno.test("a crash loop ends in failed until an explicit start", async () => {
  const { container, controller } = setup({
    restart: { maxRestarts: 1, window: "1h" },
  });
  await controller.start();
  container.crash();
  await controller.ensureRunning();
  container.crash();
  const error = await rejectsWith(controller.ensureRunning(), "failed");
  assert(error.detail.includes("crashed too often"), error.message);
  assertEquals(controller.state().status, "failed");
  await rejectsWith(controller.fetch("http://x/", undefined, 80), "failed");
  await controller.start();
  assertEquals(controller.state().status, "running");
  assertEquals(controller.state().restarts, 0);
});

Deno.test("crashes outside the window are forgotten", async () => {
  const { container, controller, clock } = setup({
    restart: { maxRestarts: 1, window: "1m" },
  });
  await controller.start();
  for (let round = 0; round < 3; round++) {
    container.crash();
    await controller.ensureRunning();
    clock.advance(61_000);
  }
  assertEquals(container.starts.length, 4);
});

Deno.test("the never policy fails on the first crash", async () => {
  const { container, controller } = setup({ restart: { mode: "never" } });
  await controller.start();
  container.crash();
  await rejectsWith(controller.ensureRunning(), "failed");
  assertEquals(container.starts.length, 1);
});

Deno.test("a failed start is reported and thrown", async () => {
  const { container, controller, recorded } = setup();
  container.failNextStart(new Error("image missing"));
  const error = await rejectsWith(controller.start(), "start_failed");
  assert(error.detail.includes("image missing"), error.message);
  assertEquals(recorded.events, ["stop:start_failed", "error:start_failed"]);
  assertEquals(controller.state().status, "stopped");
  assertEquals(controller.state().lastError, "image missing");
  await controller.start();
  assertEquals(controller.state().status, "running");
});

Deno.test("a start that never reports running times out", async () => {
  const { container, controller } = setup({ startTimeout: "1s" }, {
    startDelayReads: 1_000,
  });
  await rejectsWith(controller.start(), "start_timeout");
  assertEquals(container.destroys, 1);
  assertEquals(controller.state().status, "stopped");
});

Deno.test("required ports make it healthy, or time out", async () => {
  const good = setup({ requiredPorts: [8080] });
  good.container.ports.set(8080, () => new Response("ok"));
  await good.controller.start();
  assertEquals(good.controller.state().status, "healthy");

  const bad = setup({ requiredPorts: [8080], portTimeout: "1s" });
  await rejectsWith(bad.controller.start(), "port_timeout");
  assertEquals(bad.recorded.events, ["error:port_timeout"]);
  assertEquals(bad.controller.state().status, "running");
});

Deno.test("an HTTP ping path is requested while waiting", async () => {
  const seen: string[] = [];
  const { container, controller } = setup({
    requiredPorts: [3000],
    pingPath: "/healthz",
  });
  container.ports.set(3000, (request) => {
    seen.push(new URL(request.url).pathname);
    return new Response("ok");
  });
  await controller.start();
  assertEquals(seen, ["/healthz"]);
});

Deno.test("startAndWaitForPorts waits for the default port", async () => {
  const { container, controller } = setup({
    defaultPort: 8080,
    portTimeout: "1s",
  });
  await rejectsWith(controller.startAndWaitForPorts(), "port_timeout");
  container.ports.set(8080, () => new Response("ok"));
  await controller.startAndWaitForPorts();
  assertEquals(controller.state().status, "healthy");
});

Deno.test("fetch starts the container and uses the default port", async () => {
  const { container, controller } = setup({ defaultPort: 8080 });
  container.ports.set(
    8080,
    (request) => new Response(`8080 ${request.method}`),
  );
  container.ports.set(9000, () => new Response("9000"));
  const first = await controller.fetch("http://example/a", { method: "POST" });
  assertEquals(await first.text(), "8080 POST");
  const second = await controller.fetch(
    new Request("http://example/b"),
    undefined,
    9000,
  );
  assertEquals(await second.text(), "9000");
  assertEquals(container.starts.length, 1);
  await rejectsWith(controller.fetch("http://x/", undefined, 70000), "invalid");
  await rejectsWith(setup().controller.fetch("http://x/"), "invalid");
});

Deno.test("stop signals, waits and clears the alarm", async () => {
  const { container, controller, recorded, state } = setup();
  await controller.start();
  await controller.stop();
  assertEquals(container.signals, [15]);
  assertEquals(container.destroys, 0);
  assertEquals(controller.state().status, "stopped");
  assertEquals(state.alarm, null);
  assertEquals(recorded.stops, [{ reason: "stop", exitCode: null }]);
  await controller.stop();
  assertEquals(recorded.stops.length, 1);
});

Deno.test("stop destroys a container that ignores the signal", async () => {
  const { container, controller } = setup({ stopGrace: "1s" });
  await controller.start();
  await controller.stop("stop", 10);
  assertEquals(container.signals, [10]);
  assertEquals(container.destroys, 1);
  await rejectsWith(controller.stop("stop", 99), "invalid");
});

Deno.test("destroy kills at once", async () => {
  const { container, controller, recorded } = setup();
  await controller.start();
  await controller.destroy();
  assertEquals(container.destroys, 1);
  assertEquals(recorded.stops, [{ reason: "destroy", exitCode: null }]);
  assertEquals(controller.state().running, false);
});

Deno.test("the alarm sleeps an idle container", async () => {
  const { container, controller, clock, state, recorded } = setup({
    sleepAfter: 60,
  });
  await controller.start();
  clock.advance(30_000);
  await controller.touch();
  clock.advance(40_000);
  await controller.alarm();
  assertEquals(container.running, true);
  assertEquals(state.alarm, clock.now() + 20_000);
  clock.advance(20_000);
  await controller.alarm();
  assertEquals(container.running, false);
  assertEquals(recorded.stops.map((stop) => stop.reason), ["sleep"]);
  assertEquals(state.alarm, null);
  await controller.alarm();
  assertEquals(container.starts.length, 1);
});

Deno.test("onActivityExpired can keep the container up", async () => {
  let asked = 0;
  const holder: { controller?: ContainerController } = {};
  const { container, controller, clock, state } = setup(
    { sleepAfter: "1m" },
    {},
    {
      onActivityExpired: async () => {
        asked += 1;
        await holder.controller!.touch();
      },
    },
  );
  holder.controller = controller;
  await controller.start();
  clock.advance(61_000);
  await controller.alarm();
  assertEquals(asked, 1);
  assertEquals(container.running, true);
  assertEquals(state.alarm, clock.now() + 60_000);
});

Deno.test("the always policy restarts from the alarm", async () => {
  const { container, controller, clock, state } = setup({
    restart: { mode: "always" },
    healthCheckInterval: "10s",
    sleepAfter: "10m",
  });
  await controller.start();
  assertEquals(state.alarm, clock.now() + 10_000);
  container.crash();
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(container.starts.length, 2);
  assertEquals(container.running, true);
});

Deno.test("the on-demand policy waits for a call after a crash", async () => {
  const { container, controller, clock } = setup();
  await controller.start();
  container.crash();
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(container.starts.length, 1);
  assertEquals(controller.state().status, "stopped");
  await controller.ensureRunning();
  assertEquals(container.starts.length, 2);
});

Deno.test("a container already running is adopted, not restarted", async () => {
  const first = setup();
  await first.controller.start();
  // A fresh controller over the same state, as after the object's reset.
  const again = new ContainerController(first.state, {}, {}, first.clock);
  await again.ensureRunning();
  assertEquals(first.container.starts.length, 1);
  assertEquals(again.state().status, "running");
});

Deno.test("a class without a container says so", async () => {
  const controller = new ContainerController(new FakeState());
  await rejectsWith(controller.ensureRunning(), "no_container");
  assertEquals(controller.state().running, false);
  await controller.alarm();
});

Deno.test("the record lives under one KV key", async () => {
  const { controller, state } = setup();
  await controller.start();
  assertEquals([...state.kv.map.keys()], [STATE_KEY]);
});

Deno.test("errors keep their code through a message", () => {
  const error = new ContainerError("port_timeout", "port 1 did not answer");
  assertEquals(error.message, "[port_timeout] port 1 did not answer");
  const back = ContainerError.from(new Error(error.message));
  assertEquals(back?.code, "port_timeout");
  assertEquals(back?.detail, "port 1 did not answer");
  assertEquals(ContainerError.from(new Error("[nope] x")), null);
  assertEquals(ContainerError.from("plain"), null);
});

Deno.test("options are checked", () => {
  for (
    const options of [
      { defaultPort: 0 },
      { requiredPorts: [65536] },
      { pingPath: "healthz" },
      { restart: { mode: "sometimes" as "never" } },
      { restart: { maxRestarts: -1 } },
      { sleepAfter: "soon" },
    ]
  ) {
    let threw = false;
    try {
      new ContainerController(new FakeState(), options);
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(options));
  }
});

Deno.test("idle sleep waits for work in flight", async () => {
  const { container, controller, clock } = setup({ sleepAfter: "1m" });
  await controller.start();
  let finish: () => void = () => {};
  const work = controller.busy(() =>
    new Promise<void>((resolve) => (finish = resolve))
  );
  assertEquals(controller.isBusy, true);
  clock.advance(120_000);
  await controller.alarm();
  assertEquals(container.running, true);
  finish();
  await work;
  assertEquals(controller.isBusy, false);
  clock.advance(59_000);
  await controller.alarm();
  assertEquals(container.running, true);
  clock.advance(2_000);
  await controller.alarm();
  assertEquals(container.running, false);
});
