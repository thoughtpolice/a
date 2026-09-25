// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  ExeClient,
  ExeInvalidRequestError,
  type VmSummary,
} from "@celld/api/exedev";
import {
  desiredNames,
  FleetReconciler,
  FleetSpec,
  fleetSpecIssues,
  type LedgerEntry,
  memoryFleetStore,
  newVmOptions,
  NOTHING_APPLIED,
  ownerTag,
  planFleet,
} from "@celld/api/exedev/fleet";
import { FakeExe, virtualRuntime } from "@celld/api/exedev/testing";

const NOW = 1_800_000_000_000;

function vm(name: string, extra: Partial<VmSummary> = {}): VmSummary {
  return { vm_name: name, status: "running", raw: {}, ...extra };
}

function entry(name: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    name,
    phase: "present",
    intentAt: NOW,
    updatedAt: NOW,
    attempts: 0,
    applied: NOTHING_APPLIED,
    lastError: null,
    ...extra,
  };
}

function kinds(actions: readonly { kind: string; vm: string }[]): string[] {
  return actions.map((action) => `${action.kind} ${action.vm}`);
}

function setup(options: ConstructorParameters<typeof FakeExe>[0] = {}) {
  const fake = new FakeExe(options);
  const runtime = virtualRuntime({ start: NOW });
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    runtime,
    retry: { maxRetries: 0 },
  });
  const store = memoryFleetStore();
  const reconciler = new FleetReconciler(client, store, { runtime });
  return { fake, runtime, client, store, reconciler };
}

Deno.test("specs are validated and name their VMs deterministically", () => {
  assertEquals(desiredNames({ prefix: "web", size: 3 }), [
    "web-0",
    "web-1",
    "web-2",
  ]);
  assertEquals(desiredNames({ prefix: "web", names: ["a", "b"] }), ["a", "b"]);
  assertEquals(desiredNames({ prefix: "web" }), []);
  assertEquals(ownerTag({ prefix: "web" }), "fleet-web");
  assertEquals(ownerTag({ prefix: "web", ownerTag: "mine" }), "mine");
  assertEquals(
    fleetSpecIssues({
      prefix: "Web",
      size: 2,
      names: ["a", "a"],
      cpu: 0,
      memory: "big",
      tags: ["a b"],
      region: "LONDON",
      share: { port: 0 },
      env: { "bad key": "x" },
      comment: "-x",
    }).map((issue) => issue.path.join(".")),
    [
      "prefix",
      "cpu",
      "memory",
      "comment",
      "tags.0",
      "env.bad key",
      "region",
      "share.port",
    ],
  );
  // The cross-field rules run once every field is valid.
  assertEquals(
    fleetSpecIssues({ prefix: "web", size: 2, names: ["a", "a"] }).map((
      issue,
    ) => `${issue.path.join(".")}: ${issue.message}`),
    ["size: give size or names, not both", "names: has duplicates"],
  );
  // A strict object: a misspelled key is an error, not ignored.
  assertEquals(
    fleetSpecIssues({ prefix: "web", sise: 2 }).map((issue) => issue.message),
    ['unrecognized key: "sise"'],
  );
  assertEquals(FleetSpec.parse({ prefix: "web", size: 1 }), {
    prefix: "web",
    size: 1,
  });
  try {
    planFleet({ prefix: "" }, [], [], NOW);
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeInvalidRequestError, String(error));
  }
});

Deno.test("newVmOptions carries the spec and the owner tag", () => {
  assertEquals(
    newVmOptions({
      prefix: "web",
      tags: ["prod", "fleet-web"],
      cpu: 2,
      memory: 8,
      integrations: ["llm"],
      noEmail: false,
    }, "web-0"),
    {
      name: "web-0",
      cpu: 2,
      memory: "8",
      tags: ["fleet-web", "prod"],
      integrations: ["llm"],
      noEmail: false,
    },
  );
});

