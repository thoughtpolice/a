// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  parseSSEStream,
  readAll,
  SandboxCore,
  type SandboxEvent,
} from "@celld/box/sandbox";
import { ContainerController } from "@celld/box/container";
import { FakeContainer, FakeState } from "@celld/box/container/testing";
import { eventually, rejectsWith, withSandbox } from "./fixture.ts";

Deno.test("exec runs argv in the workspace and starts the container", () =>
  withSandbox(async ({ sandbox, container, workspace }) => {
    const result = await sandbox.exec(["pwd"]);
    assertEquals(result.stdout, `${workspace}\n`);
    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);
    assertEquals(result.timedOut, false);
    assertEquals(container.starts.length, 1);
    assertEquals(container.starts[0].enableInternet, false);
    const failed = await sandbox.exec(["sh", "-c", "echo no >&2; exit 4"]);
    assertEquals([failed.success, failed.exitCode, failed.stderr], [
      false,
      4,
      "no\n",
    ]);
  }));

Deno.test("arguments are never parsed by a shell", () =>
  withSandbox(async ({ sandbox }) => {
    const tricky = "$(touch pwned); `id` && echo 'quoted' \"$HOME\" ; *";
    const result = await sandbox.exec(["printf", "%s", tricky]);
    assertEquals(result.stdout, tricky);
    assertEquals((await sandbox.exists("pwned")).exists, false);
  }));

Deno.test("execShell runs a script with sh -c", () =>
  withSandbox(async ({ sandbox }) => {
    const result = await sandbox.execShell("echo $((6 * 7)) | tr 4 X");
    assertEquals(result.stdout, "X2\n");
  }));

Deno.test("commands see only the sandbox's environment", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.setEnvVars({ SHARED: "s", GONE: "g" });
    await sandbox.setEnvVars({ GONE: null });
    const result = await sandbox.exec(["env"], { env: { CALL: "c" } });
    const names = result.stdout.trim().split("\n").map((line) =>
      line.split("=")[0]
    ).sort();
    assertEquals(names, ["CALL", "HOME", "LANG", "PATH", "SHARED"]);
  }, { fake: { env: { SECRET_TOKEN: "container start env" } } }));

Deno.test("without cleanEnv the container environment is inherited", () =>
  withSandbox(async ({ sandbox }) => {
    const result = await sandbox.exec(["sh", "-c", "echo $SECRET_TOKEN"]);
    assertEquals(result.stdout, "inherited\n");
  }, {
    settings: { cleanEnv: false },
    fake: { env: { SECRET_TOKEN: "inherited" } },
  }));

Deno.test("environment names and values are checked", () =>
  withSandbox(async ({ sandbox }) => {
    await rejectsWith(
      sandbox.exec(["true"], { env: { "A-B": "x" } }),
      "invalid",
    );
    await rejectsWith(
      sandbox.exec(["true"], { env: { A: "x\0y" } }),
      "invalid",
    );
    await rejectsWith(sandbox.setEnvVars({ "1A": "x" }), "invalid");
    await rejectsWith(sandbox.exec(["A=1"]), "invalid");
    await rejectsWith(sandbox.exec(["-i"]), "invalid");
    await rejectsWith(sandbox.exec([]), "invalid");
    await rejectsWith(sandbox.exec(["true"], { bogus: 1 } as never), "invalid");
  }));

Deno.test("cwd is workspace-relative and guarded", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.mkdir("sub/dir", { recursive: true });
    assertEquals(
      (await sandbox.exec(["pwd"], { cwd: "sub/dir" })).stdout,
      `${workspace}/sub/dir\n`,
    );
    assertEquals(
      (await sandbox.exec(["pwd"], { cwd: `${workspace}/sub` })).stdout,
      `${workspace}/sub\n`,
    );
    await rejectsWith(
      sandbox.exec(["pwd"], { cwd: "../.." }),
      "outside_workspace",
    );
    await rejectsWith(
      sandbox.exec(["pwd"], { cwd: "/etc" }),
      "outside_workspace",
    );
  }));

Deno.test("stdin takes text or bytes", () =>
  withSandbox(async ({ sandbox }) => {
    assertEquals(
      (await sandbox.exec(["cat"], { stdin: "typed in" })).stdout,
      "typed in",
    );
    const bytes = await sandbox.exec(["od", "-An", "-tu1"], {
      stdin: new Uint8Array([0, 7, 255]),
    });
    assertEquals(bytes.stdout.trim().split(/\s+/), ["0", "7", "255"]);
  }));

Deno.test("a command past its deadline is killed", () =>
  withSandbox(async ({ sandbox }) => {
    const started = Date.now();
    const result = await sandbox.exec(["sleep", "20"], { timeoutMs: 300 });
    assertEquals(result.timedOut, true);
    assertEquals(result.exitCode, null);
    assertEquals(result.success, false);
    assert(Date.now() - started < 5_000, "the kill was not prompt");
  }));

