// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorization: a policy set (and usually a schema) answering requests.
 *
 * An {@link Authorizer} parses its policies and schema into the engine
 * once ("preparsed"), so a request costs Cedar only its entities and
 * context. Engines hold a bounded number of preparsed sets; an authorizer
 * that lost its place (to eviction, or to the engine replacing its
 * instance) parses again on its next request.
 *
 * Decisions fail closed. A request Cedar cannot evaluate (a context that
 * does not match the schema, malformed entities) is a deny with the reason
 * in {@link Decision.invalid}; a policy that errors during evaluation (an
 * attribute missing on some entity) does not apply, as Cedar specifies, and
 * is listed in {@link Decision.errors}.
 *
 * @module
 */

import { CedarError, type Diagnostic, toDiagnostics } from "./diagnostics.ts";
import {
  closure,
  DEFAULT_MAX_ENTITIES,
  type Entity,
  type EntityLoader,
  EntitySet,
  type EntitySetLimits,
} from "./entities.ts";
import type * as ffi from "./ffi.ts";
import { PolicySet } from "./policies.ts";
import { Schema, validatePolicies } from "./schema.ts";
import {
  type CedarInput,
  type EntityUid,
  toCedarJson,
  uid,
  uidJson,
} from "./values.ts";
import { type CedarEngine, CedarEngineError, sharedEngine } from "./wasm.ts";

/** Options for an {@link Authorizer}. */
export interface AuthorizerOptions {
  /** A parsed set, or Cedar text (which must parse). */
  readonly policies: PolicySet | string;
  /** A parsed schema, or schema text or JSON (which must parse). */
  readonly schema?: Schema | string | ffi.SchemaJson;
  /** Check every request against the schema (default: true with a schema). */
  readonly validateRequests?: boolean;
  /**
   * Refuse, at construction, policies that do not validate against the
   * schema (default true). Turn off only to serve a set that was stored
   * before the schema changed.
   */
  readonly validatePolicies?: boolean;
  /** Where {@link Authorizer.authorize} loads entities from. */
  readonly entities?: EntityLoader;
  /** The entity type of actions given as strings (default `Action`). */
  readonly actionType?: string;
  /** Limits on each request's entities and values. */
  readonly limits?: EntitySetLimits;
  readonly engine?: CedarEngine;
}

/** A request, with the entities Cedar should see. */
export interface Request {
  readonly principal: EntityUid;
  /** A uid, or an action id of the authorizer's `actionType`. */
  readonly action: EntityUid | string;
  readonly resource: EntityUid;
  readonly context?: { readonly [key: string]: CedarInput | undefined };
  /**
   * The request's entities. {@link Authorizer.authorize} adds what its
   * loader finds for the principal, resource and their ancestors.
   */
  readonly entities?: EntitySet | readonly Entity[];
}

/** A request whose unknowns partial evaluation leaves open. */
export interface PartialRequest {
  readonly principal?: EntityUid | null;
  readonly action?: EntityUid | string | null;
  readonly resource?: EntityUid | null;
  readonly context?: { readonly [key: string]: CedarInput | undefined };
  readonly entities?: EntitySet | readonly Entity[];
}

/** An error a policy hit while being evaluated; the policy did not apply. */
export interface EvaluationError {
  readonly policyId: string;
  readonly message: string;
}

/** Cedar's answer to a request. */
export interface Decision {
  readonly allowed: boolean;
  readonly decision: "allow" | "deny";
  /**
   * The policies that decided: the permits that allowed, or the forbids
   * that denied. Empty for a deny because nothing permitted.
   */
  readonly reasons: readonly string[];
  readonly errors: readonly EvaluationError[];
  /** Set when Cedar could not evaluate the request at all; always a deny. */
  readonly invalid?: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

/** What partial evaluation left of the policies. */
export interface Residuals {
  /** The decision if the unknowns cannot change it, else null. */
  readonly decision: "allow" | "deny" | null;
  /** Each policy that still depends on an unknown, simplified. */
  readonly residuals: readonly Residual[];
  /** Policies already satisfied whatever the unknowns are. */
  readonly satisfied: readonly string[];
  readonly errored: readonly string[];
  readonly invalid?: readonly Diagnostic[];
}

export interface Residual {
  readonly id: string;
  readonly effect: ffi.Effect;
  readonly policy: ffi.PolicyJson;
}

/** Preparsed slots of one kind in one engine, least recently used first. */
class Slots {
  readonly #owners = new Map<string, object>();
  readonly #prefix: string;
  readonly #capacity: number;
  #generation = -1;
  #next = 0;

