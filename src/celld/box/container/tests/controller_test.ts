// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  ContainerController,
  ContainerError,
  OPTION_LIMITS,
  STATE_KEY,
} from "@celld/box/container";
import { FakeState } from "@celld/box/container/testing";
import { rejectsWith, setup } from "./fixture.ts";

Deno.test("Daybreak container configuration is strict before any start", async () => {
  for (
    const options of [
      { enableInterent: true },
      { enableInternet: "false" },
      { restart: { maxRestart: 1 } },
      { entrypoint: "sh" },
      { envVars: { TOKEN: 42 } },
      { labels: [] },
      { pingPath: "//elsewhere.test/" },
    ]
  ) {
    assertThrows(() => setup(options as never), ContainerError);
  }
  let reads = 0;
  assertThrows(() =>
    setup({
      get enableInternet() {
        reads++;
        return true;
      },
    }), ContainerError);
  assertEquals(reads, 0);
  const { container, controller } = setup();
  assertThrows(
    () => controller.start({ enableInternet: "false" } as never),
    ContainerError,
  );
  assertThrows(
    () => controller.start({}, { waitForPorts: "false" } as never),
    ContainerError,
  );
  await rejectsWith(controller.startAndWaitForPorts({}, [70000]), "invalid");
  assertEquals(container.starts.length, 0);
});

Deno.test("Daybreak resolved container security state and registries are immutable", async () => {
  const options = {
    enableInternet: false,
    envVars: { MODE: "safe" },
    entrypoint: ["/bin/app"],
    restart: { maxRestarts: 1 },
  };
  const { controller, container } = setup(options);
  options.enableInternet = true;
  options.envVars.MODE = "unsafe";
  options.entrypoint[0] = "/bin/other";
  assert(
    Object.isFrozen(controller.options) &&
      Object.isFrozen(controller.options.envVars) &&
      Object.isFrozen(controller.options.entrypoint),
    "resolved options are deeply frozen",
  );
  assertThrows(() => {
    (OPTION_LIMITS.maxRestarts as { max: number }).max = 999999;
  }, TypeError);
  await controller.start();
  assertEquals(container.starts[0].enableInternet, false);
  assertEquals(container.starts[0].env, { MODE: "safe" });
  assertEquals(container.starts[0].entrypoint, ["/bin/app"]);
});

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

// Rewritten (DB-SBX-009): this test asserted `status === "running"` after
// a required port timed out, which was the defect: a later ensureRunning
// served that container without probing its ports again, and no alarm was
// set. Such a container is now `unhealthy` until its ports answer.
Deno.test("required ports make it healthy, or unhealthy when they time out", async () => {
  const good = setup({ requiredPorts: [8080] });
  good.container.ports.set(8080, () => new Response("ok"));
  await good.controller.start();
  assertEquals(good.controller.state().status, "healthy");

  const bad = setup({ requiredPorts: [8080], portTimeout: "1s" });
  await rejectsWith(bad.controller.start(), "port_timeout");
  assertEquals(bad.recorded.events, ["error:port_timeout"]);
  assertEquals(bad.controller.state().status, "unhealthy");
  assertEquals(bad.container.running, true);
  // The cleanup and retry alarm is set even though the start failed.
  assert(bad.state.alarm !== null, "no alarm after a failed readiness check");
});

Deno.test("an unhealthy container is probed again and never served unchecked", async () => {
  const { container, controller } = setup({
    defaultPort: 8080,
    requiredPorts: [8080],
    portTimeout: "1s",
  });
  await rejectsWith(controller.start(), "port_timeout");
  // Still not answering: refused with a clear error, not forwarded.
  const refused = await rejectsWith(controller.fetch("http://x/"), "unhealthy");
  assert(refused.detail.includes("8080"), refused.message);
  await rejectsWith(controller.tcpPort(8080), "unhealthy");
  assertEquals(controller.state().status, "unhealthy");
  // Once the port answers, the next call probes, and then serves.
  container.ports.set(8080, () => new Response("up"));
  const response = await controller.fetch("http://x/");
  assertEquals(await response.text(), "up");
  assertEquals(controller.state().status, "healthy");
  assertEquals(container.starts.length, 1);
});

