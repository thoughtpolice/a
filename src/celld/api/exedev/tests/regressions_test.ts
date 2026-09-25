// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Regressions for the WP-12 sweep (F1 bodies, F2 egress, F3 retries, F7
// numbers, F8 growth) and the WP-12b follow-up (F6, F9, F12, F15, F16,
// F17). Each test names the finding it pins. The bootstrap's shell-level
// regressions are in bootstrap_shell_test.ts.

import { assert, assertEquals } from "@celld/core/assert";
import {
  ExeClient,
  ExeError,
  mintExe0,
  mintingTokenSource,
  signerFromOpenSsh,
  verifyExe0,
} from "@celld/api/exedev";
import {
  FLEET_MAX_INTERVAL_MS,
  fleetIntervalIssues,
  FleetReconciler,
  fleetSpecIssues,
  memoryFleetStore,
  planFleet,
} from "@celld/api/exedev/fleet";
import {
  exeAuth,
  type ExeAuthOptions,
  VmEndpointClient,
} from "@celld/api/exedev/proxy";
import { FakeExe, fakeStep, virtualRuntime } from "@celld/api/exedev/testing";
import {
  VmHttp,
  type VmHttpOptions,
  VmIntegrations,
} from "@celld/api/exedev/vm";
import { router } from "@celld/web/router";
import { bootstrapVm, waitForVm } from "@celld/api/exedev/workflow";
import * as fixture from "./fixtures.ts";

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

function recording(answer: (url: string, init: RequestInit) => Response) {
  const calls: Seen[] = [];
  const fetch = (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    try {
      return Promise.resolve(answer(String(input), init));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { fetch, calls };
}

function throws(work: () => unknown, type: ErrorConstructor, what: string) {
  let thrown: unknown = null;
  try {
    work();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof type, `${what}: ${thrown}`);
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

function endless(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4096).fill(0x61));
      },
    }, { highWaterMark: 0 }),
  );
}

// DB-SWP-F2-2: the lobby origin could be http to any host, and a redirect
// was followed with the bearer token attached.
Deno.test("the lobby origin must be https, and redirects are not followed", async () => {
  for (
    const baseUrl of [
      "http://exe.dev",
      "http://127.0.0.1:8080",
      "https://10.1.2.3",
      "https://[fe80::1]",
      "https://u:p@exe.dev",
    ]
  ) {
    throws(
      () => new ExeClient({ token: "exe1.t", baseUrl }),
      TypeError,
      baseUrl,
    );
  }
  new ExeClient({
    token: "exe1.t",
    baseUrl: "http://127.0.0.1:8080",
    allowLoopbackForDevelopment: true,
  });
  ExeClient.fromEnv({
    EXE_API_TOKEN: "exe1.t",
    EXE_BASE_URL: "http://127.0.0.1:8080",
    EXE_LOOPBACK_FOR_DEVELOPMENT: "true",
  });

  const { fetch, calls } = recording(() =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/exec" },
    })
  );
  const exe = new ExeClient({
    token: "exe1.t",
    fetch,
    runtime: virtualRuntime(),
  });
  const error = await failure(exe.ls());
  assertEquals([error.kind, error.status], ["http", 302]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].init.redirect, "manual");
});

// DB-SWP-F1-4: the lobby's answer was read with arrayBuffer(), whole.
Deno.test("an endless lobby answer is cut at maxResponseBytes", async () => {
  const { fetch } = recording(endless);
  const exe = new ExeClient({
    token: "exe1.t",
    fetch,
    runtime: virtualRuntime(),
    maxResponseBytes: 64 * 1024,
    retry: { maxRetries: 0 },
  });
  const error = await failure(exe.ls());
  assertEquals(error.kind, "decode");
  throws(
    () => new ExeClient({ token: "exe1.t", maxResponseBytes: 2 ** 40 }),
    RangeError,
    "maxResponseBytes",
  );
});

