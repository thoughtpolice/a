// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  Authorizer,
  type Entity,
  EntitySet,
  type EntityUid,
  formatUid,
  MemoryEntities,
  ref,
  uid,
} from "@celld/sec/cedar";
import {
  compileResiduals,
  evaluate,
  type Filter,
  planQuery,
  queryFilter,
  QueryUnsupported,
  type ResourceMapping,
  toSql,
} from "@celld/sec/cedar/query";
import { raw, render, sql } from "@celld/sec/cedar/sql";
import {
  alice,
  bob,
  carol,
  doc,
  ERROR_CONDITIONS,
  FOLDERS,
  POLICIES,
  SCHEMA,
  USERS,
  WRAPPERS,
} from "./fixture.ts";

const authorizer = new Authorizer({ policies: POLICIES, schema: SCHEMA });

/** Documents covering every attribute combination the policies look at. */
function docs(): Entity[] {
  const out: Entity[] = [];
  let n = 0;
  for (const owner of ["alice", "bob", "carol"]) {
    for (const pub of [false, true]) {
      for (const classification of [undefined, 1, 3, 5]) {
        for (const folder of [undefined, "root", "eng"]) {
          out.push(
            doc(`d${n++}`, {
              owner,
              public: pub,
              classification,
              folder,
              title: n % 2 ? "pub-notes" : "plan",
            }),
          );
        }
      }
    }
  }
  return out;
}

const DOCS = docs();
const FOLDER_PARENTS: Record<string, string[]> = { eng: ["root"], root: [] };

function view(entity: Entity) {
  const folders = new Set<string>();
  const walk = (f: string) => {
    if (folders.has(f)) return;
    folders.add(f);
    for (const p of FOLDER_PARENTS[f] ?? []) walk(p);
  };
  for (const parent of entity.parents ?? []) walk(parent.id);
  const attrs = new EntitySet([entity]).get(entity.uid)!.attrs;
  return {
    uid: entity.uid,
    attrs,
    isIn: (ancestor: EntityUid) =>
      ancestor.type === "Folder" && folders.has(ancestor.id),
  };
}

Deno.test("compiled filters agree with Cedar on every document (differential)", () => {
  for (const principal of [alice, bob, carol]) {
    for (const action of ["read", "comment", "edit", "delete"]) {
      for (const mfa of [false, true]) {
        const context = { mfa };
        const residuals = authorizer.partial({
          principal,
          action,
          context,
          entities: [...USERS, ...FOLDERS],
        });
        const filter = compileResiduals(residuals, "Doc");
        for (const d of DOCS) {
          const expected = authorizer.check({
            principal,
            action,
            resource: d.uid,
            context,
            entities: [...USERS, ...FOLDERS, d],
          }).allowed;
          const actual = evaluate(filter, view(d));
          assertEquals(
            actual ?? false,
            expected,
            `${principal.id} ${action} mfa=${mfa} ${formatUid(d.uid)} ${
              JSON.stringify(filter)
            }`,
          );
        }
      }
    }
  }
});

Deno.test("decided requests compile to constants", () => {
  const onlyForbid = new Authorizer({
    policies: '@id("f") forbid(principal, action, resource);',
  });
  assertEquals(
    compileResiduals(
      onlyForbid.partial({ principal: alice, action: "read" }),
      "Doc",
    ),
    { kind: "const", value: false },
  );
  const everyone = new Authorizer({
    policies: '@id("p") permit(principal, action, resource);',
  });
  assertEquals(
    compileResiduals(
      everyone.partial({ principal: alice, action: "read" }),
      "Doc",
    ),
    { kind: "const", value: true },
  );
});

