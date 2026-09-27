// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { Authorizer, type EntityUid, PolicySet, uid } from "@celld/sec/cedar";
import {
  type Fragment,
  render,
  type Row,
  type SqlDriver,
} from "@celld/sec/cedar/sql";
import { PolicyStore } from "@celld/sec/cedar/store";
import { alice, bob } from "./fixture.ts";

const secret = uid("Doc", "secret");
const open = uid("Doc", "open");

/**
 * Two coherent versions of a store, both denying Bob the private document:
 * an unrestricted template linked to Alice, then a template that asks for
 * a public document, linked to Bob.
 */
const VERSIONS: Record<number, { template: string; linked: EntityUid }> = {
  1: {
    template: "permit(principal == ?principal, action, resource);",
    linked: alice,
  },
  2: {
    template:
      "permit(principal == ?principal, action, resource) when { resource.public };",
    linked: bob,
  },
};

const DOCS = [
  { uid: secret, attrs: { public: false } },
  { uid: open, attrs: { public: true } },
];

function bobReads(authorizer: Authorizer, resource: EntityUid): boolean {
  return authorizer.check({
    principal: bob,
    action: "read",
    resource,
    entities: DOCS,
  }).allowed;
}

Deno.test("a snapshot never mixes versions: a write between its reads is read again", async () => {
  for (const { template, linked } of Object.values(VERSIONS)) {
    const parsed = PolicySet.fromParts({
      templates: { viewer: template },
      links: [{ id: "grant", template: "viewer", principal: linked }],
    });
    assert(parsed.ok, "a coherent version parses");
    assertEquals(
      bobReads(new Authorizer({ policies: parsed.value }), secret),
      false,
    );
  }

  // An asynchronous driver whose reads interleave with a writer: version 2
  // commits after the policies are read and before the links are.
  let version = 1;
  let moved = false;
  const driver: SqlDriver = {
    query<T extends Row>(statement: Fragment): Promise<T[]> {
      const { text } = render(statement);
      let rows: Row[];
      if (text.startsWith("SELECT version, schema_text")) {
        rows = [{ version, schema_text: null }];
      } else if (text.startsWith("SELECT version")) {
        rows = [{ version }];
      } else if (text.includes("FROM cedar_policies")) {
        rows = [{
          id: "viewer",
          kind: "template",
          text: VERSIONS[version].template,
        }];
      } else if (text.includes("FROM cedar_links")) {
        if (!moved) {
          moved = true;
          version = 2;
        }
        const { linked } = VERSIONS[version];
        rows = [{
          id: "grant",
          template: "viewer",
          principal_type: linked.type,
          principal_id: linked.id,
          resource_type: null,
          resource_id: null,
        }];
      } else {
        throw new Error(`unexpected statement ${text}`);
      }
      return Promise.resolve(rows as T[]);
    },
    batch: () => Promise.reject(new Error("reads only")),
    migrate: () => Promise.resolve(),
  };

  const store = new PolicyStore({ driver, store: "tenant" });
  const snapshot = await store.load();
  assert(moved, "the writer committed during the first read");
  assertEquals(snapshot.version, 2);
  const authorizer = await store.authorizer();
  assertEquals(bobReads(authorizer, secret), false);
  assertEquals(bobReads(authorizer, open), true);
});
