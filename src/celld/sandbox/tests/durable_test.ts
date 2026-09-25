// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The Sandbox Durable Object and the client over it, in one process: the
// "stub" is the object itself, so RPC is a method call and `fetch` is the
// object's fetch. Errors are re-thrown as plain Errors to mimic RPC.

import { assert, assertEquals } from "@celld/assert";
import {
  getSandbox,
  parsePreviewHost,
  PREVIEW_HEADER,
  previewUrl,
  proxyToSandbox,
  SandboxError,
  type SandboxEvent,
  STREAM_PATH,
} from "@celld/sandbox";
import { Sandbox } from "@celld/sandbox/durable";
import { FakeContainer, FakeState } from "@celld/container/testing";
import { rejectsWith } from "./fixture.ts";

interface Box {
  box: Sandbox;
  container: FakeContainer;
  namespace: DurableObjectNamespace<Sandbox>;
  names: string[];
  close(): Promise<void>;
}

// Wraps methods so thrown errors lose their class, as over RPC.
function rpc<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof value !== "function" || key === "fetch") {
        return typeof value === "function" ? value.bind(object) : value;
      }
      return async (...args: unknown[]) => {
        try {
          return await value.apply(object, args);
        } catch (error) {
          throw new Error((error as Error).message);
        }
      };
    },
  });
}

async function make(): Promise<Box> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const container = new FakeContainer({ cwd: root });
  const state = new FakeState(container);
  const box = new Sandbox(state as unknown as DurableObjectState, {});
  box.settings = {
    workspace: `${root}/ws`,
    stateDir: `${root}/state`,
    user: null,
    setupUser: null,
    baseEnv: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: `${root}/ws`,
    },
    logPollInterval: "20ms",
  };
  const names: string[] = [];
  const stub = rpc(box);
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return stub;
    },
  } as unknown as DurableObjectNamespace<Sandbox>;
  return {
    box,
    container,
    namespace,
    names,
    async close() {
      await box.killAllProcesses("KILL").catch(() => {});
      await container.destroy();
      await Deno.remove(root, { recursive: true });
    },
  };
}

async function using(body: (box: Box) => Promise<void>): Promise<void> {
  const box = await make();
  try {
    await body(box);
  } finally {
    await box.close();
  }
}

Deno.test("the client calls the object and restores error codes", () =>
  using(async ({ namespace, names }) => {
    const sandbox = getSandbox(namespace, "user-1");
    assertEquals(names, ["user-1"]);
    await sandbox.writeFile("hello.txt", "hi");
    assertEquals((await sandbox.readFile("hello.txt")).content, "hi");
    assertEquals((await sandbox.exec(["cat", "hello.txt"])).stdout, "hi");
    const error = await rejectsWith(
      sandbox.readFile("../x"),
      "outside_workspace",
    );
    assert(error instanceof SandboxError, "a SandboxError again");
    assertEquals((await sandbox.getState()).status, "running");
  }));

Deno.test("streams go through the object's fetch", () =>
  using(async ({ namespace }) => {
    const sandbox = getSandbox(namespace, "streams");
    const events: SandboxEvent[] = [];
    for await (
      const event of sandbox.events(
        await sandbox.execStream(["echo", "streamed"]),
      )
    ) {
      events.push(event);
    }
    assertEquals(events.map((e) => e.type), ["start", "stdout", "complete"]);
    const written = await sandbox.writeFileStream(
      "up.bin",
      new Uint8Array([1, 2, 3]),
    );
    assertEquals(written, { path: "up.bin", size: 3 });
    const bytes = new Uint8Array(
      await new Response(await sandbox.readFileStream("up.bin")).arrayBuffer(),
    );
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
    const process = await sandbox.startShellProcess("echo from the background");
    const lines: string[] = [];
    for await (
      const event of sandbox.events(await sandbox.streamProcessLogs(process.id))
    ) {
      if (event.type === "stdout") lines.push(event.data);
    }
    assertEquals(lines.join(""), "from the background\n");
    await rejectsWith(sandbox.readFileStream("missing"), "not_found");
  }));