// DB-SWP-F1-5, DB-SWP-F2-3, DB-SWP-F7-5: VmHttp read integration answers
// whole, followed redirects, and took any timeout.
Deno.test("VM-side requests are bounded", async () => {
  for (const timeoutMs of [Number.NaN, -1, 2 ** 31]) {
    throws(() => new VmHttp({ timeoutMs }), RangeError, `${timeoutMs}`);
  }
  const big = recording(endless);
  const http = new VmHttp({
    fetch: big.fetch,
    runtime: virtualRuntime(),
    maxResponseBytes: 64 * 1024,
  });
  assertEquals(
    (await failure(http.request("https://llm.int.exe.xyz/"))).kind,
    "decode",
  );

  const moved = recording(() =>
    new Response(null, {
      status: 307,
      headers: { location: "https://x.example/" },
    })
  );
  const vm = new VmHttp({ fetch: moved.fetch, runtime: virtualRuntime() });
  const error = await failure(vm.request("https://llm.int.exe.xyz/v1/models"));
  assertEquals([error.kind, error.status], ["http", 307]);
  assertEquals(moved.calls[0].init.redirect, "manual");
});

// F05 of the 2026-09-26 review: each attempt has a signal of its own,
// wired to the caller's, which never fires for a caller that has already
// given up; such a request is not sent.
Deno.test("a VM-side request whose signal already fired is not sent", async () => {
  const sent = recording(() => new Response("{}"));
  const http = new VmHttp({ fetch: sent.fetch, runtime: virtualRuntime() });
  const error = await failure(
    http.request("https://llm.int.exe.xyz/", {
      method: "POST",
      signal: AbortSignal.abort(),
    }),
  );
  assertEquals([error.kind, sent.calls.length], ["aborted", 0]);
});

// DB-SWP-F2-4: the VM token rode along on any redirect the VM answered with.
Deno.test("a VM endpoint call never follows a redirect with its token", async () => {
  const { fetch, calls } = recording(() => new Response("ok"));
  const client = new VmEndpointClient({
    vm: "web-0",
    token: "exe0.x.y",
    fetch,
  });
  await client.fetch("/api");
  assertEquals(calls[0].init.redirect, "manual");
  let refused = false;
  try {
    await client.fetch("/api", { redirect: "follow" });
  } catch (error) {
    refused = error instanceof TypeError;
  }
  assert(refused, "redirect: follow is refused");
  throws(
    () =>
      new VmEndpointClient({
        vm: "web-0",
        token: "exe0.x.y",
        origin: "http://web-0.example",
      }),
    TypeError,
    "an http origin off loopback",
  );
});

// DB-SWP-F7-6: an exit status read from a header of any length.
Deno.test("an unreadable exit header is not an exit status", async () => {
  const { fetch } = recording(() =>
    new Response("done\n", { headers: { "x-exe-exit": "9".repeat(400) } })
  );
  const exe = new ExeClient({
    token: "exe1.t",
    fetch,
    runtime: virtualRuntime(),
  });
  const run = await exe.runOnVm("web-0", ["true"], { exit: "header" });
  assertEquals(run.exitCode, null);
});

// DB-SWP-F7-7: token lifetimes and the TTL binding were unchecked.
Deno.test("minted token lifetimes are checked, from options and from env", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  throws(
    () => mintingTokenSource({ signer, ttlSeconds: 10 ** 9 }),
    RangeError,
    "ttlSeconds",
  );
  for (const ttl of ["soon", "1e12", "-5", ""]) {
    throws(
      () =>
        ExeClient.fromEnv({
          EXE_SSH_PRIVATE_KEY: fixture.PRIVATE_KEY,
          EXE_TOKEN_TTL_SECONDS: ttl,
        }),
      RangeError,
      `EXE_TOKEN_TTL_SECONDS=${ttl}`,
    );
  }
});

