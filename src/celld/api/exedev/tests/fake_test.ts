// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  ExeClient,
  ExeError,
  mintExe0,
  signerFromOpenSsh,
} from "@celld/api/exedev";
import { FakeExe, fakeStep } from "@celld/api/exedev/testing";
import * as fixture from "./fixtures.ts";

async function post(
  fake: FakeExe,
  body: string,
  token: string | null,
  method = "POST",
) {
  const response = await fake.fetch("https://exe.dev/exec", {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON (ssh output).
  }
  return { status: response.status, json, headers: response.headers };
}

async function failure(promise: Promise<unknown>): Promise<ExeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExeError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

Deno.test("the fake answers the HTTPS API's documented refusals", async () => {
  const fake = new FakeExe();
  const admin = fake.issueAdminToken();
  const narrow = fake.issueToken({ cmds: ["ls"] });
  const cases: [string, string | null, string, number][] = [
    ["ls", null, "POST", 401],
    ["ls", "exe1.unknown", "POST", 401],
    ["ls", admin, "GET", 405],
    ["", admin, "POST", 400],
    ["ls 'open", admin, "POST", 400],
    ["frobnicate", admin, "POST", 404],
    ["new", narrow, "POST", 403],
    ["ls --bogus", admin, "POST", 422],
    ["x".repeat(70_000), admin, "POST", 413],
    ["rm nope", admin, "POST", 422],
    ["ls", narrow, "POST", 200],
  ];
  for (const [body, token, method, status] of cases) {
    assertEquals(
      (await post(fake, body, token, method)).status,
      status,
      `${body.slice(0, 20)} ${method}`,
    );
  }
});

Deno.test("the fake keeps VM state across commands", async () => {
  const fake = new FakeExe();
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
  });
  const vm = await client.new({
    name: "web-0",
    tags: ["prod"],
    comment: "front",
    cpu: 4,
  });
  assertEquals(vm.vm_name, "web-0");
  const generated = await client.new();
  assert(generated.vm_name !== "web-0", "a generated name");
  assertEquals(
    (await failure(client.new({ name: "web-0" }))).detail,
    "VM name web-0 already exists",
  );
  await client.tag("web-0", ["web"]);
  await client.untag("web-0", ["prod"]);
  await client.comment("web-0", "renamed soon");
  await client.rename("web-0", "web-1");
  await client.resize("web-1", { cpu: 8 });
  const copy = await client.cp("web-1", { name: "web-2", copyTags: false });
  const listed = await client.ls();
  const byName = new Map(listed.vms.map((item) => [item.vm_name, item]));
  assertEquals(byName.get("web-1")?.tags, ["web"]);
  assertEquals(byName.get("web-1")?.comment, "renamed soon");
  assertEquals(byName.get(copy.vm_name)?.tags, []);
  assertEquals(fake.vms.get("web-1")?.cpu, 8);
  await client.rm(["web-1", copy.vm_name]);
  assertEquals((await client.ls()).vms.map((item) => item.vm_name), [
    generated.vm_name,
  ]);
});

Deno.test("new VMs can spend a few listings starting", async () => {
  const fake = new FakeExe({ bootPolls: 2 });
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
  });
  assertEquals((await client.new({ name: "a" })).status, "starting");
  assertEquals((await client.getVm("a"))?.status, "starting");
  assertEquals((await client.getVm("a"))?.status, "running");
  assertEquals(
    (await failure(client.runOnVm("b", ["x"]))).kind,
    "command_failed",
  );
});

Deno.test("listDetails off hides tags and comments, as the documented listing does", async () => {
  const fake = new FakeExe({ listDetails: false });
  fake.seedVm("a", { tags: ["x"] });
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
  });
  const [vm] = (await client.ls()).vms;
  assertEquals([vm.tags, vm.comment], [undefined, undefined]);
});

Deno.test("faults: statuses, lost answers and resets", async () => {
  const fake = new FakeExe();
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    retry: { maxRetries: 0 },
  });
  fake.failNext("ls", { status: 429, headers: { "retry-after": "3" } });
  const limited = await failure(client.ls());
  assertEquals([limited.kind, limited.retryAfterMs], ["rate_limited", 3000]);
  fake.failNext("new", { status: 504, execute: true });
  const lost = await failure(client.new({ name: "a" }));
  assertEquals([lost.kind, lost.ambiguous], ["command_timeout", true]);
  assert(fake.vms.has("a"), "the command ran anyway");
  fake.failNext("rm", { connection: true, execute: true });
  const reset = await failure(client.rm("a"));
  assertEquals([reset.kind, reset.ambiguous, fake.vms.has("a")], [
    "connection",
    true,
    false,
  ]);
  fake.failNext((path) => path === "whoami", { connection: true }, 2);
  await failure(client.whoami());
  await failure(client.whoami());
  await client.whoami();
  assertEquals(fake.count("whoami"), 3);
});