Deno.test("a ticket path that is not a ticket is a 404 answer", () =>
  using(async ({ box }) => {
    const response = await box.fetch(
      new Request(`http://sandbox${STREAM_PATH}nope`),
    );
    assertEquals(response.status, 404);
    assertEquals((await response.json()).error, "bad_ticket");
  }));

Deno.test("sessions through the client", () =>
  using(async ({ namespace }) => {
    const sandbox = getSandbox(namespace, "s");
    await sandbox.createSession({ id: "work", env: { WHO: "session" } });
    const result = await sandbox.session("work").execShell("echo $WHO");
    assertEquals(result.stdout, "session\n");
  }));

Deno.test("preview requests reach an exposed port with the right token only", () =>
  using(async ({ namespace, container, box }) => {
    container.ports.set(
      3000,
      (request) =>
        new Response(
          `app saw ${new URL(request.url).pathname} ${
            request.headers.get(PREVIEW_HEADER)
          }`,
        ),
    );
    const sandbox = getSandbox(namespace, "dev-box", {
      hostname: "preview.test",
      protocol: "http",
      port: 9876,
    });
    const exposed = await sandbox.exposePort(3000, { name: "web" });
    assertEquals(
      exposed.url,
      `http://3000-dev-box-${exposed.token}.preview.test:9876`,
    );
    assertEquals((await sandbox.getExposedPorts()).map((p) => p.url), [
      exposed.url,
    ]);

    const hit = await proxyToSandbox(
      new Request(`${exposed.url}/page`),
      namespace,
      { hostname: "preview.test" },
    );
    assertEquals(await hit!.text(), "app saw /page null");

    const wrong = `http://3000-dev-box-${"a".repeat(16)}.preview.test/`;
    assertEquals(
      (await proxyToSandbox(new Request(wrong), namespace))!.status,
      404,
    );
    const other = `http://3001-dev-box-${exposed.token}.preview.test/`;
    assertEquals(
      (await proxyToSandbox(new Request(other), namespace))!.status,
      404,
    );
    assertEquals(
      await proxyToSandbox(new Request("http://example.test/"), namespace),
      null,
    );
    assertEquals(
      await proxyToSandbox(new Request(`${exposed.url}/`), namespace, {
        hostname: "other.test",
      }),
      null,
    );

    await sandbox.unexposePort(3000);
    assertEquals(
      (await proxyToSandbox(new Request(`${exposed.url}/`), namespace))!.status,
      404,
    );
    await rejectsWith(sandbox.unexposePort(3000), "port_not_exposed");
    assertEquals((await box.exposePort(3000)).token === exposed.token, false);
  }));

Deno.test("preview host names parse strictly", () => {
  const token = "abcdefghijklmnop";
  assertEquals(parsePreviewHost(`8080-my-box-${token}.x.test`), {
    port: 8080,
    id: "my-box",
    token,
  });
  assertEquals(
    parsePreviewHost(`8080-my-box-${token}.x.test:443`, "x.test")?.id,
    "my-box",
  );
  for (
    const host of [
      `0-box-${token}.x`,
      `70000-box-${token}.x`,
      `8080-box-${token}`,
      `8080--${token}.x`,
      `8080-box-short.x`,
      `x8080-box-${token}.x`,
    ]
  ) {
    assertEquals(parsePreviewHost(host), null, host);
  }
  let threw = false;
  try {
    previewUrl("Not_DNS", { port: 1, token }, { hostname: "x" });
  } catch {
    threw = true;
  }
  assert(threw, "an id that is not a DNS label is refused");
});

Deno.test("other requests fall through to the container proxy", () =>
  using(async ({ box }) => {
    const response = await box.fetch(new Request("http://sandbox/anything"));
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error, "invalid");
  }));
