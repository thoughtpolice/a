// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The stores and SQL filters against a real Durable Object's SQLite, for
 * runtime_test.py. `POST /<suite>` runs one suite in the object named by
 * `?object=` and answers `{ ok, failures }`; the runner restarts `celld
 * dev` between `durable-write` and `durable-read`.
 */

import { DurableObject } from "cloudflare:workers";
import {
  Authorizer,
  type Entity,
  formatUid,
  PolicySet,
  ref,
  uid,
} from "@celld/sec/cedar";
import {
  queryFilter,
  QueryUnsupported,
  type ResourceMapping,
} from "@celld/sec/cedar/query";
import { durableObjectSql, raw, render, sql } from "@celld/sec/cedar/sql";
import {
  type AttributeType,
  EntityStore,
  migrate,
  PolicyStore,
} from "@celld/sec/cedar/store";
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
} from "../fixture.ts";

interface Env {
  RUNTIME: DurableObjectNamespace<CedarRuntime>;
}

type Check = (condition: unknown, message: string) => void;

const ATTRIBUTES: Record<string, AttributeType> = {
  owner: { entity: "User" },
  public: "bool",
  title: "string",
  classification: "long",
  tags: "set",
};

function docs(): Entity[] {
  const out: Entity[] = [];
  let n = 0;
  for (const owner of ["alice", "bob", "carol"]) {
    for (const pub of [false, true]) {
      for (const classification of [undefined, 1, 5]) {
        for (const folder of [undefined, "root", "eng"]) {
          out.push(
            doc(`d${String(n++).padStart(3, "0")}`, {
              owner,
              public: pub,
              classification,
              folder,
              tags: n % 3 ? ["x"] : [],
            }),
          );
        }
      }
    }
  }
  return out;
}

export class CedarRuntime extends DurableObject<Env> {
  async run(suite: string): Promise<{ ok: boolean; failures: string[] }> {
    const failures: string[] = [];
    const check: Check = (condition, message) => {
      if (!condition) failures.push(message);
    };
    const driver = durableObjectSql(this.ctx.storage);
    await migrate(driver);
    try {
      switch (suite) {
        case "policy-store":
          await policyStore(driver, check);
          break;
        case "entity-store":
          await entityStore(driver, check);
          break;
        case "query":
          await query(driver, check);
          break;
        case "errors":
          await errors(driver, check);
          break;
        case "durable-write": {
          const store = new PolicyStore({ driver, store: "durable" });
          const result = await store.putPolicy(
            "p",
            "permit(principal, action, resource);",
          );
          check(
            result.ok && result.version === 1,
            `write: ${JSON.stringify(result)}`,
          );
          await new EntityStore({ driver, store: "durable" }).put({
            uid: alice,
            parents: [uid("Team", "eng")],
          });
          break;
        }
        case "durable-read": {
          const store = new PolicyStore({ driver, store: "durable" });
          check(await store.version() === 1, "the version survived");
          check(
            (await store.load()).policies.get("p") !== undefined,
            "the policy survived",
          );
          const loaded = await new EntityStore({ driver, store: "durable" })
            .load([alice]);
          check(
            JSON.stringify(loaded.get(alice)?.parents) ===
              '[{"type":"Team","id":"eng"}]',
            "the parent edge survived",
          );
          break;
        }
        default:
          failures.push(`unknown suite ${suite}`);
      }
    } catch (error) {
      failures.push(
        `threw: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }`,
      );
    }
    return { ok: failures.length === 0, failures };
  }
}