// DB-SWP-F7-8: verifyExe0 with `now: NaN` skipped the expiry check.
Deno.test("verifyExe0 refuses a clock that is not a number", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const token = await mintExe0({ signer, permissions: { exp: 1_000_000_000 } });
  const expired = await verifyExe0(token, { now: Date.parse("2026-01-01") });
  assertEquals(expired.ok, false);
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
    let outcome: unknown;
    try {
      outcome = await verifyExe0(token, { now });
    } catch (error) {
      outcome = error;
    }
    assert(
      outcome instanceof RangeError ||
        (outcome as { ok: boolean }).ok === false,
      `now ${now} gave ${JSON.stringify(outcome)}`,
    );
  }
});

// DB-SWP-F7-9 and DB-SWP-F8-2: fleet numbers and name lists.
Deno.test("fleet options, intervals and name lists are bounded", () => {
  const spec = { prefix: "web", size: 1 };
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    throws(
      () => planFleet(spec, [], [], 0, { creatingGraceMs: bad }),
      RangeError,
      `creatingGraceMs ${bad}`,
    );
    throws(
      () =>
        new FleetReconciler(
          { ls: () => Promise.resolve({ vms: [] }) } as never,
          memoryFleetStore(),
          { maxMutations: bad },
        ),
      RangeError,
      `maxMutations ${bad}`,
    );
  }
  assert(fleetIntervalIssues(FLEET_MAX_INTERVAL_MS + 1).length > 0, "too long");
  assert(fleetIntervalIssues(1e300).length > 0, "absurd");
  assertEquals(fleetIntervalIssues(60_000), []);
  const names = Array.from({ length: 1001 }, (_, index) => `web-${index}`);
  assert(fleetSpecIssues({ prefix: "web", names }).length > 0, "names capped");
});

// DB-SWP-F7-10: maxPolls reached a loop bound unchecked; NaN meant no polls
// and Infinity meant polls forever.
Deno.test("workflow poll counts are checked", async () => {
  const exe = new ExeClient({
    token: "exe1.t",
    fetch: () => Promise.resolve(new Response('{"vms":[]}')),
    runtime: virtualRuntime(),
  });
  for (const maxPolls of [Number.NaN, 0, Number.POSITIVE_INFINITY, 1.5]) {
    let thrown: unknown = null;
    try {
      await waitForVm(fakeStep(), "wait", exe, "web-0", { maxPolls });
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof RangeError, `maxPolls ${maxPolls}`);
  }
});

function vmReply(reply: (command: string) => string) {
  return (_url: string, init: RequestInit) =>
    new Response(reply(String(init.body)), { headers: { "x-exe-exit": "0" } });
}

// DB-SWP-F7-11: an empty status file read as exit status 0.
Deno.test("an empty bootstrap status is not success", async () => {
  const { fetch } = recording(
    vmReply((command) => command.includes("echo started") ? "started\n" : "\n"),
  );
  const exe = new ExeClient({
    token: "exe1.t",
    fetch,
    runtime: virtualRuntime(),
  });
  const outcome = await bootstrapVm(
    fakeStep(),
    "boot",
    exe,
    "web-0",
    "true\n",
    {
      maxPolls: 1,
      run: { exit: "header" },
    },
  );
  assert(!outcome.ok || outcome.value.exitCode !== 0, JSON.stringify(outcome));
});

// DB-SWP-F3-4: an inline bootstrap whose request failed ambiguously was
// thrown, so the step ran the script again while the first run could still
// be going.
Deno.test("an inline bootstrap is not re-run after an ambiguous failure", async () => {
  const { fetch, calls } = recording(() => {
    throw new TypeError("connection reset");
  });
  const exe = new ExeClient({
    token: "exe1.t",
    fetch,
    runtime: virtualRuntime(),
  });
  const outcome = await bootstrapVm(
    fakeStep(),
    "boot",
    exe,
    "web-0",
    "true\n",
    {
      mode: "inline",
    },
  );
  assert(!outcome.ok, "failed");
  assertEquals(outcome.error.ambiguous, true);
  assertEquals(calls.length, 1);
});

// ----- WP-12b -----

