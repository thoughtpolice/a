// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { isUlid } from "@celld/core/ulid";
import { parseSSEStream, type SandboxEvent } from "@celld/box/sandbox";
import { eventually, rejectsWith, withSandbox } from "./fixture.ts";

const fast = { settings: { logPollInterval: "20ms" } };

Deno.test("a background process outlives the call that started it", () =>
  withSandbox(async ({ sandbox }) => {
    const started = await sandbox.startShellProcess(
      "echo begin; sleep 0.3; echo end; echo oops >&2; exit 5",
      { name: "job" },
    );
    assert(isUlid(started.id), started.id);
    assertEquals([started.status, started.name, started.cwd], [
      "running",
      "job",
      "",
    ]);
    assert(started.pid > 0, "pid");
    const done = await sandbox.waitForExit(started.id, { timeoutMs: 10_000 });
    assertEquals([done.status, done.exitCode], ["exited", 5]);
    assert(done.endedAt !== null, "endedAt");
    const logs = await sandbox.getProcessLogs(started.id);
    assertEquals([logs.stdout, logs.stderr, logs.truncated], [
      "begin\nend\n",
      "oops\n",
      false,
    ]);
  }, fast));

Deno.test("processes get the sandbox environment and cwd", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.mkdir("srv");
    await sandbox.setEnvVars({ GREETING: "hi" });
    const started = await sandbox.startProcess([
      "sh",
      "-c",
      'pwd; echo "$GREETING $EXTRA"',
    ], {
      cwd: "srv",
      env: { EXTRA: "there" },
    });
    await sandbox.waitForExit(started.id);
    assertEquals(
      (await sandbox.getProcessLogs(started.id)).stdout,
      `${workspace}/srv\nhi there\n`,
    );
  }, fast));

Deno.test("list, get and kill", () =>
  withSandbox(async ({ sandbox }) => {
    const long = await sandbox.startProcess(["sleep", "30"]);
    const short = await sandbox.startProcess(["true"]);
    await sandbox.waitForExit(short.id);
    const listed = (await sandbox.listProcesses()).processes;
    assertEquals(listed.map((p) => [p.id, p.status]), [
      [long.id, "running"],
      [short.id, "exited"],
    ]);
    const killed = await sandbox.killProcess(long.id);
    assertEquals([killed.status, killed.exitCode], ["killed", 143]);
    assertEquals((await sandbox.getProcess(long.id)).status, "killed");
    await rejectsWith(
      sandbox.getProcess("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      "no_such_process",
    );
    await rejectsWith(sandbox.getProcess("../etc"), "invalid");
    await rejectsWith(sandbox.killProcess(long.id, "BOOM"), "invalid");
  }, fast));

Deno.test("kill reaches the whole process group", () =>
  withSandbox(async ({ sandbox }) => {
    const started = await sandbox.startShellProcess(
      "sleep 30 & sleep 30 & wait",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const killed = await sandbox.killProcess(started.id, "KILL");
    assertEquals(killed.status, "killed");
    const left = await sandbox.exec([
      "sh",
      "-c",
      `pgrep -g ${started.pid} || true`,
    ]);
    assertEquals(left.stdout.trim(), "");
  }, fast));

Deno.test("killAllProcesses stops everything running", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.startProcess(["sleep", "30"]);
    await sandbox.startProcess(["sleep", "30"]);
    const all = await sandbox.killAllProcesses();
    assertEquals(all.map((p) => p.status), ["killed", "killed"]);
  }, fast));

Deno.test("a process past its timeout is killed", () =>
  withSandbox(async ({ sandbox }) => {
    const started = await sandbox.startProcess(["sleep", "30"], {
      timeoutMs: 500,
    });
    const done = await sandbox.waitForExit(started.id, { timeoutMs: 10_000 });
    assertEquals([done.status, done.exitCode], ["timed_out", 137]);
  }, fast));

Deno.test("the running process limit holds", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.startProcess(["sleep", "30"]);
    await sandbox.startProcess(["sleep", "30"]);
    await rejectsWith(
      sandbox.startProcess(["sleep", "30"]),
      "too_many_processes",
    );
    await sandbox.killAllProcesses("KILL");
    await sandbox.startProcess(["true"]);
  }, { settings: { maxProcesses: 2, logPollInterval: "20ms" } }));

Deno.test("process output is capped in the container", () =>
  withSandbox(async ({ sandbox }) => {
    const started = await sandbox.startShellProcess(
      "head -c 5000 /dev/zero | tr '\\0' x; echo after",
    );
    const done = await sandbox.waitForExit(started.id);
    assertEquals([done.status, done.exitCode], ["exited", 0]);
    const logs = await sandbox.getProcessLogs(started.id);
    assertEquals([logs.stdout.length, logs.truncated], [1024, true]);
  }, { settings: { processLogBytes: 1000, logPollInterval: "20ms" } }));

