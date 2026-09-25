// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Metadata policies (OpenID Federation 1.0 section 6.1): checking a
 * parameter policy's operators and their combinations
 * ({@link checkParameterPolicy}), merging the policies of a trust chain
 * from the trust anchor down ({@link resolveMetadataPolicy}), and applying
 * the result to an entity's metadata ({@link applyMetadataPolicy}).
 *
 * The standard operators, in the order they apply:
 *
 * | Operator      | Action                                          | Merge                  |
 * | ------------- | ----------------------------------------------- | ---------------------- |
 * | `value`       | set the parameter (null removes it)              | must be equal          |
 * | `add`         | add values to the array (create it if absent)    | union                  |
 * | `default`     | set the parameter if absent                      | must be equal          |
 * | `one_of`      | a present value must be one of these             | intersection, non-empty |
 * | `subset_of`   | a present array becomes its intersection with these | intersection         |
 * | `superset_of` | a present array must contain these               | union                  |
 * | `essential`   | `true`: the parameter must be present            | logical OR             |
 *
 * `one_of` cannot be combined with `add`, `subset_of` or `superset_of`;
 * the other conditional combinations of section 6.1.3.1 are checked for
 * every policy and again after every merge. Values are compared as JSON
 * (object key order does not matter). `scope`, a space-separated string,
 * is handled as an array (section 6.1.3.1.8). Any failure is a
 * {@link FederationError} with code `policy`, which makes the trust chain
 * invalid. Other operators are ignored unless named in
 * `metadata_policy_crit`, in which case the policy is refused: this
 * implementation knows only the standard ones.
 *
 * @module
 */

import { isObject } from "../util.ts";
import {
  type EntityMetadata,
  FederationError,
  type MetadataPolicy,
} from "./statement.ts";

/** The standard operators, in application order. */
export const POLICY_OPERATORS = [
  "value",
  "add",
  "default",
  "one_of",
  "subset_of",
  "superset_of",
  "essential",
] as const;

/** A standard operator. */
export type PolicyOperator = typeof POLICY_OPERATORS[number];

/** The operators of one parameter's policy. */
export type ParameterPolicy = Readonly<
  Partial<Record<PolicyOperator, unknown>>
>;

const STANDARD = new Set<string>(POLICY_OPERATORS);

function fail(message: string): FederationError {
  return new FederationError("policy", message);
}

function canonical(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) =>
      isObject(item)
        ? Object.fromEntries(
          Object.keys(item).sort().map((name) => [name, item[name]]),
        )
        : item,
  );
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function includes(list: readonly unknown[], value: unknown): boolean {
  return list.some((item) => same(item, value));
}

function isSubset(small: readonly unknown[], big: readonly unknown[]): boolean {
  return small.every((item) => includes(big, item));
}

function union(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  const out = [...a];
  for (const item of b) if (!includes(out, item)) out.push(item);
  return out;
}

function intersection(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  return a.filter((item) => includes(b, item));
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean";
}

function checkOperatorValue(
  name: string,
  operator: string,
  value: unknown,
): void {
  const where = `${name}.${operator}`;
  switch (operator) {
    case "value":
      if (
        !(value === null || isScalar(value) || Array.isArray(value) ||
          isObject(value))
      ) {
        throw fail(`${where} has an unsupported type`);
      }
      return;
    case "default":
      if (!(isScalar(value) || Array.isArray(value) || isObject(value))) {
        throw fail(
          `${where} must be a string, number, boolean, array or object`,
        );
      }
      return;
    case "add":
    case "one_of":
    case "subset_of":
    case "superset_of":
      if (!Array.isArray(value)) throw fail(`${where} must be an array`);
      return;
    case "essential":
      if (typeof value !== "boolean") throw fail(`${where} must be a boolean`);
      return;
  }
}

/** A `scope` value as an array, as section 6.1.3.1.8 prescribes. */
function asScopeArray(value: unknown): unknown {
  return typeof value === "string"
    ? value.split(" ").filter((item) => item !== "")
    : value;
}

/**
 * Checks one parameter's policy: each operator's value type, and that the
 * operators may be combined (with their conditions). Returns the policy
 * with only the standard operators; an unknown operator in `critical`
 * throws, any other unknown one is dropped.
 */