Deno.test("plan: create missing, await recent intents, retry stale ones", () => {
  const plan = planFleet(
    { prefix: "web", size: 3 },
    [vm("web-0")],
    [
      entry("web-0", { applied: { ...NOTHING_APPLIED, tags: ["fleet-web"] } }),
      entry("web-1", { phase: "creating", intentAt: NOW - 1000 }),
      entry("web-2", { phase: "creating", intentAt: NOW - 600_000 }),
    ],
    NOW,
    { creatingGraceMs: 60_000 },
  );
  assertEquals(kinds(plan.actions), ["await web-1", "create web-2"]);
});

Deno.test("plan: adopt VMs that exist without a present record", () => {
  const plan = planFleet(
    { prefix: "web", size: 2, tags: ["prod"] },
    [
      vm("web-0", { tags: ["fleet-web", "prod", "hand-made"] }),
      vm("web-1"),
    ],
    [entry("web-1", { phase: "creating" })],
    NOW,
  );
  assertEquals(kinds(plan.actions), ["adopt web-0", "adopt web-1"]);
  const adopted = plan.actions[0] as unknown as { applied: { tags: string[] } };
  // Only the owner tag is claimed: hand-made tags are never removed.
  assertEquals(adopted.applied.tags, ["fleet-web"]);
});

Deno.test("plan: tags converge using observed tags, touching only managed ones", () => {
  const spec: FleetSpec = { prefix: "web", size: 1, tags: ["prod", "blue"] };
  const applied = { ...NOTHING_APPLIED, tags: ["fleet-web", "prod", "green"] };
  const observed = planFleet(
    spec,
    [vm("web-0", { tags: ["fleet-web", "prod", "green", "hand-made"] })],
    [entry("web-0", { applied })],
    NOW,
  );
  assertEquals(observed.actions, [
    { kind: "tag", vm: "web-0", tags: ["blue"] },
    { kind: "untag", vm: "web-0", tags: ["green"] },
  ]);
  const blind = planFleet(
    spec,
    [vm("web-0")],
    [entry("web-0", { applied })],
    NOW,
  );
  assertEquals(blind.actions, observed.actions);
  const removedByHand = planFleet(
    spec,
    [vm("web-0", { tags: ["fleet-web", "prod"] })],
    [entry("web-0", { applied })],
    NOW,
  );
  assertEquals(removedByHand.actions, [{
    kind: "tag",
    vm: "web-0",
    tags: ["blue"],
  }]);
});

Deno.test("plan: comment, resize, integrations and sharing", () => {
  const spec: FleetSpec = {
    prefix: "web",
    size: 1,
    comment: "web tier",
    cpu: 4,
    memory: "16G",
    disk: "50GB",
    integrations: ["llm", "gh"],
    share: { public: true, port: 8080 },
  };
  const applied = {
    ...NOTHING_APPLIED,
    tags: ["fleet-web"],
    comment: "old",
    cpu: 2,
    memory: "16GB",
    disk: "20",
    integrations: ["llm", "old-proxy"],
    sharePort: 8080,
  };
  const plan = planFleet(
    spec,
    [vm("web-0")],
    [entry("web-0", { applied })],
    NOW,
  );
  assertEquals(plan.actions, [
    { kind: "comment", vm: "web-0", text: "web tier" },
    { kind: "resize", vm: "web-0", cpu: 4, disk: "50GB" },
    { kind: "attach", vm: "web-0", integration: "gh" },
    { kind: "detach", vm: "web-0", integration: "old-proxy" },
    { kind: "share-visibility", vm: "web-0", public: true },
  ]);
  const same = planFleet(spec, [vm("web-0", { comment: "web tier" })], [
    entry("web-0", {
      applied: {
        ...applied,
        comment: "stale",
        cpu: 4,
        disk: "50GB",
        integrations: ["llm", "gh"],
        sharePublic: true,
      },
    }),
  ], NOW);
  assertEquals(same.actions, []);
});

