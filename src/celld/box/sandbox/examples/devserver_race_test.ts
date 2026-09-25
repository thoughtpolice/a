// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Concurrent `POST /start`s, which the spec's one-at-a-time steps cannot
// send. The stand-in answers like the sandbox: each call awaits, and a
// second httpd on port 8080 cannot bind, so it exits. A start that lists
// and then starts across those awaits lets both callers start one, and the
// loser is answered a dead process; a start shared by the object's callers
// starts exactly one.

import { assertEquals } from "@celld/core/assert";
import type { ProcessInfo } from "@celld/box/sandbox";
import { type HttpdHost, serveOnce } from "./httpd.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

function sandbox(): HttpdHost & { readonly started: ProcessInfo[] } {
  const started: ProcessInfo[] = [];
  return {
    started,
    async listProcesses() {
      await tick();
      return { processes: [...started], cursor: null };
    },
    async writeFile() {
      await tick();
    },
    async startProcess(argv, options) {
      await tick();
      const bound = !started.some((process) => process.status === "running");
      const process: ProcessInfo = {
        id: `p${started.length}`,
        name: options?.name ?? null,
        pid: 100 + started.length,
        command: argv,
        cwd: ".",
        status: bound ? "running" : "exited",
        exitCode: bound ? null : 1,
        startedAt: "2026-09-26T00:00:00Z",
        endedAt: bound ? null : "2026-09-26T00:00:00Z",
      };
      started.push(process);
      return process;
    },
  };
}

Deno.test("concurrent starts share one httpd, and every caller gets the one that runs", async () => {
  const box = sandbox();
  const answers = await Promise.all([serveOnce(box), serveOnce(box)]);
  assertEquals(box.started.length, 1);
  assertEquals(answers.map((process) => process.status), [
    "running",
    "running",
  ]);
  assertEquals(answers[0].id, answers[1].id);
});

Deno.test("a later start finds the running httpd instead of starting another", async () => {
  const box = sandbox();
  const first = await serveOnce(box);
  const second = await serveOnce(box);
  assertEquals(box.started.length, 1);
  assertEquals(second.id, first.id);
});
