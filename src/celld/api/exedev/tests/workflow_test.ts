// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  base64Decode,
  ExeClient,
  ExeInvalidRequestError,
} from "@celld/api/exedev";
import { FakeExe, fakeStep } from "@celld/api/exedev/testing";
import {
  bootstrapVm,
  provisionVm,
  verifyVm,
  waitForVm,
} from "@celld/api/exedev/workflow";

/**
 * Plays the part of a VM's shell for the bootstrap commands: it recognises
 * the marker, status and start commands by shape and runs the embedded
 * script through `behave`.
 */
function vmShell(
  behave: (script: string) => { output: string; exitCode: number },
  pollsUntilDone = 0,
) {
  const done = new Set<string>();
  const started = new Set<string>();
  const status = new Map<
    string,
    { exitCode: number; output: string; pollsLeft: number }
  >();
  const scripts: string[] = [];
  const run = (command: string) => {
    const encoded = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command)
      ?.[1];
    const script = new TextDecoder().decode(base64Decode(encoded!));
    scripts.push(script);
    return behave(script);
  };
  const exec = (_vm: string, command: string) => {
    const key = /bootstrap"\/([A-Za-z0-9_.-]+)\.(done|status)/.exec(command)
      ?.[1];
    if (key === undefined) {
      return command.includes("healthz")
        ? { output: "ok\n", exitCode: 0 }
        : { output: "", exitCode: 1 };
    }
    if (command.startsWith("if [ -f") && command.includes("echo pending")) {
      const state = status.get(key);
      if (state === undefined || state.pollsLeft-- > 0) {
        return { output: "pending\n" };
      }
      return { output: `${state.exitCode}\n${state.output}` };
    }
    if (done.has(key)) return { output: "__EXEDEV_BOOTSTRAP_ALREADY_DONE__\n" };
    if (command.includes("setsid nohup")) {
      if (started.has(key) && !status.has(key)) return { output: "running\n" };
      started.add(key);
      const result = run(command);
      status.set(key, { ...result, pollsLeft: pollsUntilDone });
      if (result.exitCode === 0) done.add(key);
      return { output: "started\n" };
    }
    const result = run(command);
    if (result.exitCode === 0) done.add(key);
    return result;
  };
  return { exec, scripts, done };
}

function setup(options: ConstructorParameters<typeof FakeExe>[0] = {}) {
  const fake = new FakeExe(options);
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    retry: { maxRetries: 0 },
  });
  return { fake, client };
}

Deno.test("provisionVm creates once; a replay and a rerun do not create again", async () => {
  const { fake, client } = setup();
  const step = fakeStep();
  const first = await provisionVm(step, "provision", client, {
    name: "web-0",
    tags: ["web"],
  });
  assertEquals(first, {
    ok: true,
    value: {
      vm_name: "web-0",
      created: true,
      ssh_dest: "web-0.exe.xyz",
      https_url: "https://web-0.exe.xyz",
    },
  });
  assertEquals(
    await provisionVm(step, "provision", client, { name: "web-0" }),
    first,
  );
  const rerun = await provisionVm(fakeStep(), "provision", client, {
    name: "web-0",
  });
  assertEquals(rerun.ok && rerun.value.created, false);
  assertEquals(fake.count("new"), 1);
});

Deno.test("provisionVm adopts a VM whose new was lost", async () => {
  const { fake, client } = setup();
  fake.failNext("new", { status: 504, execute: true });
  const step = fakeStep();
  const result = await provisionVm(step, "provision", client, {
    name: "web-0",
  });
  assertEquals(result.ok && result.value, {
    vm_name: "web-0",
    created: false,
    ssh_dest: "web-0.exe.xyz",
    https_url: "https://web-0.exe.xyz",
  });
  assertEquals(step.log, ["run provision #1"]);
});

Deno.test("provisionVm lets the step retry transient failures", async () => {
  const { fake, client } = setup();
  fake.failNext("new", { status: 503 });
  const step = fakeStep();
  const result = await provisionVm(step, "provision", client, {
    name: "web-0",
  });
  assert(result.ok && result.value.created, JSON.stringify(result));
  assertEquals(step.log, [
    "run provision #1",
    "threw ExeError(server): exe.dev answered 503 to `new --name=web-0`: injected failure",
    "run provision #2",
  ]);
});

Deno.test("provisionVm returns permanent failures as data", async () => {
  const { client } = setup({ maxVms: 0 });
  const step = fakeStep();
  const result = await provisionVm(step, "provision", client, {
    name: "web-0",
  });
  assert(!result.ok, JSON.stringify(result));
  assertEquals([result.error.kind, result.error.detail], [
    "command_failed",
    "VM limit reached for your plan",
  ]);
  assertEquals(step.log, ["run provision #1"]);
  try {
    await provisionVm(step, "x", client, { name: "" } as never);
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeInvalidRequestError, String(error));
  }
});

Deno.test("waitForVm polls with durable sleeps and replays", async () => {
  const { fake, client } = setup({ bootPolls: 3 });
  await client.new({ name: "web-0" });
  const step = fakeStep();
  const result = await waitForVm(step, "wait", client, "web-0", {
    interval: "2 seconds",
  });
  assertEquals(result, { ok: true, value: "running" });
  assertEquals(step.log.filter((line) => line.startsWith("sleep")), [
    "sleep wait:sleep:0 2 seconds",
    "sleep wait:sleep:1 2 seconds",
  ]);
  const listings = fake.count("ls");
  assertEquals(await waitForVm(step, "wait", client, "web-0"), result);
  assertEquals(fake.count("ls"), listings);
});

