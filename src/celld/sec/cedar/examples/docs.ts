// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Document sharing decided by Cedar policies that live, with the
 * documents, in a Durable Object's SQLite.
 *
 * The Workspace object keeps a policy store and an entity store (from
 * "@celld/sec/cedar/store"). Every decision is made inside it, next to the data,
 * so a share or a policy edit applies to the very next request. Sharing is
 * a template link (`viewer`), listing is one SQL query whose filter comes
 * from partial evaluation of the policies, and admins edit policies through
 * the API: each edit is validated against the schema before it is stored,
 * and a policy that does not validate is answered 422 with Cedar's
 * diagnostics, rendered against the policy's text.
 *
 * Callers send `x-api-key`. Keys are looked up by SHA-256 in `API_KEYS`
 * (from the spec's `vars`; unset, every key is refused). User entity ids are
 * always the principals' complete keys, so adding another authentication
 * scheme later cannot merge equal subjects into one owner. The viewer path
 * names an API-key subject and derives the same canonical key.
 *
 * - `POST /docs` `{title, public?}`: a document owned by the caller (201).
 * - `GET /docs`: the documents the caller may read.
 * - `GET /docs/:id`: one document and the policies that allowed it.
 * - `PUT /docs/:id/viewers/:user`: share with a user (owners only; 204,
 *   again 204 when already shared).
 * - `DELETE /docs/:id/viewers/:user`: stop sharing (owners only).
 * - `PUT /policies/:id` (role `admin`), body `{text}`: add or replace a
 *   policy; 422 with diagnostics when it does not validate.
 *
 * ```sh
 * buck2 run root//src/celld/sec/cedar/examples:docs-dev
 * curl -sS 127.0.0.1:9876/docs -H 'x-api-key: docs_alice_2mTIqUW4ZWkNGhKOVaNEvtPpW0mG0dL0' \
 *   -H 'content-type: application/json' -d '{"title":"Plan"}'
 * curl -sS 127.0.0.1:9876/docs -H 'x-api-key: docs_alice_2mTIqUW4ZWkNGhKOVaNEvtPpW0mG0dL0'
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { type Diagnostic, formatDiagnostic, ref, uid } from "@celld/sec/cedar";
import { durableObjectSql } from "@celld/sec/cedar/sql";
import { EntityStore, migrate, PolicyStore } from "@celld/sec/cedar/store";
import {
  apiKey,
  hashedKeys,
  HttpError,
  principalKey,
  router,
} from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  /** `{"<sha256 of key>": {"subject": ..., "roles": [...]}}` */
  readonly API_KEYS?: string;
  readonly WORKSPACE: DurableObjectNamespace<Workspace>;
}

const SCHEMA = `
entity User;
entity Doc { owner: User, title: String, public: Bool };
action read, share appliesTo { principal: User, resource: Doc };
`;

const POLICIES = `
@id("owners")
permit (principal, action, resource) when { resource.owner == principal };

@id("public")
permit (principal, action == Action::"read", resource) when { resource.public };

@id("viewer")
permit (principal == ?principal, action == Action::"read", resource == ?resource);
`;

/** How the document list reads attributes out of the entity store. */
const DOC_ATTRIBUTES = {
  owner: { entity: "User" },
  title: "string",
  public: "bool",
} as const;

type Answer<T> = { ok: true; value: T } | {
  ok: false;
  status: 403 | 404 | 422;
  errors?: string[];
};

/** One workspace: its documents, users and policies. */
export class Workspace extends DurableObject<Env> {
  readonly #policies: PolicyStore;
  readonly #entities: EntityStore;
  readonly #loader: { entities: EntityStore };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const driver = durableObjectSql(ctx.storage);
    this.#policies = new PolicyStore({ driver, store: "workspace" });
    this.#entities = new EntityStore({ driver, store: "workspace" });
    this.#loader = { entities: this.#entities };
    ctx.blockConcurrencyWhile(async () => {
      await migrate(driver);
      if (await this.#policies.version() === 0) {
        const schema = await this.#policies.putSchema(SCHEMA);
        const policies = await this.#policies.replacePolicies(POLICIES);
        if (!schema.ok || !policies.ok) {
          throw new Error("the built-in policies do not validate");
        }
      }
    });
  }

  async create(
    user: string,
    title: string,
    isPublic: boolean,
  ): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await this.#entities.put(
      { uid: uid("User", user) },
      {
        uid: uid("Doc", id),
        attrs: { owner: ref("User", user), title, public: isPublic },
      },
    );
    return { id };
  }

  async list(user: string): Promise<{ id: string; title: string }[]> {
    const authorizer = await this.#policies.authorizer(this.#loader);
    const docs = await this.#entities.query(
      authorizer,
      { principal: uid("User", user), action: "read" },
      "Doc",
      DOC_ATTRIBUTES,
    );
    return docs.map((doc) => ({
      id: (doc.uid as { id: string }).id,
      title: doc.attrs.title as string,
    }));
  }

  async read(
    user: string,
    id: string,
  ): Promise<
    Answer<{ id: string; title: string; reasons: readonly string[] }>
  > {
    const doc = await this.#entities.get(uid("Doc", id));
    if (doc === undefined) return { ok: false, status: 404 };
    const decision = await this.#decide(user, "read", id);
    if (!decision.allowed) return { ok: false, status: 403 };
    return {
      ok: true,
      value: {
        id,
        title: doc.attrs.title as string,
        reasons: decision.reasons,
      },
    };
  }

  async share(
    user: string,
    id: string,
    viewer: string,
    grant: boolean,
  ): Promise<Answer<null>> {
    if (await this.#entities.get(uid("Doc", id)) === undefined) {
      return { ok: false, status: 404 };
    }
    if (!(await this.#decide(user, "share", id)).allowed) {
      return { ok: false, status: 403 };
    }
    // One link per document and viewer: sharing again finds it taken.
    const link = `viewer/${id}/${viewer}`;
    const existing = await this.#policies.links({
      resource: uid("Doc", id),
      principal: uid("User", viewer),
    });
    if (grant && existing.length === 0) {
      const result = await this.#policies.link({
        id: link,
        template: "viewer",
        principal: uid("User", viewer),
        resource: uid("Doc", id),
      });
      // A concurrent share of the same pair wrote the link first: done.
      if (
        !result.ok &&
        (await this.#policies.links({
            resource: uid("Doc", id),
            principal: uid("User", viewer),
          })).length === 0
      ) {
        throw new Error(result.errors.map((e) => e.message).join("; "));
      }
    }
    if (!grant && existing.length > 0) await this.#policies.unlink(link);
    return { ok: true, value: null };
  }

  async putPolicy(
    id: string,
    text: string,
  ): Promise<Answer<{ version: number }>> {
    const result = await this.#policies.putPolicy(id, text);
    if (result.ok) return { ok: true, value: { version: result.version } };
    const render = (d: Diagnostic) =>
      formatDiagnostic(d, result.sourceOf?.(d.policyId) ?? text);
    return { ok: false, status: 422, errors: result.errors.map(render) };
  }

  async #decide(user: string, action: string, id: string) {
    const authorizer = await this.#policies.authorizer(this.#loader);
    return await authorizer.authorize({
      principal: uid("User", user),
      action,
      resource: uid("Doc", id),
    });
  }
}

const Id = v.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const User = v.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/** The principal key produced by this example's default `apiKey` scheme. */
function apiKeyUser(subject: string): string {
  return principalKey({ scheme: "apiKey", subject });
}

function answer<T>(result: Answer<T>): T {
  if (result.ok) return result.value;
  if (result.status === 422) {
    throw new HttpError(422, "the policy does not validate", {
      details: { errors: result.errors },
    });
  }
  throw new HttpError(
    result.status,
    result.status === 404 ? "no such document" : "not allowed",
  );
}

function build(env: Env) {
  const app = router<Env>({
    auth: apiKey({
      lookup: hashedKeys(
        env.API_KEYS === undefined ? {} : JSON.parse(env.API_KEYS),
      ),
    }),
    limits: { body: 16 * 1024 },
  });
  // One workspace for the whole Worker; a multi-tenant one would name the
  // object after the principal's tenant.
  const workspace = (c: { env: Env }) => c.env.WORKSPACE.getByName("workspace");

  app.post("/docs", {
    body: v.object({
      title: v.string().min(1).max(200),
      public: v.boolean().optional(),
    }),
  }, async (c) => {
    return c.json(
      await workspace(c).create(
        c.principal.key,
        c.body.title,
        c.body.public ?? false,
      ),
      201,
    );
  });
  app.get(
    "/docs",
    async (c) => c.json({ docs: await workspace(c).list(c.principal.key) }),
  );
  app.get("/docs/:id", { params: v.object({ id: Id }) }, async (c) => {
    return c.json(
      answer(await workspace(c).read(c.principal.key, c.params.id)),
    );
  });
  for (const [method, grant] of [["put", true], ["delete", false]] as const) {
    app[method]("/docs/:id/viewers/:user", {
      params: v.object({ id: Id, user: User }),
    }, async (c) => {
      answer(
        await workspace(c).share(
          c.principal.key,
          c.params.id,
          apiKeyUser(c.params.user),
          grant,
        ),
      );
      return new Response(null, { status: 204 });
    });
  }
  app.put(
    "/policies/:id",
    {
      roles: ["admin"],
      params: v.object({ id: v.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }),
      body: v.object({ text: v.string().max(8 * 1024) }),
    },
    async (c) =>
      c.json(answer(await workspace(c).putPolicy(c.params.id, c.body.text))),
  );
  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