Deno.test("exe0 tokens are accepted when signed by a registered key", async () => {
  const fake = new FakeExe({ now: () => 1_800_000_000_000 });
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const token = await mintExe0({
    signer,
    permissions: { cmds: ["whoami"], exp: 1_900_000_000 },
  });
  assertEquals((await post(fake, "whoami", token)).status, 401);
  fake.addSshKey(fixture.PUBLIC_KEY, "api");
  const me = await post(fake, "whoami", token);
  assertEquals(me.status, 200);
  assertEquals(
    (me.json as { ssh_keys: { fingerprint: string }[] }).ssh_keys[0]
      .fingerprint,
    fixture.FINGERPRINT,
  );
  assertEquals((await post(fake, "ls", token)).status, 403);
  const expired = await mintExe0({
    signer,
    permissions: { exp: 1_700_000_000 },
  });
  assertEquals((await post(fake, "whoami", expired)).status, 401);
  const vmToken = await mintExe0({ signer, vm: "web-0", permissions: {} });
  assertEquals((await post(fake, "whoami", vmToken)).status, 401);
});

Deno.test("ssh runs the VM handler and reports the exit code", async () => {
  const seen: [string, string, string | null][] = [];
  const fake = new FakeExe({
    vmExec: (vm, command, user) => {
      seen.push([vm, command, user]);
      return { output: "hello\n", exitCode: 3 };
    },
  });
  fake.seedVm("web-0");
  const token = fake.issueToken({ cmds: ["ssh web-0"] });
  const direct = await post(fake, "ssh root@web-0 'echo hello'", token);
  assertEquals([direct.status, direct.json, direct.headers.get("x-exe-exit")], [
    200,
    "hello\n",
    "3",
  ]);
  assertEquals(seen[0], ["web-0", "echo hello", "root"]);
  assertEquals((await post(fake, "ssh web-1 id", token)).status, 403);
  const client = new ExeClient({ token, fetch: fake.fetch });
  const run = await client.runOnVm("web-0", ["echo", "hello"]);
  assertEquals([run.exitCode, run.text, seen[1][1]], [
    3,
    "hello\n",
    "echo hello",
  ]);
});

Deno.test("share, domain, ssh-key and integration state", async () => {
  const fake = new FakeExe();
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
  });
  fake.seedVm("web-0");
  await client.share.port("web-0", 8080);
  await client.share.setPublic("web-0");
  await client.share.add("web-0", "a@example.com", { root: true });
  await client.share.remove("web-0", "a@example.com", { root: true });
  const link = await client.share.addLink("web-0") as { token: string };
  await client.share.removeLink("web-0", link.token);
  const shown = await client.share.show("web-0");
  assertEquals(shown, {
    vm_name: "web-0",
    public: true,
    port: 8080,
    shares: [{ who: "a@example.com", access: "web" }],
    links: [],
  });
  await client.domain.add("web-0", "app.example.com");
  assertEquals(await client.domain.ls(), [{
    vm_name: "web-0",
    domain: "app.example.com",
  }]);
  await client.sshKey.add(fixture.PUBLIC_KEY);
  assertEquals((await client.sshKey.list()).map((key) => key.fingerprint), [
    fixture.FINGERPRINT,
  ]);
  await client.sshKey.remove(fixture.FINGERPRINT);
  assertEquals(await client.sshKey.list(), []);
  await client.integrations.add({
    type: "http-proxy",
    name: "api",
    target: "https://x",
    bearer: "sk",
    attach: ["auto:all"],
  });
  await client.integrations.attach("api", "vm:web-0");
  const [item] = await client.integrations.list();
  assertEquals([item.name, item.type, item.config?.bearer], [
    "api",
    "http-proxy",
    "***",
  ]);
  assert(fake.vms.get("web-0")!.integrations.has("api"), "attached");
  assertEquals(
    (await failure(client.new({ integrations: ["missing"] }))).kind,
    "command_failed",
  );
  await client.integrations.detach("api", "vm:web-0");
  assert(!fake.vms.get("web-0")!.integrations.has("api"), "detached");
  assertEquals(
    (await client.commandHelp("share add") as { command: string }).command,
    "share add",
  );
});

Deno.test("fakeStep replays stored results and retries throwing steps", async () => {
  const step = fakeStep();
  let runs = 0;
  const flaky = () =>
    step.do("s", { retries: { limit: 2, delay: "1 second" } }, () => {
      runs++;
      if (runs < 2) throw new Error("transient");
      return { value: runs };
    });
  assertEquals(await flaky(), { value: 2 });
  assertEquals(await flaky(), { value: 2 });
  assertEquals(step.log, [
    "run s #1",
    "threw Error: transient",
    "run s #2",
    "replay s",
  ]);
  await step.sleep("nap", "5 seconds");
  await step.sleep("nap", "5 seconds");
  assertEquals(step.log.filter((line) => line.startsWith("sleep")), [
    "sleep nap 5 seconds",
  ]);
  let tries = 0;
  try {
    await step.do(
      "always",
      { retries: { limit: 1, delay: "1 second" } },
      () => {
        tries++;
        throw new Error("permanent");
      },
    );
    throw new Error("resolved");
  } catch (error) {
    assertEquals([(error as Error).message, tries], ["permanent", 2]);
  }
});
