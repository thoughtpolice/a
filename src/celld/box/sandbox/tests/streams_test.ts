// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-SBX-002 and DB-SBX-003: streamed commands and reads must end their
// command however the reader behaves (never reading, cancelling, stalling,
// going slowly), and a streamed read must not keep what it moves.

import { assert, assertEquals } from "@celld/core/assert";
import { ContainerController } from "@celld/box/container";
import { FakeContainer, FakeState } from "@celld/box/container/testing";
import {
  encodeEvent,
  parseSSEStream,
  randomToken,
  runRaw,
  SandboxCore,
  SandboxError,
  type SandboxEvent,
} from "@celld/box/sandbox";
import { eventually, withSandbox } from "./fixture.ts";

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

// The pid a command wrote to `file` in the workspace, once it exists.
async function pidIn(workspace: string, file: string): Promise<number> {
  let text = "";
  await eventually(async () => {
    try {
      text = (await Deno.readTextFile(`${workspace}/${file}`)).trim();
    } catch {
      return false;
    }
    return text !== "";
  });
  return Number(text);
}

const SLEEPER = "echo $$ > pid; exec sleep 30";

Deno.test("a stream nobody reads ends at its deadline and frees the object", () =>
  withSandbox(async ({ sandbox, controller, workspace }) => {
    const ticket = await sandbox.openStream({
      kind: "shell",
      script: SLEEPER,
      options: { timeoutMs: 400 },
    });
    const response = await sandbox.stream(ticket, null);
    const pid = await pidIn(workspace, "pid");
    assert(await alive(pid), "the command started");
    await eventually(async () => !(await alive(pid)), 4_000);
    await eventually(() => Promise.resolve(!controller.isBusy), 4_000);
    await response.body!.cancel();
  }));

Deno.test("cancelling the reader kills the command at once", () =>
  withSandbox(async ({ sandbox, controller, workspace }) => {
    const ticket = await sandbox.openStream({
      kind: "shell",
      script: SLEEPER,
      options: { timeoutMs: 60_000 },
    });
    const response = await sandbox.stream(ticket, null);
    const events = parseSSEStream<SandboxEvent>(response.body!);
    const first = await events.next();
    assertEquals((first.value as SandboxEvent).type, "start");
    const pid = await pidIn(workspace, "pid");
    await events.return(undefined);
    const cancelled = Date.now();
    await eventually(async () => !(await alive(pid)), 3_000);
    await eventually(() => Promise.resolve(!controller.isBusy), 3_000);
    assert(Date.now() - cancelled < 3_000, "the kill was not prompt");
  }));

Deno.test("a reader that stalls cannot hold the command past its deadline", () =>
  withSandbox(async ({ sandbox, controller, workspace }) => {
    const ticket = await sandbox.openStream({
      kind: "shell",
      // Far more output than any queue holds, then a long sleep.
      script:
        "echo $$ > pid; head -c 4000000 /dev/zero | tr '\\0' x; exec sleep 30",
      options: { timeoutMs: 500, maxOutputBytes: 8_000_000 },
    });
    const response = await sandbox.stream(ticket, null);
    const reader = response.body!.getReader();
    await reader.read();
    const pid = await pidIn(workspace, "pid");
    // The reader never reads again, and never cancels.
    await eventually(async () => !(await alive(pid)), 5_000);
    await eventually(() => Promise.resolve(!controller.isBusy), 5_000);
    // The stream gave up on its reader.
    let failed = false;
    await reader.read().catch(() => {
      failed = true;
    });
    for (let i = 0; i < 1000 && !failed; i++) {
      await reader.read().then(({ done }) => {
        if (done) failed = true;
      }, () => {
        failed = true;
      });
    }
    assert(failed, "the stream still flows");
  }));