Deno.test("waitForVm gives up after maxPolls", async () => {
  const { client } = setup();
  const result = await waitForVm(fakeStep(), "wait", client, "absent-vm", {
    maxPolls: 3,
  });
  assert(!result.ok, JSON.stringify(result));
  assertEquals(result.error.kind, "timeout");
  assert(result.error.message.includes("last: absent"), result.error.message);
});

Deno.test("bootstrapVm inline runs its script once per marker", async () => {
  const shell = vmShell(() => ({ output: "installed celld\n", exitCode: 0 }));
  const { fake, client } = setup({ vmExec: shell.exec });
  fake.seedVm("web-0");
  const first = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "curl -fsSL x | sh\n",
    { mode: "inline" },
  );
  assertEquals(first, {
    ok: true,
    value: { exitCode: 0, skipped: false, output: "installed celld\n" },
  });
  const second = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "curl -fsSL x | sh\n",
    { mode: "inline" },
  );
  assertEquals(second, {
    ok: true,
    value: { exitCode: 0, skipped: true, output: "" },
  });
  assertEquals(shell.scripts, ["curl -fsSL x | sh\n"]);
  const changed = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "echo v2\n",
    { mode: "inline" },
  );
  assertEquals(changed.ok && changed.value.skipped, false);
});

Deno.test("a failing bootstrap reports its exit code and runs again next time", async () => {
  let attempt = 0;
  const shell = vmShell(
    () => (++attempt === 1
      ? { output: "network down\n", exitCode: 7 }
      : { output: "ok\n", exitCode: 0 }),
  );
  const { fake, client } = setup({ vmExec: shell.exec });
  fake.seedVm("web-0");
  const failed = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "setup",
    { mode: "inline", key: "setup-v1" },
  );
  assertEquals(failed, {
    ok: true,
    value: { exitCode: 7, skipped: false, output: "network down\n" },
  });
  const fixed = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "setup",
    { mode: "inline", key: "setup-v1" },
  );
  assertEquals(fixed.ok && fixed.value.exitCode, 0);
  assert(shell.done.has("setup-v1"), "marked done");
});

Deno.test("bootstrapVm detached starts once and polls the status file", async () => {
  const shell = vmShell(() => ({ output: "long install\n", exitCode: 0 }), 2);
  const { fake, client } = setup({ vmExec: shell.exec });
  fake.seedVm("web-0");
  const step = fakeStep();
  const result = await bootstrapVm(step, "boot", client, "web-0", "sleep 600", {
    key: "slow",
  });
  assertEquals(result, {
    ok: true,
    value: { exitCode: 0, skipped: false, output: "long install\n" },
  });
  assertEquals(step.log.filter((line) => line.startsWith("run")), [
    "run boot:start #1",
    "run boot:status:0 #1",
    "run boot:status:1 #1",
    "run boot:status:2 #1",
  ]);
  const replayed = await bootstrapVm(
    step,
    "boot",
    client,
    "web-0",
    "sleep 600",
    { key: "slow" },
  );
  assertEquals(replayed, result);
  const again = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "sleep 600",
    { key: "slow" },
  );
  assertEquals(again, {
    ok: true,
    value: { exitCode: 0, skipped: true, output: "" },
  });
  assertEquals(shell.scripts.length, 1);
});

Deno.test("bootstrapVm detached times out when the status never appears", async () => {
  const shell = vmShell(() => ({ output: "", exitCode: 0 }), 100);
  const { fake, client } = setup({ vmExec: shell.exec });
  fake.seedVm("web-0");
  const result = await bootstrapVm(fakeStep(), "boot", client, "web-0", "x", {
    maxPolls: 2,
  });
  assert(!result.ok && result.error.kind === "timeout", JSON.stringify(result));
});

Deno.test("bootstrapVm refuses unsafe marker keys", async () => {
  const { client } = setup();
  try {
    await bootstrapVm(fakeStep(), "boot", client, "web-0", "x", {
      key: "../etc",
    });
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeInvalidRequestError, String(error));
  }
});

Deno.test("verifyVm checks exit code and output", async () => {
  const shell = vmShell(() => ({ output: "", exitCode: 0 }));
  const { fake, client } = setup({ vmExec: shell.exec });
  fake.seedVm("web-0");
  const passed = await verifyVm(fakeStep(), "verify", client, "web-0", {
    command: ["curl", "-fsS", "http://localhost:8000/healthz"],
    contains: "ok",
  });
  assertEquals(passed, {
    ok: true,
    value: { passed: true, exitCode: 0, output: "ok\n" },
  });
  const failed = await verifyVm(fakeStep(), "verify", client, "web-0", {
    command: ["false"],
  });
  assertEquals(failed, {
    ok: true,
    value: { passed: false, exitCode: 1, output: "" },
  });
  const missing = await verifyVm(fakeStep(), "verify", client, "web-9", {
    command: ["true"],
  });
  assert(
    !missing.ok && missing.error.kind === "command_failed",
    JSON.stringify(missing),
  );
});
