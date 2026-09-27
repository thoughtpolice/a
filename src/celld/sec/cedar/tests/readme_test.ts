// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The examples in src/mod.ts and README.md, as written there. */

import { assertEquals } from "@celld/core/assert";
import { Authorizer, ip, MemoryEntities, ref, uid } from "@celld/sec/cedar";

Deno.test("the module documentation's example", () => {
  const authorizer = new Authorizer({
    schema: `
      entity User in [Team];
      entity Team;
      entity Doc { owner: User };
      action read, edit appliesTo { principal: User, resource: Doc };
    `,
    policies: `
      @id("owners")
      permit (principal, action, resource) when { resource.owner == principal };
    `,
  });

  const alice = uid("User", "alice");
  const decision = authorizer.check({
    principal: alice,
    action: "edit",
    resource: uid("Doc", "plan"),
    entities: [{ uid: uid("Doc", "plan"), attrs: { owner: ref(alice) } }],
  });
  assertEquals([decision.allowed, decision.reasons], [true, ["owners"]]);
});

Deno.test("the README's example", async () => {
  const authorizer = new Authorizer({
    schema: `
      entity User in [Team] { level: Long };
      entity Team;
      entity Doc { owner: User, public: Bool };
      action read, edit appliesTo { principal: User, resource: Doc, context: { ip: ipaddr } };
    `,
    policies: `
      @id("owners")
      permit (principal, action, resource) when { resource.owner == principal };

      @id("public-read")
      permit (principal, action == Action::"read", resource) when { resource.public };

      @id("office-only")
      forbid (principal, action == Action::"edit", resource)
      unless { context.ip.isInRange(ip("10.0.0.0/8")) };
    `,
    entities: new MemoryEntities([
      {
        uid: uid("User", "alice"),
        attrs: { level: 3 },
        parents: [uid("Team", "eng")],
      },
      {
        uid: uid("Doc", "plan"),
        attrs: { owner: ref("User", "alice"), public: false },
      },
    ]),
  });

  const decision = await authorizer.authorize({
    principal: uid("User", "alice"),
    action: "edit",
    resource: uid("Doc", "plan"),
    context: { ip: ip("10.1.2.3") },
  });
  assertEquals(decision, {
    allowed: true,
    decision: "allow",
    reasons: ["owners"],
    errors: [],
    warnings: [],
  });
  const away = await authorizer.authorize({
    principal: uid("User", "alice"),
    action: "edit",
    resource: uid("Doc", "plan"),
    context: { ip: ip("192.0.2.1") },
  });
  assertEquals(away.reasons, ["office-only"]);
});
