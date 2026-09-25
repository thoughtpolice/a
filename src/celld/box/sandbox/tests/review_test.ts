// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Regressions for the adversarial review of the sandbox (WP-16). Each test
// names its finding (DB-REV-SBX-<n>) and fails on the code the review read.

import { assert, assertEquals } from "@celld/core/assert";
import { ContainerController } from "@celld/box/container";
import {
  type ExecCall,
  FakeContainer,
  FakeState,
  ManualClock,
  type ScriptedExec,
} from "@celld/box/container/testing";
import {
  parseSSEStream,
  resolveSettings,
  runRaw,
  SandboxCore,
  type SandboxEvent,
  type SandboxSettings,
} from "@celld/box/sandbox";
import { eventually, rejectsWith, withSandbox } from "./fixture.ts";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Which of the sandbox's constant scripts an exec runs, by a line only
// that script has.
const SCRIPT_MARKS = {
  spawnUndo: 'exec 3<> "$f"',
  spawn: 'mkfifo "$d/o"',
  poll: "echo missing",
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
  settings: Partial<SandboxSettings> = {},
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
    { tier: "trusted", ...settings },
    () => `01J00000000000000000000${String(n++).padStart(3, "0")}`,
  );
  return { container, state, controller, sandbox };
}

// A directory of links to every program on PATH but the ones named, and
// the settings that make it a local sandbox's PATH.
async function pathWithout(...missing: string[]) {
  const bin = await Deno.realPath(await Deno.makeTempDir());
  for (const dir of ("/usr/local/bin:/usr/bin:/bin").split(":")) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (missing.includes(entry.name)) continue;
      try {
        await Deno.symlink(`${dir}/${entry.name}`, `${bin}/${entry.name}`);
      } catch {
        // An earlier directory of PATH has it.
      }
    }
  }
  return bin;
}

