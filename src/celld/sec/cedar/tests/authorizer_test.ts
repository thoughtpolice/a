// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertOk,
  assertThrows,
} from "@celld/core/assert";
import {
  Authorizer,
  CEDAR_WASM,
  CedarEngine,
  CedarError,
  EntitySet,
  ip,
  MemoryEntities,
  PolicySet,
  PREPARSED_CAPACITY,
  ref,
  uid,
} from "@celld/sec/cedar";
import {
  alice,
  bob,
  carol,
  doc,
  FOLDERS,
  POLICIES,
  SCHEMA,
  USERS,
} from "./fixture.ts";

const store = new MemoryEntities([
  ...USERS,
  ...FOLDERS,
  doc("plan"),
  doc("memo", { owner: "bob", public: true }),
  doc("spec", { owner: "bob", folder: "eng" }),
  doc("secret", { owner: "bob", classification: 4 }),
]);
const authorizer = new Authorizer({
  policies: POLICIES,
  schema: SCHEMA,
  entities: store,
});
const context = { mfa: false };

Deno.test("owners, public documents, team folders and clearance", async () => {
  const cases: [typeof alice, string, string, boolean, string[]][] = [
    [alice, "edit", "plan", true, ["owners"]],
    [bob, "read", "plan", false, []],
    [bob, "read", "memo", true, ["owners", "public-read"]],
    [alice, "read", "memo", true, ["public-read"]],
    [alice, "edit", "memo", false, []],
    [alice, "comment", "spec", true, ["team-folder"]],
    [bob, "read", "secret", true, ["owners"]],
    [alice, "read", "secret", false, []],
    [carol, "read", "secret", true, ["clearance"]],
  ];
  for (const [principal, action, resource, allowed, reasons] of cases) {
    const decision = await authorizer.authorize({
      principal,
      action,
      resource: uid("Doc", resource),
      context,
    });
    assertEquals(
      decision.allowed,
      allowed,
      `${principal.id} ${action} ${resource}`,
    );
    assertEquals(
      [...decision.reasons].sort(),
      reasons,
      `${principal.id} ${action} ${resource}`,
    );
    assertEquals(decision.invalid, undefined);
  }
});

Deno.test("action groups come from the schema", async () => {
  // delete is in manage, which admins may do; the schema supplies the group.
  const decision = await authorizer.authorize({
    principal: carol,
    action: "delete",
    resource: uid("Doc", "plan"),
    context: { mfa: true },
  });
  assertEquals(decision.reasons, ["admins"]);
  const notInGroup = await authorizer.authorize({
    principal: carol,
    action: "edit",
    resource: uid("Doc", "plan"),
    context,
  });
  assertEquals(notInGroup.allowed, false);
});

Deno.test("forbid overrides permit", async () => {
  const denied = await authorizer.authorize({
    principal: alice,
    action: "delete",
    resource: uid("Doc", "plan"),
    context,
  });
  assertEquals(denied.allowed, false);
  assertEquals(denied.reasons, ["no-delete-without-mfa"]);
  const allowed = await authorizer.authorize({
    principal: alice,
    action: "delete",
    resource: uid("Doc", "plan"),
    context: { mfa: true },
  });
  assertEquals(allowed.allowed, true);
});

Deno.test("a request the schema refuses is a deny with the reason", async () => {
  const missing = await authorizer.authorize({
    principal: alice,
    action: "edit",
    resource: uid("Doc", "plan"),
  });
  assertEquals(missing.allowed, false);
  assert(
    missing.invalid !== undefined && /context/.test(missing.invalid[0].message),
    JSON.stringify(missing),
  );
  const wrongType = await authorizer.authorize({
    principal: uid("Team", "eng"),
    action: "read",
    resource: uid("Doc", "plan"),
    context,
  });
  assert(wrongType.invalid !== undefined, JSON.stringify(wrongType));
  const unknownAction = await authorizer.authorize({
    principal: alice,
    action: "fly",
    resource: uid("Doc", "plan"),
    context,
  });
  assert(unknownAction.invalid !== undefined, JSON.stringify(unknownAction));
  const badValue = await authorizer.authorize({
    principal: alice,
    action: "read",
    resource: uid("Doc", "plan"),
    context: { mfa: false, n: 1.5 } as never,
  });
  assert(
    badValue.invalid !== undefined &&
      badValue.invalid[0].message.includes("safe integer"),
    JSON.stringify(badValue),
  );
});

Deno.test("extension values reach the schema's typed context", async () => {
  const decision = await authorizer.authorize({
    principal: alice,
    action: "read",
    resource: uid("Doc", "plan"),
    context: { mfa: true, ip: ip("10.1.2.3") },
  });
  assertEquals(decision.allowed, true);
});

Deno.test("a policy that errors does not apply and is reported", () => {
  const erroring = new Authorizer({
    policies:
      '@id("bad") permit(principal, action, resource) when { resource.missing == 1 };\n@id("ok") permit(principal, action, resource) when { context.ok };',
  });
  const decision = erroring.check({
    principal: alice,
    action: "read",
    resource: uid("Doc", "d"),
    context: { ok: true },
  });
  assertEquals(decision.allowed, true);
  assertEquals(decision.reasons, ["ok"]);
  assertEquals(decision.errors.map((e) => e.policyId), ["bad"]);
});

