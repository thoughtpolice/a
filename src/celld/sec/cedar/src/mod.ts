// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Cedar policies and authorization for celld, imported as "@celld/sec/cedar".
 *
 * ```ts
 * import { Authorizer, ref, uid } from "@celld/sec/cedar";
 *
 * const authorizer = new Authorizer({
 *   schema: `
 *     entity User in [Team];
 *     entity Team;
 *     entity Doc { owner: User };
 *     action read, edit appliesTo { principal: User, resource: Doc };
 *   `,
 *   policies: `
 *     @id("owners")
 *     permit (principal, action, resource) when { resource.owner == principal };
 *   `,
 * });
 *
 * const alice = uid("User", "alice");
 * const decision = authorizer.check({
 *   principal: alice,
 *   action: "edit",
 *   resource: uid("Doc", "plan"),
 *   entities: [{ uid: uid("Doc", "plan"), attrs: { owner: ref(alice) } }],
 * });
 * decision.allowed; // true, decision.reasons: ["owners"]
 * ```
 *
 * The engine is cedar-wasm (Cedar 4.x) behind a binding of its own (see
 * ./wasm.ts); celld compiles the module once per node. Beyond the core:
 *
 * - "@celld/sec/cedar/query": partial evaluation compiled to SQL filters, for
 *   listing what a principal may see without fetching everything.
 * - "@celld/sec/cedar/store": policy and entity stores in a Durable Object's
 *   SQLite, with validate-on-write and versioned reloads.
 * - "@celld/sec/cedar/router": `authorize` for "@celld/web/router" routes.
 * - "@celld/sec/cedar/testing": table-driven policy tests.
 *
 * @module
 */

export {
  Authorizer,
  type AuthorizerOptions,
  type Decision,
  type EvaluationError,
  type PartialRequest,
  PREPARSED_CAPACITY,
  type Request,
  type Residual,
  type Residuals,
} from "./authorizer.ts";
export {
  CedarError,
  type Checked,
  type Diagnostic,
  formatDiagnostic,
  orThrow,
  type SourceOf,
  type Span,
} from "./diagnostics.ts";
export {
  closure,
  DEFAULT_MAX_ENTITIES,
  type Entity,
  entityFromJson,
  entityJson,
  type EntityLoader,
  EntitySet,
  type EntitySetLimits,
  MemoryEntities,
} from "./entities.ts";
export type * as ffi from "./ffi.ts";
export {
  type FormatOptions,
  formatPolicies,
  type Link,
  type Policy,
  type PolicyOptions,
  PolicySet,
  problem,
} from "./policies.ts";
export {
  type RequestEnvs,
  requestEnvs,
  Schema,
  validatePolicies,
  type Validation,
} from "./schema.ts";
export {
  type CedarInput,
  type CedarValue,
  CedarValueError,
  datetime,
  decimal,
  DEFAULT_MAX_DEPTH,
  duration,
  EntityRef,
  type EntityUid,
  Extension,
  formatUid,
  fromCedarJson,
  ip,
  isTypeName,
  parseUid,
  quote,
  ref,
  sameUid,
  toCedarJson,
  uid,
  uidFromJson,
  uidJson,
  unquote,
  type ValueLimits,
} from "./values.ts";
export {
  CEDAR_WASM,
  CedarEngine,
  CedarEngineError,
  type EngineOptions,
  sharedEngine,
} from "./wasm.ts";
