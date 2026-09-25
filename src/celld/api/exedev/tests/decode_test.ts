// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  CreatedVm,
  decodeCreatedVm,
  decodeIntegrations,
  decodeIssuedToken,
  decodeLs,
  decodeSshKeys,
  decodeWhoami,
  ExeDecodeError,
  findToken,
  IntegrationInfo,
  parseStrictJson,
  SshKeyInfo,
  VmSummary,
} from "@celld/api/exedev";

function issues(decode: () => unknown): string[] {
  try {
    decode();
  } catch (error) {
    if (error instanceof ExeDecodeError) {
      return error.issues.map((issue) =>
        `${issue.path.join(".")}: ${issue.message}`
      );
    }
    throw error;
  }
  throw new Error("expected a decode error");
}

Deno.test("decodeLs: the API page's example, tags as list or text", () => {
  const result = decodeLs({
    vms: [
      {
        https_url: "https://bloggy.exe.xyz",
        region: "lon",
        region_display: "London, UK",
        ssh_dest: "bloggy.exe.xyz",
        ssh_host: "bloggy.exe.xyz",
        status: "running",
        vm_name: "bloggy",
      },
      {
        vm_name: "b",
        status: "stopped",
        tags: "prod, web",
        ssh_dest: "vm+b@vm.exe.xyz",
        ssh_user: "vm+b",
        ssh_host: "vm.exe.xyz",
      },
      { vm_name: "c", status: "running", tags: ["x"], comment: null },
    ],
  });
  assertEquals(
    result.vms.map((vm) => [vm.vm_name, vm.status, vm.tags ?? null]),
    [
      ["bloggy", "running", null],
      ["b", "stopped", ["prod", "web"]],
      ["c", "running", ["x"]],
    ],
  );
  assertEquals([result.vms[1].ssh_user, result.vms[1].ssh_host], [
    "vm+b",
    "vm.exe.xyz",
  ]);
  assertEquals(result.vms[2].comment, undefined);
  assertEquals(result.raw.vms, [
    {
      https_url: "https://bloggy.exe.xyz",
      region: "lon",
      region_display: "London, UK",
      ssh_dest: "bloggy.exe.xyz",
      ssh_host: "bloggy.exe.xyz",
      status: "running",
      vm_name: "bloggy",
    },
    {
      vm_name: "b",
      status: "stopped",
      tags: "prod, web",
      ssh_dest: "vm+b@vm.exe.xyz",
      ssh_user: "vm+b",
      ssh_host: "vm.exe.xyz",
    },
    { vm_name: "c", status: "running", tags: ["x"], comment: null },
  ]);
});

Deno.test("the named schemas keep unknown fields in raw only", () => {
  const vm = VmSummary.parse({
    vm_name: "a",
    status: "running",
    plan: "small",
    region: null,
  });
  assertEquals(vm, {
    vm_name: "a",
    status: "running",
    raw: { vm_name: "a", status: "running", plan: "small", region: null },
  });
  const key = SshKeyInfo.parse({ fingerprint: "SHA256:x", extra: 1 });
  assertEquals([key.fingerprint, key.raw.extra], ["SHA256:x", 1]);
  assert(!("extra" in key), "unknown fields stay in raw");
  assertEquals(
    IntegrationInfo.parse({ name: "gh", usedByVMs: [{ vm_name: "x" }, 3] })
      .usedByVMs,
    ["x", "3"],
  );
  assertEquals(CreatedVm.safeParse({ name: "" }).success, false);
});

Deno.test("decodeLs: missing or mistyped fields are located", () => {
  assertEquals(issues(() => decodeLs([])), [
    ": expected object, received array",
  ]);
  assertEquals(issues(() => decodeLs({})), [
    "vms: missing required key",
  ]);
  assertEquals(
    issues(() =>
      decodeLs({
        vms: [1, { vm_name: "a", status: "x", region: 3, tags: [1] }],
      })
    ),
    [
      "vms.0: expected object, received number",
      "vms.1.region: expected string, received number",
      "vms.1.tags.0: expected string, received number",
    ],
  );
});

Deno.test("decodeCreatedVm: vm_name or the legacy name, and routing", () => {
  const vm = decodeCreatedVm({
    vm_name: "jetpack-gray",
    ssh_dest: "jetpack-gray.exe.xyz",
    https_url: "https://jetpack-gray.exe.xyz",
  });
  assertEquals([vm.vm_name, vm.ssh_dest, vm.https_url], [
    "jetpack-gray",
    "jetpack-gray.exe.xyz",
    "https://jetpack-gray.exe.xyz",
  ]);
  assertEquals(
    decodeCreatedVm({ name: "legacy", ssh_dest: "legacy.exe.xyz" }).vm_name,
    "legacy",
  );
  assertEquals(issues(() => decodeCreatedVm({ ssh_dest: "x" })), [
    "vm_name: is missing",
  ]);
  assertEquals(issues(() => decodeCreatedVm({ vm_name: "a", ssh_user: 1 })), [
    "ssh_user: expected string, received number",
  ]);
  // The missing name is reported alongside other fields' issues, but not
  // when a name is there with the wrong type.
  assertEquals(issues(() => decodeCreatedVm({ ssh_user: 1 })), [
    "ssh_user: expected string, received number",
    "vm_name: is missing",
  ]);
  assertEquals(issues(() => decodeCreatedVm({ name: 7 })), [
    "name: expected string, received number",
  ]);
});