Deno.test("policies that do not validate are refused at construction", () => {
  const error = assertThrows(
    () =>
      new Authorizer({
        policies:
          '@id("typo") permit(principal, action, resource) when { resource.titel == "x" };',
        schema: SCHEMA,
      }),
    CedarError,
    "do not validate",
  );
  assert(error.message.includes("resource.titel"), error.message);
  new Authorizer({
    policies:
      '@id("typo") permit(principal, action, resource) when { resource.titel == "x" };',
    schema: SCHEMA,
    validatePolicies: false,
  });
});

Deno.test("links grant through templates", () => {
  const set = assertOk(
    assertOk(PolicySet.parse(POLICIES)).value.link({
      id: "bob-plan",
      template: "viewer",
      principal: bob,
      resource: uid("Doc", "plan"),
    }),
  ).value;
  const shared = new Authorizer({ policies: set, schema: SCHEMA });
  const entities = new EntitySet([...USERS, doc("plan")]);
  const decision = shared.check({
    principal: bob,
    action: "read",
    resource: uid("Doc", "plan"),
    context,
    entities,
  });
  assertEquals(decision.reasons, ["bob-plan"]);
});

Deno.test("permittedActions and filter load once and answer per item", async () => {
  const actions = await authorizer.permittedActions({
    principal: alice,
    resource: uid("Doc", "spec"),
    context,
  }, ["read", "comment", "edit", "delete"]);
  assertEquals(actions.map((a) => a.id), ["read", "comment"]);
  const owner = await authorizer.permittedActions({
    principal: alice,
    resource: uid("Doc", "plan"),
    context,
  }, ["read", "comment", "edit", "delete"]);
  assertEquals(owner.map((a) => a.id), ["read", "comment", "edit"]);
  let loads = 0;
  const counting = new Authorizer({
    policies: POLICIES,
    schema: SCHEMA,
    entities: { load: (uids, options) => (loads++, store.load(uids, options)) },
  });
  const ids = ["plan", "memo", "spec", "secret", "missing"];
  const visible = await counting.filter(
    ids,
    (id) => ({
      principal: alice,
      action: "read",
      resource: uid("Doc", id),
      context,
    }),
  );
  assertEquals(visible, ["plan", "memo", "spec"]);
  assertEquals(loads, 1);
});

Deno.test("authorizers beyond the engine's capacity take turns preparsing", () => {
  const engine = new CedarEngine(CEDAR_WASM);
  const many = Array.from(
    { length: PREPARSED_CAPACITY + 3 },
    (_, i) =>
      new Authorizer({
        engine,
        policies:
          `@id("p${i}") permit(principal, action, resource) when { context.n == ${i} };`,
      }),
  );
  for (let round = 0; round < 2; round++) {
    many.forEach((a, i) => {
      const decision = a.check({
        principal: alice,
        action: "read",
        resource: uid("Doc", "x"),
        context: { n: i },
      });
      assertEquals(decision.reasons, [`p${i}`]);
    });
  }
});

Deno.test("an engine reset is survived", () => {
  const engine = new CedarEngine(CEDAR_WASM);
  const a = new Authorizer({
    engine,
    policies: "permit(principal, action, resource);",
    schema: SCHEMA,
  });
  const request = {
    principal: alice,
    action: "read",
    resource: uid("Doc", "x"),
    context,
  };
  assertEquals(a.check(request).allowed, true);
  engine.reset();
  assertEquals(a.check(request).allowed, true);
});

Deno.test("partial evaluation leaves conditions on the unknown resource", () => {
  const residuals = authorizer.partial({
    principal: alice,
    action: "read",
    context,
    entities: USERS,
  });
  assertEquals(residuals.decision, null);
  const ids = residuals.residuals.map((r) => r.id).sort();
  assert(
    ids.includes("owners") && ids.includes("public-read") &&
      ids.includes("team-folder"),
    ids.join(),
  );
  assert(
    !ids.includes("no-delete-without-mfa") && !ids.includes("admins"),
    "policies about other actions are gone",
  );
  const owners = residuals.residuals.find((r) => r.id === "owners")!;
  assert(
    JSON.stringify(owners.policy).includes('"unknown"'),
    JSON.stringify(owners.policy),
  );
});

Deno.test("entities and references are checked before Cedar sees them", () => {
  const decision = authorizer.check({
    principal: alice,
    action: "read",
    resource: uid("Doc", "x"),
    context,
    entities: [{
      uid: uid("Doc", "x"),
      attrs: { owner: JSON.parse('{"__entity":{"type":"User","id":"alice"}}') },
    }],
  });
  assertEquals(decision.allowed, false);
  assert(
    decision.invalid![0].message.includes("escape keys"),
    JSON.stringify(decision),
  );
  const ok = authorizer.check({
    principal: alice,
    action: "read",
    resource: uid("Doc", "x"),
    context,
    entities: [{
      uid: uid("Doc", "x"),
      attrs: { owner: ref(alice), public: false, title: "x", tags: [] },
    }],
  });
  assertEquals(ok.reasons, ["owners"]);
});
