// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON shapes of Cedar's FFI: what cedar-wasm takes and answers.
 *
 * These follow the declarations tsify generates for cedar-wasm 4.13
 * (`@cedar-policy/cedar-wasm`, Apache-2.0, Copyright Cedar Contributors),
 * written out by hand with the fixes its build script applies by `sed`
 * (quoted operator keys, no `__skip` variants). They are the wire format;
 * the typed API in ./cedar.ts wraps them, and most code never needs them
 * except to read a {@link PolicyJson} or a residual.
 *
 * @module
 */

/** An entity's type and id, as the FFI takes them. */
export interface TypeAndId {
  readonly type: string;
  readonly id: string;
}

/** An entity reference: `{type, id}` or the escaped `{__entity: {type, id}}`. */
export type EntityUidJson = { readonly __entity: TypeAndId } | TypeAndId;

/** A Cedar value as JSON, with `__entity` and `__extn` escapes. */
export type CedarValueJson =
  | { readonly __entity: TypeAndId }
  | { readonly __extn: FnAndArgs }
  | boolean
  | number
  | string
  | readonly CedarValueJson[]
  | { readonly [key: string]: CedarValueJson }
  | null;

/** An extension value: its constructor and argument(s). */
export type FnAndArgs =
  | { readonly fn: string; readonly arg: CedarValueJson }
  | { readonly fn: string; readonly args: readonly CedarValueJson[] };

/** One entity. */
export interface EntityJson {
  readonly uid: EntityUidJson;
  readonly attrs: { readonly [key: string]: CedarValueJson };
  readonly parents: readonly EntityUidJson[];
  readonly tags?: { readonly [key: string]: CedarValueJson };
}

export type Entities = readonly EntityJson[];

export type Context = { readonly [key: string]: CedarValueJson };

/** A policy in Cedar text or JSON. */
export type Policy = string | PolicyJson;
export type Template = string | PolicyJson;

/** A Cedar schema, as Cedar text or JSON. */
export type Schema = string | SchemaJson;

/**
 * A policy set: static policies (one text of many policies, a list, or a
 * map from id to policy), templates by id, and template links.
 */
export interface PolicySet {
  readonly staticPolicies?: string | readonly Policy[] | {
    readonly [id: string]: Policy;
  };
  readonly templates?: { readonly [id: string]: Template };
  readonly templateLinks?: readonly TemplateLink[];
}

/** A template link: `values` fills `?principal` and `?resource`. */
export interface TemplateLink {
  readonly templateId: string;
  readonly newId: string;
  readonly values: { readonly [slot: string]: EntityUidJson };
}

export type Severity = "advice" | "warning" | "error";

export interface SourceLabel {
  readonly start: number;
  readonly end: number;
  readonly label: string | null;
}

/** An error or warning, with byte offsets into the text it is about. */
export interface DetailedError {
  readonly message: string;
  readonly help: string | null;
  readonly code: string | null;
  readonly url: string | null;
  readonly severity: Severity | null;
  readonly sourceLocations?: readonly SourceLabel[];
  readonly related?: readonly DetailedError[];
}

export type CheckParseAnswer =
  | { readonly type: "success" }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export interface FormattingCall {
  readonly policyText: string;
  readonly lineWidth?: number;
  readonly indentWidth?: number;
}

export type FormattingAnswer =
  | { readonly type: "success"; readonly formatted_policy: string }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export type PolicySetTextToPartsAnswer =
  | {
    readonly type: "success";
    readonly policies: readonly string[];
    readonly policy_templates: readonly string[];
  }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export type PolicyToJsonAnswer =
  | { readonly type: "success"; readonly json: PolicyJson }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export type PolicyToTextAnswer =
  | { readonly type: "success"; readonly text: string }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export type SchemaToJsonAnswer =
  | {
    readonly type: "success";
    readonly json: SchemaJson;
    readonly warnings: readonly DetailedError[];
  }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export type SchemaToTextAnswer =
  | {
    readonly type: "success";
    readonly text: string;
    readonly warnings: readonly DetailedError[];
  }
  | { readonly type: "failure"; readonly errors: readonly DetailedError[] };

export interface EntitiesParsingCall {
  readonly entities: Entities;
  readonly schema?: Schema | null;
}