async function policyStore(
  driver: ReturnType<typeof durableObjectSql>,
  check: Check,
): Promise<void> {
  const store = new PolicyStore({ driver, store: "tenant-a" });
  const other = new PolicyStore({ driver, store: "tenant-b" });
  check(await store.version() === 0, "a new store is at version 0");

  const schema = await store.putSchema(SCHEMA);
  check(
    schema.ok && schema.version === 1,
    `putSchema: ${JSON.stringify(schema)}`,
  );
  for (
    const policy of [
      ...PolicySet.parseOrThrow(POLICIES).policies(),
      ...PolicySet.parseOrThrow(POLICIES).templates(),
    ]
  ) {
    const result = await store.putPolicy(policy.id, policy.text);
    check(result.ok, `put ${policy.id}: ${JSON.stringify(result)}`);
  }
  check(await store.version() === 8, `eight writes: ${await store.version()}`);
  check(await other.version() === 0, "tenants are separate");

  const typo = await store.putPolicy(
    "typo",
    'permit(principal, action == Action::"read", resource) when { resource.titel == "x" };',
  );
  check(
    !typo.ok && typo.errors[0].policyId === "typo" &&
      typo.errors[0].help === "did you mean `title`?",
    `typo refused: ${JSON.stringify(typo)}`,
  );
  check(await store.version() === 8, "a refused write changes nothing");

  const snapshot = await store.load();
  check(
    snapshot.schema !== undefined && snapshot.policies.policies().length === 6,
    "snapshot",
  );

  const entities = new EntityStore({ driver, store: "tenant-a" });
  await entities.put(...USERS, ...FOLDERS, doc("plan"));
  const options = { entities };
  const context = { mfa: false };
  let authorizer = await store.authorizer(options);
  check(
    authorizer === await store.authorizer(options),
    "the authorizer is cached per version",
  );
  const bobReads = {
    principal: bob,
    action: "read",
    resource: uid("Doc", "plan"),
    context,
  };
  check(
    !(await authorizer.authorize(bobReads)).allowed,
    "bob cannot read plan yet",
  );

  const linked = await store.link({
    id: "share-bob-plan",
    template: "viewer",
    principal: bob,
    resource: uid("Doc", "plan"),
  });
  check(linked.ok, `link: ${JSON.stringify(linked)}`);
  const grants = await store.links({ resource: uid("Doc", "plan") });
  check(
    grants.length === 1 && grants[0].principal?.id === "bob",
    `links index: ${JSON.stringify(grants)}`,
  );
  check(
    (await store.links({ principal: alice })).length === 0,
    "alice has no links",
  );
  authorizer = await store.authorizer(options);
  const shared = await authorizer.authorize(bobReads);
  check(
    shared.allowed && shared.reasons[0] === "share-bob-plan",
    `bob reads through the link: ${JSON.stringify(shared)}`,
  );

  const blocked = await store.removePolicy("viewer");
  check(
    !blocked.ok && blocked.errors[0].message.includes("link"),
    "a linked template stays",
  );
  const retyped = await store.putSchema(
    SCHEMA.replace("classification?: Long,", "classification?: String,"),
  );
  check(
    !retyped.ok && retyped.errors.some((e) => e.policyId === "clearance"),
    `a schema the policies do not fit is refused: ${JSON.stringify(retyped)}`,
  );
  // Without the attribute, `clearance` could never apply: a warning in
  // Cedar, refused by the store.
  const impossible = await store.putSchema(
    SCHEMA.replace("classification?: Long,", ""),
  );
  check(
    !impossible.ok &&
      impossible.errors.some((e) =>
        e.policyId === "clearance" && e.severity === "warning"
      ),
    `an impossible policy is refused: ${JSON.stringify(impossible)}`,
  );
  const lenient = new PolicyStore({
    driver,
    store: "tenant-a",
    allowWarnings: true,
  });
  const dead = await lenient.putPolicy(
    "dead",
    "permit(principal, action, resource) when { resource has nope && resource.nope };",
    { expectVersion: await store.version() },
  );
  check(dead.ok, `allowWarnings accepts it: ${JSON.stringify(dead)}`);
  check((await store.removePolicy("dead")).ok, "remove dead");

  // Optimistic concurrency: a writer that read version v loses to one that
  // wrote since, when it says so, and retries otherwise.
  const racer = new PolicyStore({ driver, store: "tenant-a" });
  const seen = await racer.version();
  check(
    (await store.putPolicy(
      "extra",
      'forbid(principal, action == Action::"delete", resource) when { resource.public };',
    )).ok,
    "extra",
  );
  const stale = await racer.putPolicy(
    "extra2",
    'forbid(principal, action == Action::"delete", resource) when { resource.public };',
    { expectVersion: seen },
  );
  check(
    !stale.ok && stale.conflict === true,
    `stale write refused: ${JSON.stringify(stale)}`,
  );
  const retried = await racer.putPolicy(
    "extra2",
    'forbid(principal, action == Action::"delete", resource) when { resource.public };',
  );
  check(
    retried.ok && retried.version === seen + 2,
    `a write without a version retries: ${JSON.stringify(retried)}`,
  );

  check((await store.unlink("share-bob-plan")).ok, "unlink");
  authorizer = await store.authorizer(options);
  check(
    !(await authorizer.authorize(bobReads)).allowed,
    "bob cannot read after unlink",
  );

  const deployed = await store.replacePolicies(
    '@id("only") permit(principal == User::"bob", action, resource);',
  );
  check(deployed.ok, `replacePolicies: ${JSON.stringify(deployed)}`);
  const after = await store.load();
  check(
    after.policies.policies().map((p) => p.id).join() === "only" &&
      after.policies.templates().length === 0,
    "replaced",
  );
  check(
    (await (await store.authorizer(options)).authorize(bobReads)).allowed,
    "the deployed policy applies",
  );
}

