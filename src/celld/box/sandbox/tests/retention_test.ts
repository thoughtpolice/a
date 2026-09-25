// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-SBX-006: what the object keeps is bounded: finished process records
// (a ring with a TTL), their output directories, sessions and stream
// tickets, and nothing scans the whole history on a hot path.

import { assert, assertEquals } from "@celld/core/assert";
import type { ProcessInfo, ProcessList } from "@celld/box/sandbox";
import { rejectsWith, withSandbox } from "./fixture.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("finished records are kept in a ring of the newest", () =>
  withSandbox(async ({ sandbox }) => {
    const done: ProcessInfo[] = [];
    for (let i = 0; i < 5; i++) {
      const started = await sandbox.startProcess(["true"]);
      done.push(await sandbox.waitForExit(started.id));
    }
    const listed = await sandbox.listProcesses();
    assertEquals(
      listed.processes.map((p) => p.id),
      done.slice(2).map((p) => p.id),
    );
    await rejectsWith(sandbox.getProcess(done[0].id), "no_such_process");
    assertEquals((await sandbox.getProcess(done[4].id)).status, "exited");
  }, { settings: { maxFinishedRecords: 3, logPollInterval: "20ms" } }));

Deno.test("finished records expire, and the alarm is set for them", () =>
  withSandbox(async ({ sandbox, state }) => {
    const started = await sandbox.startProcess(["true"]);
    const done = await sandbox.waitForExit(started.id);
    const endedAt = Date.parse(done.endedAt!);
    assert(state.alarm !== null && state.alarm <= endedAt + 300, "no alarm");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await sandbox.alarm();
    await rejectsWith(sandbox.getProcess(started.id), "no_such_process");
  }, { settings: { recordTtlMs: 300, logPollInterval: "20ms" } }));

Deno.test("a purge alarm survives stopping the container", () =>
  withSandbox(async ({ sandbox, state }) => {
    const started = await sandbox.startProcess(["true"]);
    const done = await sandbox.waitForExit(started.id);
    await sandbox.stop();
    assertEquals(state.alarm, Date.parse(done.endedAt!) + 3_600_000);
  }, { settings: { recordTtlMs: 3_600_000, logPollInterval: "20ms" } }));

Deno.test("deleteProcess removes a finished record and refuses a running one", () =>
  withSandbox(async ({ sandbox }) => {
    const running = await sandbox.startProcess(["sleep", "30"]);
    await rejectsWith(sandbox.deleteProcess(running.id), "invalid");
    await sandbox.killProcess(running.id, "KILL");
    // The kill is asynchronous: under load the record can still read
    // `running` when killProcess returns, so wait for the exit before
    // deleting it (the flake WP-14 recorded).
    await sandbox.waitForExit(running.id);
    await sandbox.deleteProcess(running.id);
    await rejectsWith(sandbox.getProcess(running.id), "no_such_process");
    await rejectsWith(sandbox.deleteProcess(running.id), "no_such_process");
    assertEquals((await sandbox.listProcesses()).processes, []);
  }, { settings: { logPollInterval: "20ms" } }));

Deno.test("output directories go once the tail is kept", () =>
  withSandbox(async ({ sandbox, root }) => {
    const started = await sandbox.startShellProcess("echo kept; echo too >&2");
    assert(await exists(`${root}/state/proc/${started.id}`), "no directory");
    await sandbox.waitForExit(started.id);
    assertEquals(await exists(`${root}/state/proc/${started.id}`), false);
    const logs = await sandbox.getProcessLogs(started.id);
    assertEquals([logs.stdout, logs.stderr], ["kept\n", "too\n"]);
  }, { settings: { logPollInterval: "20ms" } }));

