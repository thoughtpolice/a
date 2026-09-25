// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert as ensure, assertEquals } from "@celld/core/assert";
import {
  ContainerController,
  type NativeContainer,
} from "@celld/box/container";
import { FakeContainer, FakeState } from "@celld/box/container/testing";
import {
  deriveSandboxId,
  parsePreviewHost,
  parseSSEStream,
  previewUrl,
  proxyToSandbox,
  resolveSettings,
  runRaw,
  type SandboxApi,
  SandboxClient,
  SandboxCore,
  SandboxError,
  type SandboxSettings,
} from "@celld/box/sandbox";
import { eventually, rejectsWith, withSandbox } from "./fixture.ts";

const token = "a".repeat(26);
function assert(
  condition: unknown,
  message = "security invariant",
): asserts condition {
  ensure(condition, message);
}
function invalid(work: () => unknown) {
  try {
    work();
  } catch (error) {
    assert(error instanceof SandboxError);
    assertEquals(error.code, "invalid");
    return;
  }
  throw new Error("configuration unexpectedly accepted");
}

Deno.test("DB-SBX-003/004: strict immutable settings require deliberate threat intent", () => {
  for (
    const options of [
      {},
      { teir: "hostile" },
      null,
      [],
      { tier: "trusted", typo: 1 },
      { tier: "trusted", cleanEnv: "false" },
      { tier: "trusted", shell: "sh" },
      { tier: "trusted", user: "root" },
      { tier: "trusted", maxProcesses: NaN },
      { tier: "trusted", maxProcesses: null },
      { tier: "trusted", workspace: "/work", stateDir: "/work/state" },
      { tier: "trusted", baseEnv: { HOME: "/workspace", PATH: "/bin" } },
      { tier: "hostile", sweepEscapes: false },
      { tier: "hostile", user: "0" },
      { tier: "trusted", user: "4294967295" },
      { tier: "trusted", shell: ["/bin/../workspace/sh", "-c"] },
      {
        tier: "trusted",
        baseEnv: { HOME: "/safe", PATH: "/var/../tmp/.celld-sandbox" },
      },
      { tier: "hostile", baseEnv: { HOME: "/safe", PATH: "/tmp:/bin" } },
    ]
  ) invalid(() => resolveSettings(options as SandboxSettings));
  let called = false;
  invalid(() =>
    resolveSettings({
      get tier() {
        called = true;
        return "trusted" as const;
      },
    })
  );
  assertEquals(called, false);
  const baseEnv = { HOME: "/safe-home", PATH: "/bin" };
  const shell = ["/bin/sh", "-c"];
  const settings = resolveSettings({ tier: "trusted", baseEnv, shell });
  baseEnv.HOME = "/workspace";
  shell[0] = "/workspace/sh";
  assertEquals(settings.baseEnv.HOME, "/safe-home");
  assertEquals(settings.shell[0], "/bin/sh");
  assert(
    Object.isFrozen(settings) && Object.isFrozen(settings.baseEnv) &&
      Object.isFrozen(settings.shell),
  );
});