  constructor(prefix: string, capacity: number) {
    this.#prefix = prefix;
    this.#capacity = capacity;
  }

  /** The slot `owner` holds, if it still does in this generation. */
  held(owner: object, name: string | undefined, generation: number): boolean {
    if (generation !== this.#generation) {
      this.#owners.clear();
      this.#generation = generation;
      return false;
    }
    if (name === undefined || this.#owners.get(name) !== owner) return false;
    this.#owners.delete(name);
    this.#owners.set(name, owner);
    return true;
  }

  /** A slot for `owner`, evicting the least recently used when full. */
  take(owner: object): string {
    let name: string;
    if (this.#owners.size < this.#capacity) {
      name = `${this.#prefix}${this.#next++}`;
    } else {
      name = this.#owners.keys().next().value!;
      this.#owners.delete(name);
    }
    this.#owners.set(name, owner);
    return name;
  }

  release(name: string, owner: object): void {
    if (this.#owners.get(name) === owner) this.#owners.delete(name);
  }
}

const SLOTS = new WeakMap<CedarEngine, { policies: Slots; schemas: Slots }>();

/** How many policy sets (and schemas) one engine keeps preparsed. */
export const PREPARSED_CAPACITY = 32;

function slotsOf(engine: CedarEngine): { policies: Slots; schemas: Slots } {
  let slots = SLOTS.get(engine);
  if (slots === undefined) {
    slots = {
      policies: new Slots("p", PREPARSED_CAPACITY),
      schemas: new Slots("s", PREPARSED_CAPACITY),
    };
    SLOTS.set(engine, slots);
  }
  return slots;
}

/** A policy set and schema that answer requests. */
export class Authorizer {
  readonly policies: PolicySet;
  readonly schema?: Schema;
  readonly #engine: CedarEngine;
  readonly #validateRequests: boolean;
  readonly #loader?: EntityLoader;
  readonly #actionType: string;
  readonly #limits: EntitySetLimits;
  #policySlot: string | undefined;
  #schemaSlot: string | undefined;

  constructor(options: AuthorizerOptions) {
    this.#engine = options.engine ?? sharedEngine();
    const engine = this.#engine;
    this.policies = typeof options.policies === "string"
      ? PolicySet.parseOrThrow(options.policies, { engine })
      : options.policies;
    if (options.schema !== undefined) {
      this.schema = options.schema instanceof Schema
        ? options.schema
        : Schema.parseOrThrow(options.schema, { engine });
      if (options.validatePolicies ?? true) {
        const validation = validatePolicies(this.policies, this.schema, {
          engine,
        });
        if (!validation.ok) {
          throw new CedarError(
            "the policies do not validate against the schema",
            validation.errors,
            (d) => this.policies.sourceOf(d.policyId),
          );
        }
      }
    }
    this.#validateRequests = options.validateRequests ??
      this.schema !== undefined;
    if (this.#validateRequests && this.schema === undefined) {
      throw new TypeError("validateRequests needs a schema");
    }
    this.#loader = options.entities;
    this.#actionType = options.actionType ?? "Action";
    this.#limits = options.limits ?? {};
    uid(this.#actionType, "");
  }

  /** The action uid for `action`: a uid, or an id of `actionType`. */
  action(action: EntityUid | string): EntityUid {
    return typeof action === "string"
      ? uid(this.#actionType, action)
      : uid(action.type, action.id);
  }

  /** Decides a request with exactly the entities it carries. */
  check(request: Request): Decision {
    let call: ffi.StatefulAuthorizationCall;
    try {
      call = this.#call(request, this.#entities(request.entities));
      return this.#decide(call);
    } catch (error) {
      return invalid(error);
    }
  }

  /**
   * Decides a request after loading the principal, the resource and their
   * ancestors with the `entities` loader (added to the request's own).
   */
  async authorize(request: Request): Promise<Decision> {
    let entities: EntitySet;
    try {
      entities = await this.#load(
        [request.principal, request.resource],
        request.entities,
      );
    } catch (error) {
      return invalid(error);
    }
    return this.check({ ...request, entities });
  }

  /** {@link check}'s `allowed`. */
  isAllowed(request: Request): boolean {
    return this.check(request).allowed;
  }

  /**
   * The actions among `actions` the principal may take on the resource,
   * loading entities once (for a UI's "what can I do here").
   */
  async permittedActions(
    request: Omit<Request, "action">,
    actions: readonly (EntityUid | string)[],
  ): Promise<EntityUid[]> {
    const entities = await this.#load(
      [request.principal, request.resource],
      request.entities,
    );
    return actions.map((action) => this.action(action)).filter((action) =>
      this.check({ ...request, action, entities }).allowed
    );
  }

  /**
   * The items the request each maps to allows, loading the entities of all
   * of them in one loader call (a list endpoint filtering what it fetched).
   * For lists too long to fetch first, plan a query instead
   * ("@celld/sec/cedar/query").
   */
  async filter<T>(
    items: readonly T[],
    toRequest: (item: T) => Request,
  ): Promise<T[]> {
    const requests = items.map(toRequest);
    const wanted = requests.flatMap((
      request,
    ) => [request.principal, request.resource]);
    const loaded = await this.#load(wanted, undefined);
    const max = this.#limits.maxEntities ?? DEFAULT_MAX_ENTITIES;
    return items.filter((_, i) => {
      const request = requests[i];
      // Each check sees its own principal, resource and ancestors, not
      // every entity the list loaded.
      const entities = closure(
        [request.principal, request.resource],
        (id) => loaded.get(id),
        true,
        max,
      );
      if (request.entities !== undefined) {
        entities.merge(this.#entities(request.entities));
      }
      return this.check({ ...request, entities }).allowed;
    });
  }

  /**
   * {@link partial} after loading the known principal and resource, and
   * their ancestors, with the `entities` loader (added to the request's
   * own). Without them, `principal in Team::"eng"` cannot hold.
   */
  async partialAuthorize(request: PartialRequest): Promise<Residuals> {
    const known = [request.principal, request.resource].filter((
      u,
    ): u is EntityUid => u !== null && u !== undefined);
    let entities: EntitySet;
    try {
      entities = await this.#load(known, request.entities);
    } catch (error) {
      return {
        decision: "deny",
        residuals: [],
        satisfied: [],
        errored: [],
        invalid: invalid(error).invalid,
      };
    }
    return this.partial({ ...request, entities });
  }

  /**
   * Partial evaluation: the policies with what is known filled in, leaving
   * conditions on the unknowns (null or missing principal, action or
   * resource). "@celld/sec/cedar/query" turns residuals on the resource into
   * a query filter.
   */
  partial(request: PartialRequest): Residuals {
    let call: ffi.PartialAuthorizationCall;
    try {
      call = {
        principal: request.principal ? uidJson(request.principal) : null,
        action: request.action ? uidJson(this.action(request.action)) : null,
        resource: request.resource ? uidJson(request.resource) : null,
        context: this.#context(request.context),
        ...(this.schema ? { schema: this.schema.toFfi() } : {}),
        validateRequest: this.#validateRequests,
        policies: this.policies.toFfi(),
        entities: this.#entities(request.entities).toJSON(),
      };
    } catch (error) {
      return {
        decision: "deny",
        residuals: [],
        satisfied: [],
        errored: [],
        invalid: invalid(error).invalid,
      };
    }
    let answer: ffi.PartialAuthorizationAnswer;
    try {
      answer = this.#engine.isAuthorizedPartial(call);
    } catch (error) {
      return {
        decision: "deny",
        residuals: [],
        satisfied: [],
        errored: [],
        invalid: invalid(error).invalid,
      };
    }
    if (answer.type === "failure") {
      return {
        decision: "deny",
        residuals: [],
        satisfied: [],
        errored: [],
        invalid: toDiagnostics(answer.errors),
      };
    }
    const response = answer.response;
    return {
      decision: response.decision,
      // Partial evaluation keeps policies it proved cannot apply, as a
      // `when { false }`; they say nothing about the unknowns.
      residuals: Object.entries(response.residuals)
        .filter(([, policy]) =>
          !policy.conditions.some((c) =>
            c.kind === "when" && isLiteral(c.body, false)
          )
        )
        .map(([id, policy]) => ({ id, effect: policy.effect, policy })),
      satisfied: response.satisfied,
      errored: response.errored,
    };
  }

  async #load(
    uids: readonly EntityUid[],
    extra: Request["entities"],
  ): Promise<EntitySet> {
    const entities = new EntitySet([], this.#limits);
    if (this.#loader !== undefined) {
      entities.merge(await this.#loader.load(uids, { ancestors: true }));
    }
    if (extra !== undefined) entities.merge(this.#entities(extra));
    return entities;
  }

  #entities(entities: Request["entities"]): EntitySet {
    if (entities instanceof EntitySet) return entities;
    return new EntitySet(entities ?? [], this.#limits);
  }

  #context(context: Request["context"]): ffi.Context {
    return toCedarJson(context ?? {}, this.#limits, "context") as ffi.Context;
  }

  #call(request: Request, entities: EntitySet): ffi.StatefulAuthorizationCall {
    return {
      principal: uidJson(uid(request.principal.type, request.principal.id)),
      action: uidJson(this.action(request.action)),
      resource: uidJson(uid(request.resource.type, request.resource.id)),
      context: this.#context(request.context),
      entities: entities.toJSON(),
      validateRequest: this.#validateRequests,
      preparsedPolicySetId: "",
    };
  }

  #decide(call: ffi.StatefulAuthorizationCall): Decision {
    // Preparsing can itself retire the instance (memory), and a retired
    // instance forgets what was preparsed, so a miss parses once more.
    for (let attempt = 0;; attempt++) {
      const prepared = this.#prepare();
      const answer = this.#engine.statefulIsAuthorized({
        ...call,
        ...prepared,
      });
      if (answer.type === "success") return decision(answer);
      if (
        attempt === 0 &&
        answer.errors.some((e) =>
          /^preparsed (policy set|schema) .* not found/.test(e.message)
        )
      ) {
        this.#policySlot = this.#schemaSlot = undefined;
        continue;
      }
      return {
        allowed: false,
        decision: "deny",
        reasons: [],
        errors: [],
        invalid: toDiagnostics(answer.errors),
        warnings: toDiagnostics(answer.warnings, { severity: "warning" }),
      };
    }
  }

  #prepare(): { preparsedPolicySetId: string; preparsedSchemaName?: string } {
    const engine = this.#engine;
    const slots = slotsOf(engine);
    if (!slots.policies.held(this, this.#policySlot, engine.generation)) {
      const name = slots.policies.take(this);
      const answer = engine.preparsePolicySet(name, this.policies.toFfi());
      if (answer.type === "failure") {
        slots.policies.release(name, this);
        throw new CedarError(
          "the policies do not preparse",
          toDiagnostics(answer.errors),
        );
      }
      this.#policySlot = name;
    }
    if (this.schema === undefined) {
      return { preparsedPolicySetId: this.#policySlot! };
    }
    if (!slots.schemas.held(this, this.#schemaSlot, engine.generation)) {
      const name = slots.schemas.take(this);
      const answer = engine.preparseSchema(name, this.schema.toFfi());
      if (answer.type === "failure") {
        slots.schemas.release(name, this);
        throw new CedarError(
          "the schema does not preparse",
          toDiagnostics(answer.errors),
        );
      }
      this.#schemaSlot = name;
    }
    return {
      preparsedPolicySetId: this.#policySlot!,
      preparsedSchemaName: this.#schemaSlot!,
    };
  }
}

function isLiteral(expr: ffi.Expr, value: boolean): boolean {
  return "Value" in expr && expr.Value === value;
}

function decision(
  answer: Extract<ffi.AuthorizationAnswer, { type: "success" }>,
): Decision {
  const response = answer.response;
  return {
    allowed: response.decision === "allow",
    decision: response.decision,
    reasons: response.diagnostics.reason,
    errors: response.diagnostics.errors.map((error) => ({
      policyId: error.policyId,
      message: error.error.message,
    })),
    warnings: toDiagnostics(answer.warnings, { severity: "warning" }),
  };
}

/**
 * A deny for a request Cedar would not take: a bad value, or input the FFI
 * rejected. An engine that trapped or never loaded is not an answer, so
 * that error propagates.
 */
function invalid(error: unknown): Decision {
  if (!(error instanceof Error)) throw error;
  if (error instanceof CedarEngineError && error.code !== "rejected") {
    throw error;
  }
  return {
    allowed: false,
    decision: "deny",
    reasons: [],
    errors: [],
    invalid: error instanceof CedarError
      ? error.diagnostics
      : [{ severity: "error", message: error.message, spans: [], related: [] }],
    warnings: [],
  };
}