Deno.test("plan: drift the fleet reports instead of fixing", () => {
  const spec: FleetSpec = {
    prefix: "web",
    size: 1,
    disk: "10G",
    region: "lax",
  };
  const plan = planFleet(spec, [
    vm("web-0", { region: "fra", status: "stopped" }),
    vm("web-7"),
    vm("stray", { tags: ["fleet-web"] }),
  ], [
    entry("web-0", {
      applied: { ...NOTHING_APPLIED, tags: ["fleet-web"], disk: "20G" },
    }),
    entry("web-3"),
  ], NOW);
  assertEquals(plan.drift.map((item) => `${item.kind} ${item.vm}`), [
    "disk-shrink web-0",
    "region web-0",
    "status web-0",
    "unowned-extra web-7",
    "extra stray",
  ]);
  assertEquals(kinds(plan.actions), ["forget web-3"]);
  const unknownDisk = planFleet(spec, [vm("web-0")], [
    entry("web-0", { applied: { ...NOTHING_APPLIED, tags: ["fleet-web"] } }),
  ], NOW);
  assertEquals(unknownDisk.drift.map((item) => item.kind), [
    "setting-unapplied",
  ]);
});

Deno.test("plan: prune deletes owned VMs only, and waits on recent deletes", () => {
  const spec: FleetSpec = { prefix: "web", size: 1, prune: true };
  const plan = planFleet(spec, [
    vm("web-0", { tags: ["fleet-web"] }),
    vm("web-1", { tags: ["fleet-web"] }),
    vm("web-2"),
    vm("web-3"),
    vm("other", { tags: ["fleet-web"] }),
  ], [
    entry("web-0", { applied: { ...NOTHING_APPLIED, tags: ["fleet-web"] } }),
    entry("web-2"),
    entry("web-3", { phase: "deleting", intentAt: NOW - 5_000 }),
  ], NOW);
  assertEquals(kinds(plan.actions), [
    "delete web-2",
    "await web-3",
    "delete web-1",
    "delete other",
  ]);
  assertEquals(plan.drift, []);
});

Deno.test("reconcile creates the fleet, then does nothing", async () => {
  const { fake, reconciler, store } = setup();
  const spec: FleetSpec = {
    prefix: "web",
    size: 3,
    tags: ["prod"],
    comment: "web tier",
    cpu: 2,
  };
  const first = await reconciler.reconcile(spec);
  assertEquals(
    first.results.map((result) =>
      `${result.action.kind} ${result.action.vm} ${result.ok}`
    ),
    [
      "create web-0 true",
      "create web-1 true",
      "create web-2 true",
    ],
  );
  assertEquals([...fake.vms.keys()].sort(), ["web-0", "web-1", "web-2"]);
  assertEquals(fake.vms.get("web-1")!.tags, ["fleet-web", "prod"]);
  assertEquals(fake.vms.get("web-1")!.comment, "web tier");
  assertEquals([...store.entries.values()].map((item) => item.phase), [
    "present",
    "present",
    "present",
  ]);
  const second = await reconciler.reconcile(spec);
  assertEquals([second.results, second.converged, second.observed], [[], true, [
    "web-0",
    "web-1",
    "web-2",
  ]]);
  assertEquals(fake.count("new"), 3);
});

Deno.test("an ambiguous new whose VM landed is adopted, not repeated", async () => {
  const { fake, reconciler, store } = setup();
  fake.failNext("new", { status: 504, execute: true });
  const report = await reconciler.reconcile({ prefix: "db", size: 1 });
  assertEquals(report.results[0].ok, true);
  assert(
    report.results[0].note?.includes("exists; adopted") ?? false,
    JSON.stringify(report.results[0]),
  );
  assertEquals(store.entries.get("db-0")?.phase, "present");
  assertEquals(fake.count("new"), 1);
  assertEquals(
    (await reconciler.reconcile({ prefix: "db", size: 1 })).converged,
    true,
  );
});

