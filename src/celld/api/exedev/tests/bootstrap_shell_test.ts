// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The bootstrap and detach command lines run through a real /bin/sh in a
// temporary directory, standing in for the VM: WP-12b sweep regressions
// for claims, liveness and file creation (F12, F18). Needs flock(1).

import { assert, assertEquals } from "@celld/core/assert";
import { ExeClient } from "@celld/api/exedev";
import { FakeExe, fakeStep } from "@celld/api/exedev/testing";
import { bootstrapVm } from "@celld/api/exedev/workflow";

/** Runs VM commands with `sh -c` in `cwd`. */
function shellVm(cwd: string) {
  const commands: string[] = [];
  const exec = async (_vm: string, command: string) => {
    commands.push(command);
    const run = await new Deno.Command("sh", {
      args: ["-c", command],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new Uint8Array(run.stdout.length + run.stderr.length);
    output.set(run.stdout);
    output.set(run.stderr, run.stdout.length);
    return { output, exitCode: run.code };
  };
  return { exec, commands };
}

async function setup() {
  const root = await Deno.makeTempDir({ prefix: "exedev-boot-" });
  const vm = shellVm(root);
  const fake = new FakeExe({ vmExec: vm.exec });
  fake.seedVm("web-0");
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    retry: { maxRetries: 0 },
  });
  return { root, vm, client, dir: `${root}/boot` };
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(path)).split("\n").filter((l) => l !== "");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const NO_RETRY = {
  retries: { limit: 0, delay: "1 second" },
  timeout: "1 minute",
} as const;

// DB-SWP-F12-309: concurrent detached starts for one key all passed the
// `.started` check and both ran the script, rewriting it under each other.
Deno.test("concurrent detached starts run the script once", async () => {
  const { root, client, dir } = await setup();
  const script = `echo run >> ${root}/runs; sleep 0.3\n`;
  // The fake step's sleeps return at once, so the polls are what waits.
  const start = () =>
    bootstrapVm(fakeStep(), "boot", client, "web-0", script, {
      key: "once",
      directory: dir,
      maxPolls: 10_000,
      interval: "1 second",
    });
  const outcomes = await Promise.all(Array.from({ length: 12 }, start));
  assertEquals(await lines(`${root}/runs`), ["run"]);
  for (const outcome of outcomes) {
    assert(outcome.ok, JSON.stringify(outcome));
  }
  await until(
    async () => (await lines(`${dir}/once.status`)).length === 1,
    "the status",
  );
  const again = await bootstrapVm(fakeStep(), "boot", client, "web-0", script, {
    key: "once",
    directory: dir,
  });
  assertEquals(again, {
    ok: true,
    value: { exitCode: 0, skipped: true, output: "" },
  });
  assertEquals(await lines(`${root}/runs`), ["run"]);
  await Deno.remove(root, { recursive: true });
});

// DB-SWP-F12-311: inline mode had no claim, so overlapping runs both ran.
Deno.test("an inline run that loses the claim retries instead of running", async () => {
  const { root, client, dir } = await setup();
  const script = `echo run >> ${root}/runs; sleep 1\n`;
  const run = (config?: typeof NO_RETRY) =>
    bootstrapVm(fakeStep(), "boot", client, "web-0", script, {
      key: "inline",
      directory: dir,
      mode: "inline",
      ...(config === undefined ? {} : { config }),
    });
  const first = run();
  await until(async () => (await lines(`${root}/runs`)).length === 1, "run");
  let lost: unknown = null;
  try {
    await run(NO_RETRY);
  } catch (error) {
    lost = error;
  }
  assert(lost instanceof Error, `the second run was refused: ${lost}`);
  const done = await first;
  assertEquals(done.ok && done.value.exitCode, 0);
  assertEquals(await lines(`${root}/runs`), ["run"]);
  await Deno.remove(root, { recursive: true });
});

// DB-SWP-F12-310: a `.started` marker outlived a killed run, so every later
// start answered "running" and polled into a timeout.
Deno.test("a killed detached run is reported lost and can start again", async () => {
  const { root, client, dir } = await setup();
  // The first run kills its own process group (as a VM restart would),
  // before it can write a status; later runs succeed.
  const script =
    `if [ ! -f ${root}/killed ]; then touch ${root}/killed; kill -KILL 0; fi; echo ok\n`;
  const options = {
    key: "killed",
    directory: dir,
    maxPolls: 10_000,
    interval: "1 second",
  } as const;
  const first = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    script,
    options,
  );
  assert(!first.ok, JSON.stringify(first));
  assertEquals(first.error.kind, "command_failed");
  assert(first.error.message.includes("without a status"), first.error.message);
  const second = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    script,
    options,
  );
  assert(second.ok, JSON.stringify(second));
  assertEquals(second.value.exitCode, 0);
  assertEquals(second.value.output.trim(), "ok");
  await Deno.remove(root, { recursive: true });
});

// DB-SWP-F18-315: files went to predictable names with `>`, in a directory
// that could belong to someone else or be a symlink.
Deno.test("the bootstrap directory must be the user's own, and private", async () => {
  const { root, client, dir } = await setup();
  await Deno.mkdir(`${root}/elsewhere`);
  await Deno.symlink(`${root}/elsewhere`, dir);
  const refused = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "echo hi\n",
    { key: "link", directory: dir, mode: "inline" },
  );
  assert(!refused.ok, JSON.stringify(refused));
  assertEquals([...Deno.readDirSync(`${root}/elsewhere`)], []);

  await Deno.remove(dir);
  await Deno.mkdir(dir, { mode: 0o777 });
  await Deno.chmod(dir, 0o777);
  // A planted script name is not followed: scripts get fresh names.
  await Deno.writeTextFile(`${root}/target`, "untouched");
  await Deno.symlink(`${root}/target`, `${dir}/plant.script`);
  const ran = await bootstrapVm(
    fakeStep(),
    "boot",
    client,
    "web-0",
    "echo hi\n",
    { key: "plant", directory: dir, mode: "inline" },
  );
  assertEquals(ran.ok && ran.value.exitCode, 0);
  assertEquals(await Deno.readTextFile(`${root}/target`), "untouched");
  assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
  await Deno.remove(root, { recursive: true });
});

Deno.test("a detached status file is written through a fresh name", async () => {
  const { root, client } = await setup();
  await Deno.writeTextFile(`${root}/target`, "untouched");
  await Deno.symlink(`${root}/target`, `${root}/job.status.tmp`);
  await client.startDetached("web-0", ["true"], {
    statusFile: `${root}/job.status`,
  });
  await until(
    async () => (await lines(`${root}/job.status`)).length === 1,
    "the status",
  );
  assertEquals(await lines(`${root}/job.status`), ["0"]);
  assertEquals(await Deno.readTextFile(`${root}/target`), "untouched");
  await Deno.remove(root, { recursive: true });
});
