// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertOk } from "@celld/core/assert";
import {
  formatDiagnostic,
  PolicySet,
  requestEnvs,
  Schema,
  uid,
  validatePolicies,
} from "@celld/sec/cedar";
import { POLICIES, SCHEMA } from "./fixture.ts";

Deno.test("a schema parses from text or JSON and lists its types and actions", () => {
  const schema = assertOk(Schema.parse(SCHEMA)).value;
  assertEquals(schema.entityTypes().sort(), ["Doc", "Folder", "Team", "User"]);
  assertEquals(schema.actions().map((a) => a.id).sort(), [
    "comment",
    "delete",
    "edit",
    "manage",
    "read",
  ]);
  assertEquals(schema.actions()[0].type, "Action");
  const again = assertOk(Schema.parse(schema.json)).value;
  assertEquals(again.entityTypes().sort(), schema.entityTypes().sort());
  assert(again.text.includes("entity Doc"), again.text);
});

Deno.test("namespaced actions are qualified", () => {
  const schema = assertOk(
    Schema.parse(
      "namespace Acme { entity U; action go appliesTo { principal: U, resource: U }; }",
    ),
  ).value;
  assertEquals(schema.actions(), [uid("Acme::Action", "go")]);
  assertEquals(schema.entityTypes(), ["Acme::U"]);
});

Deno.test("schema errors have positions", () => {
  const text = "entity User;\nentity Doc { owner: Usr };";
  const result = Schema.parse(text);
  assert(!result.ok, "fails");
  assert(
    result.errors[0].message.includes("Usr"),
    JSON.stringify(result.errors),
  );
});

Deno.test("strict validation names the policy and points into its text", () => {
  const schema = assertOk(Schema.parse(SCHEMA)).value;
  assert(
    validatePolicies(assertOk(PolicySet.parse(POLICIES)).value, schema).ok,
    "the fixture validates",
  );
  const bad = assertOk(PolicySet.parse(`
@id("typo") permit(principal, action == Action::"read", resource) when { resource.titel == "x" };
@id("types") permit(principal, action, resource) when { resource.title == 1 };
`)).value;
  const validation = validatePolicies(bad, schema);
  assertEquals(validation.ok, false);
  const typo = validation.errors.find((e) => e.policyId === "typo")!;
  assertEquals(typo.help, "did you mean `title`?");
  assertEquals(typo.spans[0].line, 1);
  const rendered = formatDiagnostic(typo, bad.sourceOf("typo"));
  assert(rendered.includes("resource.titel"), rendered);
  assert(
    validation.errors.some((e) => e.policyId === "types"),
    JSON.stringify(validation.errors),
  );
});

Deno.test("requestEnvs says what a policy applies to", () => {
  const schema = assertOk(Schema.parse(SCHEMA)).value;
  const set = assertOk(PolicySet.parse(POLICIES)).value;
  const envs = assertOk(requestEnvs(set, "team-folder", schema)).value;
  assertEquals([...envs.actions].sort(), [
    'Action::"comment"',
    'Action::"read"',
  ]);
  assertEquals(envs.principals, ["User"]);
  assert(!requestEnvs(set, "nope", schema).ok, "unknown id");
});
