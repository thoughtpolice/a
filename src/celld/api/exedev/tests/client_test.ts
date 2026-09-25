// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  ExeApiError,
  ExeClient,
  type ExeClientOptions,
  ExeDecodeError,
  ExeError,
  ExeInvalidRequestError,
  isAlreadyExists,
  mintExe0,
  type RetryEvent,
  signerFromOpenSsh,
  splitCommandLine,
} from "@celld/api/exedev";
import { memoryLimiter } from "@celld/api/exedev/limiter";
import {
  FakeExe,
  fakeFetch,
  jsonResponse,
  type RecordedRequest,
  virtualRuntime,
} from "@celld/api/exedev/testing";
import * as fixture from "./fixtures.ts";

function status(
  code: number,
  body: unknown = { error: `status ${code}` },
  headers: Record<string, string> = {},
) {
  return jsonResponse(body, { status: code, headers });
}

/** Answers with each scripted step in turn, then `{}`. */
function script(
  ...steps: (Response | Error | ((call: RecordedRequest) => Response))[]
) {
  return fakeFetch((call, index) => {
    const step = steps[index];
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(call);
    return step ?? jsonResponse({ vms: [] });
  });
}

function client(
  fetch: ExeClientOptions["fetch"],
  options: Partial<ExeClientOptions> = {},
) {
  const runtime = virtualRuntime();
  const events: RetryEvent[] = [];
  const exe = new ExeClient({
    token: "exe1.test",
    fetch,
    runtime,
    onRetry: (event) => events.push(event),
    ...options,
  });
  return { exe, runtime, events };
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

function fake(options: ConstructorParameters<typeof FakeExe>[0] = {}) {
  const exe = new FakeExe(options);
  const token = exe.issueAdminToken();
  const runtime = virtualRuntime();
  return {
    fake: exe,
    runtime,
    client: new ExeClient({ token, fetch: exe.fetch, runtime }),
  };
}

Deno.test("a command is a POST of the command line with a bearer token", async () => {
  const fetch = script(jsonResponse({ vms: [] }));
  const { exe } = client(fetch, {
    baseUrl: "https://lobby.example/",
    headers: { "x-trace": "1", authorization: "Bearer stolen" },
  });
  await exe.ls({ long: true, pattern: "web-*" });
  const [call] = fetch.calls;
  assertEquals(call.url, "https://lobby.example/exec");
  assertEquals(call.method, "POST");
  assertEquals(call.body, "ls -l 'web-*'");
  assertEquals(call.headers.get("authorization"), "Bearer exe1.test");
  assertEquals(call.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(call.headers.get("user-agent"), "celld-exedev/0.1.0");
  assertEquals(call.headers.get("x-trace"), "1");
});

Deno.test("ls decodes the documented listing and keeps unknown fields", async () => {
  const listing = {
    vms: [{
      https_url: "https://bloggy.exe.xyz",
      region: "lon",
      region_display: "London, UK",
      ssh_dest: "bloggy.exe.xyz",
      ssh_host: "bloggy.exe.xyz",
      status: "running",
      vm_name: "bloggy",
      future_field: 1,
    }],
    total: 1,
  };
  const { exe } = client(script(jsonResponse(listing)));
  const result = await exe.ls();
  assertEquals(result.vms[0].vm_name, "bloggy");
  assertEquals(result.vms[0].region_display, "London, UK");
  assertEquals(result.vms[0].tags, undefined);
  assertEquals(result.vms[0].raw.future_field, 1);
  assertEquals(result.raw.total, 1);
});

Deno.test("a listing without required fields is a decode error with paths", async () => {
  const { exe } = client(
    script(
      jsonResponse({
        vms: [{ vm_name: "a" }, { status: "running", vm_name: 3 }],
      }),
    ),
  );
  const error = await failure(exe.ls());
  assert(error instanceof ExeDecodeError, String(error));
  assertEquals(error.issues.map((issue) => issue.path), [["vms", 0, "status"], [
    "vms",
    1,
    "vm_name",
  ]]);
  assertEquals([error.status, error.command], [200, "ls"]);
  const text = await failure(client(script(new Response("not json"))).exe.ls());
  assertEquals([text.kind, text.body], ["decode", "not json"]);
});

Deno.test("every documented status becomes its typed error", async () => {
  const cases: [number, string, boolean][] = [
    [400, "bad_request", false],
    [401, "authentication", false],
    [403, "permission", false],
    [404, "not_found", false],
    [405, "method_not_allowed", false],
    [413, "too_large", false],
    [422, "command_failed", false],
    [500, "server", true],
    [504, "command_timeout", true],
  ];
  for (const [code, kind, ambiguous] of cases) {
    const { exe } = client(script(status(code, { error: "the reason" })), {
      retry: { maxRetries: 0 },
    });
    const error = await failure(exe.new({ name: "web-0" }));
    assert(error instanceof ExeApiError, String(error));
    assertEquals([
      error.kind,
      error.status,
      error.detail,
      error.ambiguous,
      error.attempts,
    ], [kind, code, "the reason", ambiguous, 1]);
    assertEquals(error.command, "new --name=web-0");
    assert(error.message.includes("the reason"), error.message);
  }
});

Deno.test("plain-text error bodies are kept and used as the detail", async () => {
  const { exe } = client(
    script(new Response("no such VM: web-9\n", { status: 422 })),
  );
  const error = await failure(exe.rm("web-9"));
  assertEquals([error.body, error.detail], [
    "no such VM: web-9\n",
    "no such VM: web-9",
  ]);
});

Deno.test("reads are retried on transient failures; retry-after is honoured", async () => {
  const fetch = script(status(503), status(429, {}, { "retry-after": "2" }));
  const { exe, runtime, events } = client(fetch);
  await exe.ls();
  assertEquals(fetch.calls.length, 3);
  assertEquals(runtime.sleeps, [438, 2000]);
  assertEquals(events.map((event) => [event.attempt, event.error.kind]), [[
    1,
    "server",
  ], [2, "rate_limited"]]);
});

Deno.test("mutating commands are sent once, whatever the failure", async () => {
  for (
    const step of [
      status(503),
      status(429, {}, { "retry-after": "1" }),
      status(504),
      new TypeError("reset"),
    ]
  ) {
    const fetch = script(step);
    const { exe } = client(fetch);
    const error = await failure(exe.new({ name: "web-0" }));
    assertEquals(fetch.calls.length, 1, error.kind);
    assertEquals(error.attempts, 1);
  }
});

Deno.test("a connection failure on a mutation is ambiguous; on a read it is retried", async () => {
  const { exe } = client(script(new TypeError("connection reset")));
  const error = await failure(exe.rm("web-0"));
  assertEquals([error.kind, error.ambiguous, error.retryable], [
    "connection",
    true,
    true,
  ]);
  const read = script(new TypeError("reset"), jsonResponse({ vms: [] }));
  await client(read).exe.whoami().catch(() => {});
  assertEquals(read.calls.length, 2);
});

Deno.test("4xx other than 429 is never retried, even for reads", async () => {
  const fetch = script(status(401));
  const error = await failure(client(fetch).exe.ls());
  assertEquals([error.kind, fetch.calls.length], ["authentication", 1]);
});

Deno.test("retries stop at maxRetries and within the budget", async () => {
  const always = fakeFetch(() => status(500));
  const { exe } = client(always, { retry: { maxRetries: 3 } });
  const error = await failure(exe.ls());
  assertEquals([always.calls.length, error.attempts], [4, 4]);
  const budget = fakeFetch(() => status(429, {}, { "retry-after": "50" }));
  const limited = await failure(
    client(budget, { retry: { budgetMs: 10_000 } }).exe.ls(),
  );
  assertEquals([budget.calls.length, limited.kind], [1, "rate_limited"]);
});

Deno.test("per-call retry: false sends a read once", async () => {
  const fetch = script(status(500));
  await failure(client(fetch).exe.ls({}, { retry: false }));
  assertEquals(fetch.calls.length, 1);
});

Deno.test("an attempt that outlives its timeout is a timeout error", async () => {
  const hang = fakeFetch((call) =>
    new Promise<Response>((_, reject) =>
      call.signal!.addEventListener("abort", () => reject(call.signal!.reason))
    )
  );
  const { exe } = client(hang, { timeoutMs: 20, retry: { maxRetries: 1 } });
  const error = await failure(exe.ls());
  assertEquals(
    [error.kind, error.attempts, hang.calls.length, error.ambiguous],
    ["timeout", 2, 2, true],
  );
  assert(error.message.includes("within 20 ms"), error.message);
  const deaf = fakeFetch(() => new Promise<Response>(() => {}));
  const ignored = await failure(client(deaf, { timeoutMs: 20 }).exe.rm("a"));
  assertEquals(ignored.kind, "timeout");
});

Deno.test("aborting cancels the request and is never retried", async () => {
  const controller = new AbortController();
  const hang = fakeFetch((call) => {
    queueMicrotask(() => controller.abort(new Error("stop")));
    return new Promise<Response>((_, reject) =>
      call.signal!.addEventListener("abort", () => reject(call.signal!.reason))
    );
  });
  const error = await failure(
    client(hang).exe.ls({}, { signal: controller.signal }),
  );
  assertEquals([error.kind, hang.calls.length], ["aborted", 1]);
  const early = new AbortController();
  early.abort();
  const fetch = script();
  assertEquals(
    (await failure(client(fetch).exe.ls({}, { signal: early.signal }))).kind,
    "aborted",
  );
  assertEquals(fetch.calls.length, 0);
});

Deno.test("the limiter paces attempts and hears about 429s", async () => {
  let now = 0;
  const limiter = memoryLimiter({
    limits: { requestsPerSecond: 1, burst: 1 },
    now: () => now,
  });
  const runtime = virtualRuntime({ start: 0 });
  const sleep = runtime.sleep;
  runtime.sleep = (ms, signal) => {
    now += ms;
    return sleep(ms, signal);
  };
  const fetch = script(
    jsonResponse({ vms: [] }),
    status(429, {}, { "retry-after": "5" }),
    jsonResponse({ vms: [] }),
  );
  const exe = new ExeClient({ token: "exe1.t", fetch, runtime, limiter });
  await exe.ls();
  await exe.ls();
  assertEquals(runtime.sleeps, [1000, 5000]);
  assertEquals(limiter.snapshot().blockedUntil, 6000);
});

Deno.test("a failing limiter is reported and does not stop traffic", async () => {
  const errors: unknown[] = [];
  const fetch = script(jsonResponse({ vms: [] }));
  const exe = new ExeClient({
    token: "exe1.t",
    fetch,
    limiter: { acquire: () => Promise.reject(new Error("limiter down")) },
    onLimiterError: (error) => errors.push(error),
  });
  await exe.ls();
  assertEquals([fetch.calls.length, errors.length], [1, 1]);
});

Deno.test("the client checks an exe0 token's cmds and expiry before sending", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const token = await mintExe0({
    signer,
    permissions: { exp: 1_800_000_000, cmds: ["ls", "ssh web-0"] },
  });
  const fetch = script(jsonResponse({ vms: [] }));
  const runtime = virtualRuntime({ start: 1_700_000_000_000 });
  const exe = new ExeClient({ token, fetch, runtime });
  await exe.ls();
  const denied = await failure(exe.new({ name: "a" }));
  assertEquals([denied.kind, denied.issues[0].message], [
    "invalid_request",
    "the token's cmds do not allow new",
  ]);
  const ssh = await failure(exe.runOnVm("web-1", ["id"]));
  assertEquals(
    ssh.issues[0].message,
    "the token's cmds do not allow ssh web-1",
  );
  runtime.advance(200_000_000_000);
  assertEquals(
    (await failure(exe.ls())).issues[0].message,
    "the token has expired",
  );
  assertEquals(fetch.calls.length, 1);
  const unchecked = new ExeClient({
    token,
    fetch,
    runtime,
    checkPermissions: false,
  });
  await failure(unchecked.new({ name: "a" }));
  assertEquals(fetch.calls.length, 2);
});

Deno.test("constructor and fromEnv refuse missing or malformed settings", () => {
  for (
    const options of [{ token: "" }, { token: "exe1 x" }, {
      token: "t",
      baseUrl: "ftp://x",
    }, { token: "t", baseUrl: "nope" }]
  ) {
    try {
      new ExeClient(options);
      throw new Error(`accepted ${JSON.stringify(options)}`);
    } catch (error) {
      assert(error instanceof TypeError, String(error));
    }
  }
  try {
    new ExeClient({ token: "t", timeoutMs: 0 });
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof RangeError, String(error));
  }
  try {
    ExeClient.fromEnv({});
    throw new Error("accepted");
  } catch (error) {
    assert(
      error instanceof TypeError && error.message.includes("EXE_API_TOKEN"),
      String(error),
    );
  }
});

