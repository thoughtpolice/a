// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The exact argv, user and environment the sandbox hands to celld's exec,
// with a scripted container that runs nothing.

import { assert, assertEquals } from "@celld/core/assert";
import { ContainerController } from "@celld/box/container";
import {
  type ExecCall,
  FakeContainer,
  FakeState,
} from "@celld/box/container/testing";
import { SandboxCore, type SandboxSettings } from "@celld/box/sandbox";
import { rejectsWith } from "./fixture.ts";

function scripted(
  answer: (call: ExecCall) => { stdout?: string; exitCode?: number } | null =
    () => ({}),
  settings: Partial<SandboxSettings> = {},
) {
  const container = new FakeContainer({ exec: (call) => answer(call) ?? {} });
  const state = new FakeState(container);
  const sandbox = new SandboxCore(
    new ContainerController(state),
    state.kv,
    { tier: "trusted", ...settings },
    () => "01J0000000000000000000000A",
  );
  return { container, sandbox };
}

Deno.test("defaults: setup as root, then everything as 1000:1000 in /workspace", async () => {
  const { container, sandbox } = scripted();
  await sandbox.exec(["make", "test"], { env: { CI: "1" } });
  const [setup, state, exec] = container.execs;
  assertEquals(setup.options.user, "0");
  assertEquals(setup.argv.slice(0, 2), ["/usr/bin/env", "-i"]);
  assertEquals(setup.argv.slice(-2), ["1000:1000", "/workspace"]);
  assertEquals(state.options.user, "1000:1000");
  assertEquals(state.argv.slice(-3), [
    "/tmp/.celld-sandbox/proc",
    "/tmp/.celld-sandbox/run",
    "/tmp/.celld-sandbox/home",
  ]);
  assertEquals(exec.options.user, "1000:1000");
  assertEquals(exec.options.cwd, "/workspace");
  assertEquals(exec.options.env, undefined);
  // The process-group wrapper (RUN) starts from a clean environment too,
  // and runs the command's own `env -i` argv.
  assertEquals(exec.argv.slice(0, 2), ["/usr/bin/env", "-i"]);
  const run = exec.argv.indexOf("celld-sandbox");
  assert(
    exec.argv[run + 1].startsWith("/tmp/.celld-sandbox/run/"),
    exec.argv[run + 1],
  );
  assertEquals(exec.argv[run + 2], "0");
  // Rewritten with the group-kill fix: RUN now also takes the shell that
  // records the group id before the command execs.
  assertEquals(exec.argv[run + 3], "/bin/sh");
  assertEquals(exec.argv.slice(run + 4), [
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/tmp/.celld-sandbox/home",
    "LANG=C.UTF-8",
    "CI=1",
    "make",
    "test",
  ]);
  assertEquals(container.starts[0].enableInternet, false);
});

Deno.test("setup runs once per container start", async () => {
  const { container, sandbox } = scripted();
  await sandbox.exec(["true"]);
  await sandbox.exec(["true"]);
  assertEquals(container.execs.length, 4);
  container.crash();
  await sandbox.exec(["true"]);
  assertEquals(container.execs.length, 7);
  assertEquals(container.execs[4].options.user, "0");
});

