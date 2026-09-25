// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The exact argv, user and environment the sandbox hands to celld's exec,
// with a scripted container that runs nothing.

import { assert, assertEquals } from "@celld/assert";
import { ContainerController } from "@celld/container";
import {
  type ExecCall,
  FakeContainer,
  FakeState,
} from "@celld/container/testing";
import { SandboxCore } from "@celld/sandbox";
import { rejectsWith } from "./fixture.ts";

function scripted(
  answer: (call: ExecCall) => { stdout?: string; exitCode?: number } | null =
    () => ({}),
) {
  const container = new FakeContainer({ exec: (call) => answer(call) ?? {} });
  const state = new FakeState(container);
  const sandbox = new SandboxCore(
    new ContainerController(state),
    state.kv,
    {},
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
  assertEquals(state.argv.slice(-1), ["/tmp/.celld-sandbox/proc"]);
  assertEquals(exec.options.user, "1000:1000");
  assertEquals(exec.options.cwd, "/workspace");
  assertEquals(exec.options.env, undefined);
  assertEquals(exec.argv, [
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/workspace",
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

Deno.test("gitCheckout clones https only, shallow, with no prompts", async () => {
  const { container, sandbox } = scripted();
  await sandbox.gitCheckout("https://example.com/org/repo.git", {
    branch: "v1.2",
  });
  const call = container.execs[2];
  assert(call.argv.includes("GIT_TERMINAL_PROMPT=0"), call.argv.join(" "));
  assertEquals(call.argv.slice(call.argv.indexOf("git")), [
    "git",
    "clone",
    "--depth",
    "1",
    "--branch",
    "v1.2",
    "--",
    "https://example.com/org/repo.git",
    "/workspace/repo",
  ]);
  for (
    const url of [
      "file:///etc",
      "ext::sh -c touch% /tmp/pwned",
      "git@example.com:org/repo.git",
      "http://example.com/repo",
      "https://example.com/--upload-pack=evil",
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
    ]
  ) {
    let threw = false;
    try {
      new SandboxCore(new ContainerController(state), state.kv, settings);
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(settings));
  }
});