Deno.test("resource types fold statically", () => {
  const typed = new Authorizer({
    policies:
      '@id("p") permit(principal, action, resource is Folder);\n@id("q") permit(principal, action, resource) when { resource is Doc && resource.public };',
  });
  const filter = compileResiduals(
    typed.partial({ principal: alice, action: "read" }),
    "Doc",
  );
  // The attribute may be missing (an error), so the policy is wrapped.
  assertEquals(filter, {
    kind: "applies",
    arg: { kind: "attr", path: ["public"] },
  });
});

Deno.test("errors are exact: a missing attribute makes a permit not apply, and a forbid too", () => {
  const policies = new Authorizer({
    policies: `
@id("p") permit(principal, action, resource) when { resource.level > 1 || resource.open };
@id("f") forbid(principal, action, resource) when { resource.banned };
`,
  });
  const filter = compileResiduals(
    policies.partial({ principal: alice, action: "read" }),
    "Doc",
  );
  const cases: [Record<string, unknown>, boolean][] = [
    [{ level: 2 }, true], // banned missing: the forbid errors and does not apply
    [{ level: 2, banned: true }, false],
    [{ level: 0, open: true }, true],
    [{ open: true }, false], // level missing: `||` errors before reading open
    [{ level: 0 }, false],
  ];
  for (const [attrs, expected] of cases) {
    const d = { uid: uid("Doc", "x"), attrs: attrs as Record<string, never> };
    const cedar = policies.check({
      principal: alice,
      action: "read",
      resource: d.uid,
      entities: [d],
    }).allowed;
    assertEquals(cedar, expected, `cedar ${JSON.stringify(attrs)}`);
    assertEquals(
      evaluate(filter, { uid: d.uid, attrs: attrs as never }) ?? false,
      expected,
      JSON.stringify(attrs),
    );
  }
});

/** {@link ERROR_CONDITIONS}, and attributes every object has a property for. */
const CONDITIONS = [
  ...ERROR_CONDITIONS,
  "resource has constructor",
  "resource.toString == 1",
];

/** Resources that make those conditions true, false, and errors. */
const ERROR_RESOURCES: Record<string, unknown>[] = [
  {},
  { profile: {} },
  { profile: { admin: true } },
  { profile: { admin: false, level: 3 } },
  { profile: "admin" },
  { profile: [1] },
  { profile: { admin: 1 } },
  {
    name: "abc",
    level: 2,
    tags: ["a"],
    owner: ref("User", "alice"),
    missing: 1,
  },
  { name: 5, level: "2", tags: "a", owner: "alice" },
];

Deno.test("errors survive nested has, empty sets and negation (differential)", () => {
  let errored = 0;
  const wrong: string[] = [];
  for (const condition of CONDITIONS) {
    for (const wrap of WRAPPERS) {
      const policies = wrap(condition);
      const auth = new Authorizer({ policies });
      const filter = compileResiduals(
        auth.partial({ principal: alice, action: "read" }),
        "Doc",
      );
      for (const [n, attrs] of ERROR_RESOURCES.entries()) {
        const entity: Entity = {
          uid: uid("Doc", `r${n}`),
          attrs: attrs as Entity["attrs"],
        };
        const cedar = auth.check({
          principal: alice,
          action: "read",
          resource: entity.uid,
          entities: [entity],
        });
        errored += cedar.errors.length;
        if ((evaluate(filter, view(entity)) ?? false) !== cedar.allowed) {
          wrong.push(
            `${policies} on ${JSON.stringify(attrs)}: Cedar ${
              cedar.allowed ? "allows" : "denies"
            }, ${JSON.stringify(filter)}`,
          );
        }
      }
    }
  }
  assertEquals(wrong, []);
  assert(errored > 100, `the resources made Cedar err (${errored})`);
});

Deno.test("evaluate refuses to read through an entity it cannot see", () => {
  for (
    const condition of [
      "resource.owner has dept",
      'resource.owner.dept == "eng"',
    ]
  ) {
    const auth = new Authorizer({
      policies:
        `@id("p") permit(principal, action, resource) when { ${condition} };`,
    });
    const filter = compileResiduals(
      auth.partial({ principal: alice, action: "read" }),
      "Doc",
    );
    assertThrows(
      () => evaluate(filter, view(doc("d", { owner: "alice" }))),
      QueryUnsupported,
      "resource.owner",
    );
  }
});

