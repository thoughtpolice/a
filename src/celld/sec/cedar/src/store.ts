// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Policies and entities kept in a Durable Object's SQLite. Many stores
 * (tenants) may share one set of tables, told apart by a `store` key; in a
 * Durable Object per tenant there is usually one.
 *
 * {@link PolicyStore} is the workflow for policies people edit: every
 * change is parsed and validated against the stored schema before it is
 * written (a policy that would never apply is refused with Cedar's
 * diagnostics, not stored), writes are guarded by a version number
 * (optimistic concurrency, retried on a race), and
 * {@link PolicyStore.authorizer} hands out an {@link Authorizer} cached
 * until the version moves.
 *
 * {@link EntityStore} keeps entities and their parents, loads a request's
 * entities with every ancestor in one recursive query, and lists the entities a principal may act on with a
 * filter compiled from the policies ({@link EntityStore.query}).
 *
 * ```ts
 * const driver = durableObjectSql(ctx.storage);
 * await migrate(driver);
 * const policies = new PolicyStore({ driver, store: tenant });
 * const entities = new EntityStore({ driver, store: tenant });
 *
 * const result = await policies.putPolicy("owners", text);
 * if (!result.ok) return Response.json({ errors: result.errors }, { status: 422 });
 *
 * const authorizer = await policies.authorizer({ entities });
 * const decision = await authorizer.authorize({ principal, action: "read", resource, context });
 * ```
 *
 * @module
 */

import { Authorizer, type AuthorizerOptions } from "./authorizer.ts";
import type { Checked, Diagnostic } from "./diagnostics.ts";
import {
  type Entity,
  entityJson,
  type EntityLoader,
  EntitySet,
  type EntitySetLimits,
} from "./entities.ts";
import type * as ffi from "./ffi.ts";
import { type Link, PolicySet, problem } from "./policies.ts";
import {
  type AttributeMapping,
  type ListRequest,
  planQuery,
  QueryUnsupported,
  type ResourceMapping,
} from "./query.ts";
import { Schema, validatePolicies } from "./schema.ts";
import {
  type Fragment,
  join,
  raw,
  type Row,
  sql,
  SqlConflictError,
  type SqlDriver,
  type Statement,
} from "./sql.ts";
import { type EntityUid, formatUid, uid, uidFromJson } from "./values.ts";
import { type CedarEngine, sharedEngine } from "./wasm.ts";

/** Where a store's tables are and which store (tenant) it is. */
export interface StoreOptions {
  readonly driver: SqlDriver;
  /** The key that tells tenants apart in the shared tables. */
  readonly store: string;
  /** Table name prefix (default `cedar_`): trusted text, not a request value. */
  readonly prefix?: string;
  readonly engine?: CedarEngine;
}

interface Tables {
  readonly stores: Fragment;
  readonly policies: Fragment;
  readonly links: Fragment;
  readonly entities: Fragment;
  readonly parents: Fragment;
}

function tables(prefix = "cedar_"): Tables {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) {
    throw new TypeError(
      "a table prefix must be lower-case letters, digits and _",
    );
  }
  return {
    stores: raw(`${prefix}stores`),
    policies: raw(`${prefix}policies`),
    links: raw(`${prefix}links`),
    entities: raw(`${prefix}entities`),
    parents: raw(`${prefix}parents`),
  };
}