Deno.test("fromEnv reads EXE_API_TOKEN and EXE_BASE_URL", async () => {
  const fetch = script(jsonResponse({ vms: [] }));
  const exe = ExeClient.fromEnv({
    EXE_API_TOKEN: " exe1.env ",
    EXE_BASE_URL: "http://127.0.0.1:9",
  }, { fetch });
  await exe.ls();
  assertEquals(fetch.calls[0].url, "http://127.0.0.1:9/exec");
  assertEquals(fetch.calls[0].headers.get("authorization"), "Bearer exe1.env");
});

Deno.test("fromEnv mints short-lived tokens from a private key", async () => {
  const lobby = new FakeExe();
  lobby.addSshKey(fixture.PUBLIC_KEY);
  const runtime = virtualRuntime({ start: 1_800_000_000_000 });
  const exe = ExeClient.fromEnv({
    EXE_SSH_PRIVATE_KEY: fixture.PRIVATE_KEY,
    EXE_TOKEN_CMDS: "ls, whoami",
    EXE_TOKEN_TTL_SECONDS: "600",
  }, { fetch: lobby.fetch, runtime });
  await exe.whoami();
  await exe.ls();
  const tokens = lobby.requests.map((request) => request.token);
  assertEquals(tokens[0], tokens[1]);
  assert(tokens[0]!.startsWith("exe0."), String(tokens[0]));
  const denied = await failure(exe.new({ name: "x" }));
  assertEquals(denied.kind, "permission");
});

