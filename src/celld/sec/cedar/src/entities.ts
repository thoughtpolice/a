// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Entities: what a request's principal, resource and everything they are
 * `in` look like to Cedar.
 *
 * Cedar computes `in` over the entities it is given: `User::"a" in
 * Group::"eng"` holds when the path from `a` to `eng` runs through entities
 * that are all present, so a request needs its principal's and resource's
 * ancestors as well as the two themselves. An {@link EntityLoader} fetches
 * that closure; {@link EntitySet} keeps what was fetched, once per uid.
 *
 * @module
 */

import type { EntityJson } from "./ffi.ts";
import {
  type CedarInput,
  CedarValueError,
  type EntityUid,
  formatUid,
  toCedarJson,
  uid,
  uidFromJson,
  uidJson,
  type ValueLimits,
} from "./values.ts";

/** An entity as code writes it. */
export interface Entity {
  readonly uid: EntityUid;
  /** Attributes; `undefined` fields are left out. */
  readonly attrs?: { readonly [key: string]: CedarInput | undefined };
  /** Direct parents (groups, folders, ...). */
  readonly parents?: readonly EntityUid[];
  /** Tags: a map of string keys to values, read with `getTag`/`hasTag`. */
  readonly tags?: { readonly [key: string]: CedarInput | undefined };
}

/** Converts an entity to Cedar's JSON, checking every value. */
export function entityJson(entity: Entity, limits?: ValueLimits): EntityJson {
  const id = uid(entity.uid.type, entity.uid.id);
  const where = formatUid(id);
  const attrs = toCedarJson(
    entity.attrs ?? {},
    limits,
    `${where}.attrs`,
  ) as EntityJson["attrs"];
  const parents = (entity.parents ?? []).map((parent) =>
    uidJson(uid(parent.type, parent.id))
  );
  const json: EntityJson = { uid: uidJson(id), attrs, parents };
  if (entity.tags === undefined) return json;
  return {
    ...json,
    tags: toCedarJson(
      entity.tags,
      limits,
      `${where}.tags`,
    ) as EntityJson["tags"],
  };
}

/** Reads Cedar's JSON back into an {@link Entity}, values left as JSON. */
export function entityFromJson(
  json: EntityJson,
): Entity & { readonly attrs: EntityJson["attrs"] } {
  return {
    uid: uidFromJson(json.uid),
    attrs: json.attrs,
    parents: json.parents.map(uidFromJson),
    ...(json.tags ? { tags: json.tags } : {}),
  } as Entity & { readonly attrs: EntityJson["attrs"] };
}

/** Limits for an {@link EntitySet}. */
export interface EntitySetLimits extends ValueLimits {
  /** How many entities the set may hold (default 10,000). */
  readonly maxEntities?: number;
}

/**
 * Entities keyed by uid. Adding a uid twice with the same content is a
 * no-op and with different content an error, which is what Cedar would
 * say about the request; `replace` is for deliberate overrides.
 *
 * `add` takes entities as code writes them and checks every value
 * ({@link toCedarJson}); `addJson` takes Cedar JSON as a store returns it,
 * which may use Cedar's `__entity` and `__extn` escapes. Never pass caller
 * data to `addJson`.
 */
export class EntitySet {
  readonly #entities = new Map<string, EntityJson>();
  readonly #limits: EntitySetLimits;

  constructor(entities: Iterable<Entity> = [], limits: EntitySetLimits = {}) {
    this.#limits = limits;
    for (const entity of entities) this.add(entity);
  }

  get size(): number {
    return this.#entities.size;
  }

  has(id: EntityUid): boolean {
    return this.#entities.has(formatUid(id));
  }

  get(id: EntityUid): EntityJson | undefined {
    return this.#entities.get(formatUid(id));
  }

  add(entity: Entity): this {
    return this.#put(entityJson(entity, this.#limits), false);
  }

  addJson(json: EntityJson): this {
    return this.#put(trustedJson(json), false);
  }

  replace(entity: Entity): this {
    return this.#put(entityJson(entity, this.#limits), true);
  }