/** The DDL for the store tables, one statement per fragment. */
export function storeTables(prefix?: string): Fragment[] {
  const t = tables(prefix);
  const name = (suffix: string) => raw(`${prefix ?? "cedar_"}${suffix}`);
  return [
    sql`CREATE TABLE IF NOT EXISTS ${t.stores} (store TEXT PRIMARY KEY, version INTEGER NOT NULL, schema_text TEXT)`,
    sql`CREATE TABLE IF NOT EXISTS ${t.policies} (store TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('policy', 'template')), text TEXT NOT NULL, PRIMARY KEY (store, id))`,
    sql`CREATE TABLE IF NOT EXISTS ${t.links} (store TEXT NOT NULL, id TEXT NOT NULL, template TEXT NOT NULL, principal_type TEXT, principal_id TEXT, resource_type TEXT, resource_id TEXT, PRIMARY KEY (store, id))`,
    sql`CREATE INDEX IF NOT EXISTS ${
      name("links_principal")
    } ON ${t.links} (store, principal_type, principal_id)`,
    sql`CREATE INDEX IF NOT EXISTS ${
      name("links_resource")
    } ON ${t.links} (store, resource_type, resource_id)`,
    sql`CREATE TABLE IF NOT EXISTS ${t.entities} (store TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, attrs TEXT NOT NULL, tags TEXT, PRIMARY KEY (store, type, id))`,
    sql`CREATE TABLE IF NOT EXISTS ${t.parents} (store TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, parent_type TEXT NOT NULL, parent_id TEXT NOT NULL, PRIMARY KEY (store, type, id, parent_type, parent_id))`,
    sql`CREATE INDEX IF NOT EXISTS ${
      name("parents_parent")
    } ON ${t.parents} (store, parent_type, parent_id)`,
  ];
}

/** Creates the store tables if they are missing. */
export function migrate(driver: SqlDriver, prefix?: string): Promise<void> {
  return driver.migrate(storeTables(prefix));
}

/** A JSON column read back. */
function readJson<T>(value: unknown): T {
  if (typeof value !== "string") {
    throw new TypeError("a JSON column is not text");
  }
  return JSON.parse(value) as T;
}

// MARK: Policies

/** Policies and schema as of one version. */
export interface Snapshot {
  /** 0 before the first write. */
  readonly version: number;
  readonly policies: PolicySet;
  readonly schema?: Schema;
}

/** What a write did. */
export type WriteResult =
  | { readonly ok: true; readonly version: number }
  | {
    readonly ok: false;
    /** Cedar's diagnostics, or a version conflict's. */
    readonly errors: readonly Diagnostic[];
    /** The store moved past `expectVersion` (or kept moving while retrying). */
    readonly conflict?: boolean;
    /** Render errors against `sourceOf(error.policyId)`. */
    readonly sourceOf?: (id: string | undefined) => string | undefined;
  };

/** Options of every write. */
export interface WriteOptions {
  /**
   * Write only if the store is still at this version (from a snapshot the
   * caller showed someone); without it a race is retried.
   */
  readonly expectVersion?: number;
}

const RETRIES = 5;

/** Uids per load statement: two parameters each, within SQLite's bound of 100. */
const SEEDS_PER_QUERY = 40;

/** A tenant's policies, templates, links and schema. */
/** Options of a {@link PolicyStore}. */
export interface PolicyStoreOptions extends StoreOptions {
  /**
   * Accept writes that leave validation warnings on a policy (default
   * false). Cedar warns, rather than errs, about a policy that can never
   * apply under the schema ("impossible policy") and about identifiers
   * that mix scripts or use confusable characters; refusing them keeps a
   * rule from silently doing nothing.
   */
  readonly allowWarnings?: boolean;
}

export class PolicyStore {
  readonly #driver: SqlDriver;
  readonly #store: string;
  readonly #t: Tables;
  readonly #engine: CedarEngine;
  readonly #allowWarnings: boolean;
  #cached: { version: number; snapshot: Snapshot } | null = null;
  #authorizers = new WeakMap<
    object,
    { version: number; authorizer: Authorizer }
  >();