Deno.test("a start that skipped the port wait is probed before it serves", async () => {
  const { container, controller } = setup({
    defaultPort: 8080,
    requiredPorts: [8080],
    portTimeout: "1s",
  });
  await controller.start(undefined, { waitForPorts: false });
  assertEquals(controller.state().status, "running");
  await rejectsWith(controller.fetch("http://x/"), "unhealthy");
  container.ports.set(8080, () => new Response("up"));
  await controller.ensureRunning();
  assertEquals(controller.state().status, "healthy");
});

// DB-REV-SBX-2: a call made while a `waitForPorts: false` start was in
// flight awaited that start and was served, with the required port never
// probed.
Deno.test("a call concurrent with a start that skips the port wait is probed", async () => {
  const { container, controller } = setup({
    defaultPort: 8080,
    requiredPorts: [8080],
    portTimeout: "1s",
  });
  container.ports.set(9090, () => new Response("other"));
  const starting = controller.start(undefined, { waitForPorts: false });
  const route = controller.tcpPort(9090);
  await starting;
  await rejectsWith(route, "unhealthy");
  assertEquals(controller.state().status, "unhealthy");
  // Once the required port answers, the same kind of call is served.
  container.ports.set(8080, () => new Response("up"));
  const served = await controller.tcpPort(9090);
  assertEquals(await (await served.fetch("http://x/")).text(), "other");
  assertEquals(controller.state().status, "healthy");
});

Deno.test("the alarm retries an unhealthy container's ports", async () => {
  const { container, controller, clock, state } = setup({
    requiredPorts: [8080],
    portTimeout: "1s",
    healthCheckInterval: "10s",
    sleepAfter: "10m",
  });
  await rejectsWith(controller.start(), "port_timeout");
  // The retry comes at the health check interval, before idle sleep.
  assert(
    state.alarm !== null && state.alarm <= clock.now() + 10_000,
    `retry alarm at ${state.alarm}`,
  );
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(controller.state().status, "unhealthy");
  assert(state.alarm !== null, "the retry alarm was dropped");
  container.ports.set(8080, () => new Response("ok"));
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(controller.state().status, "healthy");
  // An unhealthy container still sleeps when idle.
  const idle = setup({
    requiredPorts: [8080],
    portTimeout: "1s",
    sleepAfter: "1m",
  });
  await rejectsWith(idle.controller.start(), "port_timeout");
  idle.clock.advance(61_000);
  await idle.controller.alarm();
  assertEquals(idle.container.running, false);
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
    sleepAfter: "60s",
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
  // The restarted container keeps its health checks: the next alarm is
  // still set, and it notices the next crash too.
  assertEquals(state.alarm, clock.now() + 10_000);
  container.crash();
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(container.starts.length, 3);
  assertEquals(container.running, true);
  assertEquals(state.alarm, clock.now() + 10_000);
});

Deno.test("a restart from the alarm that is not ready keeps its retry alarm", async () => {
  const { container, controller, clock, state } = setup({
    restart: { mode: "always" },
    requiredPorts: [8080],
    portTimeout: "1s",
    healthCheckInterval: "10s",
    sleepAfter: "10m",
  });
  container.ports.set(8080, () => new Response("ok"));
  await controller.start();
  assertEquals(controller.state().status, "healthy");
  container.crash();
  container.ports.delete(8080);
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(container.starts.length, 2);
  assertEquals(controller.state().status, "unhealthy");
  assert(
    state.alarm !== null && state.alarm <= clock.now() + 10_000,
    `readiness retry alarm at ${state.alarm}`,
  );
  container.ports.set(8080, () => new Response("ok"));
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(controller.state().status, "healthy");
  assertEquals(state.alarm, clock.now() + 10_000);
});