Deno.test("new sends every documented flag and decodes the result", async () => {
  const fetch = script(
    jsonResponse({
      vm_name: "web-0",
      ssh_dest: "vm+web-0@vm.exe.xyz",
      ssh_host: "vm.exe.xyz",
      ssh_user: "vm+web-0",
      extra: true,
    }),
  );
  const { exe } = client(fetch);
  const vm = await exe.new({
    name: "web-0",
    image: "ghcr.io/o/i:1",
    cpu: 4,
    memory: "16GB",
    disk: 50,
    comment: "front end",
    env: { A: "1", B: "two words" },
    integrations: ["llm", "gh"],
    tags: ["prod", "web"],
    noEmail: true,
    pool: "build",
    prompt: "build me a web app",
    registryAuth: { username: "octocat", password: "ghp_x" },
    standalone: true,
    setupScript: "#!/bin/sh\ntouch /tmp/ok\n",
  });
  assertEquals(vm.vm_name, "web-0");
  assertEquals([vm.ssh_host, vm.ssh_user], ["vm.exe.xyz", "vm+web-0"]);
  const words = splitCommandLine(fetch.calls[0].body!);
  assertEquals(words, {
    ok: true,
    words: [
      "new",
      "--name=web-0",
      "--image=ghcr.io/o/i:1",
      "--cpu=4",
      "--memory=16GB",
      "--disk=50",
      "--comment=front end",
      "--env=A=1",
      "--env=B=two words",
      "--integration=llm",
      "--integration=gh",
      "--tag=prod",
      "--tag=web",
      "--no-email",
      "--pool=build",
      "--prompt=build me a web app",
      "--registry-auth=octocat:ghp_x",
      "--standalone",
      "--setup-script=#!/bin/sh\\ntouch /tmp/ok\\n",
    ],
  });
});

