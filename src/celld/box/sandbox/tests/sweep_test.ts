// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Regressions for the sweep of the process and storage families (WP-14):
// work that outlived what reported it (F10), stored records written over
// a newer state (F12), prototype names as keys (F9) and paths or sizes
// checked in one step and used in another (F18). Each test names its
// finding (DB-SWP-F<family>-<n>).

import { assert, assertEquals } from "@celld/core/assert";
import { ContainerController } from "@celld/box/container";
import {
  type ExecCall,
  FakeContainer,
  FakeState,
  type ScriptedExec,
} from "@celld/box/container/testing";
import {
  boundedStream,
  DEFAULT_LEASE_TTL_MS,
  MAX_EXPOSED_PORTS,
  MAX_LEASES,
  previewUrl,
  readAll,
  runRaw,
  SandboxClient,
  SandboxCore,
  SandboxError,
} from "@celld/box/sandbox";
import { eventually, rejectsWith, withSandbox } from "./fixture.ts";

const fast = { settings: { logPollInterval: "20ms" } } as const;

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

// Which of the sandbox's constant scripts an exec runs, by a line only
// that script has.
const SCRIPT_MARKS = {
  spawn: 'mkfifo "$d/o"',
  poll: "echo missing",
  kill: 'kill -s "$2" -- "-$1"',
  removeDir: 'rm -rf -- "$1"',
  killRun: 'while [ ! -s "$1" ]',
  run: "exec 3<&0",
} as const;

function scriptOf(call: ExecCall): keyof typeof SCRIPT_MARKS | "other" {
  for (const [name, mark] of Object.entries(SCRIPT_MARKS)) {
    if (call.argv.some((arg) => arg.includes(mark))) {
      return name as keyof typeof SCRIPT_MARKS;
    }
  }
  return "other";
}

// A sandbox over a container that runs nothing: `answer` scripts every
// exec (setup and helpers default to success).
function scripted(
  answer: (
    call: ExecCall,
  ) => ScriptedExec | null | Promise<ScriptedExec | null>,
) {
  const container = new FakeContainer({
    exec: async (call) => (await answer(call)) ?? {},
  });
  const state = new FakeState(container);
  const controller = new ContainerController(state);
  let n = 0;
  const sandbox = new SandboxCore(
    controller,
    state.kv,
    { tier: "trusted" },
    () => `01J00000000000000000000${String(n++).padStart(3, "0")}`,
  );
  return { container, state, controller, sandbox };
}

// A promise and the function that settles it.
function gate<T = void>(): { wait: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const wait = new Promise<T>((resolve) => (open = resolve));
  return { wait, open };
}

// MARK: F10

// DB-SWP-F10-3: a command ended early (deadline, cancel) is killed through
// its process group by KILLRUN. When that kill failed or hung, the failure
// was swallowed and the call reported the command stopped while its group
// kept running. The kill is now confirmed, or the container is destroyed.
Deno.test("a command whose group kill fails does not outlive its report", async () => {
  const { container, sandbox } = scripted((call) => {
    switch (scriptOf(call)) {
      case "run":
        return { delayMs: 60_000 };
      case "killRun":
        return { exitCode: 1, stderr: "kill: operation not permitted" };
      default:
        return null;
    }
  });
  const result = await sandbox.exec(["sleep", "60"], { timeoutMs: 200 });
  assertEquals(result.timedOut, true);
  assertEquals(
    container.destroys,
    1,
    "an unconfirmed group kill destroys the container before the call returns",
  );
});

