// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { FakeContainer, FakeKv } from "@celld/container/testing";

const text = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);

async function running(options = {}): Promise<FakeContainer> {
  const container = new FakeContainer(options);
  container.start();
  return await Promise.resolve(container);
}

Deno.test("exec refuses a stopped container like celld does", async () => {
  const container = new FakeContainer();
  let message = "";
  try {
    await container.exec(["true"]);
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("not running"), message);
});

Deno.test("exec runs a real process with the given env and cwd", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const container = await running({ env: { BASE: "b" } });
    const process = await container.exec(
      [
        "/bin/sh",
        "-c",
        'printf "%s %s " "$BASE" "$EXTRA"; pwd; echo oops >&2; exit 3',
      ],
      { cwd: dir, env: { EXTRA: "e" } },
    );
    const output = await process.output();
    assertEquals(text(output.stdout), `b e ${await Deno.realPath(dir)}\n`);
    assertEquals(text(output.stderr), "oops\n");
    assertEquals(output.exitCode, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stdin can be piped or streamed, and output combined", async () => {
  const container = await running();
  const piped = await container.exec(["cat"], { stdin: "pipe" });
  const writer = piped.stdin!.getWriter();
  await writer.write(new Uint8Array([0, 1, 2, 255]));
  await writer.close();
  assertEquals(
    new Uint8Array((await piped.output()).stdout),
    new Uint8Array([0, 1, 2, 255]),
  );

  const streamed = await container.exec(["cat"], {
    stdin: new Blob(["from a stream"]).stream(),
  });
  assertEquals(text((await streamed.output()).stdout), "from a stream");

  const combined = await container.exec([
    "/bin/sh",
    "-c",
    "echo out; echo err >&2",
  ], {
    stderr: "combined",
  });
  assertEquals(combined.stderr, null);
  const both = text((await combined.output()).stdout);
  assert(both.includes("out\n") && both.includes("err\n"), both);
});

Deno.test("kill ends a process with 128 + signal", async () => {
  const container = await running();
  const process = await container.exec(["sleep", "30"]);
  process.kill(9);
  assertEquals(await process.exitCode, 137);
});

Deno.test("a crash kills running execs and settles the monitor", async () => {
  const container = await running();
  const monitor = container.monitor().then(
    () => "",
    (error: Error) => error.message,
  );
  const process = await container.exec(["sleep", "30"]);
  container.crash(3);
  assertEquals(await process.exitCode, 137);
  const rejected = await monitor;
  assert(rejected.includes("status 3"), rejected);
  assertEquals(container.running, false);
});

Deno.test("a scripted handler answers, or defers to a real process", async () => {
  const container = await running({
    exec: (
      { argv, stdin }: { argv: readonly string[]; stdin: Uint8Array | null },
    ) =>
      argv[0] === "fake"
        ? {
          stdout: `saw ${new TextDecoder().decode(stdin ?? new Uint8Array())}`,
          stderr: "e",
          exitCode: 4,
        }
        : null,
  });
  const scripted = await container.exec(["fake"], {
    stdin: new Blob(["input"]).stream(),
  });
  const output = await scripted.output();
  assertEquals([text(output.stdout), text(output.stderr), output.exitCode], [
    "saw input",
    "e",
    4,
  ]);
  const real = await container.exec(["echo", "real"]);
  assertEquals(text((await real.output()).stdout), "real\n");
  assertEquals(container.execs.map((call) => call.argv[0]), ["fake", "echo"]);
});

Deno.test("a slow scripted exec can be killed", async () => {
  const container = await running({ exec: () => ({ delayMs: 10_000 }) });
  const process = await container.exec(["anything"]);
  process.kill(15);
  assertEquals(await process.exitCode, 143);
});

Deno.test("ports answer only while running and with a handler", async () => {
  const container = await running();
  container.ports.set(80, () => new Response("hi"));
  assertEquals(
    await (await container.getTcpPort(80).fetch("http://c/")).text(),
    "hi",
  );
  let refused = false;
  try {
    await container.getTcpPort(81).fetch("http://c/");
  } catch {
    refused = true;
  }
  assert(refused, "port 81 has no handler");
  await container.getTcpPort(80).connect().opened;
  let closed = false;
  try {
    await container.getTcpPort(81).connect().opened;
  } catch {
    closed = true;
  }
  assert(closed, "connect to 81 must fail");
});

Deno.test("the KV fake clones and lists in order", () => {
  const kv = new FakeKv();
  const value = { a: [1] };
  kv.put("p/b", value);
  kv.put("p/a", 1);
  kv.put("q", 2);
  value.a.push(2);
  assertEquals(kv.get("p/b"), { a: [1] });
  assertEquals([...kv.list({ prefix: "p/" })].map(([key]) => key), [
    "p/a",
    "p/b",
  ]);
  assertEquals([...kv.list({ limit: 1, reverse: true })].map(([key]) => key), [
    "q",
  ]);
  assertEquals(kv.delete("q"), true);
  assertEquals(kv.get("q"), undefined);
});