Deno.test("DB-SBX-001: paused streamed write cannot commit after handoff", () =>
  withSandbox(async ({ sandbox, workspace, controller }) => {
    await sandbox.ready();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("old"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const ticket = await sandbox.openStream({ kind: "write", path: "value" });
    const result = rejectsWith(sandbox.stream(ticket, body), "lease_held");
    await eventually(async () => {
      for await (const entry of Deno.readDir(workspace)) {
        if (entry.name.startsWith(".celld-write-")) return true;
      }
      return false;
    });
    const lease = await sandbox.acquireLease("workspace");
    assert(lease !== null);
    await sandbox.writeFile("value", "new", { lease: lease.token });
    await result;
    assertEquals((await sandbox.readFile("value")).content, "new");
    for await (const entry of Deno.readDir(workspace)) {
      assert(!entry.name.startsWith(".celld-write-"), entry.name);
    }
    assertEquals(controller.isBusy, false);
    assert(cancelled, "the displaced upload source must be cancelled");
  }));

Deno.test("DB-SBX-004: rejected file writes never destroy an existing workspace", () =>
  withSandbox(async ({ sandbox, workspace, root, container }) => {
    await sandbox.writeFile("keep", "unchanged");
    await Deno.symlink(root, `${workspace}/outside`);
    const before = container.destroys;
    await rejectsWith(
      sandbox.writeFile("outside/nope", "bad"),
      "outside_workspace",
    );
    assertEquals(container.destroys, before);
    assertEquals((await sandbox.readFile("keep")).content, "unchanged");
  }));

Deno.test("DB-SBX-002: mutating background processes stop before handoff and read-only servers survive", () =>
  withSandbox(async ({ sandbox }) => {
    const writer = await sandbox.startShellProcess(
      "while :; do echo old > value; sleep 0.01; done",
    );
    const reader = await sandbox.startProcess(["sleep", "60"], {
      mutates: false,
    });
    const lease = await sandbox.acquireLease("workspace");
    assert(lease !== null);
    assert((await sandbox.getProcess(writer.id)).status !== "running");
    assertEquals((await sandbox.getProcess(reader.id)).status, "running");
    await sandbox.writeFile("value", "new", { lease: lease.token });
    assertEquals((await sandbox.readFile("value")).content, "new");
    await sandbox.killProcess(reader.id, "KILL");
  }));

Deno.test("DB-SBX-001: simultaneous acquirers have one winner, including one-ms leases", () =>
  withSandbox(async ({ sandbox }) => {
    const answers = await Promise.all(
      Array.from(
        { length: 20 },
        () => sandbox.acquireLease("workspace", { ttlMs: 1 }),
      ),
    );
    assertEquals(answers.filter((value) => value !== null).length, 1);
  }));

Deno.test("DB-SBX-001: an expired upload is drained before the successor receives its full TTL", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.ready();
    const old = (await sandbox.acquireLease("workspace", { ttlMs: 100 }))!;
    const ticket = await sandbox.openStream({
      kind: "write",
      path: "value",
      options: { lease: old.token },
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("old"));
      },
    });
    const failed = rejectsWith(sandbox.stream(ticket, body), "lease_lost");
    await eventually(async () => {
      for await (const entry of Deno.readDir(workspace)) {
        if (entry.name.startsWith(".celld-write-")) return true;
      }
      return false;
    });
    await new Promise((resolve) => setTimeout(resolve, 110));
    const next = await sandbox.acquireLease("workspace", { ttlMs: 1000 });
    assert(next !== null);
    assert(
      new Date(next.expiresAt).getTime() - Date.now() >= 900,
      "TTL begins after the displaced helper has drained",
    );
    await sandbox.writeFile("value", "new", { lease: next.token });
    await failed;
    assertEquals((await sandbox.readFile("value")).content, "new");
  }));

Deno.test("DB-SBX-001: cold-start mutations cannot emerge after the lease handoff", () =>
  withSandbox(async ({ sandbox }) => {
    for (
      const operation of [
        () => sandbox.writeFile("late", "old"),
        () => sandbox.exec(["touch", "late"]),
        () => sandbox.startProcess(["touch", "late"]),
      ]
    ) {
      const original = sandbox.ready.bind(sandbox);
      let resume!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      sandbox.ready = async () => {
        entered();
        await gate;
        await original();
      };
      const failed = rejectsWith(operation(), "lease_held");
      await waiting;
      let acquired = false;
      const pending = sandbox.acquireLease("workspace").then((lease) => {
        acquired = true;
        return lease;
      });
      await Promise.resolve();
      assertEquals(acquired, false);
      await rejectsWith(sandbox.writeFile("other", "old"), "lease_held");
      resume();
      const lease = await pending;
      await failed;
      sandbox.ready = original;
      assert(lease !== null);
      assertEquals((await sandbox.exists("late")).exists, false);
      await sandbox.releaseLease("workspace", lease.token);
    }
  }));

Deno.test("DB-SBX-001/002: incomplete background cleanup fails handoff closed until explicit destroy", () =>
  withSandbox(async ({ sandbox, controller }) => {
    const process = await sandbox.startProcess(["sleep", "30"]);
    const kill = sandbox.killProcess.bind(sandbox);
    const wait = sandbox.waitForExit.bind(sandbox);
    const destroy = controller.destroy.bind(controller);
    sandbox.killProcess = () => Promise.resolve(process);
    sandbox.waitForExit = () => Promise.resolve(process);
    controller.destroy = () =>
      Promise.reject(new Error("injected containment failure"));
    try {
      await rejectsWith(sandbox.acquireLease("workspace"), "not_running");
      await rejectsWith(sandbox.writeFile("unsafe", "x"), "not_running");
      await rejectsWith(sandbox.acquireLease("workspace"), "not_running");
    } finally {
      sandbox.killProcess = kill;
      sandbox.waitForExit = wait;
      controller.destroy = destroy;
      await sandbox.killProcess(process.id, "KILL");
      await sandbox.destroy();
    }
    await sandbox.writeFile("safe", "new generation");
  }));