async function entityStore(
  driver: ReturnType<typeof durableObjectSql>,
  check: Check,
): Promise<void> {
  const store = new EntityStore({ driver, store: "entities" });
  const nested = uid("Folder", "deep");
  await store.put(...USERS, ...FOLDERS, {
    uid: nested,
    parents: [uid("Folder", "eng")],
  }, doc("plan", { folder: "deep" }));
  const loaded = await store.load([uid("Doc", "plan"), alice]);
  const keys = loaded.uids().map(formatUid).sort();
  const want = [
    'Doc::"plan"',
    'Folder::"deep"',
    'Folder::"eng"',
    'Folder::"root"',
    'Team::"eng"',
    'User::"alice"',
  ];
  check(
    JSON.stringify(keys) === JSON.stringify(want),
    `closure: ${keys.join(", ")}`,
  );
  const plan = loaded.get(uid("Doc", "plan"));
  check(
    JSON.stringify(plan?.attrs.owner) ===
      '{"__entity":{"type":"User","id":"alice"}}',
    `attrs round-trip: ${JSON.stringify(plan)}`,
  );
  check(
    (await store.load([uid("Doc", "plan")], { ancestors: false })).size === 1,
    "no ancestors when asked",
  );

  // An ancestor that exists only as an edge still connects the closure.
  await store.addParent(uid("Team", "eng"), uid("Team", "all"));
  // Team::"eng" has no row but now a parent: it is loaded, with no
  // attributes, so `alice in Team::"all"` holds. Team::"all" has neither.
  const team = await store.load([alice]);
  const eng = team.get(uid("Team", "eng"));
  check(
    eng !== undefined &&
      JSON.stringify(eng.parents) === '[{"type":"Team","id":"all"}]' &&
      JSON.stringify(eng.attrs) === "{}",
    `edge-only ancestors are included: ${JSON.stringify(eng)}`,
  );
  check(
    !team.has(uid("Team", "all")),
    "an ancestor with no row and no parents is not invented",
  );
  check(
    await store.removeParent(uid("Team", "eng"), uid("Team", "all")),
    "removeParent",
  );
  check(await store.remove(nested), "remove");
  check(
    !(await store.load([uid("Doc", "plan")])).has(uid("Folder", "eng")),
    "removing a folder cuts the path",
  );
  check(!(await store.remove(nested)), "removing twice");
  check(
    (await store.get(uid("Doc", "nope"))) === undefined,
    "get of a missing entity",
  );

  // A cycle terminates (UNION, not UNION ALL).
  await store.addParent(uid("Folder", "root"), uid("Folder", "eng"));
  check(
    (await store.load([uid("Folder", "eng")])).size === 2,
    "cycles terminate",
  );
}

async function query(
  driver: ReturnType<typeof durableObjectSql>,
  check: Check,
): Promise<void> {
  const store = new EntityStore({ driver, store: "query" });
  const all = docs();
  await store.put(...USERS, ...FOLDERS, ...all);
  const authorizer = new Authorizer({
    policies: POLICIES,
    schema: SCHEMA,
    entities: store,
  });

  // The same documents in an application table with a folder closure table.
  driver.querySync(
    sql`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, public INTEGER NOT NULL, title TEXT NOT NULL, classification INTEGER, tags TEXT NOT NULL)`,
  );
  driver.querySync(
    sql`CREATE TABLE IF NOT EXISTS doc_folders (doc TEXT NOT NULL, folder TEXT NOT NULL)`,
  );
  const ancestors: Record<string, string[]> = {
    root: ["root"],
    eng: ["eng", "root"],
  };
  await driver.batch(all.flatMap((d) => {
    const a = d.attrs as {
      owner: { uid: { id: string } };
      public: boolean;
      title: string;
      classification?: number;
      tags: string[];
    };
    const folder = d.parents?.[0]?.id;
    return [
      {
        sql:
          sql`INSERT INTO docs VALUES (${d.uid.id}, ${a.owner.uid.id}, ${a.public}, ${a.title}, ${
            a.classification ?? null
          }, ${JSON.stringify(a.tags)})`,
      },
      ...(folder
        ? ancestors[folder].map((f) => ({
          sql: sql`INSERT INTO doc_folders VALUES (${d.uid.id}, ${f})`,
        }))
        : []),
    ];
  }));
  const mapping: ResourceMapping = {
    type: "Doc",
    id: "docs.id",
    attributes: {
      owner: { type: "entity", column: "docs.owner", entityType: "User" },
      public: { type: "bool", column: "docs.public" },
      title: { type: "string", column: "docs.title" },
      classification: { type: "long", column: "docs.classification" },
      tags: { type: "set", column: "docs.tags", element: "string" },
    },
    in: (a) =>
      a.type === "Folder"
        ? sql`docs.id IN (SELECT doc FROM doc_folders WHERE folder = ${a.id})`
        : false,
  };

  let compared = 0;
  for (const principal of [alice, bob, carol]) {
    for (const action of ["read", "comment", "edit", "delete"]) {
      for (const mfa of [false, true]) {
        const context = { mfa };
        const expected: string[] = [];
        for (const d of all) {
          if (
            (await authorizer.authorize({
              principal,
              action,
              resource: d.uid,
              context,
            })).allowed
          ) expected.push(d.uid.id);
        }
        // The store's query loads the principal and its teams itself;
        // the hand-mapped table is given them.
        const request = { principal, action, context, entities: USERS };
        const viaStore = (await store.query(
          authorizer,
          { principal, action, context },
          "Doc",
          ATTRIBUTES,
          { limit: 1000 },
        )).map((
          e,
        ) => (e.uid as { id: string }).id);
        const plan = queryFilter(authorizer, request, mapping);
        const viaTable = driver.querySync<{ id: string }>(
          sql`SELECT id FROM docs WHERE ${plan.where} ORDER BY id`,
        ).map((r) => r.id);
        const label = `${principal.id} ${action} mfa=${mfa}`;
        check(
          JSON.stringify(viaStore) === JSON.stringify(expected),
          `${label}: store ${viaStore.join()} != cedar ${expected.join()}`,
        );
        check(
          JSON.stringify(viaTable) === JSON.stringify(expected),
          `${label}: table ${viaTable.join()} != cedar ${expected.join()}\n${
            render(plan.where).text
          }`,
        );
        compared += expected.length;
      }
    }
  }
  check(
    compared > 50,
    `the differential allowed enough rows to mean something (${compared})`,
  );

  // Pagination walks the same set.
  const request = {
    principal: carol,
    action: "read",
    context: { mfa: false },
    entities: USERS,
  };
  const everything =
    (await store.query(authorizer, request, "Doc", ATTRIBUTES, { limit: 1000 }))
      .map((e) => (e.uid as { id: string }).id);
  const paged: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.query(authorizer, request, "Doc", ATTRIBUTES, {
      limit: 7,
      ...(after ? { after } : {}),
    });
    if (page.length === 0) break;
    paged.push(...page.map((e) => (e.uid as { id: string }).id));
    after = paged[paged.length - 1];
  }
  check(
    JSON.stringify(paged) === JSON.stringify(everything),
    "pages cover the set once",
  );
  check(raw("x").isRaw, "raw");
}

