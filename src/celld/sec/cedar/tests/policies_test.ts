// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertOk,
  assertThrows,
} from "@celld/core/assert";
import {
  CedarError,
  formatDiagnostic,
  formatPolicies,
  PolicySet,
  uid,
} from "@celld/sec/cedar";
import { POLICIES } from "./fixture.ts";

Deno.test("ids come from @id annotations; templates are told apart", () => {
  const set = assertOk(PolicySet.parse(POLICIES)).value;
  assertEquals(set.policies().map((p) => p.id).sort(), [
    "admins",
    "clearance",
    "no-delete-without-mfa",
    "owners",
    "public-read",
    "team-folder",
  ]);
  assertEquals(set.templates().map((p) => p.id), ["viewer"]);
  const owners = set.get("owners")!;
  assertEquals(owners.effect, "permit");
  assertEquals(owners.annotations, { id: "owners" });
  assert(owners.text.startsWith('@id("owners")'), owners.text);
  assertEquals(owners.json.conditions.length, 1);
});

Deno.test("policies without @id get positional ids, or all of them with idAnnotation false", () => {
  const text =
    'permit(principal, action, resource);\n@id("named") forbid(principal, action, resource);';
  assertEquals(
    assertOk(PolicySet.parse(text)).value.policies().map((p) => p.id).sort(),
    ["named", "policy0"],
  );
  assertEquals(
    assertOk(PolicySet.parse(text, { idAnnotation: false })).value.policies()
      .map((p) => p.id).sort(),
    ["policy0", "policy1"],
  );
});

Deno.test("parse errors point at the text, in characters", () => {
  const text =
    "permit(principal, action, resource);\nforbid(principal, action, résource) when { 1 + };";
  const result = PolicySet.parse(text);
  assert(!result.ok, "fails");
  const [error] = result.errors;
  assertEquals(error.spans[0].line, 2);
  // "é" is two bytes; the column counts it once.
  assertEquals(error.spans[0].column, 28);
  const rendered = formatDiagnostic(error, text);
  assert(
    rendered.includes("2 | forbid(principal, action, résource)"),
    rendered,
  );
  assert(rendered.includes("  |                            ^"), rendered);
  assertThrows(() => PolicySet.parseOrThrow(text), CedarError, "invalid token");
});

Deno.test("duplicate ids are errors", () => {
  const result = PolicySet.parse(
    '@id("x") permit(principal, action, resource);\n@id("x") forbid(principal, action, resource);',
  );
  assert(
    !result.ok &&
      result.errors[0].message.includes('two policies have the id "x"'),
    JSON.stringify(result),
  );
});

Deno.test("with, without, link and unlink return checked new sets", () => {
  const set = assertOk(PolicySet.parse(POLICIES)).value;
  const linked = assertOk(
    set.link({
      id: "share-1",
      template: "viewer",
      principal: uid("User", "bob"),
      resource: uid("Doc", "plan"),
    }),
  ).value;
  assertEquals(linked.links(), [{
    id: "share-1",
    template: "viewer",
    principal: uid("User", "bob"),
    resource: uid("Doc", "plan"),
  }]);
  assertEquals(set.links(), []);

  const missingSlot = set.link({
    id: "share-2",
    template: "viewer",
    principal: uid("User", "bob"),
  });
  assert(
    !missingSlot.ok && missingSlot.errors[0].message.includes("?resource"),
    JSON.stringify(missingSlot),
  );
  assert(!set.link({ id: "owners", template: "viewer" }).ok, "id taken");
  assert(!set.link({ id: "x", template: "owners" }).ok, "not a template");

  const blocked = linked.without("viewer");
  assert(
    !blocked.ok && blocked.errors[0].message.includes("still has 1 link"),
    JSON.stringify(blocked),
  );
  const unlinked = assertOk(linked.unlink("share-1")).value;
  assertEquals(assertOk(unlinked.without("viewer")).value.templates(), []);

  const replaced =
    assertOk(set.with("owners", "forbid(principal, action, resource);")).value;
  assertEquals(replaced.get("owners")!.effect, "forbid");
  const template = assertOk(
    set.with(
      "editor",
      "permit(principal == ?principal, action, resource == ?resource);",
    ),
  ).value;
  assertEquals(template.get("editor")!.kind, "template");
  assert(
    !set.with(
      "two",
      "permit(principal, action, resource); permit(principal, action, resource);",
    ).ok,
    "one policy",
  );
});

Deno.test("fromParts builds a set from stored rows", () => {
  const set = assertOk(PolicySet.fromParts({
    policies: { a: "permit(principal, action, resource);" },
    templates: { t: "permit(principal == ?principal, action, resource);" },
    links: [{ id: "l", template: "t", principal: uid("User", "x") }],
  })).value;
  assertEquals(set.size, 3);
  const ffi = set.toFfi();
  assertEquals(ffi.templateLinks, [{
    templateId: "t",
    newId: "l",
    values: { "?principal": { type: "User", id: "x" } },
  }]);
  const bad = PolicySet.fromParts({
    policies: { a: "permit(principal, action, resource" },
  });
  assert(!bad.ok && bad.errors[0].policyId === "a", JSON.stringify(bad));
});

Deno.test("toText round-trips ids through @id annotations", () => {
  const set = assertOk(
    PolicySet.fromParts({
      policies: { a: "permit(principal, action, resource);" },
    }),
  ).value;
  const text = set.toText();
  assertEquals(text, '@id("a")\npermit(principal, action, resource);');
  assertEquals(
    assertOk(PolicySet.parse(text)).value.policies().map((p) => p.id),
    ["a"],
  );
});

Deno.test("formatPolicies formats", () => {
  const formatted = assertOk(
    formatPolicies("permit(principal,action,resource) when {context.a==1};"),
  ).value;
  assertEquals(
    formatted,
    "permit (principal, action, resource)\nwhen { context.a == 1 };\n",
  );
  assert(!formatPolicies("permit(").ok, "fails");
});