export function checkParameterPolicy(
  name: string,
  policy: Readonly<Record<string, unknown>>,
  critical: ReadonlySet<string> = new Set(),
): ParameterPolicy {
  if (!isObject(policy)) throw fail(`the policy for ${name} must be an object`);
  const out: Record<string, unknown> = {};
  for (const [operator, raw] of Object.entries(policy)) {
    if (!STANDARD.has(operator)) {
      if (critical.has(operator)) {
        throw fail(`the critical operator ${operator} is not supported`);
      }
      continue;
    }
    const value = name === "scope" && operator !== "essential"
      ? asScopeArray(raw)
      : raw;
    checkOperatorValue(name, operator, value);
    out[operator] = value;
  }
  const has = (operator: PolicyOperator) => Object.hasOwn(out, operator);
  const list = (operator: PolicyOperator) => out[operator] as unknown[];
  for (
    const [a, b] of [
      ["one_of", "add"],
      ["one_of", "subset_of"],
      ["one_of", "superset_of"],
    ] as const
  ) {
    if (has(a) && has(b)) {
      throw fail(`${name}: ${a} cannot be combined with ${b}`);
    }
  }
  if (has("value")) {
    const value = out.value;
    if (
      has("add") && (!Array.isArray(value) || !isSubset(list("add"), value))
    ) {
      throw fail(
        `${name}: the values of add must be among the values of value`,
      );
    }
    if (has("default") && value === null) {
      throw fail(`${name}: default cannot be combined with a null value`);
    }
    if (has("one_of") && !includes(list("one_of"), value)) {
      throw fail(`${name}: value must be one of one_of`);
    }
    if (
      has("subset_of") &&
      (!Array.isArray(value) || !isSubset(value, list("subset_of")))
    ) {
      throw fail(`${name}: value must be a subset of subset_of`);
    }
    if (
      has("superset_of") &&
      (!Array.isArray(value) || !isSubset(list("superset_of"), value))
    ) {
      throw fail(`${name}: value must be a superset of superset_of`);
    }
    if (value === null && out.essential === true) {
      throw fail(`${name}: a null value cannot be essential`);
    }
  }
  if (
    has("add") && has("subset_of") && !isSubset(list("add"), list("subset_of"))
  ) {
    throw fail(`${name}: the values of add must be a subset of subset_of`);
  }
  if (
    has("subset_of") && has("superset_of") &&
    !isSubset(list("superset_of"), list("subset_of"))
  ) {
    throw fail(`${name}: subset_of must be a superset of superset_of`);
  }
  return out as ParameterPolicy;
}

/** Merges a subordinate's parameter policy into the current one (section 6.1.4.1). */
export function mergeParameterPolicy(
  name: string,
  current: ParameterPolicy,
  next: ParameterPolicy,
): ParameterPolicy {
  const out: Record<string, unknown> = { ...current };
  for (const [operator, value] of Object.entries(next)) {
    if (!Object.hasOwn(out, operator)) {
      out[operator] = value;
      continue;
    }
    const mine = out[operator];
    switch (operator) {
      case "value":
      case "default":
        if (!same(mine, value)) {
          throw fail(
            `${name}: two different ${operator} operators cannot be merged`,
          );
        }
        break;
      case "add":
      case "superset_of":
        out[operator] = union(mine as unknown[], value as unknown[]);
        break;
      case "one_of": {
        const both = intersection(mine as unknown[], value as unknown[]);
        if (both.length === 0) {
          throw fail(`${name}: the one_of operators have nothing in common`);
        }
        out[operator] = both;
        break;
      }
      case "subset_of":
        out[operator] = intersection(mine as unknown[], value as unknown[]);
        break;
      case "essential":
        out[operator] = mine === true || value === true;
        break;
    }
  }
  return checkParameterPolicy(name, out);
}