// DB-SBX-008: gitCheckout used to run `git clone` on the unresolved target
// with the sandbox's environment and the ambient configuration. This test
// asserted that argv; it now asserts the pinned clone script and the
// configuration-free environment. (DB-REV-OAI-2 and DB-REV-SBX-6 added the
// symbolic-link policy and the claim file to the script's arguments, and
// `core.symlinks=false` to the flags.)
Deno.test("gitCheckout clones https only, shallow, with no ambient configuration", async () => {
  const { container, sandbox } = scripted();
  await sandbox.setEnvVars({ GIT_CONFIG_GLOBAL: "/workspace/evil" });
  await sandbox.gitCheckout("https://example.com/org/repo.git", {
    branch: "v1.2",
  });
  const call = container.execs[2];
  const argv = call.argv;
  for (
    const variable of [
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_ALLOW_PROTOCOL=https",
      "HOME=/tmp/.celld-sandbox/home",
    ]
  ) {
    assert(argv.includes(variable), `${variable} in ${argv.join(" ")}`);
  }
  assert(!argv.includes("GIT_CONFIG_GLOBAL=/workspace/evil"), "sandbox env");
  const script = argv[argv.lastIndexOf("-c") + 1];
  for (
    const flag of [
      "protocol.allow=never",
      "protocol.https.allow=always",
      "core.hooksPath=/dev/null",
      "credential.helper=",
      "http.followRedirects=false",
      "--template=",
      "core.symlinks=false",
    ]
  ) {
    assert(script.includes(flag), flag);
  }
  const args = argv.slice(argv.lastIndexOf("-c") + 2);
  assertEquals(args.slice(0, 7), [
    "celld-sandbox",
    "/workspace",
    "/workspace/repo",
    "https://example.com/org/repo.git",
    "1",
    "v1.2",
    "0",
  ]);
  assert(
    /^\/tmp\/\.celld-sandbox\/run\/clone-[a-z2-7]{20}$/.test(args[7]),
    args[7],
  );
  assertEquals(args.length, 8);
  for (
    const url of [
      "file:///etc",
      "ext::sh -c touch% /tmp/pwned",
      "git@example.com:org/repo.git",
      "http://example.com/repo",
      "https://example.com/--upload-pack=evil",
      "https://127.0.0.1/repo",
      "https://metadata.localhost/repo",
    ]
  ) {
    await rejectsWith(sandbox.gitCheckout(url), "invalid");
  }
  await rejectsWith(
    sandbox.gitCheckout("https://example.com/r", { branch: "--exec=x" }),
    "invalid",
  );
  await rejectsWith(
    sandbox.gitCheckout("https://example.com/r", { targetDir: "../out" }),
    "outside_workspace",
  );
});

Deno.test("script failures map to codes, unknown ones to command_failed", async () => {
  let status = 93;
  const { sandbox } = scripted((call) =>
    call.argv.includes("celld-sandbox") && call.options.user !== "0"
      ? { exitCode: status, stdout: "" }
      : null
  );
  await rejectsWith(sandbox.readFile("x"), "not_found");
  status = 42;
  await rejectsWith(sandbox.readFile("x"), "command_failed");
});

Deno.test("settings are checked", () => {
  const state = new FakeState(new FakeContainer());
  for (
    const settings of [
      { workspace: "relative" },
      { workspace: "/" },
      { stateDir: "/a/../b" },
      { maxOutputBytes: 0 },
      { shell: [] },
      { baseEnv: { "BAD-NAME": "x" } },
      { execTimeout: "whenever" },
      // DB-SBX-013: every setting has an upper bound, and durations are
      // strings (a number's unit is ambiguous).
      { execTimeout: 30 as unknown as string },
      { execTimeout: "   " },
      { execTimeout: "2h", maxExecTimeout: "1h" },
      { maxExecTimeout: "2d" },
      { maxOutputBytes: 2 ** 40 },
      { maxOutputBytes: 64 * 1024 * 1024, outputLimitBytes: 16 * 1024 * 1024 },
      { outputLimitBytes: 2 ** 40 },
      { maxFileBytes: 2 ** 40 },
      { maxStreamFileBytes: 2 ** 50 },
      { maxProcesses: 1_000_000 },
      { processLogBytes: 2 ** 40 },
      { keptLogBytes: 64 * 1024 * 1024 },
      { maxStdinBytes: 2 ** 40 },
      { maxTicketBytes: 2 ** 40 },
      { maxFinishedRecords: 1_000_000 },
      { recordTtlMs: 1e12 },
      { recordTtlMs: Infinity },
      { maxSessions: 1_000_000 },
      { maxOpenTickets: 1_000_000 },
      { previewTokenTtlMs: 31 * 86_400_000 },
      { logPollInterval: "0ms" },
      { logPollInterval: "1h" },
      { maxStream: "30d" },
      { maxArgvBytes: 0.5 },
    ]
  ) {
    let threw = false;
    try {
      new SandboxCore(new ContainerController(state), state.kv, {
        tier: "trusted",
        ...settings,
      });
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(settings));
  }
});

