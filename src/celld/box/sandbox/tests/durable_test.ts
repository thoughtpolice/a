// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The Sandbox Durable Object and the client over it, in one process: the
// "stub" is the object itself, so RPC is a method call and `fetch` is the
// object's fetch. Errors are re-thrown as plain Errors to mimic RPC.

import { assert, assertEquals } from "@celld/core/assert";
import {
  getSandbox,
  parsePreviewHost,
  PREVIEW_HEADER,
  previewUrl,
  proxyToSandbox,
  SandboxError,
  type SandboxEvent,
  type SandboxSettings,
  STREAM_PATH,
} from "@celld/box/sandbox";
import { errorResponse, Sandbox } from "@celld/box/sandbox/durable";
import { FakeContainer, FakeState } from "@celld/box/container/testing";
import { rejectsWith } from "./fixture.ts";

class TestSandbox extends Sandbox {
  override settings: SandboxSettings = { tier: "trusted" };
}

function compileTimeThreatIntentAssertions() {
  // @ts-expect-error a concrete durable class must declare its threat settings
  class MissingThreatIntent extends Sandbox {}
  void MissingThreatIntent;
  // @ts-expect-error even a declared settings record must contain a tier
  const missing: SandboxSettings = {};
  void missing;
}
void compileTimeThreatIntentAssertions;

interface Box {
  box: Sandbox;
  container: FakeContainer;
  state: FakeState;
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
  const box = new TestSandbox(state as unknown as DurableObjectState, {});
  box.settings = {
    tier: "trusted",
    workspace: `${root}/ws`,
    stateDir: `${root}/state`,
    user: null,
    setupUser: null,
    baseEnv: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `${root}/state/home`,
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
    state,
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
      hostname: "preview.localhost",
      httpForDevelopment: true,
      port: 9876,
    });
    const exposed = await sandbox.exposePort(3000, { name: "web" });
    assertEquals(
      exposed.url,
      `http://3000-dev-box-${exposed.token}.preview.localhost:9876`,
    );
    assertEquals((await sandbox.getExposedPorts()).map((p) => p.url), [
      exposed.url,
    ]);

    const hit = await proxyToSandbox(
      new Request(`${exposed.url}/page`),
      namespace,
      { hostname: "preview.localhost", httpForDevelopment: true, port: 9876 },
    );
    assertEquals(await hit!.text(), "app saw /page null");

    const wrong = `http://3000-dev-box-${"a".repeat(26)}.preview.localhost/`;
    assertEquals(
      (await proxyToSandbox(new Request(wrong), namespace, {
        hostname: "preview.localhost",
        httpForDevelopment: true,
      }))!.status,
      404,
    );
    const other = `http://3001-dev-box-${exposed.token}.preview.localhost/`;
    assertEquals(
      (await proxyToSandbox(new Request(other), namespace, {
        hostname: "preview.localhost",
        httpForDevelopment: true,
      }))!.status,
      404,
    );
    assertEquals(
      await proxyToSandbox(new Request("http://example.test/"), namespace, {
        hostname: "preview.localhost",
        httpForDevelopment: true,
      }),
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
      (await proxyToSandbox(new Request(`${exposed.url}/`), namespace, {
        hostname: "preview.localhost",
        httpForDevelopment: true,
        port: 9876,
      }))!.status,
      404,
    );
    await rejectsWith(sandbox.unexposePort(3000), "port_not_exposed");
    assertEquals((await box.exposePort(3000)).token === exposed.token, false);
  }));

// DB-SBX-014: tokens were 16 letters (80 bits); they are 26 (130 bits),
// so the test's token and the old 16-letter form changed with them.
Deno.test("preview host names parse strictly", () => {
  const token = "abcdefghijklmnopqrstuvwxyz";
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
      `8080-box-abcdefghijklmnop.x`,
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
  // The whole label stays within DNS's 63 characters: ids of at most 30.
  const longest = "b".repeat(30);
  const url = previewUrl(longest, { port: 65535, token }, { hostname: "x" });
  assert(url.split("//")[1].split(".")[0].length <= 63, url);
  threw = false;
  try {
    previewUrl("b".repeat(31), { port: 1, token }, { hostname: "x" });
  } catch {
    threw = true;
  }
  assert(threw, "an id past 30 characters is refused");
});

