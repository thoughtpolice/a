// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI 3.1 documents from a router's routes, imported as
 * "@celld/web/router/openapi". The router core never imports this, so a Worker
 * that does not serve a document does not carry JSON Schema export.
 *
 * ```ts
 * import { openapi } from "@celld/web/router/openapi";
 *
 * app.get("/openapi.json", { public: true }, () =>
 *   new Response(DOCUMENT, { headers: { "content-type": "application/json" } }));
 * // Once, after the last route is added:
 * const DOCUMENT = JSON.stringify(
 *   openapi(app, { info: { title: "Notes", version: "1.0.0" } }),
 * );
 * ```
 *
 * @module
 */

import type { AnySchema } from "@celld/sieve";
import { type JsonSchema, toJSONSchema } from "@celld/sieve/json-schema";
import { RouterError } from "./errors.ts";
import type { RouteInfo } from "./router.ts";
import {
  exactBoolean,
  optionsRecord,
  optionText,
  optionType,
} from "./validation.ts";

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

/** A map without a prototype, so a key such as `__proto__` is an own key. */
function table(): Json {
  return Object.create(null);
}

/** The names OpenAPI allows for components (section 4.8.7.1). */
const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

function checkName(name: string, what: string): string {
  if (!COMPONENT_NAME.test(name)) {
    throw new RouterError(
      `OpenAPI ${what} name ${
        JSON.stringify(name)
      } must match ${COMPONENT_NAME.source}`,
    );
  }
  return name;
}

/** `name` as a JSON Pointer reference token (RFC 6901: `~` is `~0`, `/` is `~1`). */
function pointer(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

const SCHEMAS = "#/components/schemas/";

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
    const ref = SCHEMAS + pointer(checkName(name, "schema"));
    this.#define(name, rewrite(body, ref) as JsonSchema);
    return { $ref: ref };
  }

  /** `schema` with references to component schemas replaced by the schemas. */
  resolve(schema: JsonSchema): JsonSchema {
    let current = schema;
    for (let depth = 0; depth < 32; depth++) {
      const ref = current.$ref;
      if (typeof ref !== "string" || !ref.startsWith(SCHEMAS)) return current;
      const name = ref.slice(SCHEMAS.length).replaceAll("~1", "/")
        .replaceAll("~0", "~");
      const found = this.schemas.get(name);
      if (found === undefined) return current;
      current = found;
    }
    return current;
  }

  #define(name: string, schema: JsonSchema): void {
    checkName(name, "schema");
    const existing = this.schemas.get(name);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(schema)
    ) {
      throw new RouterError(`two different schemas are named ${name}`);
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
  const out: Json = table();
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string") {
      out[key] = item === "#" ? root : item.replace(/^#\/\$defs\//, SCHEMAS);
    } else {
      out[key] = rewrite(item, root);
    }
  }
  return out;
}

/** The route's OpenAPI path, and its shape with parameter names erased. */
function openApiPath(route: RouteInfo): { path: string; shape: string } {
  if (route.segments.length === 0) return { path: "/", shape: "/" };
  const parts = route.segments.map((segment) =>
    segment.kind === "static" ? segment.value : `{${segment.name}}`
  );
  const shape = route.segments.map((segment) =>
    segment.kind === "static" ? segment.value : "\u0000"
  );
  return { path: "/" + parts.join("/"), shape: "/" + shape.join("/") };
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
  const pathSchema = route.options.params === undefined ? null : objectParts(
    components.resolve(components.convert(route.options.params, "input")),
  );
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
    const query = objectParts(
      components.resolve(components.convert(route.options.query, "input")),
    );
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
      "application/json": { schema: { $ref: `${SCHEMAS}Error` } },
    },
  };
}

/** Statuses whose answers have no body. */
const EMPTY = new Set(["204", "205", "304"]);

/** Security scheme types whose requirements list scopes (OpenAPI 4.8.30). */
const SCOPED = new Set(["oauth2", "openIdConnect"]);