Deno.test("DB-SBX-006/008: preview delimiters fail before any remote mutation", async () => {
  for (
    const hostname of [
      "attacker.example#.localhost",
      "attacker.example/.localhost",
      "x?y.localhost",
      "user@host",
      "host:80",
      "host\\name",
      "[::1]",
      "a b",
      "a\nb",
      "host.",
      "é.example",
      "a..b",
    ]
  ) {
    invalid(() =>
      previewUrl("box", { port: 8080, token }, {
        hostname,
        httpForDevelopment: true,
      })
    );
  }
  let calls = 0;
  const stub = {
    exposePort() {
      calls++;
      return Promise.resolve({ port: 8080, token });
    },
  } as unknown as DurableObjectStub<SandboxApi>;
  const client = new SandboxClient(stub, "not/preview-safe");
  await rejectsWith(
    client.exposePort(8080, { hostname: "preview.example" }),
    "invalid",
  );
  await rejectsWith(client.exposePort(0), "invalid");
  await rejectsWith(
    client.exposePort(8080, { hostname: null } as never),
    "invalid",
  );
  assertEquals(calls, 0);
  for (
    const hostname of [
      "preview.example",
      "a-b.example",
      "localhost",
      "preview.localhost",
    ]
  ) {
    const url = new URL(previewUrl("box", { port: 8080, token }, { hostname }));
    assertEquals(parsePreviewHost(url.host, hostname), {
      id: "box",
      port: 8080,
      token,
    });
  }
});

Deno.test("DB-SBX-006/019: deterministic preview syntax fuzz preserves the exact origin", () => {
  const alphabet = "abc012-.:/@#?\\ []\n\r\t%é☃";
  let seed = 0x5ba0;
  for (let n = 0; n < 5000; n++) {
    let hostname = "";
    for (let j = 0; j < 12; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      hostname += alphabet[seed % alphabet.length];
    }
    hostname += ".localhost";
    try {
      const url = new URL(
        previewUrl("box", { port: 8080, token }, {
          hostname,
          httpForDevelopment: true,
        }),
      );
      assertEquals(url.protocol, "http:");
      assertEquals(url.hostname, `8080-box-${token}.${hostname.toLowerCase()}`);
      assertEquals(url.username + url.password + url.search + url.hash, "");
      assertEquals(parsePreviewHost(url.host, hostname), {
        id: "box",
        port: 8080,
        token,
      });
    } catch (error) {
      assert(error instanceof SandboxError && error.code === "invalid");
    }
  }
});