Deno.test("a missing program exits 127 with a message", () =>
  withSandbox(async ({ sandbox }) => {
    const started = await sandbox.startProcess(["/no/such/program"]);
    const done = await sandbox.waitForExit(started.id);
    assertEquals(done.exitCode, 127);
    assert(
      (await sandbox.getProcessLogs(started.id)).stderr.includes(
        "/no/such/program",
      ),
      "stderr",
    );
  }, fast));

// DB-SBX-005: patterns used to be regular expressions by default, run in
// the isolate. This test asserted that default; it now asks for one.
Deno.test("waitForLog finds a line, or reports the process ended", () =>
  withSandbox(async ({ sandbox }) => {
    const server = await sandbox.startShellProcess(
      "sleep 0.2; echo 'starting'; echo 'listening on :8080' >&2; sleep 30",
    );
    const found = await sandbox.waitForLog(server.id, "listening on :[0-9]+", {
      regex: true,
      timeoutMs: 10_000,
    });
    assertEquals([found.matched, found.line], [true, "listening on :8080"]);
    const literal = await sandbox.waitForLog(server.id, "on :8080", {
      timeoutMs: 10_000,
    });
    assertEquals([literal.matched, literal.line], [true, "listening on :8080"]);
    const notRegex = await sandbox.waitForLog(server.id, "on :[0-9]+", {
      timeoutMs: 300,
    });
    assertEquals(notRegex.matched, false);
    const onlyOut = await sandbox.waitForLog(server.id, "listening", {
      stream: "stdout",
      timeoutMs: 300,
    });
    assertEquals(onlyOut.matched, false);
    await sandbox.killProcess(server.id);
    const quiet = await sandbox.startProcess(["true"]);
    const missed = await sandbox.waitForLog(quiet.id, "never", {
      timeoutMs: 10_000,
    });
    assertEquals([missed.matched, missed.process.status], [false, "exited"]);
    await rejectsWith(
      sandbox.waitForLog(quiet.id, "(", { regex: true }),
      "invalid",
    );
    await rejectsWith(
      sandbox.waitForLog(quiet.id, "a".repeat(257), { regex: true }),
      "invalid",
    );
    await rejectsWith(sandbox.waitForLog(quiet.id, "two\nlines"), "invalid");
  }, fast));