  replaceJson(json: EntityJson): this {
    return this.#put(trustedJson(json), true);
  }

  /** Adds every entity of `other`. */
  merge(other: EntitySet): this {
    for (const json of other.values()) this.#put(json, false);
    return this;
  }

  values(): IterableIterator<EntityJson> {
    return this.#entities.values();
  }

  /** The uids of the entities, in insertion order. */
  uids(): EntityUid[] {
    return [...this.#entities.values()].map((json) => uidFromJson(json.uid));
  }

  toJSON(): EntityJson[] {
    return [...this.#entities.values()];
  }

  #put(json: EntityJson, replace: boolean): this {
    const key = formatUid(uidFromJson(json.uid));
    const previous = this.#entities.get(key);
    if (previous !== undefined && !replace) {
      if (JSON.stringify(previous) !== JSON.stringify(json)) {
        throw new CedarValueError(
          key,
          "added twice with different attributes, parents or tags",
        );
      }
      return this;
    }
    const max = this.#limits.maxEntities ?? DEFAULT_MAX_ENTITIES;
    if (previous === undefined && this.#entities.size >= max) {
      throw new CedarValueError("", `more than ${max} entities`);
    }
    this.#entities.set(key, json);
    return this;
  }
}

export const DEFAULT_MAX_ENTITIES = 10_000;

/** Store JSON: the uid shapes are checked; Cedar checks the values. */
function trustedJson(json: EntityJson): EntityJson {
  return {
    uid: uidJson(uidFromJson(json.uid)),
    attrs: json.attrs ?? {},
    parents: (json.parents ?? []).map((parent) => uidJson(uidFromJson(parent))),
    ...(json.tags ? { tags: json.tags } : {}),
  };
}

/**
 * Fetches entities for a request: those it names and, when asked, their
 * ancestors. Stores implement it; see "@celld/sec/cedar/store".
 */
export interface EntityLoader {
  /**
   * The entities among `uids` that exist, with every ancestor of each
   * (transitively) when `ancestors` is true. Missing uids are left out:
   * Cedar treats an absent entity as one with no attributes or parents.
   */
  load(
    uids: readonly EntityUid[],
    options?: { readonly ancestors?: boolean },
  ): Promise<EntitySet>;
}

/** An {@link EntityLoader} over entities held in memory. */
export class MemoryEntities implements EntityLoader {
  readonly #set: EntitySet;
  readonly #maxEntities: number;

  constructor(entities: Iterable<Entity> = [], limits: EntitySetLimits = {}) {
    this.#set = new EntitySet([], {
      ...limits,
      maxEntities: Number.MAX_SAFE_INTEGER,
    });
    for (const entity of entities) this.#set.replace(entity);
    this.#maxEntities = limits.maxEntities ?? DEFAULT_MAX_ENTITIES;
  }

  put(entity: Entity): void {
    this.#set.replace(entity);
  }

  load(
    uids: readonly EntityUid[],
    options: { readonly ancestors?: boolean } = {},
  ): Promise<EntitySet> {
    return Promise.resolve(
      closure(
        uids,
        (id) => this.#set.get(id),
        options.ancestors ?? true,
        this.#maxEntities,
      ),
    );
  }
}

/**
 * The entities of `uids` (and their ancestors) from a synchronous lookup,
 * breadth first, stopping at `maxEntities`.
 */
export function closure(
  uids: readonly EntityUid[],
  lookup: (id: EntityUid) => EntityJson | undefined,
  ancestors: boolean,
  maxEntities: number,
): EntitySet {
  const result = new EntitySet([], { maxEntities });
  const seen = new Set<string>();
  const queue = [...uids];
  while (queue.length > 0) {
    const next = queue.shift()!;
    const key = formatUid(next);
    if (seen.has(key)) continue;
    seen.add(key);
    const found = lookup(next);
    if (found === undefined) continue;
    result.addJson(found);
    if (ancestors) queue.push(...found.parents.map(uidFromJson));
  }
  return result;
}