Deno.test("new validates its settings before sending", async () => {
  const fetch = script();
  const { exe } = client(fetch);
  const error = await failure(exe.new({
    name: "Web_0",
    cpu: 0,
    memory: "lots",
    comment: "x".repeat(201),
    env: { "1BAD": "x", OK: "a\nb" },
    tags: ["has space", "-flag", "a,b"],
    pool: "p",
    noPool: true,
    prompt: "/dev/stdin",
    registryAuth: { username: "a:b", password: "p" },
    setupScript: "x".repeat(10 * 1024 + 1),
  }));
  assertEquals(error.issues.map((issue) => issue.path.join(".")), [
    "name",
    "cpu",
    "memory",
    "comment",
    "env.1BAD",
    "env.OK",
    "tags.0",
    "tags.1",
    "tags.2",
    "noPool",
    "prompt",
    "registryAuth.username",
    "registryAuth",
    "setupScript",
  ]);
  assertEquals(fetch.calls.length, 0);
  const both = await failure(exe.new({ setupScript: "a\\nb\nc" }));
  assertEquals(both.issues[0].path, ["setupScript"]);
});

Deno.test("VM lifecycle commands build the documented lines", async () => {
  const fetch = fakeFetch(() => jsonResponse({ vm_name: "copy", ok: true }));
  const { exe } = client(fetch);
  await exe.rm(["a", "b"]);
  await exe.restart("a");
  await exe.rename("a", "b");
  await exe.tag("a", ["prod", "web"]);
  await exe.untag("a", ["prod"]);
  await exe.cp("a", {
    name: "copy",
    cpu: 4,
    memory: "16GB",
    copyTags: false,
    pool: "build",
  });
  await exe.resize("a", { memory: 8, disk: "40G" });
  await exe.comment("a", "staging copy");
  await exe.comment("a", "");
  await exe.stat("a", { range: "7d" });
  await exe.vmLogs("a");
  await exe.grantSupportRoot("a", true);
  await exe.setRegion("FRA");
  await exe.browser({ qr: true });
  await exe.lsGrouped("tag", { long: true });
  await exe.help("new");
  await exe.helpAll();
  await exe.commandHelp("share add");
  await exe.doc("regions");
  assertEquals(fetch.calls.map((call) => call.body), [
    "rm a b",
    "restart a",
    "rename a b",
    "tag a prod web",
    "tag -d a prod",
    "cp --cpu=4 --memory=16GB --pool=build --copy-tags=false a copy",
    "resize --memory=8 --disk=40G a",
    "comment a 'staging copy'",
    "comment a ''",
    "stat --range=7d a",
    "vm-logs a",
    "grant-support-root a on",
    "set-region fra",
    "browser --qr",
    "ls -l --group=tag",
    "help new",
    "help all",
    "share add --help",
    "doc regions",
  ]);
});