Deno.test("a restart from the alarm that fails leaves nothing scheduled", async () => {
  const { container, controller, clock, state } = setup({
    restart: { mode: "always" },
    healthCheckInterval: "10s",
    sleepAfter: "10m",
  });
  await controller.start();
  container.crash();
  container.failNextStart(new Error("no image"));
  clock.advance(10_000);
  await controller.alarm();
  assertEquals(controller.state().status, "stopped");
  assertEquals(state.alarm, null);
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
      // DB-SBX-013: a number's unit is ambiguous (seconds here, *Ms
      // elsewhere), so durations are strings.
      { sleepAfter: 60 as unknown as string },
      { sleepAfter: "   " },
      { sleepAfter: "1000000d" },
      { startTimeout: "2h" },
      { portTimeout: "1h" },
      { stopGrace: "1h" },
      { healthCheckInterval: "0s" },
      { healthCheckInterval: "2d" },
      { restart: { window: "30d" } },
      { restart: { maxRestarts: 1_000_001 } },
      { restart: { maxRestarts: Infinity } },
      { requiredPorts: Array.from({ length: 65 }, (_, i) => i + 1) },
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

Deno.test("another user of the alarm keeps its wake time", async () => {
  const { controller, clock, state } = setup({ sleepAfter: "1m" });
  let wake: number | null = clock.now() + 5_000;
  controller.addWakeSource(() => wake);
  await controller.start();
  // The earlier of the two wins, and stays when the idle check is later.
  assertEquals(state.alarm, clock.now() + 5_000);
  await controller.touch();
  assertEquals(state.alarm, clock.now() + 5_000);
  // The alarm fires for the other user; idle sleep is rescheduled.
  clock.advance(5_000);
  wake = clock.now() + 3_600_000;
  await controller.alarm();
  assertEquals(state.alarm, clock.now() + 55_000);
  // Stopping keeps the other user's wake time instead of clearing it.
  await controller.stop();
  assertEquals(state.alarm, wake);
  // An idle-time alarm is set again below a later one on the next start.
  await controller.start();
  assertEquals(state.alarm, clock.now() + 60_000);
  await controller.wakeBy(clock.now() + 1_000);
  assertEquals(state.alarm, clock.now() + 1_000);
  await controller.wakeBy(clock.now() + 9_000);
  assertEquals(state.alarm, clock.now() + 1_000);
  wake = null;
  await controller.stop();
  assertEquals(state.alarm, null);
});

Deno.test("waitForPort checks its own timing options", async () => {
  const { container, controller } = setup();
  await controller.start();
  container.ports.set(80, () => new Response("ok"));
  for (
    const options of [
      { timeoutMs: Infinity },
      { timeoutMs: -1 },
      { timeoutMs: 3_600_001 },
      { intervalMs: 0 },
      { intervalMs: Number.NaN },
    ]
  ) {
    await rejectsWith(controller.waitForPort(80, options), "invalid");
  }
  await controller.waitForPort(80, { timeoutMs: 1_000, intervalMs: 10 });
});

// Sweep DB-SWP-F10-2: a probe that loses to its 2 s timeout used to keep
// its HTTP request or TCP connect running, one more for every retry.
Deno.test("a probe that times out stops its request", async () => {
  const { container, controller } = setup();
  await controller.start();
  const seen: Request[] = [];
  container.ports.set(8080, (request) => {
    seen.push(request);
    return new Promise<Response>(() => {});
  });
  await rejectsWith(
    controller.waitForPort(8080, { timeoutMs: 0, path: "/health" }),
    "port_timeout",
  );
  assertEquals(seen.length, 1);
  assert(seen[0].signal.aborted, "the abandoned probe request is aborted");
});

Deno.test("a probe that times out closes its socket", async () => {
  const { container, controller } = setup();
  await controller.start();
  container.ports.set(8080, () => new Response("ok"));
  container.stalledPorts.add(8080);
  await rejectsWith(
    controller.waitForPort(8080, { timeoutMs: 0 }),
    "port_timeout",
  );
  assertEquals(container.closedSockets, [8080]);
});