Deno.test("raw is the object as received", () => {
  const entry = { vm_name: "a", status: "running", tags: "x, y" };
  const listing = { vms: [entry], total: 1 };
  const result = decodeLs(listing);
  assert(result.raw === listing, "the response itself");
  assert(result.vms[0].raw === entry, "the entry itself");
  assertEquals(result.vms[0].tags, ["x", "y"]);
  const me = { email: "a@b.c", plan: "team" };
  assert(decodeWhoami(me).raw === me, "whoami");
});

Deno.test("decodeWhoami: keys need fingerprints", () => {
  const me = decodeWhoami({
    email: "a@b.c",
    ssh_keys: [{ fingerprint: "SHA256:x", current: true }],
    plan: "small",
  });
  assertEquals([me.email, me.ssh_keys?.length, me.raw.plan], [
    "a@b.c",
    1,
    "small",
  ]);
  assertEquals(decodeWhoami({}).ssh_keys, undefined);
  assertEquals(issues(() => decodeWhoami({ ssh_keys: [{ current: true }] })), [
    "ssh_keys.0.fingerprint: missing required key",
  ]);
  assertEquals(
    issues(() =>
      decodeWhoami({ ssh_keys: [{ fingerprint: "x", current: "yes" }] })
    ),
    [
      "ssh_keys.0.current: expected boolean, received string",
    ],
  );
});

Deno.test("decodeSshKeys: a list, or a list under ssh_keys or keys", () => {
  const key = { fingerprint: "SHA256:x", name: "laptop" };
  assertEquals(decodeSshKeys([key]).map((item) => item.name), ["laptop"]);
  assertEquals(decodeSshKeys({ ssh_keys: [key] }).length, 1);
  assertEquals(decodeSshKeys({ keys: [key] }).length, 1);
  assertEquals(issues(() => decodeSshKeys({ something: [] })), [
    "ssh_keys: expected array, received undefined",
  ]);
});

Deno.test("decodeIntegrations: the GCP guide's top-level array", () => {
  const list = decodeIntegrations([
    {
      name: "gcpwif",
      type: "wif",
      config: { issuer_id: "example-team-workload", subject: "sub-ABC" },
      lastUsedAt: "2026-09-01T00:00:00Z",
      usedByVMs: ["a", { name: "b" }],
    },
    { name: "llm", type: "llm", config: null },
  ]);
  assertEquals(list[0].config?.issuer_id, "example-team-workload");
  assertEquals(list[0].usedByVMs, ["a", "b"]);
  assertEquals(list[1].config, undefined);
  assertEquals(
    decodeIntegrations({ integrations: [{ name: "x" }] })[0].name,
    "x",
  );
  assertEquals(
    issues(() =>
      decodeIntegrations([{ type: "llm" }, { name: "x", config: "secret" }])
    ),
    [
      "0.name: missing required key",
      "1.config: expected object, received string",
    ],
  );
});

Deno.test("issued tokens are found wherever the response puts them", () => {
  assertEquals(decodeIssuedToken({ token: "exe1.abc" }).token, "exe1.abc");
  assertEquals(
    decodeIssuedToken({ result: { api_key: " exe0.a.b " } }).token,
    "exe0.a.b",
  );
  assertEquals(decodeIssuedToken("exe1.xyz").token, "exe1.xyz");
  assertEquals(
    decodeIssuedToken({ note: "use exe1.nope in text", tokens: ["exe1.real"] })
      .token,
    "exe1.real",
  );
  assertEquals(issues(() => decodeIssuedToken({ token: "exe0.a.b" }, "exe1")), [
    ": no exe1 token in the response",
  ]);
  assertEquals(findToken({ nothing: true }), undefined);
});

Deno.test("parseStrictJson reports duplicates at depth and keeps number text", () => {
  const parsed = parseStrictJson('{"a":[1.50,2e3],"b":{"c":true,"d":null}}');
  assert(parsed.ok, "parses");
  assertEquals(parsed.value, { a: [1.5, 2000], b: { c: true, d: null } });
  assertEquals(parsed.numbers.get("a[0]")?.text, "1.50");
  assertEquals(parsed.numbers.get("a[1]")?.text, "2e3");
  const duplicate = parseStrictJson('{"a":{"b":1,"b":2},"__proto__":1}');
  assert(!duplicate.ok, "duplicate");
  assertEquals(duplicate.issues.map((issue) => issue.path), [["a", "b"]]);
  for (
    const bad of [
      "",
      "{",
      '{"a":01}',
      '{"a":1,}',
      '"\\q"',
      "[1] x",
      '"\u0001"',
      "tru",
    ]
  ) {
    assert(!parseStrictJson(bad).ok, JSON.stringify(bad));
  }
  const proto = parseStrictJson('{"__proto__":{"x":1}}');
  assert(
    proto.ok && Object.keys(proto.value as object).includes("__proto__"),
    "own __proto__ key",
  );
});
