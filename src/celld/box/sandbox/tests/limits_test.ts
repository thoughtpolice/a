// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-SBX-007: sizes are checked in bytes, in total, and before anything is
// decoded, copied or handed to the engine.

import { assertEquals } from "@celld/core/assert";
import { parseSSEStream, readAll, type SandboxEvent } from "@celld/box/sandbox";
import { rejectsWith, withSandbox } from "./fixture.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

Deno.test("one environment value past Linux's per-string limit never reaches exec", () =>
  withSandbox(async ({ sandbox, container }) => {
    await sandbox.ready();
    const before = container.execs.length;
    // Under the old 128 Ki-character cap, but over 128 KiB as an argument.
    const value = "é".repeat(100 * KiB);
    await rejectsWith(
      sandbox.exec(["true"], { env: { BIG: value } }),
      "invalid",
    );
    await rejectsWith(sandbox.setEnvVars({ BIG: value }), "invalid");
    await rejectsWith(sandbox.execShell("x".repeat(130 * KiB)), "invalid");
    assertEquals(container.execs.length, before);
  }));

Deno.test("argv and environment are capped in total", () =>
  withSandbox(async ({ sandbox, container }) => {
    await sandbox.ready();
    const before = container.execs.length;
    const argv = [
      "true",
      ...Array.from({ length: 40 }, () => "a".repeat(10 * KiB)),
    ];
    await rejectsWith(sandbox.exec(argv), "too_large");
    await rejectsWith(sandbox.startProcess(argv), "too_large");
    const env = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`V${i}`, "b".repeat(100 * KiB)]),
    );
    await rejectsWith(sandbox.setEnvVars(env), "too_large");
    await rejectsWith(sandbox.exec(["true"], { env }), "too_large");
    await rejectsWith(sandbox.createSession({ env }), "too_large");
    // Layers that each fit may not add up past the cap either.
    await sandbox.setEnvVars({ A: "c".repeat(100 * KiB) });
    await sandbox.createSession({ id: "s", env: { B: "d".repeat(100 * KiB) } });
    await rejectsWith(
      sandbox.exec(["true"], {
        sessionId: "s",
        env: { C: "e".repeat(100 * KiB) },
      }),
      "too_large",
    );
    assertEquals(container.execs.length, before);
    assertEquals(
      (await sandbox.exec(["true"], { sessionId: "s" })).exitCode,
      0,
    );
  }, { settings: { maxArgvBytes: 256 * KiB, maxEnvBytes: 256 * KiB } }));

Deno.test("stdin is capped before it is encoded", () =>
  withSandbox(async ({ sandbox, container }) => {
    await sandbox.ready();
    const before = container.execs.length;
    await rejectsWith(
      sandbox.exec(["cat"], { stdin: "x".repeat(MiB + 1) }),
      "too_large",
    );
    await rejectsWith(
      sandbox.exec(["cat"], { stdin: new Uint8Array(MiB + 1) }),
      "too_large",
    );
    assertEquals(container.execs.length, before);
    const fits = await sandbox.exec(["wc", "-c"], { stdin: "y".repeat(MiB) });
    assertEquals(fits.stdout.trim(), String(MiB));
  }, { settings: { maxStdinBytes: MiB } }));

Deno.test("file content is capped on its encoded size, before decoding", () =>
  withSandbox(async ({ sandbox }) => {
    // Not even valid base64: it is refused for its size, never decoded.
    await rejectsWith(
      sandbox.writeFile("x", "!".repeat(4 * MiB), { encoding: "base64" }),
      "too_large",
    );
    await rejectsWith(sandbox.writeFile("x", "é".repeat(501)), "too_large");
    await rejectsWith(
      sandbox.writeFile("x", btoa("z".repeat(1001)), { encoding: "base64" }),
      "too_large",
    );
    await sandbox.writeFile("x", btoa("z".repeat(1000)), {
      encoding: "base64",
    });
    assertEquals((await sandbox.stat("x")).size, 1000);
    await sandbox.writeFile("y", "é".repeat(500));
  }, { settings: { maxFileBytes: 1000 } }));

Deno.test("stream tickets store bounded requests", () =>
  withSandbox(async ({ sandbox }) => {
    await rejectsWith(
      sandbox.openStream({
        kind: "exec",
        argv: ["cat"],
        options: { stdin: "x".repeat(300 * KiB) },
      }),
      "too_large",
    );
    const ticket = await sandbox.openStream({
      kind: "exec",
      argv: ["cat"],
      options: { stdin: "x".repeat(100 * KiB) },
    });
    await readAll((await sandbox.stream(ticket, null)).body!);
  }, { settings: { maxTicketBytes: 256 * KiB } }));

Deno.test("a streamed command takes its stdin from the request body, capped", () =>
  withSandbox(async ({ sandbox }) => {
    const body = (size: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent < size; sent += 64 * KiB) {
            controller.enqueue(new Uint8Array(Math.min(64 * KiB, size - sent)));
          }
          controller.close();
        },
      });
    const events = async (ticket: string, size: number) => {
      const out: SandboxEvent[] = [];
      const response = await sandbox.stream(ticket, body(size));
      for await (const event of parseSSEStream<SandboxEvent>(response.body!)) {
        out.push(event);
      }
      return out;
    };
    const ok = await events(
      await sandbox.openStream({
        kind: "shell",
        script: "wc -c",
        bodyStdin: true,
      }),
      3 * MiB,
    );
    const out = ok.filter((e) => e.type === "stdout").map((e) =>
      (e as { data: string }).data
    ).join("");
    assertEquals(out.trim(), String(3 * MiB));
    const over = await events(
      await sandbox.openStream({
        kind: "shell",
        script: "wc -c",
        bodyStdin: true,
      }),
      5 * MiB,
    );
    const last = over[over.length - 1];
    assertEquals(last.type, "error");
    assertEquals((last as { code: string }).code, "too_large");
    await rejectsWith(
      sandbox.openStream({
        kind: "shell",
        script: "cat",
        bodyStdin: true,
        options: { stdin: "both" },
      }),
      "invalid",
    );
  }, { settings: { maxStdinBytes: 4 * MiB } }));
