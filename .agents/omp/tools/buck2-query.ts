// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { checked, lines, literal, result } from "../lib/tool.ts";
import type { Tool, ToolAPI } from "../lib/tool.ts";

type Operation = "deps" | "rdeps" | "kind" | "attrs" | "path" | "cycles";

export interface QueryParams {
  operation: Operation;
  target?: string;
  scope?: string;
  depth?: number;
  showKind?: boolean;
  exclude?: string;
  explain?: boolean;
  pattern?: string;
  fields?: string;
  fromTarget?: string;
  toTarget?: string;
}

const options: Record<Operation, readonly string[]> = {
  deps: ["target", "depth", "showKind", "exclude"],
  rdeps: ["target", "scope", "depth", "showKind", "exclude", "explain"],
  kind: ["pattern", "scope"],
  attrs: ["target", "fields"],
  path: ["fromTarget", "toTarget"],
  cycles: ["scope"],
};

function required(
  params: QueryParams,
  field: "target" | "scope" | "pattern" | "fromTarget" | "toTarget",
): string {
  const value = params[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${params.operation} requires a non-empty ${field}`);
  }
  return value;
}

function attributes(stdout: string): Record<string, Record<string, unknown>> {
  const data: unknown = JSON.parse(stdout);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      "Buck2 attribute output must be a target-to-attributes JSON object",
    );
  }
  for (const value of Object.values(data)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Buck2 returned invalid target attributes");
    }
  }
  return data as Record<string, Record<string, unknown>>;
}

export default function buck2Query(pi: ToolAPI): Tool<QueryParams> {
  const t = pi.typebox.Type;
  const string = (description: string) =>
    t.Optional(t.String({ minLength: 1, description }));
  return {
    name: "buck2_query",
    label: "Buck2 Query",
    description:
      "Query the unconfigured Buck2 graph: dependencies, consumers, rule kinds, attributes, all-path target sets, and cycle validation. Target/scope values are literal labels or target patterns, not query expressions.",
    approval: "read",
    parameters: t.Object({
      operation: t.Union(
        ["deps", "rdeps", "kind", "attrs", "path", "cycles"].map((value) =>
          t.Literal(value)
        ),
      ),
      target: string(
        "Required for deps, rdeps, attrs: target label or pattern.",
      ),
      scope: string(
        "Required for kind/cycles; rdeps universe defaults to //....",
      ),
      depth: t.Optional(
        t.Integer({
          minimum: 0,
          description:
            "deps/rdeps traversal depth; omitted means transitive, 0 includes only starting targets.",
        }),
      ),
      showKind: t.Optional(
        t.Boolean({
          description:
            "deps/rdeps: include buck.type metadata for each result.",
        }),
      ),
      exclude: string(
        "deps/rdeps: subtract this literal target pattern from the result.",
      ),
      explain: t.Optional(
        t.Boolean({
          description:
            "rdeps: return the complete unordered allpaths target set for each consumer.",
        }),
      ),
      pattern: string("kind: required rule-type regex."),
      fields: string(
        "attrs: attribute-name regex; omitted selects all attributes (.*).",
      ),
      fromTarget: string("path: required source label or target pattern."),
      toTarget: string("path: required destination label or target pattern."),
    }, { additionalProperties: false }),
    async execute(_id, params, _onUpdate, _ctx, signal) {
      if (!Object.hasOwn(options, params.operation)) {
        throw new Error("Unknown Buck2 query operation");
      }
      for (const [key, value] of Object.entries(params)) {
        if (
          key !== "operation" && value !== undefined &&
          !options[params.operation].includes(key)
        ) {
          throw new Error(`${key} is not supported for ${params.operation}`);
        }
      }
      if (
        params.depth !== undefined &&
        (!Number.isInteger(params.depth) || params.depth < 0)
      ) {
        throw new Error("depth must be a non-negative integer");
      }
      const queryTargets = async (query: string) =>
        lines(await checked(pi, ["uquery", query], signal));
      let query: string;
      switch (params.operation) {
        case "attrs": {
          query = literal(required(params, "target"));
          const fields = params.fields ?? ".*";
          const data = attributes(
            await checked(pi, [
              "uquery",
              query,
              "--output-attribute",
              fields,
              "--json",
            ], signal),
          );
          return result({
            operation: params.operation,
            query,
            fields,
            attributes: data,
          });
        }
        case "kind":
          query = `kind(${literal(required(params, "pattern"))}, ${
            literal(required(params, "scope"))
          })`;
          break;
        case "path": {
          const fromTarget = required(params, "fromTarget");
          const toTarget = required(params, "toTarget");
          query = `allpaths(${literal(fromTarget)}, ${literal(toTarget)})`;
          const targets = await queryTargets(query);
          return result({
            operation: params.operation,
            query,
            fromTarget,
            toTarget,
            targets,
            pathExists: targets.length > 0,
            semantics:
              "Unordered union of targets on all dependency paths; not an ordered or shortest path.",
          });
        }
        case "cycles": {
          const scope = required(params, "scope");
          query = `deps(${literal(scope)})`;
          const targets = await queryTargets(query);
          return result({
            operation: params.operation,
            query,
            scope,
            status: "no_cycles",
            checkedTargets: targets.length,
            message:
              "Buck2 loaded the unconfigured dependency graph successfully; no cycles in this scope's transitive dependency graph. Other graph-loading failures, including cycles, are raised as errors.",
          });
        }
        case "deps":
        case "rdeps": {
          const target = literal(required(params, "target"));
          const depth = params.depth === undefined ? "" : `, ${params.depth}`;
          query = params.operation === "deps"
            ? `deps(${target}${depth})`
            : `rdeps(${literal(params.scope ?? "//...")}, ${target}${depth})`;
          if (params.exclude !== undefined) {
            query = `(${query}) - ${literal(params.exclude)}`;
          }
          break;
        }
      }
      let targets: string[];
      let kinds: Record<string, string> | undefined;
      if (params.showKind) {
        const data = attributes(
          await checked(pi, [
            "uquery",
            query,
            "--output-attribute",
            "^buck\\.type$",
            "--json",
          ], signal),
        );
        targets = Object.keys(data);
        kinds = {};
        for (const target of targets) {
          const kind = data[target]["buck.type"];
          if (typeof kind !== "string") {
            throw new Error(`Buck2 returned no buck.type for ${target}`);
          }
          kinds[target] = kind;
        }
      } else {
        targets = await queryTargets(query);
      }
      if (params.operation === "rdeps" && params.explain) {
        // Resolve the starting pattern into labels, so it is not mistaken for a consumer.
        const origins = new Set(
          await queryTargets(literal(required(params, "target"))),
        );
        const explanations: { target: string; pathTargets: string[] }[] = [];
        for (const target of targets) {
          if (origins.has(target)) continue;
          const pathQuery = `allpaths(${literal(target)}, ${
            literal(required(params, "target"))
          })`;
          explanations.push({
            target,
            pathTargets: await queryTargets(pathQuery),
          });
        }
        return result({
          operation: params.operation,
          query,
          targets,
          ...(kinds ? { kinds } : {}),
          explanations,
          explanationSemantics:
            "Each pathTargets set is the complete unordered union of targets on dependency paths from that consumer to the starting target(s).",
        });
      }
      return result({
        operation: params.operation,
        query,
        targets,
        ...(kinds ? { kinds } : {}),
      });
    },
  };
}