// DB-SBX-014: a non-stream read checked the size and then read by name in
// a separate step; a file that grew in between came back longer than the
// limit, and nothing said so. The read is one bounded read of the opened
// file, and a cut is reported.
Deno.test("readFile reads once, bounded, and reports a cut", async () => {
  const { container, sandbox } = scripted(
    (call) =>
      call.argv.includes("/workspace/grows.txt")
        ? { stdout: "a".repeat(101) }
        : null,
    { maxFileBytes: 100 },
  );
  const read = await sandbox.readFile("grows.txt");
  assertEquals(read.truncated, true);
  assertEquals(read.size, 100);
  assertEquals((read.content as string).length, 100);
  const call = container.execs.find((one) =>
    one.argv.includes("/workspace/grows.txt")
  )!;
  // The limit reaches the script, which reads at most one byte past it.
  assertEquals(call.argv[call.argv.length - 1], "100");
  const script = call.argv[call.argv.lastIndexOf("-c") + 1];
  assert(script.includes("head -c"), "a bounded read");
  assert(
    !/\bcat\b/.test(script.split("opened 3")[1] ?? ""),
    "no cat after the check",
  );
});

// Filed by the openai adoption fixer: busybox grep compiles a pattern only
// once it has a line to match. The pattern check grepped an empty input
// (`/dev/null`), so `[` passed it, every grep of the search then failed
// (status 2, silenced by `-s`), and the search answered "no matches".
Deno.test("searchFiles refuses a pattern grep cannot compile, even on busybox", async () => {
  let check = 1;
  let search = 1;
  const checks: string[] = [];
  const searches: (readonly string[])[] = [];
  const { sandbox } = scripted((call) => {
    const script = call.argv.find((arg) => arg.includes('grep -E -e "$1"'));
    if (script !== undefined && !script.includes("exec find")) {
      checks.push(script);
      return { exitCode: check };
    }
    if (call.argv.some((arg) => arg.includes("exec find . -mindepth 1"))) {
      searches.push(call.argv);
      return { exitCode: search };
    }
    return null;
  });
  // A valid pattern with no hits is no matches.
  assertEquals(
    await sandbox.searchFiles("nothing", { regex: true }),
    { matches: [], truncated: false },
  );
  // The check gives grep one line to match, never an empty input.
  assertEquals(checks.length, 1);
  assert(checks[0].includes("<<"), checks[0]);
  assert(!/-e "\$1" \/dev\/null/.test(checks[0]), checks[0]);
  // A check that fails to compile is `invalid`, and nothing is searched.
  check = 2;
  await rejectsWith(sandbox.searchFiles("[", { regex: true }), "invalid");
  assertEquals(searches.length, 1);
  // The search checks the pattern on one line itself (89): a grep that
  // cannot compile it there is `invalid` too, never "no matches".
  check = 1;
  search = 89;
  await rejectsWith(sandbox.searchFiles("[", { regex: true }), "invalid");
  const script = searches[1][searches[1].lastIndexOf("-c") + 1];
  assert(script.includes("exit 89"), script);
});

Deno.test("searchFiles with noFollow hands the script the relative path", async () => {
  const searches: (readonly string[])[] = [];
  const { sandbox } = scripted((call) => {
    if (call.argv.some((arg) => arg.includes("exec find . -mindepth 1"))) {
      searches.push(call.argv);
      return { exitCode: 1 };
    }
    return null;
  });
  await sandbox.searchFiles("x", { path: "a/b", noFollow: true });
  await sandbox.searchFiles("x", { path: "a/b" });
  const args = (argv: readonly string[]) =>
    argv.slice(argv.lastIndexOf("-c") + 2);
  assertEquals(args(searches[0]), [
    "celld-sandbox",
    "/workspace",
    "/workspace/a/b",
    "fixed",
    "1",
    "0",
    "x",
    "1",
    "a/b",
  ]);
  assertEquals(args(searches[1]).length, 7);
});