Deno.test("lifecycle commands refuse bad names and empty changes", async () => {
  const { exe } = client(script());
  const cases: [Promise<unknown>, string][] = [
    [exe.rm([]), "vms"],
    [exe.rm("-rf"), "vms.0"],
    [exe.tag("a", []), "tags"],
    [exe.resize("a", {}), ""],
    [exe.comment("a", "é".repeat(101)), "text"],
    [exe.setRegion("europe"), "code"],
    [exe.lsGrouped("owner" as never), "group"],
    [exe.getVm("NOPE"), "name"],
    [exe.exe0ToExe1("exe1.abc"), "token"],
  ];
  for (const [promise, path] of cases) {
    const error = await failure(promise);
    assert(error instanceof ExeInvalidRequestError, String(error));
    assertEquals(error.issues[0].path.join("."), path);
  }
});

Deno.test("getVm finds one VM by exact name", async () => {
  const { client: exe, fake: lobby } = fake();
  lobby.seedVm("web-0");
  lobby.seedVm("web-01");
  assertEquals((await exe.getVm("web-0"))?.vm_name, "web-0");
  assertEquals(await exe.getVm("web-9"), null);
});

Deno.test("whoami decodes keys and flags the current one", async () => {
  const { exe } = client(script(jsonResponse({
    email: "a@example.com",
    ssh_keys: [{ fingerprint: "SHA256:x", current: true, name: "laptop" }],
  })));
  const me = await exe.whoami();
  assertEquals([me.email, me.ssh_keys?.[0].current, me.ssh_keys?.[0].name], [
    "a@example.com",
    true,
    "laptop",
  ]);
});