// DB-SWP-F10-4: LOGGREP ran grep as a child of its shell, and the deadline
// killed only the shell: a slow pattern kept grep running in the container
// after `waitForLog` had returned.
Deno.test("a regex waitForLog leaves no grep running after its deadline", async () => {
  const bin = await Deno.realPath(await Deno.makeTempDir());
  const real = new TextDecoder().decode(
    (await new Deno.Command("sh", { args: ["-c", "command -v grep"] })
      .output()).stdout,
  ).trim();
  // A grep that is slow on the log (not on the pattern checks against
  // /dev/null) and records its pid.
  await Deno.writeTextFile(
    `${bin}/grep`,
    `#!/bin/sh\nfor a; do [ "$a" = /dev/null ] && exec "${real}" "$@"; done\necho $$ >> "${bin}/pids"\nexec sleep 30\n`,
  );
  await Deno.chmod(`${bin}/grep`, 0o755);
  try {
    await withSandbox(async ({ sandbox }) => {
      const server = await sandbox.startShellProcess(
        "echo ready; sleep 30",
      );
      await sandbox.waitForLog(server.id, "ready", { timeoutMs: 10_000 });
      const found = await sandbox.waitForLog(server.id, "r.ady", {
        regex: true,
        timeoutMs: 500,
      });
      assertEquals(found.matched, false);
      const pids = (await Deno.readTextFile(`${bin}/pids`)).trim().split("\n")
        .map(Number);
      assert(pids.length > 0, "grep ran");
      await eventually(async () => {
        for (const pid of pids) if (await alive(pid)) return false;
        return true;
      }, 2_000).catch(() => {
        throw new Error(`grep outlived waitForLog: ${pids.join(" ")}`);
      });
      await sandbox.killProcess(server.id, "KILL");
    }, {
      settings: {
        ...fast.settings,
        baseEnv: {
          PATH: `${bin}:${"/usr/local/bin:/usr/bin:/bin"}`,
          HOME: `${bin}/home`,
          LANG: "C.UTF-8",
        },
      },
    });
  } finally {
    const pids = await Deno.readTextFile(`${bin}/pids`).catch(() => "");
    for (const pid of pids.trim().split("\n").filter(Boolean)) {
      try {
        Deno.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await Deno.remove(bin, { recursive: true });
  }
});

// DB-SWP-F10-3, the primitive: runRaw raced its kill hook against a
// two-second sleep and swallowed the hook's failure.
Deno.test("runRaw reports a kill hook that failed or hung", async () => {
  const container = new FakeContainer({ exec: () => ({ delayMs: 60_000 }) });
  container.start();
  const base = { timeoutMs: 50, maxOutputBytes: 1024 };
  const failed = await runRaw(container, ["sleep", "60"], {
    ...base,
    kill: () => Promise.reject(new Error("no")),
  });
  assertEquals([failed.timedOut, failed.contained], [true, false]);
  const contained: string[] = [];
  const hung = await runRaw(container, ["sleep", "60"], {
    ...base,
    kill: () => new Promise(() => {}),
    killMs: 100,
    contain: () => {
      contained.push("contained");
      return Promise.resolve();
    },
  });
  assertEquals([hung.timedOut, hung.contained], [true, false]);
  assertEquals(contained, ["contained"]);
  const killed = await runRaw(container, ["sleep", "60"], {
    ...base,
    kill: () => Promise.resolve(),
  });
  assertEquals([killed.timedOut, killed.contained], [true, true]);
});

// DB-SWP-F10-14: gitCheckout took no signal and no cancel token, so a clone
// could only end at its deadline (five minutes by default) while the
// caller that asked for it had long given up.
Deno.test("a gitCheckout can be cancelled", async () => {
  const bin = await Deno.realPath(await Deno.makeTempDir());
  await Deno.writeTextFile(
    `${bin}/git`,
    `#!/bin/sh\necho $$ >> "${bin}/pids"\nexec sleep 30\n`,
  );
  await Deno.chmod(`${bin}/git`, 0o755);
  try {
    await withSandbox(async ({ sandbox }) => {
      const stop = new AbortController();
      const started = Date.now();
      const cloning = sandbox.gitCheckout(
        "https://example.invalid/org/repo.git",
        { signal: stop.signal },
      );
      await eventually(async () =>
        (await Deno.readTextFile(`${bin}/pids`).catch(() => "")) !== ""
      );
      stop.abort(new Error("the caller gave up"));
      await rejectsWith(cloning, "cancelled");
      assert(Date.now() - started < 10_000, "the clone ran to its deadline");
      const pid = Number((await Deno.readTextFile(`${bin}/pids`)).trim());
      await eventually(async () => !(await alive(pid)), 3_000);
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

// MARK: F12

// DB-SWP-F12-15: the only serialization of the coding tools' mutations was
// a lane per client object and isolate, so two Workers on one sandbox could
// interleave read-modify-write sequences. The object now offers leases.
Deno.test("a lease has one holder at a time, across callers", () =>
  withSandbox(async ({ sandbox }) => {
    const first = await sandbox.acquireLease("workspace", { ttlMs: 60_000 });
    assert(first !== null, "the first caller takes it");
    assert(/^[a-z2-7]{26}$/.test(first.token), first.token);
    assertEquals(await sandbox.acquireLease("workspace"), null);
    assertEquals(
      await sandbox.releaseLease("workspace", "a".repeat(26)),
      false,
    );
    assertEquals(
      await sandbox.renewLease("workspace", "a".repeat(26)),
      null,
      "another token renews nothing",
    );
    const renewed = await sandbox.renewLease("workspace", first.token, {
      ttlMs: 120_000,
    });
    assertEquals(renewed?.token, first.token);
    assertEquals(await sandbox.releaseLease("workspace", first.token), true);
    const second = await sandbox.acquireLease("workspace");
    assert(second !== null && second.token !== first.token, "taken again");
    assertEquals(
      Date.parse(second.expiresAt) - Date.now() <= DEFAULT_LEASE_TTL_MS,
      true,
    );
    await rejectsWith(sandbox.acquireLease("bad name"), "invalid");
    await rejectsWith(
      sandbox.acquireLease("x", { ttlMs: 3_600_000 }),
      "invalid",
    );
  }));

Deno.test("a lease expires, is capped in number, and dies with destroy()", () =>
  withSandbox(async ({ sandbox }) => {
    const short = await sandbox.acquireLease("short", { ttlMs: 30 });
    assert(short !== null, "taken");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(await sandbox.renewLease("short", short.token), null);
    assert(await sandbox.acquireLease("short") !== null, "free once expired");
    for (let i = 1; i < MAX_LEASES; i++) {
      assert(await sandbox.acquireLease(`l${i}`) !== null, `lease ${i}`);
    }
    await rejectsWith(sandbox.acquireLease("one-more"), "too_many_leases");
    const held = await sandbox.acquireLease("l1");
    assertEquals(held, null);
    await sandbox.destroy();
    assert(await sandbox.acquireLease("l1") !== null, "destroy drops leases");
  }));

// DB-SWP-F12-5: killProcess read the record, awaited a refresh, and wrote
// its stale copy back: a concurrent call that had meanwhile seen the exit
// (and dropped the process's files) was overwritten, and the process ended
// up `lost` with its exit status gone and a second finished-index entry.
Deno.test("killProcess never writes back a record another call finished", async () => {
  let exited = false;
  let removed = false;
  const slowPoll = gate();
  let holdNextPoll = false;
  const { sandbox, state } = scripted(async (call) => {
    switch (scriptOf(call)) {
      case "spawn":
        return { stdout: "4242 4240\n" };
      case "poll": {
        if (holdNextPoll) {
          holdNextPoll = false;
          await slowPoll.wait;
          return { stdout: "- 0 0 0\n" };
        }
        if (removed) return { stdout: "missing\n" };
        return { stdout: exited ? "0 0 0 0\n" : "- 0 0 0\n" };
      }
      case "removeDir":
        removed = true;
        return {};
      default:
        return null;
    }
  });
  const started = await sandbox.startProcess(["server"]);
  holdNextPoll = true;
  const killing = sandbox.killProcess(started.id);
  await eventually(() => Promise.resolve(!holdNextPoll));
  exited = true;
  const seen = await sandbox.getProcess(started.id);
  assertEquals([seen.status, seen.exitCode], ["exited", 0]);
  slowPoll.open();
  const killed = await killing;
  assertEquals([killed.status, killed.exitCode], ["exited", 0]);
  assertEquals(
    [(await sandbox.getProcess(started.id)).status],
    ["exited"],
  );
  const finished = state.kv.get<[string, number][]>("celld.sandbox/finished")!;
  assertEquals(finished.map(([id]) => id), [started.id]);
});

// DB-SWP-F12-13: the finished index is built lazily from the stored
// records. #finish wrote the finished record first and built the index
// after, so the first process to end in a sandbox was indexed twice (and
// counted twice against maxFinishedRecords).
Deno.test("the first process to finish is indexed once", () =>
  withSandbox(async ({ sandbox, state }) => {
    const done = await sandbox.startProcess(["true"]);
    const ended = await sandbox.waitForExit(done.id, { timeoutMs: 10_000 });
    assertEquals(ended.status, "exited");
    const index = state.kv.get<[string, number][]>("celld.sandbox/finished")!;
    assertEquals(index.map(([id]) => id), [done.id]);
  }, fast));

// DB-SWP-F12-6: destroy() wipes the stored state first, but a startProcess
// already past its checks wrote its record (and the running index) after
// the wipe, so a destroyed sandbox listed a process again.
Deno.test("a process started across destroy() leaves no record behind", async () => {
  const spawned = gate<ScriptedExec>();
  let spawning = false;
  const { sandbox, state } = scripted((call) => {
    if (scriptOf(call) === "spawn") {
      spawning = true;
      return spawned.wait;
    }
    return null;
  });
  await sandbox.ready();
  const starting = sandbox.startProcess(["server"]);
  await eventually(() => Promise.resolve(spawning));
  await sandbox.destroy();
  spawned.open({ stdout: "4242 4240\n" });
  await rejectsWith(starting, "cancelled");
  const stored = [...state.kv.list({ prefix: "celld.sandbox/" })].map((
    [key],
  ) => key);
  assertEquals(stored, []);
});

// MARK: F9

// DB-SWP-F9-7: setEnvVars merged into a plain object, where the shell
// identifier `__proto__` is the prototype setter: the variable was
// silently dropped (and could not be removed either).
// Deno removes `Object.prototype.__proto__`, so there a plain object takes
// the name as an own key; stock V8 (and workerd) keep the Annex B accessor,
// where assigning a string to it does nothing. The accessor is put back for
// the test so both engines' behaviour is checked.
async function withProtoAccessor(body: () => Promise<void>): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, value: unknown) {
      if (typeof value === "object" || typeof value === "function") {
        Object.setPrototypeOf(this, value as object | null);
      }
    },
  });
  try {
    const probe: Record<string, unknown> = {};
    probe["__proto__"] = "text";
    assert(!Object.hasOwn(probe, "__proto__"), "the accessor is in place");
    await body();
  } finally {
    if (had === undefined) {
      delete (Object.prototype as { __proto__?: unknown }).__proto__;
    } else {
      Object.defineProperty(Object.prototype, "__proto__", had);
    }
  }
}

Deno.test("setEnvVars keeps a variable named __proto__", () =>
  withSandbox(({ sandbox }) =>
    withProtoAccessor(async () => {
      const update = JSON.parse('{"__proto__": "kept", "A": "1"}');
      const env = await sandbox.setEnvVars(update);
      assert(Object.hasOwn(env, "__proto__"), JSON.stringify(env));
      assertEquals(env["__proto__" as keyof typeof env], "kept");
      const shown = await sandbox.execShell('printf %s "$__proto__"');
      assertEquals(shown.stdout, "kept");
      const removed = await sandbox.setEnvVars(
        JSON.parse('{"__proto__": null}'),
      );
      assert(!Object.hasOwn(removed, "__proto__"), JSON.stringify(removed));
      assertEquals(Object.getPrototypeOf(removed), Object.prototype);
    })
  ));

// MARK: F18

// TERM is trapped after the foreground utility finishes. Killing only the
// shell with KILL leaves that utility racing the test directory's removal.
function swapper(dir: string, body: string): Deno.ChildProcess {
  return new Deno.Command("/bin/sh", {
    args: [
      "-c",
      `trap 'exit 0' TERM; cd "$1" && while :; do ${body}; done`,
      "swap",
      dir,
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
}

// DB-SWP-F18-8: WRITE checked the parent directory and then ran
// `mkdir -p` on its unresolved name, so a component swapped for a link in
// between made it create directories outside the workspace.
Deno.test("writeFile with createParents never creates directories outside", async () => {
  // A `mkdir` that takes a moment to start, which widens the window
  // between the check and the use of the parent directory's name.
  const bin = await Deno.realPath(await Deno.makeTempDir());
  const real = new TextDecoder().decode(
    (await new Deno.Command("sh", { args: ["-c", "command -v mkdir"] })
      .output()).stdout,
  ).trim();
  await Deno.writeTextFile(
    `${bin}/mkdir`,
    `#!/bin/sh\nsleep 0.01\nexec "${real}" "$@"\n`,
  );
  await Deno.chmod(`${bin}/mkdir`, 0o755);
  try {
    await withSandbox(async ({ sandbox, workspace, root }) => {
      await sandbox.ready();
      await Deno.mkdir(`${root}/outside`);
      await Deno.mkdir(`${workspace}/real`);
      await Deno.symlink(`${workspace}/real`, `${workspace}/d`);
      // `d` always exists: a link to a directory inside or to one outside,
      // replaced by a rename.
      const swap = swapper(
        workspace,
        `ln -s "$PWD/real" t1; mv -T t1 d; ln -s "${root}/outside" t2; mv -T t2 d`,
      );
      let written = 0;
      try {
        for (let i = 0; i < 200; i++) {
          await sandbox.writeFile(`d/n${i}/f`, "x").then(
            () => written++,
            () => {},
          );
        }
      } finally {
        swap.kill("SIGTERM");
        await swap.status;
      }
      const outside = [];
      for await (const entry of Deno.readDir(`${root}/outside`)) {
        outside.push(entry.name);
      }
      assertEquals(outside, [], "directories made outside the workspace");
      assert(written > 0, "some writes went through");
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

// DB-SWP-F18-9: RENAME resolved the source directory to a path and moved
// by that path later; a component of it swapped for a link in between
// moved a file from outside the workspace into it.
Deno.test("renameFile never moves a file in from outside", () =>
  withSandbox(async ({ sandbox, workspace, root }) => {
    await sandbox.ready();
    const count = 300;
    await Deno.mkdir(`${root}/outside`);
    await Deno.mkdir(`${workspace}/dirA`);
    for (let i = 0; i < count; i++) {
      await Deno.writeTextFile(`${root}/outside/f${i}`, "SECRET");
      await Deno.writeTextFile(`${workspace}/dirA/f${i}`, "public");
    }
    await sandbox.ready();
    const swap = swapper(
      workspace,
      `mv -T dirA hold; ln -s "${root}/outside" dirA; rm dirA; mv -T hold dirA`,
    );
    try {
      for (let i = 0; i < count; i++) {
        await sandbox.renameFile(`dirA/f${i}`, `got${i}`).catch(() => {});
      }
    } finally {
      swap.kill("SIGTERM");
      await swap.status;
    }
    let leaked = 0;
    let moved = 0;
    for (let i = 0; i < count; i++) {
      const text = await Deno.readTextFile(`${workspace}/got${i}`).catch(() =>
        null
      );
      if (text === "SECRET") leaked++;
      if (text === "public") moved++;
    }
    assertEquals(leaked, 0, "files moved in from outside");
    assert(moved > 0, "some renames went through");
  }));

// DB-SWP-F18-10: STAT reported a FIFO (or socket) by its name with
// `stat -L`, after the checks: a name swapped for a link to an outside file
// in between reported that file's size and time.
Deno.test("stat of a special file never reports an outside file", () =>
  withSandbox(async ({ sandbox, workspace, root }) => {
    await sandbox.ready();
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(`${root}/outside/big`, "S".repeat(4321));
    await new Deno.Command("mkfifo", { args: [`${workspace}/fifo`] }).output();
    await Deno.symlink(`${root}/outside/big`, `${workspace}/link`);
    await sandbox.ready();
    const swap = swapper(
      workspace,
      "mv -T fifo x; mv -T x fifo; mv -T link x; mv -T x link",
    );
    const sizes = new Map<number, number>();
    try {
      for (let i = 0; i < 400; i++) {
        try {
          const found = await sandbox.stat("x");
          sizes.set(found.size, (sizes.get(found.size) ?? 0) + 1);
        } catch {
          // Refused or missing at that moment.
        }
      }
    } finally {
      swap.kill("SIGTERM");
      await swap.status;
    }
    assertEquals(sizes.get(4321) ?? 0, 0, JSON.stringify([...sizes]));
  }));

// DB-SWP-F18-11: a streamed read sized its response by a stat of its own,
// then opened the file again to send it: the size header could describe
// another file than the bytes.
Deno.test("a streamed read's size is the size of the bytes it sends", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.ready();
    await Deno.writeTextFile(`${workspace}/small`, "s".repeat(10));
    await Deno.writeTextFile(`${workspace}/large`, "L".repeat(5000));
    await Deno.copyFile(`${workspace}/small`, `${workspace}/f`);
    await sandbox.ready();
    const swap = swapper(
      workspace,
      "cp small t1 && mv -f -T t1 f; cp large t2 && mv -f -T t2 f",
    );
    const mismatches: string[] = [];
    try {
      for (let i = 0; i < 150; i++) {
        let response: Response;
        try {
          const ticket = await sandbox.openStream({ kind: "read", path: "f" });
          response = await sandbox.stream(ticket, null);
        } catch {
          continue;
        }
        const body = await readAll(response.body!);
        const header = response.headers.get("x-celld-sandbox-size");
        if (header !== String(body.byteLength)) {
          mismatches.push(`${header} vs ${body.byteLength}`);
        }
      }
    } finally {
      swap.kill("SIGTERM");
      await swap.status;
    }
    assertEquals(mismatches, []);
  }));

// DB-SWP-F18-12: a streamed write answered with a stat taken after the
// write, which could be another writer's file.
Deno.test("a streamed write reports the bytes it wrote", () =>
  withSandbox(async ({ sandbox, workspace }) => {
    await sandbox.ready();
    await Deno.writeTextFile(`${workspace}/other`, "o".repeat(777));
    await sandbox.ready();
    const swap = swapper(workspace, "cp other t && mv -f -T t f");
    const wrong: number[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const ticket = await sandbox.openStream({ kind: "write", path: "f" });
        let answer: { size: number };
        try {
          answer = await (await sandbox.stream(
            ticket,
            new Blob(["w".repeat(123)]).stream(),
          )).json();
        } catch {
          continue;
        }
        if (answer.size !== 123) wrong.push(answer.size);
      }
    } finally {
      swap.kill("SIGTERM");
      await swap.status;
    }
    assertEquals(wrong, []);
  }));

// ----- Second round (WP-14b): findings filed by the other sweepers -----

// Whether `run` throws a RangeError (a BoundsError is one).
function rangeError(run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return error instanceof RangeError;
  }
  return false;
}

async function rejectsRange(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
  } catch (error) {
    return error instanceof RangeError;
  }
  return false;
}

// DB-SWP-F7-406: runRaw is exported, and took its numbers unchecked: a NaN
// `maxOutputBytes` turned the output cap off, and a NaN or huge
// `timeoutMs` fired the deadline at once or never. They are checked before
// anything runs.
Deno.test("DB-SWP-F7-406: runRaw refuses bad numbers before it runs", async () => {
  const container = new FakeContainer({ exec: () => ({ stdout: "x" }) });
  container.start();
  const base = { timeoutMs: 1000, maxOutputBytes: 1024 };
  for (
    const bad of [
      { timeoutMs: NaN },
      { timeoutMs: -1 },
      { timeoutMs: 2 ** 31 },
      { maxOutputBytes: NaN },
      { maxOutputBytes: Infinity },
      { maxOutputBytes: -1 },
      { maxOutputBytes: 1.5 },
      { drainMs: NaN },
      { killMs: Infinity },
    ]
  ) {
    assert(
      await rejectsRange(() =>
        runRaw(container, ["true"], { ...base, ...bad })
      ),
      JSON.stringify(bad),
    );
  }
  assertEquals(container.execs.length, 0);
  const ok = await runRaw(container, ["true"], base);
  assertEquals(ok.exitCode, 0);
});

// DB-SWP-F7-407: boundedStream took `stallMs` and `highWaterMark`
// unchecked; a NaN `stallMs` never stalled and spun on setTimeout(NaN).
Deno.test("DB-SWP-F7-407: boundedStream refuses bad options", () => {
  const produce = () => Promise.resolve();
  for (
    const bad of [
      { stallMs: NaN },
      { stallMs: -5 },
      { stallMs: 2 ** 31 },
      { highWaterMark: NaN },
      { highWaterMark: 0 },
      { highWaterMark: Infinity },
    ]
  ) {
    assert(rangeError(() => boundedStream(produce, bad)), JSON.stringify(bad));
  }
  boundedStream(produce, { stallMs: 10, highWaterMark: 1 }).cancel();
});

// DB-SWP-F1-404: the exported readAll buffered a whole stream with no cap.
Deno.test("DB-SWP-F1-404: readAll stops at its cap", async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert(
    await rejectsRange(() => readAll(endless, { maxBytes: 10_000 })),
    "past the cap",
  );
  assert(cancelled, "the stream is cancelled at the cap");
  assert(pulled < 20, `pulled ${pulled} chunks`);
  const small = new Blob([new Uint8Array(3000)]).stream();
  assertEquals((await readAll(small, { maxBytes: 3000 })).byteLength, 3000);
});

// DB-SWP-F8-409: exposePort had no cap on how many ports hold a live
// token; every one is a record in one stored value.
Deno.test("DB-SWP-F8-409: exposePort caps the live exposed ports", async () => {
  const { sandbox } = scripted(() => null);
  for (let port = 1; port <= MAX_EXPOSED_PORTS; port++) {
    await sandbox.exposePort(port);
  }
  await rejectsWith(
    sandbox.exposePort(MAX_EXPOSED_PORTS + 1),
    "too_many_ports",
  );
  // Exposing one again, or after one is revoked, still works.
  await sandbox.exposePort(1, { name: "again" });
  await sandbox.unexposePort(2);
  await sandbox.exposePort(MAX_EXPOSED_PORTS + 1);
  assertEquals((await sandbox.getExposedPorts()).length, MAX_EXPOSED_PORTS);
});

// DB-SWP-F16-13.5: `protocol: "http"` built cleartext preview URLs, which
// carry the port's token, to any host, and the client kept its options by
// reference. Cleartext is now `httpForDevelopment` for a `localhost` name
// only, and the options are copied.
Deno.test("DB-SWP-F16-13.5: preview URLs are https unless for local development", () => {
  const exposed = { port: 3000, token: "a".repeat(26) };
  const refused = (options: Record<string, unknown>) => {
    let thrown = false;
    try {
      previewUrl("box", exposed, options as { hostname: string });
    } catch (error) {
      thrown = error instanceof SandboxError && error.code === "invalid";
    }
    let constructed = false;
    try {
      new SandboxClient({} as never, "box", options);
    } catch (error) {
      constructed = error instanceof SandboxError && error.code === "invalid";
    }
    assert(thrown && constructed, `${JSON.stringify(options)} refused`);
  };
  refused({ hostname: "preview.example.com", protocol: "http" });
  refused({ hostname: "preview.example.com", httpForDevelopment: true });
  refused({ hostname: "localhost.example.com", httpForDevelopment: true });
  refused({ hostname: "preview.example.com", port: 0 });
  refused({ hostname: "preview.example.com", port: NaN });
  assertEquals(
    previewUrl("box", exposed, { hostname: "preview.example.com" }),
    `https://3000-box-${exposed.token}.preview.example.com`,
  );
  assertEquals(
    previewUrl("box", exposed, {
      hostname: "preview.localhost",
      httpForDevelopment: true,
      port: 9876,
    }),
    `http://3000-box-${exposed.token}.preview.localhost:9876`,
  );
});

Deno.test("DB-SWP-F16-13.5: the client copies its options", async () => {
  const token = "b".repeat(26);
  const stub = {
    exposePort: () =>
      Promise.resolve({
        port: 3000,
        name: null,
        token,
        createdAt: "",
        rotatedAt: null,
        expiresAt: "",
      }),
  };
  const options = { hostname: "preview.example.com" } as {
    hostname: string;
    port?: number;
  };
  const client = new SandboxClient(stub as never, "box", options);
  options.hostname = "evil.example";
  options.port = 80;
  const exposed = await client.exposePort(3000);
  assertEquals(exposed.url, `https://3000-box-${token}.preview.example.com`);
});