// DB-SBX-010: destroy() used to stop the container only. Environment,
// sessions, tickets, records and exposed ports (with their tokens) stayed,
// and a preview request with an old token started a fresh container.
Deno.test("destroy clears the sandbox's state and revokes preview tokens", () =>
  using(async ({ namespace, box, container, state }) => {
    container.ports.set(3000, () => new Response("app"));
    const sandbox = getSandbox(namespace, "wipe");
    await sandbox.setEnvVars({ SECRET: "s" });
    await sandbox.createSession({ id: "work", env: { WHO: "w" } });
    const exposed = await sandbox.exposePort(3000);
    const ticket = await box.openStream({ kind: "exec", argv: ["true"] });
    const started = await sandbox.startProcess(["true"]);
    await sandbox.waitForExit(started.id);
    const preview = () =>
      box.fetch(
        new Request("http://sandbox/", {
          headers: { [PREVIEW_HEADER]: `3000:${exposed.token}` },
        }),
      );
    assertEquals(await (await preview()).text(), "app");
    const starts = container.starts.length;

    await sandbox.destroy();
    assertEquals(container.running, false);
    // The old token reaches nothing and revives nothing.
    assertEquals((await preview()).status, 404);
    assertEquals(container.starts.length, starts);
    assertEquals(container.running, false);
    const redeem = await box.fetch(
      new Request(`http://sandbox${STREAM_PATH}${ticket}`),
    );
    assertEquals([redeem.status, (await redeem.json()).error], [
      404,
      "bad_ticket",
    ]);
    assertEquals(await box.getExposedPorts(), []);
    assertEquals(await box.listSessions(), []);
    assertEquals((await box.listProcesses()).processes, []);
    assertEquals(
      [...state.kv.map.keys()].filter((key) =>
        key.startsWith("celld.sandbox/")
      ),
      [],
    );
    // A new generation starts clean.
    const env = await sandbox.exec(["env"]);
    assertEquals(env.stdout.includes("SECRET"), false);
    await rejectsWith(
      sandbox.exec(["true"], { sessionId: "work" }),
      "no_such_session",
    );
  }));

Deno.test("destroyContainer stops the container and keeps durable state", () =>
  using(async ({ namespace, box, container }) => {
    container.ports.set(3000, () => new Response("app"));
    const sandbox = getSandbox(namespace, "keep");
    await sandbox.createSession({ id: "work", env: { WHO: "w" } });
    const exposed = await sandbox.exposePort(3000);
    await sandbox.destroyContainer();
    assertEquals(container.running, false);
    assertEquals((await box.listSessions()).map((session) => session.id), [
      "work",
    ]);
    assertEquals((await box.getExposedPorts())[0].token, exposed.token);
  }));

// DB-SBX-012: stream tickets were matched before preview requests, so an
// app behind a preview could never serve the reserved stream path.
Deno.test("preview requests are routed before stream tickets", () =>
  using(async ({ box, container }) => {
    container.ports.set(
      3000,
      (request) => new Response(`app ${new URL(request.url).pathname}`),
    );
    const exposed = await box.exposePort(3000);
    const ticket = await box.openStream({ kind: "exec", argv: ["echo", "t"] });
    const path = `${STREAM_PATH}${ticket}`;
    const viaPreview = await box.fetch(
      new Request(`http://sandbox${path}`, {
        headers: { [PREVIEW_HEADER]: `3000:${exposed.token}` },
      }),
    );
    assertEquals(await viaPreview.text(), `app ${path}`);
    // The ticket was not used up by the preview request.
    const redeemed = await box.fetch(new Request(`http://sandbox${path}`));
    assertEquals(redeemed.status, 200);
    await redeemed.body!.cancel();
  }));