  constructor(options: PolicyStoreOptions) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#t = tables(options.prefix);
    this.#engine = options.engine ?? sharedEngine();
    this.#allowWarnings = options.allowWarnings ?? false;
  }

  /** The current version: 0 before the first write, then one more per write. */
  async version(): Promise<number> {
    const rows = await this.#driver.query<{ version: number }>(
      sql`SELECT version FROM ${this.#t.stores} WHERE store = ${this.#store}`,
    );
    return rows.length === 0 ? 0 : Number(rows[0].version);
  }

  /** The current policies and schema, parsed (cached per version). */
  async load(): Promise<Snapshot> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const snapshot = await this.#read();
      if (snapshot !== null) return snapshot;
    }
    throw new Error(
      `the policy store ${this.#store} kept changing while being read`,
    );
  }

  async #read(): Promise<Snapshot | null> {
    const version = await this.version();
    if (this.#cached?.version === version) return this.#cached.snapshot;
    const [stores, policies, links] = await Promise.all([
      this.#driver.query<{ version: number; schema_text: string | null }>(
        sql`SELECT version, schema_text FROM ${this.#t.stores} WHERE store = ${this.#store}`,
      ),
      this.#driver.query<{ id: string; kind: string; text: string }>(
        sql`SELECT id, kind, text FROM ${this.#t.policies} WHERE store = ${this.#store} ORDER BY id`,
      ),
      this.#driver.query<LinkRow>(
        sql`SELECT * FROM ${this.#t.links} WHERE store = ${this.#store} ORDER BY id`,
      ),
    ]);
    // The reads are not one transaction, and a driver may interleave them
    // with writes: a template from one version with a link from the next
    // can grant what neither did. Every write moves the version, so the
    // same version before and after all of them means none landed between.
    const seen = stores.length === 0 ? 0 : Number(stores[0].version);
    if (seen !== version || await this.version() !== version) return null;
    const engine = this.#engine;
    const set = PolicySet.fromParts({
      policies: Object.fromEntries(
        policies.filter((p) => p.kind === "policy").map((p) => [p.id, p.text]),
      ),
      templates: Object.fromEntries(
        policies.filter((p) => p.kind === "template").map((
          p,
        ) => [p.id, p.text]),
      ),
      links: links.map(linkFromRow),
    }, { engine });
    if (!set.ok) {
      throw new Error(
        `stored policies of ${this.#store} do not parse: ${
          set.errors.map((e) => e.message).join("; ")
        }`,
      );
    }
    const schemaText = stores[0]?.schema_text ?? null;
    let schema: Schema | undefined;
    if (schemaText !== null) {
      const parsed = Schema.parse(schemaText, { engine });
      if (!parsed.ok) {
        throw new Error(`stored schema of ${this.#store} does not parse`);
      }
      schema = parsed.value;
    }
    const snapshot: Snapshot = {
      version,
      policies: set.value,
      ...(schema ? { schema } : {}),
    };
    this.#cached = { version, snapshot };
    return snapshot;
  }

  /**
   * An authorizer over the current version, reused until the version
   * moves. `options` (an entity loader, limits) are fixed per options
   * object: pass the same object to reuse its authorizer.
   */
  async authorizer(
    options: Omit<AuthorizerOptions, "policies" | "schema" | "engine"> = {},
  ): Promise<Authorizer> {
    const snapshot = await this.load();
    const cached = this.#authorizers.get(options);
    if (cached?.version === snapshot.version) return cached.authorizer;
    const authorizer = new Authorizer({
      ...options,
      engine: this.#engine,
      policies: snapshot.policies,
      ...(snapshot.schema ? { schema: snapshot.schema } : {}),
      // Stored policies validated when they were written; a schema change
      // re-validated them.
      validatePolicies: false,
    });
    this.#authorizers.set(options, { version: snapshot.version, authorizer });
    return authorizer;
  }

  /** Adds or replaces the policy or template `id` (one policy's text). */
  putPolicy(
    id: string,
    text: string,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    return this.#write(options, (s) => {
      const next = s.policies.with(id, text);
      if (!next.ok) return next;
      const kind = next.value.get(id)!.kind;
      return {
        ok: true,
        value: {
          policies: next.value,
          statements: [
            sql`INSERT INTO ${this.#t.policies} (store, id, kind, text) VALUES (${this.#store}, ${id}, ${kind}, ${text}) ON CONFLICT (store, id) DO UPDATE SET kind = excluded.kind, text = excluded.text`,
          ],
        },
        warnings: [],
      };
    });
  }

  /** Removes a policy, a template without links, or a link. */
  removePolicy(id: string, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#write(options, (s) => {
      const isLink = s.policies.getLink(id) !== undefined;
      const next = s.policies.without(id);
      if (!next.ok) return next;
      const table = isLink ? this.#t.links : this.#t.policies;
      return {
        ok: true,
        value: {
          policies: next.value,
          statements: [
            sql`DELETE FROM ${table} WHERE store = ${this.#store} AND id = ${id}`,
          ],
        },
        warnings: [],
      };
    });
  }

  /** Links a template (a grant); Cedar checks its slots. */
  link(link: Link, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#write(options, (s) => {
      const next = s.policies.link(link);
      if (!next.ok) return next;
      const { principal, resource } = link;
      return {
        ok: true,
        value: {
          policies: next.value,
          statements: [
            sql`INSERT INTO ${this.#t.links} (store, id, template, principal_type, principal_id, resource_type, resource_id) VALUES (${this.#store}, ${link.id}, ${link.template}, ${
              principal?.type ?? null
            }, ${principal?.id ?? null}, ${resource?.type ?? null}, ${
              resource?.id ?? null
            })`,
          ],
        },
        warnings: [],
      };
    });
  }

  /** Removes a link. */
  unlink(id: string, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#write(options, (s) => {
      const next = s.policies.unlink(id);
      if (!next.ok) return next;
      return {
        ok: true,
        value: {
          policies: next.value,
          statements: [
            sql`DELETE FROM ${this.#t.links} WHERE store = ${this.#store} AND id = ${id}`,
          ],
        },
        warnings: [],
      };
    });
  }

  /**
   * Sets the schema (Cedar text or JSON, stored as text), which every
   * stored policy must validate against; `null` removes it.
   */
  putSchema(
    schema: string | ffi.SchemaJson | null,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    let parsed: Schema | null = null;
    if (schema !== null) {
      const checked = Schema.parse(schema, { engine: this.#engine });
      if (!checked.ok) {
        return Promise.resolve({ ok: false, errors: checked.errors });
      }
      parsed = checked.value;
    }
    const text = parsed?.text ?? null;
    return this.#write(options, (s) => ({
      ok: true,
      value: {
        policies: s.policies,
        schema: parsed,
        statements: [
          sql`UPDATE ${this.#t.stores} SET schema_text = ${text} WHERE store = ${this.#store}`,
        ],
      },
      warnings: [],
    }));
  }

  /**
   * Replaces every static policy and template with those of `text` (ids
   * from `@id`), keeping links whose templates remain: deploying policies
   * kept in a repository. Links to templates that are gone make it fail.
   */
  replacePolicies(
    text: string,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    const parsed = PolicySet.parse(text, { engine: this.#engine });
    if (!parsed.ok) {
      return Promise.resolve({
        ok: false,
        errors: parsed.errors,
        sourceOf: () => text,
      });
    }
    return this.#write(options, (s) => {
      let next: Checked<PolicySet> = {
        ok: true,
        value: parsed.value,
        warnings: [],
      };
      for (const link of s.policies.links()) {
        if (!next.ok) break;
        next = next.value.link(link);
      }
      if (!next.ok) return next;
      const rows = [...parsed.value.policies(), ...parsed.value.templates()];
      return {
        ok: true,
        value: {
          policies: next.value,
          statements: [
            sql`DELETE FROM ${this.#t.policies} WHERE store = ${this.#store}`,
            ...rows.map((p) =>
              sql`INSERT INTO ${this.#t.policies} (store, id, kind, text) VALUES (${this.#store}, ${p.id}, ${p.kind}, ${p.text})`
            ),
          ],
        },
        warnings: [],
      };
    });
  }

  /**
   * Links by template, principal or resource: "what has Bob been given",
   * "who can see this document", from the links' index.
   */
  async links(
    filter: {
      readonly template?: string;
      readonly principal?: EntityUid;
      readonly resource?: EntityUid;
    } = {},
  ): Promise<Link[]> {
    const where = [sql`store = ${this.#store}`];
    if (filter.template !== undefined) {
      where.push(sql`template = ${filter.template}`);
    }
    if (filter.principal !== undefined) {
      where.push(
        sql`principal_type = ${filter.principal.type} AND principal_id = ${filter.principal.id}`,
      );
    }
    if (filter.resource !== undefined) {
      where.push(
        sql`resource_type = ${filter.resource.type} AND resource_id = ${filter.resource.id}`,
      );
    }
    const rows = await this.#driver.query<LinkRow>(
      sql`SELECT * FROM ${this.#t.links} WHERE ${
        join(where, " AND ")
      } ORDER BY id`,
    );
    return rows.map(linkFromRow);
  }

  /**
   * Reads, applies `change`, validates and writes in one guarded batch,
   * retrying when another writer got there first (unless the caller named
   * the version it expects).
   */
  async #write(
    options: WriteOptions,
    change: (
      snapshot: Snapshot,
    ) => Checked<
      { policies: PolicySet; schema?: Schema | null; statements: Fragment[] }
    >,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const snapshot = await this.load();
      if (
        options.expectVersion !== undefined &&
        options.expectVersion !== snapshot.version
      ) {
        return conflict(snapshot.version);
      }
      const changed = change(snapshot);
      if (!changed.ok) {
        return {
          ok: false,
          errors: changed.errors,
          sourceOf: (id) => snapshot.policies.sourceOf(id),
        };
      }
      const { policies, statements } = changed.value;
      const schema = changed.value.schema === undefined
        ? snapshot.schema
        : changed.value.schema ?? undefined;
      if (schema !== undefined) {
        const validation = validatePolicies(policies, schema, {
          engine: this.#engine,
        });
        const refused = [
          ...validation.errors,
          ...(this.#allowWarnings
            ? []
            : validation.warnings.filter((w) => w.policyId !== undefined)),
        ];
        if (refused.length > 0) {
          return {
            ok: false,
            errors: refused,
            sourceOf: (id) => policies.sourceOf(id),
          };
        }
      }
      const next = snapshot.version + 1;
      const guard: Statement = {
        // Creates the store's row at version 1, or moves it from the version
        // read to the next; anything else changes no row and rolls back.
        sql:
          sql`INSERT INTO ${this.#t.stores} (store, version) VALUES (${this.#store}, ${next}) ON CONFLICT (store) DO UPDATE SET version = ${next} WHERE ${this.#t.stores}.version = ${snapshot.version}`,
        expect: 1,
      };
      try {
        await this.#driver.batch([
          guard,
          ...statements.map((sql) => ({ sql })),
        ]);
      } catch (error) {
        if (!(error instanceof SqlConflictError) || error.statement !== 0) {
          throw error;
        }
        if (options.expectVersion !== undefined) {
          return conflict(await this.version());
        }
        continue;
      }
      this.#cached = null;
      return { ok: true, version: next };
    }
    return conflict(await this.version());
  }
}

