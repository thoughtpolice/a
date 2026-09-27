// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import {
  Authorizer,
  type Decision,
  MemoryEntities,
  ref,
  uid,
} from "@celld/sec/cedar";
import { cedarAuthorize, decisionOf } from "@celld/sec/cedar/router";
import {
  apiKey,
  hashApiKey,
  hashedKeys,
  principalKey,
  router,
  toPrincipal,
} from "@celld/web/router";
import { alice, doc, FOLDERS, POLICIES, SCHEMA, USERS } from "./fixture.ts";

const KEYS = {
  alice: "alice-key-0123456789abcdef0123456789abcdef",
  bob: "bob-key-0123456789abcdef0123456789abcdef",
};

const ownerKey = (subject: string) =>
  principalKey({
    scheme: "apiKey",
    subject,
  });

const ALICE_OWNER = ownerKey("alice");
const BOB_OWNER = ownerKey("bob");

async function build() {
  const store = new MemoryEntities([
    ...USERS.map((entity) =>
      entity.uid.type === "User"
        ? { ...entity, uid: uid("User", ownerKey(entity.uid.id)) }
        : entity
    ),
    ...FOLDERS,
    doc("plan", { owner: ALICE_OWNER }),
    doc("memo", { owner: BOB_OWNER, public: true }),
  ]);
  const authorizer = new Authorizer({
    policies: POLICIES,
    schema: SCHEMA,
    entities: store,
  });
  const decisions: Decision[] = [];
  const canRead = cedarAuthorize({
    authorizer,
    principal: (p) => uid("User", p.key),
    action: (c) => c.req.method === "GET" ? "read" : "edit",
    resource: (c) => uid("Doc", c.params.id),
    context: () => ({ mfa: false }),
    onDecision: (decision) => decisions.push(decision),
  });
  const routes = router({
    auth: apiKey({
      lookup: hashedKeys({
        [await hashApiKey(KEYS.alice)]: { subject: "alice" },
        [await hashApiKey(KEYS.bob)]: { subject: "bob" },
      }),
    }),
  });
  routes.get(
    "/docs/:id",
    { authorize: canRead },
    (c) => c.json({ reasons: decisionOf(c)?.reasons }),
  );
  routes.put("/docs/:id", { authorize: canRead }, (c) => c.json({ ok: true }));
  return { app: routes, decisions };
}

async function send(
  app: { fetch(r: Request): Promise<Response> },
  method: string,
  path: string,
  key: string,
) {
  const response = await app.fetch(
    new Request(`https://api.example.com${path}`, {
      method,
      headers: { "x-api-key": key },
    }),
  );
  return { status: response.status, json: await response.json() };
}

Deno.test("routes answer 403 unless Cedar allows, and handlers see the decision", async () => {
  const { app, decisions } = await build();
  assertEquals(await send(app, "GET", "/docs/plan", KEYS.alice), {
    status: 200,
    json: { reasons: ["owners"] },
  });
  assertEquals((await send(app, "GET", "/docs/plan", KEYS.bob)).status, 403);
  assertEquals((await send(app, "GET", "/docs/memo", KEYS.bob)).status, 200);
  assertEquals((await send(app, "PUT", "/docs/memo", KEYS.alice)).status, 403);
  assertEquals((await send(app, "PUT", "/docs/plan", KEYS.alice)).status, 200);
  assertEquals(decisions.map((d) => d.allowed), [
    true,
    false,
    true,
    false,
    true,
  ]);
});

Deno.test("a resource id that is not a valid request is a deny, reported", async () => {
  const decisions: Decision[] = [];
  const authorize = cedarAuthorize({
    authorizer: new Authorizer({ policies: POLICIES, schema: SCHEMA }),
    principal: (p) => uid("User", p.key),
    action: "read",
    resource: () => {
      throw new Error("no such document");
    },
    onDecision: (d) => decisions.push(d),
  });
  const allowed = await authorize({
    subject: "alice",
    scopes: [],
    roles: [],
    claims: {},
    scheme: "test",
    key: "k",
  }, {} as never);
  assertEquals(allowed, false);
  assert(
    decisions[0].invalid?.[0].message === "no such document",
    JSON.stringify(decisions),
  );
  // An entity outside the schema is refused by Cedar, also a deny.
  const typed = cedarAuthorize({
    authorizer: new Authorizer({ policies: POLICIES, schema: SCHEMA }),
    principal: () => uid("Team", "eng"),
    action: "read",
    resource: () => uid("Doc", "plan"),
    context: () => ({ mfa: false }),
  });
  assertEquals(
    await typed({
      subject: alice.id,
      scopes: [],
      roles: [],
      claims: {},
      scheme: "test",
      key: "k",
    }, {} as never),
    false,
  );
});

Deno.test("equal subjects from different issuers remain different Cedar owners", async () => {
  const fromA = toPrincipal({
    subject: "shared-subject",
    issuer: "https://issuer-a.example",
  }, "bearer");
  const fromB = toPrincipal({
    subject: "shared-subject",
    issuer: "https://issuer-b.example",
  }, "bearer");
  const resource = uid("Doc", "owned-by-a");
  const authorizer = new Authorizer({
    schema: `
      entity User;
      entity Doc { owner: User };
      action read appliesTo { principal: User, resource: Doc };
    `,
    policies:
      `permit (principal, action == Action::"read", resource) when { resource.owner == principal };`,
    entities: new MemoryEntities([
      { uid: uid("User", fromA.key) },
      { uid: uid("User", fromB.key) },
      { uid: resource, attrs: { owner: ref("User", fromA.key) } },
    ]),
  });
  const authorize = cedarAuthorize({
    authorizer,
    principal: (principal) => uid("User", principal.key),
    action: "read",
    resource: () => resource,
  });

  assertEquals(await authorize(fromA, {} as never), true);
  assertEquals(await authorize(fromB, {} as never), false);
});