Deno.test("what cannot compile says which policy", () => {
  const arithmetic = new Authorizer({
    policies:
      '@id("math") permit(principal, action, resource) when { resource.a + 1 > 2 };',
  });
  const error = assertThrows(
    () =>
      compileResiduals(
        arithmetic.partial({ principal: alice, action: "read" }),
        "Doc",
      ),
    QueryUnsupported,
    "math",
  );
  assertEquals(error.policyId, "math");
  const attrs = new Authorizer({
    policies:
      '@id("attrs") permit(principal, action, resource) when { resource.a == resource.b };',
  });
  assertThrows(
    () =>
      compileResiduals(
        attrs.partial({ principal: alice, action: "read" }),
        "Doc",
      ),
    QueryUnsupported,
    "comparing",
  );
});

const MAPPING: ResourceMapping = {
  type: "Doc",
  id: "d.id",
  attributes: {
    owner: { type: "entity", column: "d.owner", entityType: "User" },
    public: { type: "bool", column: "d.public" },
    title: { type: "string", column: "d.title" },
    classification: { type: "long", column: "d.classification" },
    tags: { type: "set", column: "d.tags", element: "string" },
    profile: { type: "record", column: "d.profile" },
    "profile.admin": { type: "bool", column: "d.profile_admin" },
  },
  in: (ancestor) =>
    ancestor.type === "Folder"
      ? sql`d.id IN (SELECT doc FROM doc_folders WHERE folder = ${ancestor.id})`
      : false,
};

Deno.test("SQL keeps values in parameters, never in the text", () => {
  const plan = queryFilter(authorizer, {
    principal: alice,
    action: "read",
    context: { mfa: false },
    entities: USERS,
  }, MAPPING);
  const { text, params } = render(plan.where);
  assert(!text.includes("alice") && text.includes("?"), text);
  assert(
    params.includes("alice") && params.includes("eng"),
    JSON.stringify(params),
  );
  assertEquals(plan.all || plan.none, false);
});