Deno.test("DB-SBX-012/019: thousands of operations leave shared signal listeners and uncontended leases bounded", async () => {
  const container = new FakeContainer({ exec: () => ({}) });
  const state = new FakeState(container);
  const sandbox = new SandboxCore(new ContainerController(state), state.kv, {
    tier: "trusted",
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let listeners = 0;
  signal.addEventListener = (...args: Parameters<typeof add>) => {
    if (args[0] === "abort") listeners++;
    add(...args);
  };
  signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    if (args[0] === "abort") listeners--;
    remove(...args);
  };
  const started = performance.now();
  for (let n = 0; n < 2000; n++) {
    await sandbox.exec(["true"], { signal });
    const lease = await sandbox.acquireLease("workspace");
    assert(lease !== null);
    await sandbox.releaseLease("workspace", lease.token);
  }
  assertEquals(listeners, 0);
  assert(
    performance.now() - started < 10_000,
    "bounded hot paths should not wait for cleanup grace when nothing is displaced",
  );
  await sandbox.destroy();
});

Deno.test("DB-SBX-006/007: proxy strips token-bearing authorities and overrides browser policy", async () => {
  let seen: Request | undefined;
  const namespace = {
    getByName: () => ({
      fetch(request: Request) {
        seen = request;
        return Promise.resolve(
          new Response("ok", {
            headers: {
              "set-cookie": "s=x; Domain=.example",
              "referrer-policy": "unsafe-url",
              "cache-control": "public, max-age=999",
            },
          }),
        );
      },
    }),
  } as unknown as DurableObjectNamespace<SandboxApi>;
  const url = previewUrl("box", { port: 8080, token }, {
    hostname: "preview.example",
  });
  const response = await proxyToSandbox(
    new Request(url, {
      headers: {
        "x-forwarded-host": new URL(url).host,
        forwarded: `host=${new URL(url).host}`,
      },
    }),
    namespace,
    { hostname: "preview.example" },
  );
  assert(response !== null && seen !== undefined);
  assert(!seen.url.includes(token));
  assertEquals(seen.headers.get("forwarded"), null);
  assertEquals(seen.headers.get("x-forwarded-host"), null);
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("referrer-policy"), "no-referrer");
  assertEquals(
    (await proxyToSandbox(
      new Request(url, { headers: { host: "other.example" } }),
      namespace,
      { hostname: "preview.example" },
    ))?.status,
    400,
  );
  assertEquals(
    (await proxyToSandbox(
      new Request(url.replace("https:", "http:")),
      namespace,
      { hostname: "preview.example" },
    ))?.status,
    400,
  );
});

Deno.test("DB-SBX-008: rotation retries return the same generation", () =>
  withSandbox(async ({ sandbox }) => {
    const port = await sandbox.exposePort(8080);
    const first = await sandbox.rotatePort(8080, { expectedToken: port.token });
    const retried = await sandbox.rotatePort(8080, {
      expectedToken: port.token,
    });
    assertEquals(retried, first);
    await sandbox.rotatePort(8080, { expectedToken: first.token });
    await rejectsWith(
      sandbox.rotatePort(8080, { expectedToken: port.token }),
      "invalid",
    );
  }));

Deno.test("DB-SBX-009: output failure never returns successful partial data and locked setup kills", async () => {
  for (const locked of [false, true]) {
    let killed = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        if (!locked) c.error(new Error("broken output"));
      },
    });
    const held = locked ? stdout.getReader() : undefined;
    const container = {
      exec: () =>
        Promise.resolve({
          pid: 1,
          stdout,
          stderr: null,
          stdin: null,
          exitCode: Promise.resolve(0),
          kill() {
            killed = true;
          },
        }),
    } as unknown as NativeContainer;
    let rejected = false;
    try {
      await runRaw(container, ["true"], {
        maxOutputBytes: 10,
        timeoutMs: 1000,
      });
    } catch {
      rejected = true;
    }
    assert(rejected && killed);
    await held?.cancel();
    held?.releaseLock();
  }
});

Deno.test("DB-SBX-010: SSE fragmentation, lone CR and huge producer chunks remain bounded", async () => {
  const encoded = new TextEncoder().encode(
    'data: {"type":"stdout","data":"é☃"}\r\n\r\n',
  );
  for (let split = 1; split < encoded.length; split++) {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoded.subarray(0, split));
        c.enqueue(encoded.subarray(split));
        c.close();
      },
    });
    const events = [];
    for await (const event of parseSSEStream(stream)) events.push(event);
    assertEquals(events, [{ type: "stdout", data: "é☃" }]);
  }
  const cr = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode('data: {"type":"stdout","data":"ok"}\r\r'),
      );
      c.close();
    },
  });
  const crEvents = [];
  for await (const event of parseSSEStream(cr)) crEvents.push(event);
  assertEquals(crEvents.length, 1);
  let cancelled = false;
  const large = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8 * 1024 * 1024).fill(65));
    },
    cancel() {
      cancelled = true;
    },
  });
  await rejectsWith(
    (async () => {
      for await (const _event of parseSSEStream(large, { maxEventBytes: 64 })) {
        /* consume */
      }
    })(),
    "too_large",
  );
  assert(cancelled);
  const many = new TextEncoder().encode(
    'data: {"type":"stdout","data":"x"}\n\n'.repeat(20_000),
  );
  let count = 0;
  for await (
    const _event of parseSSEStream(
      new ReadableStream({
        start(c) {
          c.enqueue(many);
          c.close();
        },
      }),
      { maxEventBytes: 64 },
    )
  ) count++;
  assertEquals(count, 20_000);
  let invalidCancelled = false;
  const invalidUtf8 = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([100, 97, 116, 97, 58, 32, 255, 10, 10]));
    },
    cancel() {
      invalidCancelled = true;
    },
  });
  await rejectsWith(
    (async () => {
      for await (const _event of parseSSEStream(invalidUtf8)) { /* consume */ }
    })(),
    "invalid",
  );
  assert(invalidCancelled);
});