/**
 * Runs `body` with `Object.prototype.__proto__` as V8 (and so workerd)
 * defines it; Deno removes the accessor by default.
 */
function withProtoAccessor<T>(body: () => Promise<T>): Promise<T> {
  const had = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    enumerable: false,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, proto: unknown) {
      if (typeof proto === "object" || typeof proto === "function") {
        Object.setPrototypeOf(this, proto as object | null);
      }
    },
  });
  return body().finally(() => {
    if (had === undefined) {
      delete (Object.prototype as { __proto__?: unknown }).__proto__;
    } else {
      Object.defineProperty(Object.prototype, "__proto__", had);
    }
  });
}

const PROXY_PEER = "203.0.113.7";
const ALICE = {
  "X-ExeDev-UserID": "usr1234",
  "X-ExeDev-Email": "alice@example.com",
};

function behindProxy(trust: ExeAuthOptions["trust"], explicitPeer = true) {
  const app = router({
    auth: exeAuth({ trust }),
    ...(explicitPeer
      ? { clientIp: { peer: (c) => c.req.headers.get("x-test-peer") } }
      : {}),
  });
  app.get(
    "/me",
    (c) => c.json({ subject: c.principal.subject, issuer: c.principal.issuer }),
  );
  app.get(
    "/open",
    { public: true },
    (c) => c.json({ user: c.principal?.subject ?? null }),
  );
  return app;
}

async function status(
  app: ReturnType<typeof behindProxy>,
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const response = await app.fetch(new Request(url, { headers }));
  await response.body?.cancel();
  return response.status;
}

// DB-SWP-F6-13.3: exeAuth made X-ExeDev-UserID the principal whatever peer
// sent it, and applied no cleartext rule.
Deno.test("exeAuth trusts identity headers only from the proxy's peers", async () => {
  throws(
    () => exeAuth({} as ExeAuthOptions),
    TypeError,
    "a missing trust",
  );
  throws(
    () => exeAuth({ trust: { peers: [] } }),
    RangeError,
    "no peers",
  );
  throws(
    () => exeAuth({ trust: { peers: ["not a block"] } }),
    Error,
    "a bad block",
  );
  const app = behindProxy({ peers: ["203.0.113.0/24"] });
  const url = "https://my-vm.exe.xyz/me";
  const fromProxy = await app.fetch(
    new Request(url, { headers: { ...ALICE, "x-test-peer": PROXY_PEER } }),
  );
  assertEquals(await fromProxy.json(), {
    subject: "usr1234",
    issuer: "exe.dev",
  });
  assertEquals(
    await status(app, url, { ...ALICE, "x-test-peer": "198.51.100.9" }),
    403,
  );
  assertEquals(await status(app, url, ALICE), 403);
  // Anonymous requests from anywhere still reach public routes.
  assertEquals(
    await status(app, "https://my-vm.exe.xyz/open", {
      "x-test-peer": "198.51.100.9",
    }),
    200,
  );
  // Without a peer source the router names, no peer is trusted.
  const blind = behindProxy({ peers: ["203.0.113.0/24"] }, false);
  assertEquals(
    await status(blind, url, { ...ALICE, "x-test-peer": PROXY_PEER }),
    403,
  );
  // The router's cleartext rule applies to the identity.
  assertEquals(
    await status(app, "http://my-vm.exe.xyz/me", {
      ...ALICE,
      "x-test-peer": PROXY_PEER,
    }),
    403,
  );
  const custom = behindProxy((c) => c.req.headers.get("x-test-peer") === "ok");
  assertEquals(
    await status(custom, url, { ...ALICE, "x-test-peer": "ok" }),
    200,
  );
  assertEquals(
    await status(custom, url, { ...ALICE, "x-test-peer": "no" }),
    403,
  );
  const any = behindProxy("unsafeAnyPeerForDevelopment", false);
  assertEquals(await status(any, url, ALICE), 200);
});

