// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Route authorization by Cedar policies shipped with the Worker: a
 * stateless reports API where who may read what depends on attributes of
 * the caller and the report (attribute-based access control).
 *
 * The policies and schema are constants, parsed and validated once per
 * isolate (a policy that does not validate would fail the first request,
 * not silently allow or deny). Each route's `authorize` comes from
 * `cedarAuthorize`, which builds the Cedar request:
 *
 * - the principal's entity from the API key's principal: its `region`
 *   claim becomes an attribute, its roles become `Role` parents, so
 *   `principal in Role::"auditor"` works;
 * - the report's entity from the Worker's catalogue, through an in-memory
 *   entity loader;
 * - the context: whether the key's principal carries `mfa`.
 *
 * `GET /reports/:id/actions` answers which actions the caller may take on a
 * report (what a UI enables), from one entity load. Callers send
 * `x-api-key`; keys are looked up by SHA-256 in `API_KEYS` (spec `vars`;
 * unset, every key is refused). A report the catalogue lacks is a deny
 * like any other, so an id's existence is not revealed.
 *
 * - `GET /reports/:id`: the report (analysts in its region below level 3,
 *   auditors always; level 3 needs `mfa`).
 * - `GET /reports/:id/export`: the report as CSV (auditors, with `mfa`).
 * - `GET /reports/:id/actions`: `{actions: [...]}`, the caller's allowed actions.
 *
 * ```sh
 * buck2 run root//src/celld/sec/cedar/examples:gate-dev
 * curl -sS 127.0.0.1:9876/reports/eu-sales -H 'x-api-key: gate_ana_R7tYuIoPaSdFgHjKlZxCvBnM98765432'
 * ```
 *
 * @module
 */

import { Authorizer, type Entity, MemoryEntities, uid } from "@celld/sec/cedar";
import { cedarAuthorize, decisionOf } from "@celld/sec/cedar/router";
import {
  apiKey,
  type Context,
  hashedKeys,
  type Principal,
  router,
} from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  /** `{"<sha256 of key>": {"subject": ..., "roles": [...], "claims": {"region": ..., "mfa": ...}}}` */
  readonly API_KEYS?: string;
}

const SCHEMA = `
entity Role;
entity User in [Role] { region: String };
entity Report { region: String, level: Long, title: String };
action view, export appliesTo {
  principal: User,
  resource: Report,
  context: { mfa: Bool },
};
`;

const POLICIES = `
@id("regional-analysts")
permit (principal in Role::"analyst", action == Action::"view", resource)
when { resource.region == principal.region && resource.level < 3 };

@id("auditors")
permit (principal in Role::"auditor", action, resource);

@id("level-3-needs-mfa")
forbid (principal, action, resource)
when { resource.level >= 3 }
unless { context.mfa };

@id("export-needs-mfa")
forbid (principal, action == Action::"export", resource)
unless { context.mfa };
`;

const REPORTS = {
  "eu-sales": { region: "eu", level: 1, title: "EU sales" },
  "us-sales": { region: "us", level: 1, title: "US sales" },
  "eu-payroll": { region: "eu", level: 3, title: "EU payroll" },
} as const satisfies Record<
  string,
  { region: string; level: number; title: string }
>;

const catalogue = new MemoryEntities(
  Object.entries(REPORTS).map(([id, report]): Entity => ({
    uid: uid("Report", id),
    attrs: report,
  })),
);

// Parsed and validated once per isolate.
const authorizer = new Authorizer({
  policies: POLICIES,
  schema: SCHEMA,
  entities: catalogue,
});

const Params = v.object({ id: v.string().regex(/^[a-z0-9-]{1,64}$/) });

/** The caller as a Cedar entity: attributes from claims, roles as parents. */
function principalEntity(p: Principal): Entity {
  const region = typeof p.claims.region === "string" ? p.claims.region : "";
  return {
    uid: uid("User", p.key),
    attrs: { region },
    parents: p.roles.map((role) => uid("Role", role)),
  };
}

const request = {
  authorizer,
  principal: (p: Principal) => uid("User", p.key),
  resource: (c: Context) => uid("Report", (c.params as { id: string }).id),
  context: (p: Principal) => ({ mfa: p.claims.mfa === true }),
  entities: (p: Principal) => [principalEntity(p)],
};

function build(env: Env) {
  const app = router<Env>({
    auth: apiKey({
      lookup: hashedKeys(
        env.API_KEYS === undefined ? {} : JSON.parse(env.API_KEYS),
      ),
    }),
  });
  const report = (c: Context) =>
    REPORTS[(c.params as { id: keyof typeof REPORTS }).id];

  app.get("/reports/:id", {
    params: Params,
    authorize: cedarAuthorize({ ...request, action: "view" }),
  }, (c) => {
    return c.json({ ...report(c), reasons: decisionOf(c)?.reasons });
  });
  app.get("/reports/:id/export", {
    params: Params,
    authorize: cedarAuthorize({ ...request, action: "export" }),
  }, (c) => {
    const { region, level, title } = report(c);
    return new Response(`title,region,level\n${title},${region},${level}\n`, {
      headers: { "content-type": "text/csv" },
    });
  });
  app.get("/reports/:id/actions", { params: Params }, async (c) => {
    const actions = await authorizer.permittedActions({
      principal: request.principal(c.principal),
      resource: request.resource(c),
      context: request.context(c.principal),
      entities: request.entities(c.principal),
    }, ["view", "export"]);
    return c.json({ actions: actions.map((a) => a.id) });
  });
  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(req, env, ctx);
  },
};