Deno.test("a slow reader still gets all of a command's output", () =>
  withSandbox(async ({ sandbox, controller }) => {
    const ticket = await sandbox.openStream({
      kind: "shell",
      script: "i=0; while [ $i -lt 300 ]; do echo line $i; i=$((i + 1)); done",
      options: { timeoutMs: 20_000 },
    });
    const response = await sandbox.stream(ticket, null);
    let text = "";
    let last: SandboxEvent | undefined;
    for await (const event of parseSSEStream<SandboxEvent>(response.body!)) {
      if (event.type === "stdout") text += event.data;
      last = event;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assertEquals(text.split("\n").length, 301);
    assertEquals(last?.type, "complete");
    assertEquals((last as { exitCode: number }).exitCode, 0);
    assertEquals(controller.isBusy, false);
  }));

Deno.test("runRaw kills the command when onStart or onChunk throws", () =>
  withSandbox(async ({ sandbox, container, workspace }) => {
    await sandbox.ready();
    for (const where of ["start", "chunk"] as const) {
      const file = `pid-${where}`;
      let failed: unknown = null;
      try {
        await runRaw(
          container,
          ["sh", "-c", `echo $$ > ${file}; echo out; exec sleep 30`],
          {
            cwd: workspace,
            timeoutMs: 60_000,
            maxOutputBytes: 1024,
            onStart: async () => {
              if (where !== "start") return;
              // Once the command is surely running.
              await pidIn(workspace, file);
              throw new Error("the reader went away");
            },
            onChunk: () => {
              if (where === "chunk") throw new Error("the reader went away");
            },
          },
        );
      } catch (error) {
        failed = error;
      }
      assertEquals((failed as Error | null)?.message, "the reader went away");
      const pid = await pidIn(workspace, file);
      await eventually(async () => !(await alive(pid)), 3_000);
    }
  }));

Deno.test("an aborted signal kills the command and the call fails", () =>
  withSandbox(async ({ sandbox, controller, workspace }) => {
    const abort = new AbortController();
    const running = sandbox.execShell(SLEEPER, {
      timeoutMs: 60_000,
      signal: abort.signal,
    });
    running.catch(() => {});
    const pid = await pidIn(workspace, "pid");
    abort.abort();
    let code = "";
    try {
      await running;
    } catch (error) {
      code = (error as { code?: string }).code ?? String(error);
    }
    assertEquals(code, "cancelled");
    await eventually(async () => !(await alive(pid)), 3_000);
    assertEquals(controller.isBusy, false);
  }));

// A container whose file read is an endless, counting producer: every
// exec answers at once, except the read, which announces `total` bytes on
// stderr (as READSTREAM does) and whose stdout makes 64 KiB chunks on
// demand until `total` bytes. (Rewritten with the sweep: READSTREAM used to
// be `cat` and announce nothing; the size now comes from the read itself.)
class CountingContainer extends FakeContainer {
  produced = 0;
  cancelled = false;
  killed = false;

  constructor(readonly total: number) {
    super({
      exec: (call) =>
        call.argv.some((arg) => arg.includes("%s %s %s"))
          ? { stdout: `file 0 ${total} 0\n` }
          : {},
    });
  }

  override async exec(
    command: string[],
    options: ContainerExecOptions = {},
  ): Promise<ContainerExecProcess> {
    if (!command.some((arg) => arg.includes('exec head -c "$s"'))) {
      return await super.exec(command, options);
    }
    let finish: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const stdout = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (this.produced >= this.total) {
          controller.close();
          finish(0);
          return;
        }
        // Written to, so its pages are really resident.
        const chunk = new Uint8Array(64 * 1024).fill(this.produced % 251);
        this.produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel: () => {
        this.cancelled = true;
        finish(137);
      },
    }, { highWaterMark: 0 });
    return {
      pid: 4242,
      stdin: null,
      stdout,
      stderr: new ReadableStream({
        start: (c) => {
          c.enqueue(new TextEncoder().encode(`${this.total}\n`));
          c.close();
        },
      }),
      exitCode,
      kill: () => {
        this.killed = true;
        finish(137);
      },
      output: () => Promise.reject(new Error("not used")),
    };
  }
}

function counting(total: number) {
  const container = new CountingContainer(total);
  const state = new FakeState(container);
  const sandbox = new SandboxCore(new ContainerController(state), state.kv, {
    tier: "trusted",
    maxStreamFileBytes: total,
  });
  return { container, sandbox };
}