function conflict(version: number): WriteResult {
  return {
    ok: false,
    conflict: true,
    errors: [
      problem(
        `the policy store changed (it is at version ${version}); load it and try again`,
      ),
    ],
  };
}

interface LinkRow extends Row {
  readonly id: string;
  readonly template: string;
  readonly principal_type: string | null;
  readonly principal_id: string | null;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
}

function linkFromRow(row: LinkRow): Link {
  return {
    id: row.id,
    template: row.template,
    ...(row.principal_type !== null && row.principal_id !== null
      ? { principal: uid(row.principal_type, row.principal_id) }
      : {}),
    ...(row.resource_type !== null && row.resource_id !== null
      ? { resource: uid(row.resource_type, row.resource_id) }
      : {}),
  };
}

// MARK: Entities

/** Options of an {@link EntityStore}. */
export interface EntityStoreOptions extends StoreOptions {
  /** The most entities one load returns (default 10,000); more is an error. */
  readonly maxEntities?: number;
  readonly limits?: EntitySetLimits;
}

/** A tenant's entities, their parents, and policy-filtered listing. */
export class EntityStore implements EntityLoader {
  readonly #driver: SqlDriver;
  readonly #store: string;
  readonly #t: Tables;
  readonly #max: number;
  readonly #limits: EntitySetLimits;