Deno.test("the deadline is capped by the class", () =>
  withSandbox(async ({ sandbox }) => {
    const result = await sandbox.exec(["sleep", "20"], { timeoutMs: 600_000 });
    assertEquals(result.timedOut, true);
    assert(result.durationMs < 5_000, String(result.durationMs));
  }, { settings: { maxExecTimeout: "400ms" } }));

Deno.test("output past the cap is cut and flagged", () =>
  withSandbox(async ({ sandbox }) => {
    const result = await sandbox.execShell(
      "head -c 100000 /dev/zero | tr '\\0' a; echo; echo tail >&2",
      { maxOutputBytes: 1000 },
    );
    assertEquals(result.stdout.length, 1000);
    assertEquals(result.stderr, "tail\n");
    assertEquals(result.truncated, true);
    assertEquals(result.exitCode, 0);
  }));

Deno.test("combineOutput interleaves stderr into stdout", () =>
  withSandbox(async ({ sandbox }) => {
    const result = await sandbox.execShell("echo one; echo two >&2", {
      combineOutput: true,
    });
    assert(
      result.stdout.includes("one\n") && result.stdout.includes("two\n"),
      result.stdout,
    );
    assertEquals(result.stderr, "");
  }));

Deno.test("sessions carry a working directory and environment", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.mkdir("proj/src", { recursive: true });
    const session = await sandbox.createSession({
      id: "build",
      cwd: "proj",
      env: { MODE: "debug" },
    });
    assertEquals(session, { id: "build", cwd: "proj", env: { MODE: "debug" } });
    const result = await sandbox.execShell("pwd; echo $MODE", {
      sessionId: "build",
      cwd: "src",
    });
    assertEquals(result.stdout, `${workspace}/proj/src\ndebug\n`);
    const override = await sandbox.execShell("echo $MODE", {
      sessionId: "build",
      env: { MODE: "release" },
    });
    assertEquals(override.stdout, "release\n");
    assertEquals((await sandbox.listSessions()).map((s) => s.id), ["build"]);
    await sandbox.deleteSession("build");
    await rejectsWith(
      sandbox.exec(["true"], { sessionId: "build" }),
      "no_such_session",
    );
    await rejectsWith(sandbox.deleteSession("build"), "no_such_session");
  }));

Deno.test("execStream emits start, output and complete as SSE", () =>
  withSandbox(async ({ sandbox }) => {
    const ticket = await sandbox.openStream({
      kind: "shell",
      script: "echo a; echo b >&2; exit 3",
    });
    const response = await sandbox.stream(ticket, null);
    assertEquals(
      response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    const events: SandboxEvent[] = [];
    for await (const event of parseSSEStream(response.body!)) {
      events.push(event);
    }
    assertEquals(events[0].type, "start");
    const text = (type: string) =>
      events.filter((e) => e.type === type).map((e) =>
        (e as { data: string }).data
      ).join("");
    assertEquals(text("stdout"), "a\n");
    assertEquals(text("stderr"), "b\n");
    const last = events[events.length - 1];
    assertEquals(last.type, "complete");
    assertEquals((last as { exitCode: number }).exitCode, 3);
  }));

Deno.test("a stream reports errors as an event", () =>
  withSandbox(async ({ sandbox }) => {
    const ticket = await sandbox.openStream({
      kind: "exec",
      argv: ["true"],
      options: { sessionId: "missing" },
    });
    const body = new TextDecoder().decode(
      await readAll((await sandbox.stream(ticket, null)).body!),
    );
    assert(body.includes("event: error"), body);
    assert(body.includes('"code":"no_such_session"'), body);
  }));

Deno.test("tickets are single-use and checked", () =>
  withSandbox(async ({ sandbox }) => {
    const ticket = await sandbox.openStream({ kind: "exec", argv: ["true"] });
    await readAll((await sandbox.stream(ticket, null)).body!);
    await rejectsWith(sandbox.stream(ticket, null), "bad_ticket");
    await rejectsWith(sandbox.stream("../../etc", null), "bad_ticket");
    await rejectsWith(sandbox.openStream({ kind: "nope" } as never), "invalid");
  }));

Deno.test("stop and restart keep the sandbox usable", () =>
  withSandbox(async ({ sandbox, container }) => {
    await sandbox.writeFile("keep.txt", "x");
    await sandbox.stop();
    assertEquals(sandbox.getState().status, "stopped");
    assertEquals((await sandbox.exec(["cat", "keep.txt"])).stdout, "x");
    assertEquals(container.starts.length, 2);
    assertEquals(sandbox.getState().generation, 2);
  }));

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

async function pids(workspace: string, ...files: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const file of files) {
    let text = "";
    await eventually(async () => {
      text = await Deno.readTextFile(`${workspace}/${file}`).catch(() => "");
      return text.trim() !== "";
    });
    out.push(Number(text.trim()));
  }
  return out;
}