export interface ContextParsingCall {
  readonly context: Context;
  readonly schema?: Schema | null;
  readonly action?: EntityUidJson | null;
}

export interface ValidationCall {
  readonly validationSettings?: { readonly mode: "strict" };
  readonly schema: Schema;
  readonly policies: PolicySet;
}

export interface ValidationError {
  readonly policyId: string;
  readonly error: DetailedError;
}

export type ValidationAnswer =
  | {
    readonly type: "failure";
    readonly errors: readonly DetailedError[];
    readonly warnings: readonly DetailedError[];
  }
  | {
    readonly type: "success";
    readonly validationErrors: readonly ValidationError[];
    readonly validationWarnings: readonly ValidationError[];
    readonly otherWarnings: readonly DetailedError[];
  };

export type GetValidRequestEnvsResult =
  | {
    readonly type: "success";
    readonly principals: readonly string[];
    readonly actions: readonly string[];
    readonly resources: readonly string[];
  }
  | { readonly type: "failure"; readonly error: string };

export interface AuthorizationCall {
  readonly principal: EntityUidJson;
  readonly action: EntityUidJson;
  readonly resource: EntityUidJson;
  readonly context: Context;
  readonly schema?: Schema;
  readonly validateRequest?: boolean;
  readonly policies: PolicySet;
  readonly entities: Entities;
}

export interface StatefulAuthorizationCall {
  readonly principal: EntityUidJson;
  readonly action: EntityUidJson;
  readonly resource: EntityUidJson;
  readonly context: Context;
  readonly preparsedSchemaName?: string;
  readonly validateRequest?: boolean;
  readonly preparsedPolicySetId: string;
  readonly entities: Entities;
}

export interface PartialAuthorizationCall {
  readonly principal: EntityUidJson | null;
  readonly action: EntityUidJson | null;
  readonly resource: EntityUidJson | null;
  readonly context: Context;
  readonly schema?: Schema;
  readonly validateRequest?: boolean;
  readonly policies: PolicySet;
  readonly entities: Entities;
}

export interface AuthorizationError {
  readonly policyId: string;
  readonly error: DetailedError;
}

export interface Response {
  readonly decision: "allow" | "deny";
  readonly diagnostics: {
    readonly reason: readonly string[];
    readonly errors: readonly AuthorizationError[];
  };
}

export type AuthorizationAnswer =
  | {
    readonly type: "failure";
    readonly errors: readonly DetailedError[];
    readonly warnings: readonly DetailedError[];
  }
  | {
    readonly type: "success";
    readonly response: Response;
    readonly warnings: readonly DetailedError[];
  };

export interface ResidualResponse {
  readonly decision: "allow" | "deny" | null;
  readonly satisfied: readonly string[];
  readonly errored: readonly string[];
  readonly mayBeDetermining: readonly string[];
  readonly mustBeDetermining: readonly string[];
  readonly residuals: { readonly [id: string]: PolicyJson };
  readonly nontrivialResiduals: readonly string[];
}

export type PartialAuthorizationAnswer =
  | {
    readonly type: "failure";
    readonly errors: readonly DetailedError[];
    readonly warnings: readonly DetailedError[];
  }
  | {
    readonly type: "residuals";
    readonly response: ResidualResponse;
    readonly warnings: readonly DetailedError[];
  };

// MARK: Policies as JSON

export type Effect = "permit" | "forbid";

export type Annotations = { readonly [key: string]: string };

/** A policy (or, with slots, a template) in Cedar's JSON format. */
export interface PolicyJson {
  readonly effect: Effect;
  readonly principal: ScopeConstraint;
  readonly action: ActionConstraint;
  readonly resource: ScopeConstraint;
  readonly conditions: readonly Clause[];
  readonly annotations?: Annotations;
}

export type ScopeConstraint =
  | { readonly op: "All" }
  | { readonly op: "=="; readonly entity: EntityUidJson }
  | { readonly op: "=="; readonly slot: string }
  | { readonly op: "in"; readonly entity: EntityUidJson }
  | { readonly op: "in"; readonly slot: string }
  | {
    readonly op: "is";
    readonly entity_type: string;
    readonly in?: { readonly entity: EntityUidJson } | {
      readonly slot: string;
    };
  };