Deno.test("a streamed read holds a bounded amount, however big the file", async () => {
  const total = 768 * 1024 * 1024;
  const { container, sandbox } = counting(total);
  const ticket = await sandbox.openStream({ kind: "read", path: "big.bin" });
  const response = await sandbox.stream(ticket, null);
  const reader = response.body!.getReader();
  const before = Deno.memoryUsage().rss;
  let consumed = 0;
  let ahead = 0;
  let peak = before;
  for (let reads = 0;; reads++) {
    const { done, value } = await reader.read();
    if (done) break;
    consumed += value.byteLength;
    ahead = Math.max(ahead, container.produced - consumed);
    if (reads % 256 === 0) peak = Math.max(peak, Deno.memoryUsage().rss);
  }
  assertEquals(consumed, total);
  // What the producer ran ahead of the reader: the stream's queue.
  assert(ahead <= 2 * 1024 * 1024, `${ahead} bytes ahead`);
  // Nothing keeps the bytes that went through.
  assert(peak - before < 256 * 1024 * 1024, `rss grew ${peak - before}`);
});

Deno.test("cancelling a streamed read stops the producer", async () => {
  const { container, sandbox } = counting(1024 * 1024 * 1024);
  const ticket = await sandbox.openStream({ kind: "read", path: "big.bin" });
  const response = await sandbox.stream(ticket, null);
  const reader = response.body!.getReader();
  let consumed = 0;
  while (consumed < 1024 * 1024) {
    consumed += (await reader.read()).value!.byteLength;
  }
  await reader.cancel();
  await eventually(() =>
    Promise.resolve(container.cancelled || container.killed)
  );
  const produced = container.produced;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEquals(container.produced, produced);
  assert(produced < 8 * 1024 * 1024, `${produced} bytes produced`);
});

function streamOf(
  ...chunks: (string | Uint8Array)[]
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return SandboxError.from(error)?.code ?? String(error);
  }
  return null;
}

// DB-SBX-012: parseSSEStream kept everything a peer sent until it sent a
// blank line, so a peer that never did grew the buffer without bound.
Deno.test("parseSSEStream caps the bytes of one event", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(
        new TextEncoder().encode("data: " + "x".repeat(65536)),
      );
    },
  });
  const code = await codeOf(async () => {
    for await (
      const _ of parseSSEStream(endless, { maxEventBytes: 256 * 1024 })
    ) {
      // Never reached.
    }
  });
  assertEquals(code, "too_large");
  assert(pulled < 16, `read ${pulled} chunks before refusing`);
  // The default is 1 MiB.
  const big = "data: " + "y".repeat(1024 * 1024 + 16);
  assertEquals(
    await codeOf(async () => {
      for await (const _ of parseSSEStream(streamOf(big))) {
        // Never reached.
      }
    }),
    "too_large",
  );
});

Deno.test("parseSSEStream checks each event against the event schema", async () => {
  const good = [
    { type: "start", pid: 4 },
    { type: "stdout", data: "hi" },
    {
      type: "complete",
      success: true,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      durationMs: 3,
    },
    { type: "exit", status: "exited", exitCode: 0 },
  ];
  const seen: unknown[] = [];
  for await (
    const event of parseSSEStream(
      streamOf(
        ...good.map((event) => encodeEvent(event as never)),
        ": comment\n\n",
      ),
    )
  ) {
    seen.push(event);
  }
  assertEquals(seen, good);
  for (
    const bad of [
      "data: not json\n\n",
      'data: {"type":"stdout","data":7}\n\n',
      'data: {"type":"exec","argv":["rm"]}\n\n',
      'data: {"type":"start","pid":"1"}\n\n',
      "data: [1,2]\n\n",
    ]
  ) {
    assertEquals(
      await codeOf(async () => {
        for await (const _ of parseSSEStream(streamOf(bad))) {
          // Refused before an event is yielded.
        }
      }),
      "invalid",
      bad,
    );
  }
  // A caller with its own event shape passes its own check.
  const custom: unknown[] = [];
  for await (
    const event of parseSSEStream<{ n: number }>(
      streamOf('data: {"n":1}\n\n'),
      {
        validate: (value): value is { n: number } =>
          typeof (value as { n?: unknown }).n === "number",
      },
    )
  ) {
    custom.push(event);
  }
  assertEquals(custom, [{ n: 1 }]);
});

// DB-SBX-014: randomToken took any length, including absurd ones.
Deno.test("randomToken takes a bounded positive length", () => {
  assertEquals(randomToken(26).length, 26);
  assert(/^[a-z2-7]{26}$/.test(randomToken(26)), "base32 letters");
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 257, 2 ** 31]) {
    let threw = false;
    try {
      randomToken(bad);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, String(bad));
  }
});