Deno.test("SQL for each filter node", () => {
  const cases: [Filter, string, unknown[]][] = [
    [
      { kind: "eq", path: ["owner"], value: uid("User", "a") },
      "(d.owner = ?)",
      ["a"],
    ],
    [
      { kind: "eq", path: ["owner"], value: uid("Team", "a") },
      "CASE WHEN d.owner IS NULL THEN CAST(NULL AS BOOLEAN) ELSE FALSE END",
      [],
    ],
    [{ kind: "attr", path: ["public"] }, "(d.public = 1)", []],
    [{ kind: "eq", path: ["public"], value: true }, "(d.public = ?)", [1]],
    [
      { kind: "cmp", path: ["classification"], op: ">=", value: 3 },
      "(d.classification >= ?)",
      [3],
    ],
    [
      { kind: "has", path: ["classification"] },
      "(d.classification IS NOT NULL)",
      [],
    ],
    [
      {
        kind: "like",
        path: ["title"],
        pattern: [{ Literal: "a*b%_[" }, "Wildcard"],
      },
      "(d.title GLOB ?)",
      ["a[*]b%_[[]*"],
    ],
    [{ kind: "self", value: uid("Doc", "x") }, "(d.id = ?)", ["x"]],
    [
      { kind: "contains", path: ["tags"], value: "x" },
      "CASE WHEN d.tags IS NULL THEN CAST(NULL AS BOOLEAN) ELSE EXISTS (SELECT 1 FROM json_each(d.tags) AS e WHERE e.value = ?) END",
      ["x"],
    ],
    [
      { kind: "has", path: ["profile", "admin"] },
      "CASE WHEN d.profile IS NULL THEN CAST(NULL AS BOOLEAN) ELSE (d.profile_admin IS NOT NULL) END",
      [],
    ],
    // A long has no attributes: `resource.classification has x` always errs.
    [
      { kind: "has", path: ["classification", "x"] },
      "CAST(NULL AS BOOLEAN)",
      [],
    ],
    [
      { kind: "defined", path: ["title"] },
      "CASE WHEN d.title IS NULL THEN CAST(NULL AS BOOLEAN) ELSE TRUE END",
      [],
    ],
    [
      { kind: "attrIn", path: ["owner"], ancestors: [] },
      "CASE WHEN d.owner IS NULL THEN CAST(NULL AS BOOLEAN) ELSE FALSE END",
      [],
    ],
    [
      {
        kind: "attrIn",
        path: ["owner"],
        ancestors: [uid("User", "a"), uid("Team", "t")],
      },
      "CASE WHEN d.owner IS NULL THEN CAST(NULL AS BOOLEAN) ELSE (((d.owner = ?) OR FALSE) OR (FALSE OR FALSE)) END",
      ["a"],
    ],
    [
      { kind: "attrIn", path: ["title"], ancestors: [] },
      "CASE WHEN d.title IS NULL THEN CAST(NULL AS BOOLEAN) ELSE CAST(NULL AS BOOLEAN) END",
      [],
    ],
    [
      {
        kind: "applies",
        arg: {
          kind: "and",
          left: { kind: "attr", path: ["public"] },
          right: { kind: "has", path: ["title"] },
        },
      },
      "COALESCE((CASE (d.public = 1) WHEN TRUE THEN (d.title IS NOT NULL) WHEN FALSE THEN FALSE END), FALSE)",
      [],
    ],
  ];
  for (const [filter, text, params] of cases) {
    const rendered = render(toSql(filter, MAPPING));
    assertEquals(rendered.text, text);
    assertEquals([...rendered.params], params, text);
  }
});

Deno.test("an attribute without a column is unsupported, not assumed absent", () => {
  assertThrows(
    () => toSql({ kind: "has", path: ["secret"] }, MAPPING),
    QueryUnsupported,
    "secret",
  );
  // Without a column for the parent, a missing parent (an error) and a
  // missing field (false) look the same.
  assertThrows(
    () => toSql({ kind: "has", path: ["meta", "x"] }, MAPPING),
    QueryUnsupported,
    "meta",
  );
  assertThrows(
    () => toSql({ kind: "eq", path: ["tags"], value: "x" }, MAPPING),
    QueryUnsupported,
  );
});

Deno.test("raw columns are trusted text", () => {
  const where = toSql({ kind: "has", path: ["x"] }, {
    type: "Doc",
    id: raw("id"),
    attributes: { x: { type: "string", column: raw('"weird col"') } },
  });
  assertEquals(render(where).text, '("weird col" IS NOT NULL)');
});

Deno.test("planQuery loads the principal's ancestors; queryFilter uses what it is given", async () => {
  const loaded = new Authorizer({
    policies: POLICIES,
    schema: SCHEMA,
    entities: new MemoryEntities([...USERS, ...FOLDERS]),
  });
  const request = { principal: alice, action: "read", context: { mfa: false } };
  // Without alice's entity, her level is unknown to partial evaluation
  // (a loud failure); her team would silently be (the bug planQuery fixes).
  assertThrows(
    () => queryFilter(loaded, request, MAPPING),
    QueryUnsupported,
    "principal",
  );
  const planned = await planQuery(loaded, request, MAPPING);
  const given = queryFilter(
    loaded,
    { ...request, entities: USERS },
    MAPPING,
  );
  const text = (plan: typeof given) => render(plan.where).text;
  assert(text(planned).includes("doc_folders"), text(planned));
  assertEquals(text(planned), text(given));
});