export type ActionConstraint =
  | { readonly op: "All" }
  | { readonly op: "=="; readonly entity: EntityUidJson }
  | { readonly op: "in"; readonly entity: EntityUidJson }
  | { readonly op: "in"; readonly entities: readonly EntityUidJson[] };

export type Clause =
  | { readonly kind: "when"; readonly body: Expr }
  | { readonly kind: "unless"; readonly body: Expr };

export type Var = "principal" | "action" | "resource" | "context";

type Binary = { readonly left: Expr; readonly right: Expr };

/**
 * An expression. The keys are Cedar's operators; an extension function
 * call is `{ "<name>": [args] }`, which in a residual includes
 * `{ "unknown": [{ "Value": "resource" }] }` for what partial evaluation
 * left open.
 */
export type Expr =
  | { readonly Value: CedarValueJson }
  | { readonly Var: Var }
  | { readonly Slot: string }
  | { readonly "!": { readonly arg: Expr } }
  | { readonly neg: { readonly arg: Expr } }
  | { readonly "==": Binary }
  | { readonly "!=": Binary }
  | { readonly in: Binary }
  | { readonly "<": Binary }
  | { readonly "<=": Binary }
  | { readonly ">": Binary }
  | { readonly ">=": Binary }
  | { readonly "&&": Binary }
  | { readonly "||": Binary }
  | { readonly "+": Binary }
  | { readonly "-": Binary }
  | { readonly "*": Binary }
  | { readonly contains: Binary }
  | { readonly containsAll: Binary }
  | { readonly containsAny: Binary }
  | { readonly isEmpty: { readonly arg: Expr } }
  | { readonly getTag: Binary }
  | { readonly hasTag: Binary }
  | { readonly ".": { readonly left: Expr; readonly attr: string } }
  | {
    readonly has: {
      readonly left: Expr;
      readonly attr: string | readonly string[];
    };
  }
  | {
    readonly like: {
      readonly left: Expr;
      readonly pattern: readonly PatternElem[];
    };
  }
  | {
    readonly is: {
      readonly left: Expr;
      readonly entity_type: string;
      readonly in?: Expr;
    };
  }
  | {
    readonly "if-then-else": {
      readonly if: Expr;
      readonly then: Expr;
      readonly else: Expr;
    };
  }
  | { readonly Set: readonly Expr[] }
  | { readonly Record: { readonly [key: string]: Expr } }
  | { readonly [extension: string]: readonly Expr[] };

export type PatternElem = "Wildcard" | { readonly Literal: string };

// MARK: Schemas as JSON

/** A schema in Cedar's JSON format: namespaces by name ("" for none). */
export type SchemaJson = { readonly [namespace: string]: NamespaceDefinition };

export interface NamespaceDefinition {
  readonly commonTypes?: {
    readonly [name: string]: SchemaType & {
      readonly annotations?: Annotations;
    };
  };
  readonly entityTypes: { readonly [name: string]: EntityTypeJson };
  readonly actions: { readonly [name: string]: ActionTypeJson };
  readonly annotations?: Annotations;
}

export type EntityTypeJson =
  & (
    | {
      readonly memberOfTypes?: readonly string[];
      readonly shape?: SchemaType;
      readonly tags?: SchemaType;
    }
    | { readonly enum: readonly string[] }
  )
  & { readonly annotations?: Annotations };

export interface ActionTypeJson {
  readonly attributes?: { readonly [key: string]: CedarValueJson };
  readonly appliesTo?: {
    readonly resourceTypes: readonly string[];
    readonly principalTypes: readonly string[];
    readonly context?: SchemaType;
  };
  readonly memberOf?: readonly {
    readonly id: string;
    readonly type?: string;
  }[];
  readonly annotations?: Annotations;
}

export type SchemaType =
  | { readonly type: "String" | "Long" | "Boolean" }
  | { readonly type: "Set"; readonly element: SchemaType }
  | {
    readonly type: "Record";
    readonly attributes: {
      readonly [key: string]: SchemaType & { readonly required?: boolean };
    };
    readonly additionalAttributes?: boolean;
  }
  | { readonly type: "Entity"; readonly name: string }
  | { readonly type: "EntityOrCommon"; readonly name: string }
  | { readonly type: "Extension"; readonly name: string }
  | { readonly type: string };