Deno.test("a lost new that did not land waits out the grace, then retries once", async () => {
  const { fake, reconciler, runtime, store } = setup();
  fake.failNext("new", { connection: true });
  const first = await reconciler.reconcile({ prefix: "db", size: 1 });
  assertEquals([first.results[0].ok, first.results[0].error?.kind], [
    false,
    "connection",
  ]);
  assertEquals(store.entries.get("db-0")?.phase, "creating");
  const waiting = await reconciler.reconcile({ prefix: "db", size: 1 });
  assertEquals(kinds(waiting.results.map((result) => result.action)), [
    "await db-0",
  ]);
  assertEquals(waiting.converged, false);
  runtime.advance(121_000);
  const retried = await reconciler.reconcile({ prefix: "db", size: 1 });
  assertEquals(retried.results.map((result) => result.ok), [true]);
  assertEquals([fake.count("new"), fake.vms.size], [2, 1]);
  assertEquals(store.entries.get("db-0")?.attempts, 0);
});

Deno.test("a crash after the intent is resolved by listing", async () => {
  const { fake, reconciler, store } = setup();
  // An earlier run recorded the intent and sent new, then died.
  store.put(
    entry("web-0", { phase: "creating", intentAt: NOW - 1000, attempts: 1 }),
  );
  fake.seedVm("web-0", { tags: ["fleet-web"] });
  const report = await reconciler.reconcile({ prefix: "web", size: 1 });
  assertEquals(kinds(report.results.map((result) => result.action)), [
    "adopt web-0",
  ]);
  assertEquals(store.entries.get("web-0")?.applied.tags, ["fleet-web"]);
  assertEquals(fake.count("new"), 0);
});

Deno.test("definite failures are reported and backed off", async () => {
  const { fake, reconciler } = setup({ maxVms: 1 });
  const report = await reconciler.reconcile({ prefix: "web", size: 2 });
  assertEquals(
    report.results.map((
      result,
    ) => [result.action.vm, result.ok, result.error?.kind ?? null]),
    [
      ["web-0", true, null],
      ["web-1", false, "command_failed"],
    ],
  );
  assertEquals(report.converged, false);
  const again = await reconciler.reconcile({ prefix: "web", size: 2 });
  assertEquals(kinds(again.results.map((result) => result.action)), [
    "await web-1",
  ]);
  assertEquals(fake.count("new"), 2);
});

Deno.test("a listing failure acts on nothing", async () => {
  const { fake, reconciler } = setup();
  fake.failNext("ls", { status: 500 });
  const report = await reconciler.reconcile({ prefix: "web", size: 2 });
  assertEquals([report.error?.kind, report.results, report.converged], [
    "server",
    [],
    false,
  ]);
  assertEquals(fake.count("new"), 0);
});

Deno.test("changes converge: tags, comment, resize, integrations, sharing", async () => {
  const { fake, reconciler, client, store } = setup();
  await client.integrations.add({
    type: "reflection",
    name: "reflection",
    fields: "all",
  });
  await client.integrations.add({ type: "llm", name: "llm" });
  const spec: FleetSpec = {
    prefix: "web",
    size: 1,
    tags: ["prod"],
    integrations: ["reflection"],
    cpu: 2,
  };
  await reconciler.reconcile(spec);
  const next: FleetSpec = {
    ...spec,
    tags: ["canary"],
    comment: "canary box",
    cpu: 4,
    integrations: ["llm"],
    share: { port: 8000, public: true },
  };
  const report = await reconciler.reconcile(next);
  assertEquals(
    report.results.map((result) => `${result.action.kind} ${result.ok}`),
    [
      "tag true",
      "untag true",
      "comment true",
      "resize true",
      "attach true",
      "detach true",
      "share-port true",
      "share-visibility true",
    ],
  );
  const vm = fake.vms.get("web-0")!;
  assertEquals([
    vm.tags,
    vm.comment,
    vm.cpu,
    [...vm.integrations],
    vm.sharePort,
    vm.sharePublic,
  ], [
    ["fleet-web", "canary"],
    "canary box",
    4,
    ["llm"],
    8000,
    true,
  ]);
  assertEquals(store.entries.get("web-0")?.applied.integrations, ["llm"]);
  assertEquals((await reconciler.reconcile(next)).converged, true);
});