// DB-SBX-014: preview tokens were 80 bits, never expired and could not be
// rotated.
Deno.test("preview tokens are 128-bit, expire, rotate and are revoked", () =>
  using(async ({ box, container }) => {
    container.ports.set(3000, () => new Response("app"));
    const exposed = await box.exposePort(3000, { ttlMs: 60_000 });
    assert(/^[a-z2-7]{26}$/.test(exposed.token), exposed.token);
    assert(exposed.createdAt !== undefined, "createdAt");
    assertEquals(exposed.rotatedAt, null);
    const expires = Date.parse(exposed.expiresAt);
    assert(
      Math.abs(expires - (Date.now() + 60_000)) < 5_000,
      exposed.expiresAt,
    );
    const fetchWith = (token: string) =>
      box.fetch(
        new Request("http://sandbox/", {
          headers: { [PREVIEW_HEADER]: `3000:${token}` },
        }),
      );
    assertEquals((await fetchWith(exposed.token)).status, 200);
    const rotated = await box.rotatePort(3000, {
      expectedToken: exposed.token,
    });
    assert(rotated.token !== exposed.token, "a new token");
    assert(rotated.rotatedAt !== null, "rotatedAt");
    assertEquals(rotated.createdAt, exposed.createdAt);
    assertEquals((await fetchWith(exposed.token)).status, 404);
    assertEquals((await fetchWith(rotated.token)).status, 200);
    await rejectsWith(
      box.rotatePort(3001, { expectedToken: rotated.token }),
      "port_not_exposed",
    );
    // An expired token is refused, and exposing again issues a new one.
    const short = await box.rotatePort(3000, {
      expectedToken: rotated.token,
      ttlMs: 1,
    });
    assert(
      short.token !== rotated.token,
      "short-lived rotation has a new token",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals((await fetchWith(rotated.token)).status, 404);
    const again = await box.exposePort(3000);
    assert(again.token !== rotated.token, "an expired token is not reused");
    await rejectsWith(box.exposePort(3000, { ttlMs: 0 }), "invalid");
    await rejectsWith(
      box.exposePort(3000, { ttlMs: 400 * 86_400_000 }),
      "invalid",
    );
  }));

Deno.test("the client keeps its stub private and names the escape hatch unsafe", () =>
  using(async ({ namespace }) => {
    const sandbox = getSandbox(namespace, "client");
    assertEquals("stub" in sandbox, false);
    assertEquals(
      (sandbox as unknown as Record<string, unknown>).stub,
      undefined,
    );
    assert(sandbox.unsafeStub !== undefined, "unsafeStub");
    // The wrapped methods still work.
    assertEquals(await sandbox.getExposedPorts(), []);
  }));

// DB-SBX-001: anything that was not a ticket or a preview used to fall
// through to the Container proxy, where a port header picked the port.
// That test asserted the fall-through; it now asserts the 404.
Deno.test("other requests are 404s and never reach a container port", () =>
  using(async ({ box, container }) => {
    const reached: string[] = [];
    for (const port of [3000, 9229]) {
      container.ports.set(port, (request) => {
        reached.push(`${port} ${new URL(request.url).pathname}`);
        return new Response("reached");
      });
    }
    box.defaultPort = 3000;
    await box.exec(["true"]);
    for (
      const request of [
        new Request("http://sandbox/anything"),
        new Request("http://sandbox/debug", {
          headers: { "x-celld-container-port": "9229" },
        }),
        new Request("http://sandbox/.celld-sandbox/other"),
      ]
    ) {
      const response = await box.fetch(request);
      assertEquals(response.status, 404);
      assertEquals((await response.json()).error, "not_found");
    }
    assertEquals(reached, []);
    // The preview path still reaches an exposed port with its token.
    const exposed = await box.exposePort(9229);
    const preview = await box.fetch(
      new Request("http://sandbox/x", {
        headers: { [PREVIEW_HEADER]: `9229:${exposed.token}` },
      }),
    );
    assertEquals(await preview.text(), "reached");
    assertEquals(reached, ["9229 /x"]);
  }));

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

async function pidIn(box: Sandbox, file: string): Promise<number> {
  for (let i = 0; i < 250; i++) {
    const found = await box.readFile(file).catch(() => null);
    if (found !== null && found.content !== "") {
      return Number((found.content as string).trim());
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${file} never appeared`);
}

async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (!(await alive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${pid} still runs`);
}

// DB-SBX-002: cancellation reaches the command, over RPC and over a stream.
Deno.test("a client signal cancels the command through the object", () =>
  using(async ({ namespace, box }) => {
    const sandbox = getSandbox(namespace, "cancel");
    const abort = new AbortController();
    const running = sandbox.execShell("echo $$ > pid; exec sleep 30", {
      timeoutMs: 60_000,
      signal: abort.signal,
    });
    running.catch(() => {});
    const pid = await pidIn(box, "pid");
    abort.abort(new Error("the user gave up"));
    let reason = "";
    try {
      await running;
    } catch (error) {
      reason = (error as Error).message;
    }
    assertEquals(reason, "the user gave up");
    await gone(pid);
  }));

Deno.test("a disconnected stream kills its command", () =>
  using(async ({ namespace, box }) => {
    const sandbox = getSandbox(namespace, "disconnect");
    const abort = new AbortController();
    const stream = await sandbox.execShellStream(
      "echo $$ > pid; exec sleep 30",
      { timeoutMs: 60_000, signal: abort.signal },
    );
    const reader = stream.getReader();
    await reader.read();
    const pid = await pidIn(box, "pid");
    abort.abort();
    await gone(pid);
    const other = await sandbox.execShellStream(
      "echo $$ > pid2; exec sleep 30",
      {
        timeoutMs: 60_000,
      },
    );
    const pid2 = await pidIn(box, "pid2");
    await other.cancel();
    await gone(pid2);
  }));

Deno.test("execStream sends a stream stdin as the request body", () =>
  using(async ({ namespace }) => {
    const sandbox = getSandbox(namespace, "stdin");
    const size = 2 * 1024 * 1024;
    const stdin = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < size; sent += 65536) {
          controller.enqueue(new Uint8Array(65536));
        }
        controller.close();
      },
    });
    let out = "";
    for await (
      const event of sandbox.events(
        await sandbox.execStream(["wc", "-c"], { stdin }),
      )
    ) {
      if (event.type === "stdout") out += event.data;
    }
    assertEquals(out.trim(), String(size));
  }));