// DB-SBX-005: a backtracking pattern used to run in the isolate, where the
// deadline was checked only after it returned and nothing else could run.
Deno.test("a catastrophic pattern neither outlives its deadline nor blocks the object", () =>
  withSandbox(async ({ sandbox }) => {
    const hostile = await sandbox.startShellProcess(
      `printf '%s!\\n' ${"a".repeat(40)}; sleep 30`,
    );
    await sandbox.waitForLog(hostile.id, "!", { timeoutMs: 10_000 });
    for (const regex of [false, true]) {
      const started = Date.now();
      const waiting = sandbox.waitForLog(hostile.id, "(a+)+$", {
        timeoutMs: 1_000,
        ...(regex ? { regex } : {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const probe = Date.now();
      assertEquals((await sandbox.getProcess(hostile.id)).status, "running");
      assert(Date.now() - probe < 1_000, "another call was blocked");
      assertEquals((await waiting).matched, false);
      assert(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
    }
    await sandbox.killProcess(hostile.id, "KILL");
  }, fast));

Deno.test("log streams follow output until exit", () =>
  withSandbox(async ({ sandbox }) => {
    const started = await sandbox.startShellProcess(
      "for i in 1 2 3; do echo line $i; sleep 0.1; done; echo warn >&2; exit 2",
    );
    const ticket = await sandbox.openStream({
      kind: "logs",
      processId: started.id,
    });
    const events: SandboxEvent[] = [];
    for await (
      const event of parseSSEStream((await sandbox.stream(ticket, null)).body!)
    ) {
      events.push(event);
    }
    const out = events.filter((e) => e.type === "stdout").map((e) =>
      (e as { data: string }).data
    ).join("");
    assertEquals(out, "line 1\nline 2\nline 3\n");
    assert(events.some((e) => e.type === "stderr"), "stderr event");
    assertEquals(events[events.length - 1], {
      type: "exit",
      status: "exited",
      exitCode: 2,
    });
  }, fast));

// Filed (orchestrator): this test printed "new" half a second after "old"
// and expected the stream to have taken its first look by then, which a
// loaded host did not always do. The process now prints "new" only once
// the stream has looked twice (its first look sets where "new" starts).
Deno.test("a stream of only new output skips what was written", () =>
  withSandbox(async ({ sandbox, container, workspace }) => {
    const started = await sandbox.startShellProcess(
      "echo old; while [ ! -e go ]; do sleep 0.05; done; echo new",
    );
    await sandbox.waitForLog(started.id, "old");
    const polls = () =>
      container.execs.filter((call) =>
        call.argv.some((arg) => arg.includes("echo missing"))
      ).length;
    const before = polls();
    const ticket = await sandbox.openStream({
      kind: "logs",
      processId: started.id,
      fromStart: false,
    });
    const data: string[] = [];
    const reading = (async () => {
      for await (
        const event of parseSSEStream(
          (await sandbox.stream(ticket, null)).body!,
        )
      ) {
        if (event.type === "stdout") data.push(event.data);
      }
    })();
    await eventually(() => Promise.resolve(polls() >= before + 2));
    await Deno.writeTextFile(`${workspace}/go`, "");
    await reading;
    assertEquals(data.join(""), "new\n");
  }, fast));

Deno.test("a crash marks processes lost but keeps their tails", () =>
  withSandbox(async ({ sandbox, container }) => {
    const finished = await sandbox.startShellProcess("echo kept; exit 0");
    await sandbox.waitForExit(finished.id);
    const running = await sandbox.startProcess(["sleep", "30"]);
    container.crash();
    assertEquals((await sandbox.getProcess(running.id)).status, "lost");
    await sandbox.exec(["true"]);
    const logs = await sandbox.getProcessLogs(finished.id);
    assertEquals(logs.process.status, "exited");
    assertEquals(logs.stdout, "kept\n");
    const listed = (await sandbox.listProcesses()).processes;
    assertEquals(listed.map((p) => p.status), ["exited", "lost"]);
    const ticket = await sandbox.openStream({
      kind: "logs",
      processId: running.id,
    });
    const events: SandboxEvent[] = [];
    for await (
      const event of parseSSEStream((await sandbox.stream(ticket, null)).body!)
    ) {
      events.push(event);
    }
    assertEquals(events, [{ type: "exit", status: "lost", exitCode: null }]);
  }, fast));

// DB-SBX-004: the limit was counted before an awaited spawn, so concurrent
// starts all passed it; foreground commands were not counted at all.
Deno.test("concurrent starts at the limit cannot exceed it", () =>
  withSandbox(async ({ sandbox }) => {
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => sandbox.startProcess(["sleep", "30"])),
    );
    const started = settled.filter((s) => s.status === "fulfilled");
    assertEquals(started.length, 2);
    for (const failed of settled.filter((s) => s.status === "rejected")) {
      await rejectsWith(Promise.reject(failed.reason), "too_many_processes");
    }
    for (const one of started) {
      const { id } = (one as PromiseFulfilledResult<{ id: string }>).value;
      assertEquals((await sandbox.getProcess(id)).status, "running");
    }
  }, { settings: { maxProcesses: 2, logPollInterval: "20ms" } }));

Deno.test("foreground commands count against the limit too", () =>
  withSandbox(async ({ sandbox }) => {
    const slow = sandbox.exec(["sleep", "1"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sandbox.startProcess(["sleep", "30"]);
    await rejectsWith(sandbox.exec(["true"]), "too_many_processes");
    await rejectsWith(
      sandbox.startProcess(["sleep", "30"]),
      "too_many_processes",
    );
    assertEquals((await slow).exitCode, 0);
    assertEquals((await sandbox.exec(["true"])).exitCode, 0);
  }, { settings: { maxProcesses: 2, logPollInterval: "20ms" } }));

Deno.test("a start that fails gives its slot back", () =>
  withSandbox(async ({ sandbox }) => {
    await rejectsWith(
      sandbox.startProcess(["true"], { cwd: "no/such/dir" }),
      "not_directory",
    );
    const started = await sandbox.startProcess(["sleep", "30"]);
    assertEquals(started.status, "running");
  }, { settings: { maxProcesses: 1, logPollInterval: "20ms" } }));

// DB-SBX-014: the state files POLL reads are written by the sandbox's own
// user, so a command can forge them. Anything that is not a well-formed
// status now makes the record `lost`, never a number like NaN.
Deno.test("forged process state files make the record lost", () =>
  withSandbox(async ({ sandbox, root }) => {
    const started = await sandbox.startProcess(["true"]);
    const exit = `${root}/state/proc/${started.id}/exit`;
    for (let i = 0; i < 250; i++) {
      if (await Deno.stat(exit).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Deno.writeTextFile(exit, "not-a-status\n");
    const info = await sandbox.getProcess(started.id);
    assertEquals([info.status, info.exitCode], ["lost", null]);
  }, fast));