// A directory holding shims (name to script body), ahead of PATH.
async function shims(files: Record<string, string>) {
  const bin = await Deno.realPath(await Deno.makeTempDir());
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${body}`);
    await Deno.chmod(`${bin}/${name}`, 0o755);
  }
  return bin;
}

function onPath(bin: string, rest = "/usr/local/bin:/usr/bin:/bin") {
  return {
    baseEnv: {
      PATH: rest === "" ? bin : `${bin}:${rest}`,
      HOME: `${bin}/home`,
      LANG: "C.UTF-8",
    },
  };
}

function realProgram(name: string): string {
  const out = new Deno.Command("sh", { args: ["-c", `command -v ${name}`] })
    .outputSync();
  return new TextDecoder().decode(out.stdout).trim();
}

async function killPidsIn(file: string) {
  const pids = await Deno.readTextFile(file).catch(() => "");
  for (const pid of pids.trim().split("\n").filter(Boolean)) {
    try {
      Deno.kill(Number(pid), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// MARK: SBX-1

// DB-REV-SBX-1: runRaw checked the signal before `container.exec()` and
// added its listener after; an abort in between (the engine starting the
// process) never fired, and the command ran to its deadline.
Deno.test("DB-REV-SBX-1: an abort while the engine starts the command is not lost", async () => {
  let killHook = 0;
  let killed = false;
  let exit!: (code: number) => void;
  const container = {
    exec: async () => {
      await sleep(50);
      return {
        pid: 42,
        stdin: null,
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        exitCode: new Promise<number>((resolve) => (exit = resolve)),
        kill: () => {
          killed = true;
          exit(137);
        },
      };
    },
  };
  const abort = new AbortController();
  setTimeout(() => abort.abort(new Error("cancel")), 10);
  const started = Date.now();
  const result = await runRaw(container as never, ["x"], {
    timeoutMs: 1500,
    maxOutputBytes: 10,
    signal: abort.signal,
    kill: () => {
      killHook += 1;
      return Promise.resolve();
    },
    drainMs: 10,
  });
  assertEquals(
    [result.cancelled, result.timedOut, killHook, killed],
    [true, false, 1, true],
  );
  assert(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

Deno.test("DB-REV-SBX-1: cancel(token) during a slow engine start ends the command", async () => {
  const { sandbox } = scripted(async (call) => {
    if (scriptOf(call) !== "run") return null;
    await sleep(200);
    return { delayMs: 60_000 };
  });
  await sandbox.ready();
  const started = Date.now();
  const running = sandbox.exec(["sleep", "60"], {
    cancelToken: "slow-engine-start-0001",
    timeoutMs: 20_000,
  });
  running.catch(() => {});
  await sleep(50);
  assertEquals(await sandbox.cancel("slow-engine-start-0001"), true);
  await rejectsWith(running, "cancelled");
  assert(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

// MARK: SBX-3

// DB-REV-SBX-3: a preview request whose token was checked before
// destroy() waited in ready(), and once any call restarted the sandbox it
// was forwarded to the next generation's port with its revoked token.
Deno.test("DB-REV-SBX-3: a preview request in flight across destroy() is a 404", async () => {
  const { sandbox, container, controller } = scripted(() => null);
  let reached = 0;
  container.ports.set(8080, () => {
    reached += 1;
    return new Response("app");
  });
  await sandbox.ready();
  const { token } = await sandbox.exposePort(8080);
  const before = controller.generation;
  const inflight = sandbox.previewFetch(
    8080,
    token,
    new Request("http://x/"),
  );
  await sandbox.destroy();
  setTimeout(() => {
    sandbox.ready().catch(() => {});
  }, 300);
  const response = await inflight;
  assertEquals(response.status, 404);
  assertEquals(reached, 0);
  await eventually(() => Promise.resolve(controller.generation > before));
  await sleep(100);
  assertEquals(reached, 0);
  await container.destroy();
});

// The same after the last check: a preview request held inside the
// controller's own awaits (its alarm bookkeeping, here) while destroy() and
// a restart run must not be dispatched to the next generation's port. The
// token and generation are checked again with no await before dispatch.
Deno.test("DB-REV-SBX-3: a preview request held after its last check never reaches the next generation", async () => {
  const { sandbox, container, state } = scripted(() => null);
  await sandbox.ready();
  const exposed = await sandbox.exposePort(8080);
  container.ports.set(8080, () => new Response("old tenant"));
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number | null>();
  const original = state.storage.getAlarm;
  let calls = 0;
  state.storage.getAlarm = () => {
    if (++calls === 2) {
      reached.resolve();
      return release.promise;
    }
    return original();
  };
  const pending = sandbox.previewFetch(
    8080,
    exposed.token,
    new Request("https://preview.example/"),
  );
  await reached.promise;
  await sandbox.destroy();
  await sandbox.ready();
  let replaced = 0;
  container.ports.set(8080, () => {
    replaced += 1;
    return new Response("new tenant secret");
  });
  release.resolve(state.alarm);
  const response = await pending;
  assertEquals(response.status, 404);
  assertEquals(await response.text(), "not found");
  assertEquals(replaced, 0);
  assertEquals(await sandbox.getExposedPorts(), []);
  await sandbox.destroy();
});

Deno.test("DB-REV-SBX-3: a command waiting across destroy() never runs in the next generation", async () => {
  let setups = 0;
  let runs = 0;
  const { sandbox, container } = scripted(async (call) => {
    if (call.options.user === "0") {
      setups += 1;
      // The first preparation is slow; destroy() lands during it.
      if (setups === 1) await sleep(300);
    }
    if (scriptOf(call) === "run") runs += 1;
    return null;
  });
  const running = sandbox.exec(["true"]);
  running.catch(() => {});
  await sleep(100);
  await sandbox.destroy();
  setTimeout(() => {
    sandbox.ready().catch(() => {});
  }, 50);
  await rejectsWith(running, "cancelled");
  await sleep(200);
  assertEquals(runs, 0);
  await container.destroy();
});

// MARK: SBX-4

// DB-REV-SBX-4: without `setsid` in the image, RUN fell back to running
// the command in the wrapper's group and KILLRUN killed its first process
// only, while the call reported the whole group dead.
Deno.test("DB-REV-SBX-4: an image without setsid is refused before any command runs", async () => {
  const bin = await pathWithout("setsid");
  try {
    await withSandbox(async ({ sandbox, workspace }) => {
      await rejectsWith(
        sandbox.execShell("echo ran > ran"),
        "unsupported_image",
      );
      await rejectsWith(
        sandbox.startShellProcess("echo ran > ran2"),
        "unsupported_image",
      );
      assertEquals(await exists(`${workspace}/ran`), false);
      assertEquals(await exists(`${workspace}/ran2`), false);
    }, { settings: onPath(bin, "") });
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});

// MARK: SBX-5

// DB-REV-SBX-5: LOGGREP checked the pattern with a grep that was a child
// of its shell; the deadline killed the shell only, and a pattern slow to
// compile kept that grep running after waitForLog returned. (The shim
// knows the check by its argv: the pattern alone, with its line on stdin.)
Deno.test("DB-REV-SBX-5: the pattern check of a regex waitForLog dies at the deadline", async () => {
  const real = realProgram("grep");
  const bin = await shims({
    grep:
      `case "$*" in "-E -e r.ady") echo $$ >> "$(dirname "$0")/pids"; exec sleep 30;; esac\nexec "${real}" "$@"\n`,
  });
  try {
    await withSandbox(async ({ sandbox }) => {
      const server = await sandbox.startShellProcess("echo ready; sleep 30");
      await sandbox.waitForLog(server.id, "ready", { timeoutMs: 10_000 });
      const found = await sandbox.waitForLog(server.id, "r.ady", {
        regex: true,
        timeoutMs: 500,
      });
      assertEquals(found.matched, false);
      const pids = (await Deno.readTextFile(`${bin}/pids`)).trim().split("\n")
        .map(Number);
      assert(pids.length > 0, "the check ran");
      await eventually(async () => {
        for (const pid of pids) if (await alive(pid)) return false;
        return true;
      }, 3_000).catch(() => {
        throw new Error(`the pattern check outlived waitForLog: ${pids}`);
      });
      await sandbox.killProcess(server.id, "KILL");
    }, { settings: { logPollInterval: "20ms", ...onPath(bin) } });
  } finally {
    await killPidsIn(`${bin}/pids`);
    await Deno.remove(bin, { recursive: true });
  }
});

// MARK: SBX-6

// DB-REV-SBX-6: a clone killed by its deadline or a cancellation left the
// directory it had created (the group kill ended the script before its
// `rm -rf`), and a retry to the same target failed with `exists`.
Deno.test("DB-REV-SBX-6: a cancelled or timed-out clone leaves no directory", async () => {
  const bin = await shims({
    git: `echo $$ >> "$(dirname "$0")/pids"\nexec sleep 30\n`,
  });
  try {
    await withSandbox(async ({ sandbox, workspace }) => {
      const stop = new AbortController();
      const cloning = sandbox.gitCheckout(
        "https://example.invalid/org/repo.git",
        { signal: stop.signal },
      );
      await eventually(async () =>
        (await Deno.readTextFile(`${bin}/pids`).catch(() => "")) !== ""
      );
      assert(await exists(`${workspace}/repo`), "the clone made its target");
      stop.abort(new Error("the caller gave up"));
      await rejectsWith(cloning, "cancelled");
      assertEquals(await exists(`${workspace}/repo`), false);
      const late = await sandbox.gitCheckout(
        "https://example.invalid/org/repo.git",
        { timeoutMs: 500 },
      );
      assertEquals(late.timedOut, true);
      assertEquals(await exists(`${workspace}/repo`), false);
      // Another caller's directory at the target is never removed.
      await Deno.mkdir(`${workspace}/repo`);
      await Deno.writeTextFile(`${workspace}/repo/keep`, "mine");
      await rejectsWith(
        sandbox.gitCheckout("https://example.invalid/org/repo.git", {
          // This tests refusal before mutation, not the deadline. Keep the
          // short timeout above for cancellation; allow loaded CI hosts to
          // start the helper that observes this already-existing directory.
          timeoutMs: 10_000,
        }),
        "exists",
      );
      assertEquals(await Deno.readTextFile(`${workspace}/repo/keep`), "mine");
    }, { settings: onPath(bin) });
  } finally {
    await killPidsIn(`${bin}/pids`);
    await Deno.remove(bin, { recursive: true });
  }
});

// MARK: SBX-7

// DB-REV-SBX-7: a stream's `error` event carried the error's detail, or
// the raw message of any other error (an engine error, a helper's stderr),
// in streams meant for browsers.
Deno.test("DB-REV-SBX-7: a stream's 5xx error event is the code and a fixed text", async () => {
  const { sandbox, container } = scripted((call) => {
    if (scriptOf(call) === "run") {
      throw new Error("engine said: /var/lib/secret-token-123");
    }
    return null;
  });
  const ticket = await sandbox.openStream({ kind: "exec", argv: ["true"] });
  const response = await sandbox.stream(ticket, null);
  const events: SandboxEvent[] = [];
  for await (const event of parseSSEStream<SandboxEvent>(response.body!)) {
    events.push(event);
  }
  const failed = events.find((event) => event.type === "error") as
    | { code: string; message: string }
    | undefined;
  assert(failed !== undefined, JSON.stringify(events));
  assertEquals(failed.code, "internal");
  assert(!failed.message.includes("secret"), failed.message);
  // A 4xx error still says what was wrong with the request.
  const bad = await sandbox.openStream({
    kind: "exec",
    argv: ["true"],
    options: { sessionId: "nobody" },
  });
  const events2: SandboxEvent[] = [];
  for await (
    const event of parseSSEStream<SandboxEvent>(
      (await sandbox.stream(bad, null)).body!,
    )
  ) {
    events2.push(event);
  }
  assertEquals(events2, [{
    type: "error",
    code: "no_such_session",
    message: "no session nobody",
  }]);
  await container.destroy();
});

// MARK: SBX-8

// DB-REV-SBX-8: a background start that failed after its command may have
// begun left the process running, untracked and uncounted.
Deno.test("DB-REV-SBX-8: a failed background start kills what it may have started", async () => {
  const { sandbox, container } = scripted(
    (call) =>
      scriptOf(call) === "spawn"
        ? { exitCode: 1, stderr: "the process did not start" }
        : null,
    { maxProcesses: 1 },
  );
  await rejectsWith(sandbox.startProcess(["sleep", "60"]), "command_failed");
  const spawn = container.execs.find((call) =>
    call.argv.some((arg) => arg.includes('mkfifo "$d/o"'))
  )!;
  const directory = spawn.argv[spawn.argv.indexOf("celld-sandbox") + 1];
  const undo = container.execs.find((call) =>
    call.argv.some((arg) => arg.includes('exec 3<> "$f"'))
  );
  assert(undo !== undefined, "the start was not undone");
  assertEquals(undo.argv[undo.argv.length - 1], directory);
  // The slot came back: the one allowed command runs.
  assertEquals((await sandbox.exec(["true"])).exitCode, 0);
  await container.destroy();
});

Deno.test("workspace preparation survives idle expiry and releases its keepalive", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<ScriptedExec>();
  let first = true;
  const container = new FakeContainer({
    exec: () => {
      if (!first) return {};
      first = false;
      entered.resolve();
      return finish.promise;
    },
  });
  const state = new FakeState(container);
  const clock = new ManualClock();
  const controller = new ContainerController(
    state,
    { sleepAfter: "4s" },
    {},
    clock,
  );
  const sandbox = new SandboxCore(controller, state.kv, { tier: "trusted" });
  const preparing = sandbox.ready();
  try {
    await entered.promise;
    clock.advance(5_000);
    await controller.alarm();
    assertEquals(container.running, true);
    finish.resolve({});
    await preparing;
    clock.advance(3_999);
    await controller.alarm();
    assertEquals(container.running, true);
    clock.advance(1);
    await controller.alarm();
    assertEquals(container.running, false);
  } finally {
    finish.resolve({});
    await preparing.catch(() => {});
    await controller.destroy();
  }
});

// MARK: SBX-10

// DB-SBX-005: a positive fixture is essential: an always-refusing probe passes
// every spoofing test. Capture the actual script without exporting an internal
// implementation detail, then replace only its kernel-log source.
Deno.test("DB-SBX-005: runtime probe accepts only a first-line gVisor boot marker", async (t) => {
  let probe = "";
  const { sandbox, container } = scripted((call) => {
    const script = call.argv.find((arg) => arg.includes("Starting gVisor"));
    if (script === undefined) return null;
    assertEquals(call.options.user, "1000:1000");
    probe = script;
    return { stdout: "other\n" };
  }, { tier: "hostile" });
  try {
    const error = await rejectsWith(sandbox.exec(["true"]), "unsafe_runtime");
    assert(error.detail.includes("could not verify gVisor"), error.detail);
    assert(!error.detail.includes("runs on another runtime"), error.detail);
    // Host distros may have both paths; the pinned BusyBox image has only
    // /bin/head. The real-container integration also checks this image layout.
    assert(
      probe.includes("/bin/head -n 1"),
      "use the pinned image's head path",
    );
    assert(
      !probe.includes("/usr/bin/head"),
      "do not assume the host image layout",
    );
    assert(
      probe.includes("/bin/dmesg"),
      "kernel-log reader must use an absolute path",
    );
    assert(
      probe.includes("/bin/grep"),
      "marker matcher must use an absolute path",
    );
    const fixtures = [
      ["canonical", "[   0.000000] Starting gVisor...\n", true],
      [
        "later boot messages",
        "[    0.000000] Starting gVisor...\n[    0.123456] Boot complete\n",
        true,
      ],
      [
        "Linux first",
        "[    0.000000] Linux version 7.0\n[    1.000000] Starting gVisor...\n",
        false,
      ],
      [
        "embedded marker",
        '[    0.000000] audit: comm="Starting gVisor..."\n',
        false,
      ],
      ["suffix", "[    0.000000] Starting gVisor... forged\n", false],
      ["not literal dots", "[    0.000000] Starting gVisorXYZ\n", false],
      ["missing timestamp", "Starting gVisor...\n", false],
      ["empty log", "", false],
    ] as const;
    for (const [name, log, accepted] of fixtures) {
      await t.step(name, async () => {
        const output = await new Deno.Command("/bin/sh", {
          args: [
            "-c",
            probe.replace("/bin/dmesg", 'printf "%s" "$1"'),
            "runtime-probe-test",
            log,
          ],
        }).output();
        assertEquals(output.code, 0);
        assertEquals(new TextDecoder().decode(output.stderr), "");
        assertEquals(
          new TextDecoder().decode(output.stdout),
          accepted ? "gvisor\n" : "other\n",
        );
      });
    }
    await t.step("unreadable kernel log fails closed", async () => {
      const output = await new Deno.Command("/bin/sh", {
        args: ["-c", probe.replace("/bin/dmesg", "false")],
      }).output();
      assertEquals(output.code, 0);
      assertEquals(new TextDecoder().decode(output.stdout), "other\n");
      assertEquals(new TextDecoder().decode(output.stderr), "");
    });
  } finally {
    await container.destroy();
  }
});

// DB-REV-SBX-10: the gVisor probe accepted a kernel log that mentioned
// "gVisor" anywhere, which a runc host with a readable log can have.
Deno.test("DB-REV-SBX-10/DB-SBX-005: PATH cannot spoof either gVisor log shape", async () => {
  const other = await shims({
    dmesg:
      `printf '%s\\n' '[    0.000000] Booting Linux on physical CPU 0x0' '[    0.000000] Linux version 7.0.0' '[    1.000000] random: crng init done' '[    2.000000] audit: comm="Starting gVisor..."' '[    3.000000] Starting gVisor...'\n`,
  });
  const gvisor = await shims({
    dmesg:
      `printf '%s\\n' '[   0.000000] Starting gVisor...' '[   0.354334] Daemonizing children...'\n`,
  });
  try {
    for (const path of [other, gvisor]) {
      await withSandbox(async ({ controller, state, root, workspace }) => {
        await rejectsWith(
          Promise.resolve().then(() =>
            resolveSettings({ tier: "hostile", ...onPath(path) })
          ),
          "invalid",
        );
        const sandbox = new SandboxCore(controller, state.kv, {
          tier: "hostile",
          workspace,
          stateDir: `${root}/state`,
          setupUser: null,
        });
        await rejectsWith(sandbox.exec(["true"]), "unsafe_runtime");
        assertEquals(controller.state().status, "stopped");
      });
    }
  } finally {
    await Deno.remove(other, { recursive: true });
    await Deno.remove(gvisor, { recursive: true });
  }
});

// MARK: Filed by the openai adoption fixer

// busybox grep compiles a pattern only once it has a line to match. The
// pattern check of `searchFiles` grepped `/dev/null`, so `[` passed it,
// every grep of the search failed (status 2, silenced by `-s`) and the
// search answered "no matches". The shim is a grep that, like busybox,
// never compiles a pattern for an empty input.
Deno.test("searchFiles refuses a bad pattern where grep compiles only on a line", async () => {
  const real = realProgram("grep");
  const bin = await shims({
    grep:
      `for a; do [ "$a" = /dev/null ] && exit 1; done\nexec "${real}" "$@"\n`,
  });
  try {
    await withSandbox(async ({ sandbox }) => {
      await sandbox.writeFile("src/a.txt", "one\n");
      await rejectsWith(sandbox.searchFiles("[", { regex: true }), "invalid");
      await rejectsWith(
        sandbox.searchFiles("a(", { regex: true, path: "src" }),
        "invalid",
      );
      assertEquals(
        await sandbox.searchFiles("n[o]thing", { regex: true }),
        { matches: [], truncated: false },
      );
      assertEquals(
        (await sandbox.searchFiles("o[n]e", { regex: true })).matches,
        [{ path: "src/a.txt", line: 1, text: "one" }],
      );
    }, { settings: onPath(bin) });
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});