Deno.test("listProcesses pages with a cursor", () =>
  withSandbox(async ({ sandbox }) => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await sandbox.startProcess(["true"])).id);
    }
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    do {
      const page: ProcessList = await sandbox.listProcesses({
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      assert(page.processes.length <= 2, "a page is too long");
      seen.push(...page.processes.map((p) => p.id));
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== null);
    assertEquals([seen, pages], [ids, 3]);
    await rejectsWith(sandbox.listProcesses({ limit: 0 }), "invalid");
    await rejectsWith(sandbox.listProcesses({ cursor: "../x" }), "invalid");
  }, { settings: { logPollInterval: "20ms" } }));

Deno.test("starting a process does not scan finished records", () =>
  withSandbox(async ({ sandbox, state }) => {
    for (let i = 0; i < 4; i++) {
      await sandbox.waitForExit((await sandbox.startProcess(["true"])).id);
    }
    const list = state.kv.list.bind(state.kv);
    const prefixes: string[] = [];
    state.kv.list = <T>(options?: DurableObjectListOptions) => {
      prefixes.push(options?.prefix ?? "");
      return list<T>(options);
    };
    await sandbox.startProcess(["sleep", "30"]);
    await sandbox.exec(["true"]);
    assertEquals(
      prefixes.filter((prefix) => prefix.startsWith("celld.sandbox/process")),
      [],
    );
  }, { settings: { logPollInterval: "20ms" } }));

// DB-SBX-012: createSession replaced an existing id silently (and the
// replacement did not count against maxSessions).
Deno.test("createSession refuses an existing id; updateSession changes one", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.createSession({ id: "a", env: { X: "1" } });
    await rejectsWith(
      sandbox.createSession({ id: "a", env: { X: "2" } }),
      "exists",
    );
    assertEquals((await sandbox.listSessions())[0].env, { X: "1" });
    await sandbox.mkdir("sub");
    const updated = await sandbox.updateSession("a", {
      cwd: "sub",
      env: { X: "3" },
    });
    assertEquals(updated, { id: "a", cwd: "sub", env: { X: "3" } });
    const kept = await sandbox.updateSession("a", { env: { Y: "4" } });
    assertEquals(kept, { id: "a", cwd: "sub", env: { Y: "4" } });
    await rejectsWith(sandbox.updateSession("zz", {}), "no_such_session");
    await rejectsWith(
      sandbox.updateSession("a", { cwd: "../x" }),
      "outside_workspace",
    );
    await sandbox.createSession({ id: "b" });
    await rejectsWith(sandbox.createSession({ id: "b" }), "exists");
    await rejectsWith(sandbox.createSession({ id: "c" }), "too_many_sessions");
  }, { settings: { maxSessions: 2 } }));

Deno.test("sessions are capped", () =>
  withSandbox(async ({ sandbox }) => {
    await sandbox.createSession({ id: "a" });
    await sandbox.createSession({ id: "b" });
    await rejectsWith(sandbox.createSession({ id: "c" }), "too_many_sessions");
    await sandbox.deleteSession("a");
    await sandbox.createSession({ id: "c" });
  }, { settings: { maxSessions: 2 } }));

Deno.test("open stream tickets are capped and expired ones purged", () =>
  withSandbox(async ({ sandbox, state }) => {
    const first = await sandbox.openStream({ kind: "exec", argv: ["true"] });
    await sandbox.openStream({ kind: "exec", argv: ["true"] });
    await rejectsWith(
      sandbox.openStream({ kind: "exec", argv: ["true"] }),
      "too_many_streams",
    );
    await (await sandbox.stream(first, null)).body!.cancel();
    const again = await sandbox.openStream({ kind: "exec", argv: ["true"] });
    // Tickets past their time are purged by the alarm.
    for (const [key, value] of [...state.kv.map]) {
      if (key.startsWith("celld.sandbox/ticket/")) {
        state.kv.put(key, { ...(value as object), expires: Date.now() - 1 });
      }
    }
    await sandbox.alarm();
    assertEquals(
      [...state.kv.map.keys()].filter((key) =>
        key.startsWith("celld.sandbox/ticket/")
      ),
      [],
    );
    await rejectsWith(sandbox.stream(again, null), "bad_ticket");
  }, { settings: { maxOpenTickets: 2 } }));
