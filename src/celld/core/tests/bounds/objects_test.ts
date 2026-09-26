// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  jsonSnapshot,
  opaqueIdentity,
  type SnapshotLimits,
  strictRecord,
} from "@celld/core/bounds";
import { assert, assertEquals, assertThrows } from "./assert.ts";

Deno.test("strict records reject ignored options and getters without running them", () => {
  let invoked = false;
  const inputs = [
    null,
    [],
    new Date(),
    { typo: true },
    Object.create({ allowed: true }),
    {
      get allowed() {
        invoked = true;
        return true;
      },
    },
  ];
  for (const input of inputs) {
    assertThrows(() => strictRecord(input, ["allowed"]));
  }
  assert(!invoked, "getter must not run");
  strictRecord({ allowed: false }, ["allowed"]);
  strictRecord(Object.assign(Object.create(null), { allowed: true }), [
    "allowed",
  ]);
});

Deno.test("opaque identity is stable, domain separated, and DNS safe", async () => {
  const key = new Uint8Array(32).fill(7);
  const first = await opaqueIdentity(
    key,
    "sandbox",
    "issuer\0tenant\0client\0subject",
  );
  assert(/^[a-z2-7]{52}$/.test(first), "fixed DNS-safe digest");
  assertEquals(
    first,
    await opaqueIdentity(key, "sandbox", "issuer\0tenant\0client\0subject"),
  );
  assert(
    first !==
      await opaqueIdentity(key, "broker", "issuer\0tenant\0client\0subject"),
    "purpose separation",
  );
  assert(
    first !==
      await opaqueIdentity(key, "sandbox", "other\0tenant\0client\0subject"),
    "issuer separation",
  );
  assert(
    first !==
      await opaqueIdentity(
        new Uint8Array(32).fill(8),
        "sandbox",
        "issuer\0tenant\0client\0subject",
      ),
    "key separation",
  );
});

Deno.test("JSON snapshots isolate nested authorization state with bounded work", () => {
  for (const key of ["maxDepth", "maxItems", "maxBytes"]) {
    assertThrows(() => jsonSnapshot({}, { [key]: null } as SnapshotLimits));
  }
  const input = { scopes: ["read"], nested: { approved: true } };
  const result = jsonSnapshot(input);
  input.scopes.push("write");
  input.nested.approved = false;
  assertEquals(result, { scopes: ["read"], nested: { approved: true } });
  assertThrows(() => result.scopes.push("admin"));
  assert(Object.isFrozen(result.nested), "nested state immutable");
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (
    const value of [
      cycle,
      [undefined],
      NaN,
      new Date(),
      JSON.parse('{"__proto__":{}}'),
      new Array(2),
    ]
  ) assertThrows(() => jsonSnapshot(value));
  let invoked = false;
  assertThrows(() =>
    jsonSnapshot({
      get x() {
        invoked = true;
        return 1;
      },
    })
  );
  assert(!invoked, "getter must not run");
  assertEquals(jsonSnapshot("é", { maxBytes: 4 }), "é");
  assertThrows(() => jsonSnapshot("é", { maxBytes: 3 }));
  assertThrows(() => jsonSnapshot([1, 2], { maxItems: 2 }));
  assertThrows(() => jsonSnapshot({ x: { y: 1 } }, { maxDepth: 1 }));
});