  constructor(options: EntityStoreOptions) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#t = tables(options.prefix);
    this.#max = options.maxEntities ?? 10_000;
    this.#limits = { ...options.limits, maxEntities: this.#max };
  }

  /** Adds or replaces entities (attributes, tags and parents) in one batch. */
  async put(...entities: readonly Entity[]): Promise<void> {
    const statements: Statement[] = [];
    for (const entity of entities) {
      const json = entityJson(entity, this.#limits);
      const { type, id } = entity.uid;
      statements.push(
        {
          sql:
            sql`INSERT INTO ${this.#t.entities} (store, type, id, attrs, tags) VALUES (${this.#store}, ${type}, ${id}, ${
              JSON.stringify(json.attrs)
            }, ${
              json.tags ? JSON.stringify(json.tags) : null
            }) ON CONFLICT (store, type, id) DO UPDATE SET attrs = excluded.attrs, tags = excluded.tags`,
        },
        {
          sql:
            sql`DELETE FROM ${this.#t.parents} WHERE store = ${this.#store} AND type = ${type} AND id = ${id}`,
        },
        ...json.parents.map((parent) => ({
          sql:
            sql`INSERT INTO ${this.#t.parents} (store, type, id, parent_type, parent_id) VALUES (${this.#store}, ${type}, ${id}, ${
              uidFromJson(parent).type
            }, ${uidFromJson(parent).id}) ON CONFLICT DO NOTHING`,
        })),
      );
    }
    await this.#driver.batch(statements);
  }

  /** Removes an entity and every parent edge to or from it; false if absent. */
  async remove(entity: EntityUid): Promise<boolean> {
    const [removed] = await this.#driver.batch([
      {
        sql:
          sql`DELETE FROM ${this.#t.entities} WHERE store = ${this.#store} AND type = ${entity.type} AND id = ${entity.id}`,
      },
      {
        sql:
          sql`DELETE FROM ${this.#t.parents} WHERE store = ${this.#store} AND ((type = ${entity.type} AND id = ${entity.id}) OR (parent_type = ${entity.type} AND parent_id = ${entity.id}))`,
      },
    ]);
    return removed > 0;
  }

  /** Adds a parent edge (`child in parent`). */
  async addParent(child: EntityUid, parent: EntityUid): Promise<void> {
    await this.#driver.batch([{
      sql:
        sql`INSERT INTO ${this.#t.parents} (store, type, id, parent_type, parent_id) VALUES (${this.#store}, ${child.type}, ${child.id}, ${parent.type}, ${parent.id}) ON CONFLICT DO NOTHING`,
    }]);
  }

  async removeParent(child: EntityUid, parent: EntityUid): Promise<boolean> {
    const [removed] = await this.#driver.batch([{
      sql:
        sql`DELETE FROM ${this.#t.parents} WHERE store = ${this.#store} AND type = ${child.type} AND id = ${child.id} AND parent_type = ${parent.type} AND parent_id = ${parent.id}`,
    }]);
    return removed > 0;
  }

  /** One entity, as Cedar JSON, or undefined. */
  async get(entity: EntityUid): Promise<ffi.EntityJson | undefined> {
    const set = await this.load([entity], { ancestors: false });
    return set.get(entity);
  }

  /**
   * The entities of `uids` and (by default) all their ancestors, from one
   * recursive query per table. An ancestor with parents but no row of its
   * own is included with no attributes, so `in` still sees through it.
   */
  async load(
    uids: readonly EntityUid[],
    options: { readonly ancestors?: boolean } = {},
  ): Promise<EntitySet> {
    const result = new EntitySet([], this.#limits);
    // Durable Object SQLite binds at most 100 parameters per statement.
    for (let i = 0; i < uids.length; i += SEEDS_PER_QUERY) {
      await this.#loadInto(
        result,
        uids.slice(i, i + SEEDS_PER_QUERY),
        options.ancestors ?? true,
      );
    }
    return result;
  }

  async #loadInto(
    result: EntitySet,
    uids: readonly EntityUid[],
    ancestors: boolean,
  ): Promise<void> {
    const seeds = join(uids.map((u) => sql`(${u.type}, ${u.id})`), ", ");
    const closure = ancestors
      ? sql`WITH RECURSIVE seeds(type, id) AS (VALUES ${seeds}), closure(type, id) AS (SELECT type, id FROM seeds UNION SELECT p.parent_type, p.parent_id FROM ${this.#t.parents} p JOIN closure c ON p.type = c.type AND p.id = c.id WHERE p.store = ${this.#store})`
      : sql`WITH closure(type, id) AS (VALUES ${seeds})`;
    const limit = this.#max + 1;
    const edgeLimit = this.#max * 64;
    const [rows, edges] = await Promise.all([
      this.#driver.query<
        { type: string; id: string; attrs: unknown; tags: unknown }
      >(
        sql`${closure} SELECT e.type, e.id, e.attrs, e.tags FROM ${this.#t.entities} e JOIN closure c ON e.type = c.type AND e.id = c.id WHERE e.store = ${this.#store} LIMIT ${limit}`,
      ),
      this.#driver.query<
        { type: string; id: string; parent_type: string; parent_id: string }
      >(
        sql`${closure} SELECT p.type, p.id, p.parent_type, p.parent_id FROM ${this.#t.parents} p JOIN closure c ON p.type = c.type AND p.id = c.id WHERE p.store = ${this.#store} ORDER BY p.type, p.id, p.parent_type, p.parent_id LIMIT ${edgeLimit}`,
      ),
    ]);
    if (rows.length + result.size > this.#max) {
      throw new RangeError(`loading entities found more than ${this.#max}`);
    }
    if (edges.length >= edgeLimit) {
      throw new RangeError(
        `loading entities found more than ${edgeLimit} parent edges`,
      );
    }
    const nodes = new Map<
      string,
      {
        uid: EntityUid;
        parents: ffi.EntityUidJson[];
        row?: (typeof rows)[number];
      }
    >();
    const node = (type: string, id: string) => {
      const key = formatUid({ type, id });
      let found = nodes.get(key);
      if (found === undefined) {
        nodes.set(key, found = { uid: uid(type, id), parents: [] });
      }
      return found;
    };
    for (const edge of edges) {
      node(edge.type, edge.id).parents.push({
        type: edge.parent_type,
        id: edge.parent_id,
      });
    }
    for (const row of rows) node(row.type, row.id).row = row;
    for (const { uid: entity, parents, row } of nodes.values()) {
      const tags = row === undefined || row.tags === null
        ? undefined
        : readJson<ffi.EntityJson["tags"]>(row.tags);
      result.addJson({
        uid: { type: entity.type, id: entity.id },
        attrs: row === undefined
          ? {}
          : readJson<ffi.EntityJson["attrs"]>(row.attrs),
        parents,
        ...(tags ? { tags } : {}),
      });
    }
  }

  /**
   * The {@link ResourceMapping} of `type` over this store's tables, for
   * "@celld/sec/cedar/query": attributes read from the JSON column, `in` from
   * the parent edges. `attributes` names the attributes a filter may read
   * and their types (Cedar's JSON does not say whether `"3"` was a string).
   */
  mapping(
    type: string,
    attributes: { readonly [path: string]: AttributeType },
  ): ResourceMapping {
    const descendants = (ancestor: EntityUid, of: string) =>
      sql`(SELECT d.id FROM (WITH RECURSIVE below(type, id) AS (SELECT type, id FROM ${this.#t.parents} WHERE store = ${this.#store} AND parent_type = ${ancestor.type} AND parent_id = ${ancestor.id} UNION SELECT p.type, p.id FROM ${this.#t.parents} p JOIN below b ON p.parent_type = b.type AND p.parent_id = b.id WHERE p.store = ${this.#store}) SELECT type, id FROM below) d WHERE d.type = ${of})`;
    const mapped: Record<string, AttributeMapping> = {};
    for (const [path, spec] of Object.entries(attributes)) {
      const keys = path.split(".");
      // A dotted path is read from the resource's own JSON, so every
      // attribute on the way must be a record: an entity's attributes are
      // in its own row, which a JSON path cannot reach.
      for (let i = 1; i < keys.length; i++) {
        const prefix = keys.slice(0, i).join(".");
        if (attributes[prefix] !== "record") {
          throw new QueryUnsupported(
            `the attribute ${path} of ${type} is read through ${prefix}, which is not declared a record`,
          );
        }
      }
      if (typeof spec === "string") {
        mapped[path] = spec === "set"
          ? {
            type: "set",
            element: "string",
            column: jsonPath(keys),
          }
          : { type: spec, column: jsonPath(keys) };
      } else if ("entity" in spec) {
        const column = jsonPath([...keys, "__entity", "id"]);
        mapped[path] = {
          type: "entity",
          entityType: spec.entity,
          column,
          in: (ancestor) =>
            sql`${column} IN ${descendants(ancestor, spec.entity)}`,
        };
      } else {
        mapped[path] = {
          type: "set",
          element: spec.set,
          column: jsonPath(keys),
        };
      }
    }
    return {
      type,
      id: raw("e.id"),
      attributes: mapped,
      in: (ancestor) => sql`e.id IN ${descendants(ancestor, type)}`,
    };
  }

  /**
   * The entities of `type` that the request (with the resource left open)
   * allows, filtered in SQL. Throws `QueryUnsupported` for policies the
   * filter cannot express; fall back to `Authorizer.filter` then.
   */
  async query(
    authorizer: Authorizer,
    request: ListRequest,
    type: string,
    attributes: { readonly [path: string]: AttributeType },
    options: { readonly limit?: number; readonly after?: string } = {},
  ): Promise<ffi.EntityJson[]> {
    const plan = await planQuery(
      authorizer,
      request,
      this.mapping(type, attributes),
    );
    if (plan.none) return [];
    const limit = Math.min(options.limit ?? 100, this.#max);
    const after = options.after === undefined
      ? raw("TRUE")
      : sql`e.id > ${options.after}`;
    const rows = await this.#driver.query<
      { id: string; attrs: unknown; tags: unknown }
    >(
      sql`SELECT e.id, e.attrs, e.tags FROM ${this.#t.entities} e WHERE e.store = ${this.#store} AND e.type = ${type} AND ${after} AND ${plan.where} ORDER BY e.id LIMIT ${limit}`,
    );
    const set = await this.load(rows.map((row) => uid(type, row.id)), {
      ancestors: false,
    });
    return rows.map((row) => set.get(uid(type, row.id))!);
  }
}

/**
 * An attribute's type for {@link EntityStore.mapping}: a scalar, a set of
 * strings (`"set"`) or of a given element, a record (whose fields are
 * declared by dotted path, `profile.admin`), or an entity of a type.
 */
export type AttributeType =
  | "string"
  | "long"
  | "bool"
  | "set"
  | "record"
  | { readonly set: "string" | "long" }
  | { readonly entity: string };

/**
 * A JSON attribute path as a column. `json_extract` answers JSON's types
 * as SQLite's own (booleans as 1 and 0), and an array as JSON text, which
 * `json_each` reads.
 */
function jsonPath(keys: readonly string[]): Fragment {
  const path = "$" + keys.map((k) => `.${JSON.stringify(k)}`).join("");
  return sql`json_extract(e.attrs, ${path})`;
}