/**
 * Conditions that err on some rows, through the store's JSON columns,
 * against Cedar row by row: a NULL where Cedar errs, and nowhere else.
 */
async function errors(
  driver: ReturnType<typeof durableObjectSql>,
  check: Check,
): Promise<void> {
  const store = new EntityStore({ driver, store: "errors" });
  const attributes: Record<string, AttributeType> = {
    profile: "record",
    "profile.admin": "bool",
    "profile.level": "long",
    name: "string",
    level: "long",
    tags: "set",
    owner: { entity: "User" },
    missing: "long",
  };
  const rows: Entity[] = [
    {},
    { profile: {} },
    { profile: { admin: true } },
    { profile: { admin: false, level: 3 } },
    {
      name: "abc",
      level: 2,
      tags: ["a"],
      owner: ref("User", "alice"),
      missing: 1,
    },
    { name: "b", level: 0, tags: [], profile: { level: 1 } },
  ].map((attrs, n) => ({
    uid: uid("Doc", `r${n}`),
    attrs: attrs as Entity["attrs"],
  }));
  await store.put(...USERS, ...rows);
  let errored = 0;
  for (const condition of ERROR_CONDITIONS) {
    for (const wrap of WRAPPERS) {
      const policies = wrap(condition);
      const authorizer = new Authorizer({ policies, entities: store });
      const expected: string[] = [];
      for (const row of rows) {
        const decision = await authorizer.authorize({
          principal: alice,
          action: "read",
          resource: row.uid,
        });
        errored += decision.errors.length;
        if (decision.allowed) expected.push(row.uid.id);
      }
      const listed = (await store.query(
        authorizer,
        { principal: alice, action: "read" },
        "Doc",
        attributes,
        { limit: 1000 },
      )).map((e) => (e.uid as { id: string }).id);
      check(
        JSON.stringify(listed) === JSON.stringify(expected),
        `${policies}: store ${listed.join()} != cedar ${expected.join()}`,
      );
    }
  }
  check(errored > 50, `the rows made Cedar err (${errored})`);
  // A path through an entity cannot be read from the resource's JSON.
  let refused = false;
  try {
    store.mapping("Doc", { owner: { entity: "User" }, "owner.dept": "string" });
  } catch (error) {
    refused = error instanceof QueryUnsupported;
  }
  check(refused, "owner.dept through an entity is unsupported");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const suite = url.pathname.slice(1);
    const object = url.searchParams.get("object") ?? suite;
    return Response.json(await env.RUNTIME.getByName(object).run(suite));
  },
};
