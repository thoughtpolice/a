// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI 3.1 documents from a router's routes, imported as
 * "@celld/router/openapi". The router core never imports this, so a Worker
 * that does not serve a document does not carry JSON Schema export.
 *
 * ```ts
 * import { openapi } from "@celld/router/openapi";
 *
 * app.get("/openapi.json", { public: true }, (c) =>
 *   c.json(openapi(app, { info: { title: "Notes", version: "1.0.0" } })));
 * ```
 *
 * @module
 */

import type { AnySchema } from "@celld/sieve";
import { type JsonSchema, toJSONSchema } from "@celld/sieve/json-schema";
import type { RouteInfo } from "./router.ts";

/** The document's `info` and `servers`. */
export interface OpenApiOptions {
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly servers?: readonly {
    readonly url: string;
    readonly description?: string;
  }[];
  /** Routes to leave out, such as the one serving the document. */
  readonly exclude?: (route: RouteInfo) => boolean;
}

/** Anything with the router's {@link Router.routes}. */
export interface RouteSource {
  routes(): RouteInfo[];
}

type Json = { [key: string]: unknown };

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    requestId: { type: "string" },
  },
  required: ["error", "message", "requestId"],
};

class Components {
  readonly schemas = new Map<string, JsonSchema>([["Error", ERROR_SCHEMA]]);
  #anonymous = 0;

  /** `schema` as JSON Schema with its `$defs` moved into the components. */
  convert(schema: AnySchema, io: "input" | "output"): JsonSchema {
    const { $schema: _, $defs, ...body } = toJSONSchema(schema, {
      io,
      unrepresentable: "any",
    });
    for (
      const [name, def] of Object.entries(
        ($defs ?? {}) as Record<string, JsonSchema>,
      )
    ) {
      this.#define(name, rewrite(def, "#") as JsonSchema);
    }
    const id = schema.def.meta?.id;
    if (id === undefined && !containsRoot(body)) {
      return rewrite(body, "#") as JsonSchema;
    }
    const name = id ?? `Schema${this.#anonymous++}`;
    const ref = `#/components/schemas/${name}`;
    this.#define(name, rewrite(body, ref) as JsonSchema);
    return { $ref: ref };
  }

  #define(name: string, schema: JsonSchema): void {
    const existing = this.schemas.get(name);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(schema)
    ) {
      throw new Error(`two different schemas are named ${name}`);
    }
    this.schemas.set(name, schema);
  }
}

function containsRoot(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRoot);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, item]) =>
    key === "$ref" ? item === "#" : containsRoot(item)
  );
}

function rewrite(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, root));
  if (typeof value !== "object" || value === null) return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string") {
      out[key] = item === "#"
        ? root
        : item.replace(/^#\/\$defs\//, "#/components/schemas/");
    } else {
      out[key] = rewrite(item, root);
    }
  }
  return out;
}

function openApiPath(route: RouteInfo): string {
  if (route.segments.length === 0) return "/";
  return route.segments.map((segment) =>
    "/" + (segment.kind === "static" ? segment.value : `{${segment.name}}`)
  ).join("");
}

function objectParts(
  schema: JsonSchema,
): { properties: Json; required: string[] } | null {
  if (schema.type !== "object" || typeof schema.properties !== "object") {
    return null;
  }
  return {
    properties: schema.properties as Json,
    required: Array.isArray(schema.required) ? schema.required as string[] : [],
  };
}

function parameters(route: RouteInfo, components: Components): Json[] {
  const out: Json[] = [];
  const pathSchema = route.options.params === undefined
    ? null
    : objectParts(components.convert(route.options.params, "input"));
  for (const segment of route.segments) {
    if (segment.kind === "static") continue;
    out.push({
      name: segment.name,
      in: "path",
      required: true,
      schema: pathSchema?.properties[segment.name] ?? { type: "string" },
    });
  }
  if (route.options.query !== undefined) {
    const query = objectParts(components.convert(route.options.query, "input"));
    for (const [name, schema] of Object.entries(query?.properties ?? {})) {
      out.push({
        name,
        in: "query",
        required: query!.required.includes(name),
        schema,
      });
    }
  }
  return out;
}

function errorResponse(description: string): Json {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  };
}

function operation(route: RouteInfo, components: Components): Json {
  const { options } = route;
  const op: Json = {};
  if (options.operationId !== undefined) op.operationId = options.operationId;
  if (options.summary !== undefined) op.summary = options.summary;
  if (options.description !== undefined) op.description = options.description;
  if (options.tags !== undefined) op.tags = [...options.tags];
  if (options.deprecated) op.deprecated = true;
  const params = parameters(route, components);
  if (params.length > 0) op.parameters = params;
  if (options.body !== undefined) {
    const type = options.bodyType === "form"
      ? "application/x-www-form-urlencoded"
      : "application/json";
    op.requestBody = {
      required: true,
      content: {
        [type]: { schema: components.convert(options.body, "input") },
      },
    };
  }
  const responses: Json = {
    "200": options.response === undefined ? { description: "OK" } : {
      description: "OK",
      content: {
        "application/json": {
          schema: components.convert(options.response, "output"),
        },
      },
    },
  };
  if (
    options.body !== undefined || options.query !== undefined ||
    options.params !== undefined
  ) {
    responses["400"] = errorResponse("The request is not valid");
  }
  const secured = route.schemes.length > 0;
  if (secured) {
    responses["401"] = errorResponse("Authentication failed or is missing");
    const demands = (options.scopes?.length ?? 0) > 0 ||
      (options.roles?.length ?? 0) > 0 ||
      options.authorize !== undefined;
    if (demands) {
      responses["403"] = errorResponse("The principal may not do this");
    }
    const scopes = [...options.scopes ?? []];
    const requirements = route.schemes.map((scheme) => ({
      [scheme.name]: scopes,
    }));
    op.security = options.public ? [{}, ...requirements] : requirements;
  } else {
    op.security = [];
  }
  op.responses = responses;
  return op;
}

/**
 * An OpenAPI 3.1 document for every route of `app`: paths with their
 * parameters, request bodies and response schemas (from sieve, through
 * `@celld/sieve/json-schema`; bodies and parameters as `parse` accepts
 * them, responses as it returns them), the auth schemes as security
 * schemes, and each operation's security requirement with its scopes.
 * Named schemas (`.meta({ id })`) become `components.schemas`. A wildcard
 * is written as a single `{name}` parameter, which OpenAPI cannot express
 * more exactly. Automatic `HEAD` and `OPTIONS` are not listed.
 */
export function openapi(app: RouteSource, options: OpenApiOptions): Json {
  const components = new Components();
  const paths: Record<string, Json> = {};
  const securitySchemes: Json = {};
  for (const route of app.routes()) {
    if (options.exclude?.(route)) continue;
    for (const scheme of route.schemes) {
      securitySchemes[scheme.name] = scheme.openapi ??
        { type: "http", scheme: scheme.name };
    }
    const path = openApiPath(route);
    (paths[path] ??= {})[route.method.toLowerCase()] = operation(
      route,
      components,
    );
  }
  const schemas: Json = {};
  for (const name of [...components.schemas.keys()].sort()) {
    schemas[name] = components.schemas.get(name);
  }
  const document: Json = {
    openapi: "3.1.0",
    info: { ...options.info },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  };
  if (options.servers !== undefined) {
    document.servers = options.servers.map((s) => ({ ...s }));
  }
  document.paths = paths;
  document.components = {
    schemas,
    ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
  };
  return document;
}