// DB-SBX-004: the deadline used to kill only the process the engine knew.
Deno.test("the deadline kills the command's children and grandchildren", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const result = await sandbox.execShell(
      "sleep 30 & echo $! > kid; ( sleep 30 & echo $! > grandkid ); sleep 30",
      { timeoutMs: 500 },
    );
    assertEquals(result.timedOut, true);
    for (const pid of await pids(workspace, "kid", "grandkid")) {
      await eventually(async () => !(await alive(pid)), 3_000);
    }
  }));

Deno.test("what a command leaves running dies when it exits", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    const result = await sandbox.execShell(
      "nohup sleep 30 > /dev/null 2>&1 & echo $! > orphan",
      { timeoutMs: 10_000 },
    );
    assertEquals([result.exitCode, result.timedOut], [0, false]);
    const [pid] = await pids(workspace, "orphan");
    await eventually(async () => !(await alive(pid)), 3_000);
  }));

Deno.test("exit statuses and stdin pass through the process group", () =>
  withSandbox(async ({ sandbox }) => {
    assertEquals((await sandbox.execShell("exit 7")).exitCode, 7);
    assertEquals(
      (await sandbox.exec(["cat"], { stdin: "through the wrapper" })).stdout,
      "through the wrapper",
    );
    assertEquals((await sandbox.exec(["cat"])).stdout, "");
  }));

Deno.test("the hostile tier refuses a container that is not gVisor", async () => {
  const container = new FakeContainer({ exec: () => ({ stdout: "other" }) });
  const state = new FakeState(container);
  const sandbox = new SandboxCore(new ContainerController(state), state.kv, {
    tier: "hostile",
  });
  const error = await rejectsWith(sandbox.exec(["true"]), "unsafe_runtime");
  assert(error.detail.includes("runsc"), error.detail);
  await rejectsWith(sandbox.writeFile("x", "y"), "unsafe_runtime");
  await container.destroy();
});

// Carry-over from WP-04: the RUN wrapper wrote the command's process group
// id to its file only after starting the command. A kill in between (or a
// file it could not write) found no id, killed the wrapper alone, and left
// the command's group running. The command's own process now records the
// id before it execs, and nothing runs when that fails.
Deno.test("a command whose process group cannot be recorded never runs", () =>
  withSandbox(async ({ sandbox, root, workspace }) => {
    await sandbox.exec(["true"]);
    await Deno.chmod(`${root}/state/run`, 0o555);
    try {
      await rejectsWith(
        sandbox.execShell("sleep 30 & echo $! > sleeper; wait", {
          timeoutMs: 500,
        }),
        "command_failed",
      );
    } finally {
      await Deno.chmod(`${root}/state/run`, 0o755);
    }
    const left = await Deno.readTextFile(`${workspace}/sleeper`).catch(() =>
      null
    );
    if (left !== null) {
      const pid = left.trim();
      const alive = await new Deno.Command("kill", {
        args: ["-0", pid],
        stderr: "null",
      }).output();
      await new Deno.Command("kill", { args: ["-KILL", pid], stderr: "null" })
        .output();
      assertEquals(alive.success, false, `sleep ${pid} outlived its command`);
    }
    assertEquals(left, null, "the command ran");
  }));

Deno.test("a kill waits for a process group id that is about to be written", async () => {
  // A slow `mv` delays the id's write past the deadline.
  const bin = await Deno.realPath(await Deno.makeTempDir());
  const real = new TextDecoder().decode(
    (await new Deno.Command("sh", { args: ["-c", "command -v mv"] }).output())
      .stdout,
  ).trim();
  await Deno.writeTextFile(
    `${bin}/mv`,
    `#!/bin/sh\nsleep 0.4\nexec "${real}" "$@"\n`,
  );
  await Deno.chmod(`${bin}/mv`, 0o755);
  try {
    await withSandbox(async ({ sandbox, workspace }) => {
      const result = await sandbox.execShell(
        "sleep 30 & echo $! > sleeper; wait",
        { timeoutMs: 100 },
      );
      assertEquals(result.timedOut, true);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const left = await Deno.readTextFile(`${workspace}/sleeper`).catch(
        () => null,
      );
      if (left !== null) {
        const alive = await new Deno.Command("kill", {
          args: ["-0", left.trim()],
          stderr: "null",
        }).output();
        await new Deno.Command("kill", {
          args: ["-KILL", left.trim()],
          stderr: "null",
        }).output();
        assertEquals(alive.success, false, "the command outlived its kill");
      }
    }, {
      settings: {
        baseEnv: {
          PATH: `${bin}:${"/usr/local/bin:/usr/bin:/bin"}`,
          HOME: `${bin}/home`,
          LANG: "C.UTF-8",
        },
      },
    });
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});