function checkPolicy(
  policy: unknown,
  critical: ReadonlySet<string>,
): Record<string, Record<string, ParameterPolicy>> {
  if (!isObject(policy)) throw fail("metadata_policy must be an object");
  const out: Record<string, Record<string, ParameterPolicy>> = {};
  for (const [type, parameters] of Object.entries(policy)) {
    if (!isObject(parameters)) {
      throw fail(`metadata_policy.${type} must be an object`);
    }
    out[type] = {};
    for (const [name, operators] of Object.entries(parameters)) {
      if (!isObject(operators)) {
        throw fail(`metadata_policy.${type}.${name} must be an object`);
      }
      out[type][name] = checkParameterPolicy(name, operators, critical);
    }
  }
  return out;
}

/**
 * The resolved policy of a trust chain: `policies` from the most superior
 * statement's down to the immediate superior's, each checked and merged
 * into the ones above it. `critical` is every `metadata_policy_crit`
 * operator in the chain.
 */
export function resolveMetadataPolicy(
  policies: readonly MetadataPolicy[],
  critical: ReadonlySet<string> = new Set(),
): MetadataPolicy {
  const resolved: Record<string, Record<string, ParameterPolicy>> = {};
  for (const policy of policies) {
    const checked = checkPolicy(policy, critical);
    for (const [type, parameters] of Object.entries(checked)) {
      const current = resolved[type] ??= {};
      for (const [name, operators] of Object.entries(parameters)) {
        current[name] = current[name] === undefined
          ? operators
          : mergeParameterPolicy(name, current[name], operators);
      }
    }
  }
  return resolved;
}

/**
 * Applies one parameter's operators to `metadata` (in place), in the
 * standard order. Throws when the metadata does not comply.
 */
function applyParameter(
  metadata: Record<string, unknown>,
  name: string,
  policy: ParameterPolicy,
): void {
  const scope = name === "scope";
  const present = () => Object.hasOwn(metadata, name);
  if (scope && typeof metadata.scope === "string") {
    metadata.scope = asScopeArray(metadata.scope);
  }
  if (Object.hasOwn(policy, "value")) {
    if (policy.value === null) delete metadata[name];
    else metadata[name] = structuredClone(policy.value);
  }
  if (Object.hasOwn(policy, "add")) {
    const add = policy.add as unknown[];
    if (!present()) metadata[name] = [...add];
    else if (!Array.isArray(metadata[name])) {
      throw fail(`${name} is not an array, so add cannot apply`);
    } else metadata[name] = union(metadata[name] as unknown[], add);
  }
  if (Object.hasOwn(policy, "default") && !present()) {
    metadata[name] = structuredClone(policy.default);
  }
  if (Object.hasOwn(policy, "one_of") && present()) {
    if (!includes(policy.one_of as unknown[], metadata[name])) {
      throw fail(`${name} is not one of the values the policy allows`);
    }
  }
  if (Object.hasOwn(policy, "subset_of") && present()) {
    if (!Array.isArray(metadata[name])) {
      throw fail(`${name} is not an array, so subset_of cannot apply`);
    }
    metadata[name] = intersection(
      metadata[name] as unknown[],
      policy.subset_of as unknown[],
    );
  }
  if (Object.hasOwn(policy, "superset_of") && present()) {
    if (
      !Array.isArray(metadata[name]) ||
      !isSubset(policy.superset_of as unknown[], metadata[name] as unknown[])
    ) {
      throw fail(`${name} lacks values the policy requires (superset_of)`);
    }
  }
  if (policy.essential === true && !present()) {
    throw fail(`${name} is essential and missing`);
  }
  if (scope && Array.isArray(metadata.scope)) {
    metadata.scope = (metadata.scope as unknown[]).join(" ");
  }
}

/**
 * Applies a resolved policy to an entity's metadata and returns the
 * result (the input is not changed). Only the entity types the metadata
 * has are affected; a policy for another type is ignored.
 */
export function applyMetadataPolicy(
  metadata: EntityMetadata,
  policy: MetadataPolicy,
): EntityMetadata {
  const out: Record<string, Record<string, unknown>> = structuredClone(
    metadata,
  ) as Record<string, Record<string, unknown>>;
  for (const [type, parameters] of Object.entries(policy)) {
    const target = out[type];
    if (target === undefined) continue;
    for (const [name, operators] of Object.entries(parameters)) {
      applyParameter(target, name, operators as ParameterPolicy);
    }
  }
  return out;
}