Deno.test("without tags in the listing, the ledger still converges tags", async () => {
  const { fake, reconciler } = setup({ listDetails: false });
  await reconciler.reconcile({ prefix: "web", size: 1, tags: ["a"] });
  await reconciler.reconcile({ prefix: "web", size: 1, tags: ["b"] });
  assertEquals(fake.vms.get("web-0")!.tags, ["fleet-web", "b"]);
  assertEquals(
    (await reconciler.reconcile({ prefix: "web", size: 1, tags: ["b"] }))
      .converged,
    true,
  );
});

Deno.test("a failed setting is retried on the next run", async () => {
  const { fake, reconciler } = setup();
  await reconciler.reconcile({ prefix: "web", size: 1 });
  fake.failNext("comment", { status: 500 });
  const failed = await reconciler.reconcile({
    prefix: "web",
    size: 1,
    comment: "x",
  });
  assertEquals(failed.results.map((result) => result.ok), [false]);
  const retried = await reconciler.reconcile({
    prefix: "web",
    size: 1,
    comment: "x",
  });
  assertEquals(retried.results.map((result) => result.ok), [true]);
  assertEquals(fake.vms.get("web-0")!.comment, "x");
});

Deno.test("shrinking with prune deletes, and a lost rm is confirmed by listing", async () => {
  const { fake, reconciler, store } = setup();
  await reconciler.reconcile({ prefix: "web", size: 3 });
  fake.failNext("rm", { connection: true, execute: true });
  const report = await reconciler.reconcile({
    prefix: "web",
    size: 1,
    prune: true,
  });
  assertEquals(
    report.results.map((result) =>
      `${result.action.kind} ${result.action.vm} ${result.ok}`
    ),
    [
      "delete web-1 true",
      "delete web-2 true",
    ],
  );
  assert(
    report.results[0].note?.includes("is gone") ?? false,
    JSON.stringify(report.results[0]),
  );
  assertEquals([...fake.vms.keys()], ["web-0"]);
  assertEquals([...store.entries.keys()], ["web-0"]);
});

Deno.test("without prune, surplus VMs are reported and kept", async () => {
  const { fake, reconciler } = setup();
  await reconciler.reconcile({ prefix: "web", size: 2 });
  const report = await reconciler.reconcile({ prefix: "web", size: 1 });
  assertEquals(report.drift.map((item) => `${item.kind} ${item.vm}`), [
    "extra web-1",
  ]);
  assertEquals(report.converged, false);
  assertEquals(fake.vms.size, 2);
});

Deno.test("the mutation cap defers the rest to the next run", async () => {
  const { fake, store } = setup();
  const runtime = virtualRuntime({ start: NOW });
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    runtime,
  });
  const capped = new FleetReconciler(client, store, {
    runtime,
    maxMutations: 2,
  });
  const first = await capped.reconcile({ prefix: "web", size: 5 });
  assertEquals([first.results.length, first.deferred, first.converged], [
    2,
    3,
    false,
  ]);
  const second = await capped.reconcile({ prefix: "web", size: 5 });
  assertEquals([second.results.length, second.deferred], [2, 1]);
  await capped.reconcile({ prefix: "web", size: 5 });
  assertEquals(fake.vms.size, 5);
});

Deno.test("beforeMutation can stop a run (a lost lease)", async () => {
  const { fake, store } = setup();
  const runtime = virtualRuntime({ start: NOW });
  const client = new ExeClient({
    token: fake.issueAdminToken(),
    fetch: fake.fetch,
    runtime,
  });
  let allowed = 1;
  const reconciler = new FleetReconciler(client, store, {
    runtime,
    beforeMutation: () => allowed-- > 0,
  });
  const report = await reconciler.reconcile({ prefix: "web", size: 3 });
  assertEquals([report.results.length, report.deferred, fake.vms.size], [
    1,
    2,
    1,
  ]);
});

Deno.test("plan() is a dry run", async () => {
  const { fake, reconciler } = setup();
  const plan = await reconciler.plan({ prefix: "web", size: 2 });
  assertEquals(kinds(plan.actions), ["create web-0", "create web-1"]);
  assertEquals(fake.count("new"), 0);
});