Deno.test("DB-SBX-011: pre-aborted streams do not create tickets", async () => {
  let calls = 0;
  const stub = {
    openStream() {
      calls++;
      return Promise.resolve("a".repeat(32));
    },
  } as unknown as DurableObjectStub<SandboxApi>;
  const client = new SandboxClient(stub, "box");
  const signal = AbortSignal.abort(new Error("cancelled"));
  for (
    const work of [
      () => client.execStream(["true"], { signal }),
      () => client.readFileStream("x", { signal }),
      () => client.writeFileStream("x", "hi", { signal }),
    ]
  ) {
    try {
      await work();
    } catch { /* expected */ }
  }
  assertEquals(calls, 0);
});

Deno.test("DB-SBX-013: opaque names are stable, DNS-safe, and domain separated", async () => {
  const secret = new Uint8Array(32).fill(7);
  const first = await deriveSandboxId(
    secret,
    "review",
    JSON.stringify(["issuer", "tenant", "client", "subject"]),
  );
  assert(/^[a-z2-7]{26}$/.test(first));
  assertEquals(
    first,
    await deriveSandboxId(
      secret,
      "review",
      JSON.stringify(["issuer", "tenant", "client", "subject"]),
    ),
  );
  assert(
    first !==
      await deriveSandboxId(
        secret,
        "other",
        JSON.stringify(["issuer", "tenant", "client", "subject"]),
      ),
  );
  for (let i = 0; i < 4; i++) {
    const identity = ["issuer", "tenant", "client", "subject"];
    identity[i] += "2";
    assert(
      first !==
        await deriveSandboxId(secret, "review", JSON.stringify(identity)),
    );
  }
});

Deno.test("DB-SBX-002: scoped file facade cannot replace its lease or outlive its callback", () =>
  withSandbox(async ({ sandbox }) => {
    const stub = new Proxy(sandbox, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as DurableObjectStub<SandboxApi>;
    const client = new SandboxClient(stub, "box");
    let expired!: Parameters<
      Parameters<typeof client.withWorkspaceLease>[0]
    >[0];
    await client.withWorkspaceLease(async (workspace) => {
      expired = workspace;
      assert(Object.isFrozen(workspace));
      assert(
        !("unsafeStub" in workspace) && !("exec" in workspace) &&
          !("setEnvVars" in workspace),
      );
      await workspace.writeFile(
        "value",
        "scoped",
        { lease: "forged" } as never,
      );
      await rejectsWith(client.writeFile("other", "unleased"), "lease_held");
    });
    assertEquals((await client.readFile("value")).content, "scoped");
    await rejectsWith(
      Promise.resolve().then(() => expired.writeFile("value", "late")),
      "lease_lost",
    );
  }));

Deno.test("DB-SBX-011: abort while opening tickets repeatedly frees the entire ticket budget", () =>
  withSandbox(async ({ sandbox }) => {
    for (let n = 0; n < 50; n++) {
      const abort = new AbortController();
      let fetched = false;
      const stub = {
        async openStream(request: Parameters<SandboxApi["openStream"]>[0]) {
          const ticket = await sandbox.openStream(request);
          abort.abort(new Error("cancel"));
          return ticket;
        },
        cancelStream: (ticket: string) => sandbox.cancelStream(ticket),
        fetch() {
          fetched = true;
          throw new Error("must not fetch");
        },
      } as unknown as DurableObjectStub<SandboxApi>;
      try {
        await new SandboxClient(stub, "box").execStream(["true"], {
          signal: abort.signal,
        });
      } catch { /* cancellation */ }
      assertEquals(fetched, false);
    }
    const ticket = await sandbox.openStream({ kind: "exec", argv: ["true"] });
    assertEquals(await sandbox.cancelStream(ticket), true);
  }, { settings: { maxOpenTickets: 1 } }));