function responsesOf(
  route: RouteInfo,
  components: Components,
): Json {
  const { options } = route;
  const out: Json = table();
  const declared = options.responses ?? {};
  const json = (schema: AnySchema) => ({
    "application/json": { schema: components.convert(schema, "output") },
  });
  if (!Object.keys(declared).some((status) => status.startsWith("2"))) {
    out["200"] = options.response === undefined
      ? { description: "OK" }
      : { description: "OK", content: json(options.response) };
  }
  for (const [status, entry] of Object.entries(declared)) {
    const schema = entry.schema ??
      (status.startsWith("2") && !EMPTY.has(status)
        ? options.response
        : undefined);
    out[status] = schema === undefined
      ? { description: entry.description }
      : { description: entry.description, content: json(schema) };
  }
  const add = (status: string, description: string) => {
    if (!(status in out)) out[status] = errorResponse(description);
  };
  if (
    options.body !== undefined || options.query !== undefined ||
    options.params !== undefined
  ) {
    add("400", "The request is not valid");
  }
  if (route.schemes.length > 0) {
    add("401", "Authentication failed or is missing");
    const demands = (options.scopes?.length ?? 0) > 0 ||
      (options.roles?.length ?? 0) > 0 ||
      options.authorize !== undefined;
    if (demands) add("403", "The principal may not do this");
  }
  if (options.body !== undefined) {
    add("413", "The body is too large");
    add("415", "The body is not of the expected media type");
  }
  const sorted: Json = table();
  const keys = Object.keys(out).sort((a, b) =>
    a === "default" ? 1 : b === "default" ? -1 : Number(a) - Number(b)
  );
  for (const key of keys) sorted[key] = out[key];
  return sorted;
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
  const scopes = [...options.scopes ?? []];
  if (route.schemes.length > 0) {
    // A requirement lists scopes only for OAuth 2 and OpenID Connect
    // schemes; for http and apiKey schemes it is empty, and the scopes the
    // route checks are stated in `x-required-scopes` instead.
    const requirements = route.schemes.map((scheme) => {
      const type = scheme.openapi?.type;
      const requirement: Json = table();
      requirement[scheme.name] = typeof type === "string" && SCOPED.has(type)
        ? scopes
        : [];
      return requirement;
    });
    op.security = options.public ? [{}, ...requirements] : requirements;
    if (scopes.length > 0) op["x-required-scopes"] = scopes;
  } else {
    op.security = [];
  }
  op.responses = responsesOf(route, components);
  return op;
}

/**
 * An OpenAPI 3.1 document for every route of `app`: paths with their
 * parameters (named `params` and `query` schemas expanded), request
 * bodies and responses (from sieve, through `@celld/sieve/json-schema`;
 * bodies and parameters as `parse` accepts them, responses as it returns
 * them; the route's `responses`, or `200`, plus the errors the router
 * itself answers), the auth schemes as security schemes, and each
 * operation's security requirement (scopes only for OAuth 2 and OpenID
 * Connect schemes; the route's scopes are also its `x-required-scopes`).
 * Named schemas (`.meta({ id })`) become `components.schemas`. A wildcard
 * is written as a single `{name}` parameter, which OpenAPI cannot express
 * more exactly. Automatic `HEAD` and `OPTIONS` are not listed.
 *
 * Throws {@link RouterError} rather than write a document that says
 * something other than what the router does: two different security
 * schemes or schemas under one name, a component name OpenAPI does not
 * allow, or two routes whose paths differ only in parameter names (or a
 * parameter against a wildcard), which OpenAPI treats as one path.
 * Component maps have no prototype, so any allowed name, `__proto__`
 * included, is an own key.
 */
export function openapi(app: RouteSource, options: OpenApiOptions): Json {
  optionsRecord(options, ["info", "servers", "exclude"], "openapi options");
  optionsRecord(
    options.info,
    ["title", "version", "description"],
    "openapi info",
  );
  if (options.info.title === undefined || options.info.version === undefined) {
    throw new RouterError("openapi info needs title and version");
  }
  for (const key of ["title", "version", "description"] as const) {
    optionText(options.info[key], `openapi info ${key}`);
  }
  optionType(options.exclude, "function", "openapi exclude");
  if (options.servers !== undefined) {
    if (!Array.isArray(options.servers) || options.servers.length > 256) {
      throw new RouterError("openapi servers must be a bounded list");
    }
    for (const server of options.servers) {
      optionsRecord(server, ["url", "description"], "openapi server");
      if (server.url === undefined) {
        throw new RouterError("openapi server needs url");
      }
      optionText(server.url, "openapi server url");
      optionText(server.description, "openapi server description");
    }
  }
  const components = new Components();
  const paths: Json = table();
  const shapes = new Map<string, string>();
  const securitySchemes: Json = table();
  const schemeText = new Map<string, string>();
  for (const route of app.routes()) {
    if (
      options.exclude !== undefined &&
      exactBoolean(options.exclude(route), "openapi exclude")
    ) continue;
    for (const scheme of route.schemes) {
      const name = checkName(scheme.name, "security scheme");
      const document = scheme.openapi ?? { type: "http", scheme: scheme.name };
      const text = JSON.stringify(document);
      const known = schemeText.get(name);
      if (known !== undefined && known !== text) {
        throw new RouterError(
          `two different security schemes are named ${name}: ${known} and ${text}`,
        );
      }
      schemeText.set(name, text);
      securitySchemes[name] = document;
    }
    const { path, shape } = openApiPath(route);
    const seen = shapes.get(shape);
    if (seen !== undefined && seen !== path) {
      throw new RouterError(
        `${seen} and ${path} are the same OpenAPI path with different parameter names`,
      );
    }
    shapes.set(shape, path);
    const item = (paths[path] ??= {}) as Json;
    const method = route.method.toLowerCase();
    if (method in item) {
      throw new RouterError(
        `two ${route.method} routes are the OpenAPI operation ${method} ${path}`,
      );
    }
    item[method] = operation(route, components);
  }
  const schemas: Json = table();
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