// DB-SWP-F16-13.1: `scheme: "http"` switched integration origins to
// cleartext with no development name, and the options were read live.
Deno.test("integration origins are https unless cleartext is named for development", () => {
  throws(
    () =>
      new VmIntegrations(
        { scheme: "http" } as unknown as VmHttpOptions,
      ),
    TypeError,
    "the old scheme option",
  );
  assertEquals(
    new VmIntegrations({
      allowCleartextForDevelopment: true,
      domain: "int.test",
    }).origin("x"),
    "http://x.int.test",
  );
  const options: { domain?: string; teamDomain?: string } = {
    domain: "int.example",
    teamDomain: "team.example",
  };
  const vm = new VmIntegrations(options);
  options.domain = "attacker.example";
  options.teamDomain = "attacker.example";
  assertEquals(vm.origin("llm"), "https://llm.int.example");
  assertEquals(vm.origin("x", { team: true }), "https://x.team.example");
});

// DB-SWP-F15-13.2: the reconciler read maxMutations and beforeMutation from
// the caller's object at each run.
Deno.test("the reconciler snapshots its options", async () => {
  const fake = new FakeExe();
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    retry: { maxRetries: 0 },
  });
  const options: { maxMutations?: number; beforeMutation?: () => boolean } = {
    maxMutations: 0,
  };
  const reconciler = new FleetReconciler(client, memoryFleetStore(), options);
  options.maxMutations = 50;
  options.beforeMutation = () => true;
  const report = await reconciler.reconcile({ prefix: "web", size: 1 });
  assertEquals(report.deferred, 1);
  assertEquals(fake.count("new"), 0);
});

// DB-SWP-F12-308: a failed `new` followed by a listing that showed the name
// recorded everything the create would have applied, even for a VM someone
// else had just made.
Deno.test("a VM found after a failed new is adopted without claiming settings", async () => {
  // With tags in the listing the owner tag decides; without them, a
  // definite refusal ("name taken") means someone else made it.
  for (const listDetails of [true, false]) {
    const fake = new FakeExe({ listDetails });
    const client = new ExeClient({
      token: fake.issueAdminToken(),
      fetch: fake.fetch,
      retry: { maxRetries: 0 },
    });
    const racing = new Proxy(client, {
      get(target, property) {
        if (property === "new") {
          return (settings: { name?: string }) => {
            fake.seedVm(settings.name!, { tags: ["someone-else"], cpu: 1 });
            return target.new(settings as never);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = memoryFleetStore();
    const reconciler = new FleetReconciler(racing, store);
    const spec = { prefix: "web", size: 1, cpu: 4, tags: ["web"] };
    const report = await reconciler.reconcile(spec);
    assert(
      report.drift.some((item) => item.vm === "web-0"),
      JSON.stringify(report.drift),
    );
    const [entry] = await store.list();
    assertEquals(entry.applied.tags, []);
    assertEquals(entry.applied.cpu, null);
    // The next run converges the adopted VM: it gets the owner tag.
    await reconciler.reconcile(spec);
    assert(
      fake.vms.get("web-0")!.tags.includes("fleet-web"),
      JSON.stringify(fake.vms.get("web-0")),
    );
  }
});

// DB-SWP-F9-304: the fake parsed `--env` into `{}` by assignment, so a
// variable named __proto__ was dropped.
Deno.test("the fake keeps an env variable named __proto__", () =>
  withProtoAccessor(async () => {
    const fake = new FakeExe();
    const client = new ExeClient({
      token: fake.issueAdminToken(),
      fetch: fake.fetch,
      retry: { maxRetries: 0 },
    });
    await client.new({
      name: "web-0",
      env: { ["__proto__"]: "x", A: "1" } as never,
    });
    const env = fake.vms.get("web-0")!.env;
    assert(Object.hasOwn(env, "__proto__"), JSON.stringify(env));
    assertEquals(env["__proto__"], "x");
    assertEquals(Object.getPrototypeOf(env), Object.prototype);
  }));