Deno.test("exe0ToExe1 and generateApiKey find the issued token", async () => {
  const lobby = new FakeExe();
  lobby.addSshKey(fixture.PUBLIC_KEY);
  const exe = new ExeClient({
    token: lobby.issueAdminToken(),
    fetch: lobby.fetch,
  });
  const exe1 = await exe.exe0ToExe1(fixture.TOKEN);
  assert(exe1.token.startsWith("exe1."), exe1.token);
  const scoped = await exe.exe0ToExe1(fixture.VM_TOKEN, { vm: "fixture-vm" });
  assert(scoped.token.startsWith("exe1."), scoped.token);
  const wrong = await failure(exe.exe0ToExe1(fixture.VM_TOKEN));
  assertEquals(wrong.kind, "command_failed");
  const key = await exe.sshKey.generateApiKey({
    label: "ci",
    cmds: ["ls", "ssh web-0"],
    exp: "30d",
  });
  assert(key.token.startsWith("exe1."), key.token);
  assertEquals(lobby.requests.at(-1)!.words, [
    "ssh-key",
    "generate-api-key",
    "--label=ci",
    "--cmds=ls,ssh web-0",
    "--exp=30d",
  ]);
  const errors = await failure(
    exe.sshKey.generateApiKey({ exp: "soon", cmds: ["Bad Cmd"] }),
  );
  assertEquals(errors.issues.map((issue) => issue.path.join(".")), [
    "cmds.0",
    "exp",
  ]);
  const redacted = await failure(
    new ExeClient({ token: "exe1.x", fetch: script(status(422)) }).exe0ToExe1(
      fixture.TOKEN,
    ),
  );
  assertEquals(redacted.command, "exe0-to-exe1 ***");
});

Deno.test("runOnVm returns output and the exit code from the marker", async () => {
  const { client: exe, fake: lobby } = fake({
    exitHeader: false,
    vmExec: (_vm, command) => ({
      output: `ran: ${command}\n`,
      exitCode: command.includes("false") ? 1 : 0,
    }),
  });
  lobby.seedVm("web-0");
  const ok = await exe.runOnVm("web-0", ["echo", "it's $HOME"]);
  assertEquals([ok.exitCode, ok.exitSource, ok.text], [
    0,
    "marker",
    "ran: echo 'it'\\''s $HOME'\n",
  ]);
  const failed = await exe.runOnVm("web-0", { shell: "false" });
  assertEquals([failed.exitCode, failed.text], [1, "ran: false\n"]);
  const body = lobby.requests.at(-1)!.body;
  assert(
    body.startsWith("ssh web-0 '( false ) </dev/null; rc=$?; printf"),
    body,
  );
});

Deno.test("runOnVm reads X-Exe-Exit headers and checks they agree", async () => {
  const header = script((call) => {
    const marker = /(__EXE_EXIT_[0-9a-f]{24}__)/.exec(call.body!)![1];
    return new Response(`out\n${marker}3\n`, {
      headers: { "x-exe-exit": "3" },
    });
  });
  const run = await client(header).exe.runOnVm("web-0", ["x"]);
  assertEquals([run.exitCode, run.exitSource, run.text], [3, "marker", "out"]);
  const conflict = script((call) => {
    const marker = /(__EXE_EXIT_[0-9a-f]{24}__)/.exec(call.body!)![1];
    return new Response(`\n${marker}0\n`, { headers: { "x-exe-exit": "1" } });
  });
  assertEquals(
    (await failure(client(conflict).exe.runOnVm("web-0", ["x"]))).kind,
    "decode",
  );
  const headerOnly = script(
    new Response("plain", { headers: { "x-exe-exit": "7" } }),
  );
  const plain = await client(headerOnly).exe.runOnVm("web-0", { shell: "x" }, {
    exit: "header",
  });
  assertEquals([plain.exitCode, plain.exitSource, plain.text], [
    7,
    "header",
    "plain",
  ]);
  assertEquals(headerOnly.calls[0].body, "ssh web-0 x");
  const none = await client(script(new Response("?"))).exe.runOnVm("web-0", {
    shell: "x",
  }, { exit: "header" });
  assertEquals([none.exitCode, none.exitSource], [null, null]);
});

