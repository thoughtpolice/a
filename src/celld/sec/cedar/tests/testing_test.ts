// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { Authorizer, uid } from "@celld/sec/cedar";
import { assertCases, checkCases } from "@celld/sec/cedar/testing";
import { alice, bob, doc, POLICIES, SCHEMA, USERS } from "./fixture.ts";

const authorizer = new Authorizer({ policies: POLICIES, schema: SCHEMA });
const entities = [
  ...USERS,
  doc("plan"),
  doc("memo", { owner: "bob", public: true }),
];
const context = { mfa: false };

Deno.test("passing cases report the policies they never exercised", () => {
  const report = assertCases(authorizer, [
    {
      name: "owners edit",
      principal: alice,
      action: "edit",
      resource: uid("Doc", "plan"),
      context,
      entities,
      expect: "allow",
      reasons: ["owners"],
    },
    {
      name: "public read",
      principal: alice,
      action: "read",
      resource: uid("Doc", "memo"),
      context,
      entities,
      expect: "allow",
      reasons: ["public-read"],
    },
    {
      name: "strangers",
      principal: bob,
      action: "edit",
      resource: uid("Doc", "plan"),
      context,
      entities,
      expect: "deny",
    },
  ]);
  assertEquals(report.unused, [
    "admins",
    "clearance",
    "no-delete-without-mfa",
    "team-folder",
  ]);
});

Deno.test("failures say what differed, and invalid requests fail even when denied", () => {
  const report = checkCases(authorizer, [
    {
      name: "wrong",
      principal: bob,
      action: "edit",
      resource: uid("Doc", "plan"),
      context,
      entities,
      expect: "allow",
    },
    {
      name: "reasons",
      principal: bob,
      action: "read",
      resource: uid("Doc", "memo"),
      context,
      entities,
      expect: "allow",
      reasons: ["public-read"],
    },
    {
      name: "invalid",
      principal: bob,
      action: "edit",
      resource: uid("Doc", "plan"),
      entities,
      expect: "deny",
    },
    {
      name: "invalid ok",
      principal: bob,
      action: "edit",
      resource: uid("Doc", "plan"),
      entities,
      expect: "deny",
      valid: false,
    },
  ]);
  assertEquals(report.failures.map((f) => f.name), [
    "wrong",
    "reasons",
    "invalid",
  ]);
  assert(
    report.failures[1].problem.includes("[owners, public-read]"),
    report.failures[1].problem,
  );
  const error = assertThrows(() =>
    assertCases(authorizer, [{
      principal: bob,
      action: "edit",
      resource: uid("Doc", "plan"),
      context,
      entities,
      expect: "allow",
    }])
  );
  assert(
    error.message.includes("case 0: expected allow, got deny"),
    error.message,
  );
});