// DB-SWP-F11-01: errorResponse answered every error with its detail, which
// for a failed helper command is the helper's stderr (workspace paths,
// whatever the guest wrote). A server-side failure now answers its code
// and a fixed message; the detail needs `unsafeDetail`.
Deno.test("DB-SWP-F11-01: errorResponse keeps helper output out of 5xx answers", async () => {
  const secret = "guest wrote /workspace/.secret-token";
  for (const code of ["command_failed", "timeout", "unsafe_runtime"] as const) {
    const answer = errorResponse(new SandboxError(code, secret));
    assert(answer.status >= 500, `${code} ${answer.status}`);
    const body = await answer.json() as { error: string; message: string };
    assertEquals(body.error, code);
    assert(!body.message.includes("secret"), body.message);
    const full = await errorResponse(new SandboxError(code, secret), {
      unsafeDetail: true,
    }).json() as { message: string };
    assertEquals(full.message, secret);
  }
  const invalid = await errorResponse(
    new SandboxError("invalid", "argv must be non-empty"),
  ).json() as { message: string };
  assertEquals(invalid.message, "argv must be non-empty");
});

// DB-REV-SBX-12: `Sandbox` inherited `start`, `startAndWaitForPorts`,
// `fetchPort` and `containerFetch` from `Container`. Through the raw stub
// they ran an entrypoint of the caller's choosing in a `hostile` sandbox
// before (and without) its gVisor check, and served a container that
// `ready()` never prepared or checked.
Deno.test("DB-REV-SBX-12: inherited container calls go through ready() and the tier", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const container = new FakeContainer({ cwd: root });
  container.ports.set(3000, () => new Response("app"));
  const state = new FakeState(container);
  const box = new TestSandbox(state as unknown as DurableObjectState, {});
  box.settings = {
    tier: "hostile",
    workspace: `${root}/ws`,
    stateDir: `${root}/state`,
    user: "1000:1000",
    setupUser: null,
    baseEnv: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `${root}/state/home`,
    },
  };
  try {
    for (
      const overrides of [
        {},
        { envVars: { LD_PRELOAD: "/workspace/attack.so" } },
        { envVars: { NODE_OPTIONS: "--require=/workspace/attack.js" } },
        { envVars: { BASH_ENV: "/workspace/attack.sh" } },
        { enableInternet: false },
      ]
    ) {
      await rejectsWith(
        box.start(overrides as Parameters<typeof box.start>[0]),
        "invalid",
      );
      await rejectsWith(
        box.startAndWaitForPorts(overrides as Parameters<typeof box.start>[0]),
        "invalid",
      );
    }
    assertEquals(container.starts.length, 0);
    await rejectsWith(
      box.start({ entrypoint: ["sh", "-c", "touch pwned; sleep 60"] }),
      "invalid",
    );
    await rejectsWith(
      box.startAndWaitForPorts({ enableInternet: true }),
      "invalid",
    );
    assertEquals(
      container.starts.filter((start) => start.entrypoint !== undefined),
      [],
    );
    assertEquals(
      container.starts.filter((start) => start.enableInternet === true),
      [],
    );
    await rejectsWith(box.start(), "unsafe_runtime");
    const port = await box.fetchPort(new Request("http://sandbox/"), 3000);
    assertEquals(port.status, 503);
    assertEquals((await port.json()).error, "unsafe_runtime");
    await rejectsWith(
      box.containerFetch("http://sandbox/", undefined, 3000),
      "unsafe_runtime",
    );
  } finally {
    await container.destroy();
    await Deno.remove(root, { recursive: true });
  }
});
