// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Schemas and validation.
 *
 * A schema names the entity types, their attributes and the actions, and
 * lets Cedar check policies before they are used (strict validation: a
 * policy that reads an attribute no entity has, or compares a string with
 * a number, is an error) and requests when they are made. Validating on
 * write is the usual workflow: a policy store refuses a policy that does
 * not validate, rather than let it silently never apply.
 *
 * @module
 */

import {
  type Checked,
  type Diagnostic,
  orThrow,
  toDiagnostics,
} from "./diagnostics.ts";
import type * as ffi from "./ffi.ts";
import type { PolicySet } from "./policies.ts";
import { type EntityUid, uid } from "./values.ts";
import { type CedarEngine, sharedEngine } from "./wasm.ts";

/** A parsed schema. */
export class Schema {
  readonly #source: string | ffi.SchemaJson;
  readonly #engine: CedarEngine;
  #json: ffi.SchemaJson | null;
  #text: string | null;

  private constructor(
    source: string | ffi.SchemaJson,
    engine: CedarEngine,
    json: ffi.SchemaJson | null,
  ) {
    this.#source = source;
    this.#engine = engine;
    this.#text = typeof source === "string" ? source : null;
    this.#json = json;
  }

  /** Parses Cedar schema text or schema JSON. */
  static parse(
    source: string | ffi.SchemaJson,
    options: { readonly engine?: CedarEngine } = {},
  ): Checked<Schema> {
    const engine = options.engine ?? sharedEngine();
    const answer = engine.schemaToJson(source);
    const text = typeof source === "string" ? source : undefined;
    if (answer.type === "failure") {
      return {
        ok: false,
        errors: toDiagnostics(answer.errors, { source: () => text }),
      };
    }
    return {
      ok: true,
      value: new Schema(source, engine, answer.json),
      warnings: toDiagnostics(answer.warnings, {
        severity: "warning",
        source: () => text,
      }),
    };
  }

  /** {@link parse}, throwing a `CedarError` with the diagnostics. */
  static parseOrThrow(
    source: string | ffi.SchemaJson,
    options: { readonly engine?: CedarEngine } = {},
  ): Schema {
    return orThrow(
      Schema.parse(source, options),
      "the schema does not parse",
      () => typeof source === "string" ? source : undefined,
    );
  }

  /** The schema as it was given, which is what Cedar is passed. */
  toFfi(): ffi.Schema {
    return this.#source;
  }

  /** The schema in Cedar's JSON format. */
  get json(): ffi.SchemaJson {
    return this.#json!;
  }

  /** The schema as Cedar text. */
  get text(): string {
    if (this.#text !== null) return this.#text;
    const answer = this.#engine.schemaToText(this.#source);
    if (answer.type === "failure") {
      throw new Error(
        `schema to text: ${answer.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return this.#text = answer.text;
  }

  /** The entity types, namespaced (`Acme::Doc`). */
  entityTypes(): string[] {
    return Object.entries(this.json).flatMap(([namespace, definition]) =>
      Object.keys(definition.entityTypes).map((name) =>
        qualify(namespace, name)
      )
    );
  }

  /** The actions, as uids (`Action::"read"`, `Acme::Action::"read"`). */
  actions(): EntityUid[] {
    return Object.entries(this.json).flatMap(([namespace, definition]) =>
      Object.keys(definition.actions).map((name) =>
        uid(qualify(namespace, "Action"), name)
      )
    );
  }
}

function qualify(namespace: string, name: string): string {
  return namespace === "" ? name : `${namespace}::${name}`;
}

/** What {@link validatePolicies} found. */
export interface Validation {
  /** No errors (warnings allowed). */
  readonly ok: boolean;
  /** Each names its policy; render it against `policies.sourceOf(id)`. */
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

/** Strict validation of every policy, template and link against `schema`. */
export function validatePolicies(
  policies: PolicySet,
  schema: Schema,
  options: { readonly engine?: CedarEngine } = {},
): Validation {
  const engine = options.engine ?? sharedEngine();
  const answer = engine.validate({
    validationSettings: { mode: "strict" },
    schema: schema.toFfi(),
    policies: policies.toFfi(),
  });
  if (answer.type === "failure") {
    return {
      ok: false,
      errors: toDiagnostics(answer.errors),
      warnings: toDiagnostics(answer.warnings, { severity: "warning" }),
    };
  }
  const located = (
    list: readonly ffi.ValidationError[],
    severity: ffi.Severity,
  ) =>
    toDiagnostics(list.map((entry) => entry.error), {
      severity,
      policyId: (_, i) => list[i].policyId,
      source: (id) => policies.sourceOf(id),
    });
  const errors = located(answer.validationErrors, "error");
  return {
    ok: errors.length === 0,
    errors,
    warnings: [
      ...located(answer.validationWarnings, "warning"),
      ...toDiagnostics(answer.otherWarnings, { severity: "warning" }),
    ],
  };
}

/** The principal, action and resource types a policy or template applies to. */
export interface RequestEnvs {
  readonly principals: readonly string[];
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}

/**
 * Which requests the policy or template `id` can apply to under `schema`:
 * for listing "what does this rule cover" next to it.
 */
export function requestEnvs(
  policies: PolicySet,
  id: string,
  schema: Schema,
  options: { readonly engine?: CedarEngine } = {},
): Checked<RequestEnvs> {
  const engine = options.engine ?? sharedEngine();
  const policy = policies.get(id);
  if (policy === undefined) {
    return {
      ok: false,
      errors: [{
        severity: "error",
        message: `no policy or template ${JSON.stringify(id)}`,
        spans: [],
        related: [],
      }],
    };
  }
  const answer = policy.kind === "policy"
    ? engine.validRequestEnvsPolicy(policy.text, schema.toFfi())
    : engine.validRequestEnvsTemplate(policy.text, schema.toFfi());
  if (answer.type === "failure") {
    return {
      ok: false,
      errors: [{
        severity: "error",
        message: answer.error,
        policyId: id,
        spans: [],
        related: [],
      }],
    };
  }
  const { principals, actions, resources } = answer;
  return { ok: true, value: { principals, actions, resources }, warnings: [] };
}