Deno.test("runOnVm treats a 422 carrying the marker as the command's result", async () => {
  const fetch = script((call) => {
    const marker = /(__EXE_EXIT_[0-9a-f]{24}__)/.exec(call.body!)![1];
    return new Response(`boom\n${marker}2\n`, { status: 422 });
  });
  const run = await client(fetch).exe.runOnVm("web-0", ["x"]);
  assertEquals([run.exitCode, run.text], [2, "boom"]);
  const long = "y".repeat(10_000);
  const big = script((call) => {
    const marker = /(__EXE_EXIT_[0-9a-f]{24}__)/.exec(call.body!)![1];
    return new Response(`${long}\n${marker}9\n`, { status: 422 });
  });
  const kept = await client(big).exe.runOnVm("web-0", ["x"]);
  assertEquals([kept.exitCode, kept.text.length], [9, 10_000]);
  const missing = await failure(
    client(script(status(422, { error: "no such VM: web-0" }))).exe.runOnVm(
      "web-0",
      ["x"],
    ),
  );
  assertEquals([missing.kind, missing.detail], [
    "command_failed",
    "no such VM: web-0",
  ]);
});

Deno.test("runOnVm is not retried unless the caller says it is idempotent", async () => {
  const once = script(status(503));
  await failure(client(once).exe.runOnVm("web-0", ["x"]));
  assertEquals(once.calls.length, 1);
  const twice = script(
    status(503),
    new Response("x", { headers: { "x-exe-exit": "0" } }),
  );
  await client(twice).exe.runOnVm("web-0", ["x"], {
    idempotent: true,
    exit: "header",
  });
  assertEquals(twice.calls.length, 2);
});

Deno.test("runOnVm refuses multi-line commands and bad users", async () => {
  const { exe } = client(script());
  const lines = await failure(exe.runOnVm("web-0", { shell: "a\nb" }));
  assert(
    lines.issues[0].message.includes("send multi-line text as {script}"),
    lines.message,
  );
  assertEquals(
    (await failure(exe.runOnVm("web-0", ["x"], { user: "Root!" }))).issues[0]
      .path,
    ["user"],
  );
  const fetch = script(new Response("x", { headers: { "x-exe-exit": "0" } }));
  await client(fetch).exe.runOnVm("web-0", { script: "echo a\necho b\n" }, {
    user: "root",
    exit: "header",
  });
  const words = splitCommandLine(fetch.calls[0].body!);
  assert(words.ok, "lexes");
  assertEquals(words.words.slice(0, 2), ["ssh", "root@web-0"]);
});

Deno.test("startDetached reports the pid of the detached command", async () => {
  const { client: exe, fake: lobby } = fake({
    vmExec: (_vm, command) => ({
      output: command.startsWith("setsid nohup") ? "4242\n" : "",
      exitCode: 0,
    }),
  });
  lobby.seedVm("web-0");
  const started = await exe.startDetached("web-0", ["./build.sh"], {
    log: "/tmp/b.log",
    statusFile: "/tmp/b.status",
  });
  assertEquals([started.pid, started.run.exitCode], [4242, 0]);
});

Deno.test("exec sends raw lines once and returns JSON or text", async () => {
  const fetch = script(
    jsonResponse({ a: 1 }),
    new Response("plain text"),
    status(500),
  );
  const { exe } = client(fetch);
  assertEquals((await exe.exec("whoami")).value, { a: 1 });
  assertEquals((await exe.exec({ path: "whoami" })).value, "plain text");
  await failure(exe.exec("ls"));
  assertEquals(fetch.calls.length, 3);
});

Deno.test("isAlreadyExists recognises name clashes", () => {
  const clash = new ExeApiError("command_failed", "x", {
    status: 422,
    detail: "VM name web-0 already exists",
  });
  assert(isAlreadyExists(clash), "clash");
  assert(
    !isAlreadyExists(
      new ExeApiError("command_failed", "x", { status: 422, detail: "quota" }),
    ),
    "quota",
  );
  assert(!isAlreadyExists(new Error("already exists")), "not an ExeError");
});
