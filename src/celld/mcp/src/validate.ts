// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict runtime checks for everything that crosses the wire: JSON-RPC
 * framing, request `_meta`, each method's params, each method's result, the
 * server's notifications, and MRTR input requests and responses.
 *
 * Checks are small combinators that append located {@link Issue}s, so a
 * rejection says exactly which field is wrong. Objects are open (unknown
 * fields pass, as the schema allows extension) except where the schema is
 * closed.
 *
 * @module
 */

import { describe, formatIssues, isPlainObject, type Issue } from "./json.ts";
import type { Path } from "./json.ts";
import { McpError } from "./errors.ts";
import {
  isLoggingLevel,
  isTraceparent,
  isValidExtensionId,
  isValidMetaKey,
  META,
} from "./meta.ts";
import type {
  ClientRequestMethod,
  JSONRPCErrorResponse,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResultResponse,
  RequestId,
} from "./types.ts";

/** Appends every reason `value` is not acceptable to `issues`. */
export type Check = (value: unknown, path: Path, issues: Issue[]) => void;

/** Runs a check and returns its issues. */
export function check(value: unknown, what: Check, path: Path = []): Issue[] {
  const issues: Issue[] = [];
  what(value, path, issues);
  return issues;
}

function expected(
  what: string,
  value: unknown,
  path: Path,
  issues: Issue[],
): void {
  issues.push({ path, message: `expected ${what}, got ${describe(value)}` });
}

/** Any string. */
export const string: Check = (value, path, issues) => {
  if (typeof value !== "string") expected("a string", value, path, issues);
};

/** A non-empty string. */
export const nonEmptyString: Check = (value, path, issues) => {
  if (typeof value !== "string") expected("a string", value, path, issues);
  else if (value === "") {
    issues.push({ path, message: "must not be empty" });
  }
};

/** A finite number. */
export const number: Check = (value, path, issues) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    expected("a number", value, path, issues);
  }
};

/** A safe integer. */
export const integer: Check = (value, path, issues) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    expected("an integer", value, path, issues);
  }
};

/** A boolean. */
export const boolean: Check = (value, path, issues) => {
  if (typeof value !== "boolean") expected("a boolean", value, path, issues);
};

/** Anything, including absent. */
export const anything: Check = () => {};

/** Any JSON object. */
export const anyObject: Check = (value, path, issues) => {
  if (!isPlainObject(value)) expected("an object", value, path, issues);
};

/** One of the given literal values. */
export function literal(...values: readonly unknown[]): Check {
  return (value, path, issues) => {
    if (!values.includes(value)) {
      issues.push({
        path,
        message: `expected ${
          values.map((item) => JSON.stringify(item)).join(" or ")
        }, got ${
          typeof value === "string" ? JSON.stringify(value) : describe(value)
        }`,
      });
    }
  };
}

/** Either check passing. */
export function either(first: Check, second: Check, what: string): Check {
  return (value, path, issues) => {
    if (check(value, first, path).length === 0) return;
    if (check(value, second, path).length === 0) return;
    expected(what, value, path, issues);
  };
}

/** An array whose items pass `item`. */
export function array(item: Check): Check {
  return (value, path, issues) => {
    if (!Array.isArray(value)) {
      expected("an array", value, path, issues);
      return;
    }
    value.forEach((entry, index) => item(entry, [...path, index], issues));
  };
}

/** An object whose values pass `item`. */
export function record(item: Check): Check {
  return (value, path, issues) => {
    if (!isPlainObject(value)) {
      expected("an object", value, path, issues);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      item(entry, [...path, key], issues);
    }
  };
}

/**
 * An object with `required` and `optional` fields. Unknown fields pass
 * unless `closed`.
 */
export function object(
  required: Record<string, Check>,
  optional: Record<string, Check> = {},
  closed = false,
): Check {
  return (value, path, issues) => {
    if (!isPlainObject(value)) {
      expected("an object", value, path, issues);
      return;
    }
    for (const [key, field] of Object.entries(required)) {
      if (value[key] === undefined) {
        issues.push({ path: [...path, key], message: "is required" });
      } else {
        field(value[key], [...path, key], issues);
      }
    }
    for (const [key, field] of Object.entries(optional)) {
      if (value[key] !== undefined) field(value[key], [...path, key], issues);
    }
    if (closed) {
      for (const key of Object.keys(value)) {
        if (!(key in required) && !(key in optional)) {
          issues.push({ path: [...path, key], message: "is not allowed" });
        }
      }
    }
  };
}

/** An object discriminated by a string field. */
export function tagged(tag: string, variants: Record<string, Check>): Check {
  return (value, path, issues) => {
    if (!isPlainObject(value)) {
      expected("an object", value, path, issues);
      return;
    }
    const kind = value[tag];
    const variant = typeof kind === "string" ? variants[kind] : undefined;
    if (variant === undefined) {
      literal(...Object.keys(variants))(kind, [...path, tag], issues);
      return;
    }
    variant(value, path, issues);
  };
}

/* Shared shapes */

/** A JSON-RPC request id: a string or an integer, never null. */
export const requestId: Check = either(
  string,
  integer,
  "a string or integer id",
);

const metaObject: Check = (value, path, issues) => {
  if (!isPlainObject(value)) {
    expected("an object", value, path, issues);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!isValidMetaKey(key)) {
      issues.push({
        path: [...path, key],
        message: "is not a valid _meta key",
      });
    }
  }
  if (
    value[META.traceparent] !== undefined &&
    !isTraceparent(value[META.traceparent])
  ) {
    issues.push({
      path: [...path, META.traceparent],
      message: "is not a W3C traceparent",
    });
  }
  for (const key of [META.tracestate, META.baggage]) {
    if (value[key] !== undefined) string(value[key], [...path, key], issues);
  }
};

const icon = object({ src: string }, {
  mimeType: string,
  sizes: array(string),
  theme: literal("light", "dark"),
});

/** An `Implementation`: `name` and `version`, plus display fields. */
export const implementation: Check = object({ name: string, version: string }, {
  title: string,
  description: string,
  websiteUrl: string,
  icons: array(icon),
});

const extensions: Check = (value, path, issues) => {
  record(anyObject)(value, path, issues);
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!isValidExtensionId(key)) {
      issues.push({
        path: [...path, key],
        message: "is not a prefixed extension identifier",
      });
    }
  }
};

/** `ClientCapabilities`. */
export const clientCapabilities: Check = object({}, {
  experimental: record(anyObject),
  roots: anyObject,
  sampling: object({}, { context: anyObject, tools: anyObject }),
  elicitation: object({}, { form: anyObject, url: anyObject }),
  extensions,
});

/** `ServerCapabilities`. */
export const serverCapabilities: Check = object({}, {
  experimental: record(anyObject),
  logging: anyObject,
  completions: anyObject,
  prompts: object({}, { listChanged: boolean }),
  resources: object({}, { subscribe: boolean, listChanged: boolean }),
  tools: object({}, { listChanged: boolean }),
  extensions,
});

const progressToken = either(string, integer, "a string or integer token");

/**
 * A request's `_meta`: valid keys, the two required per-request fields, and
 * well-formed optional ones.
 */
export const requestMeta: Check = (value, path, issues) => {
  metaObject(value, path, issues);
  if (!isPlainObject(value)) return;
  object({
    [META.protocolVersion]: nonEmptyString,
    [META.clientCapabilities]: clientCapabilities,
  }, {
    [META.clientInfo]: implementation,
    [META.progressToken]: progressToken,
    [META.logLevel]: (level, at, out) => {
      if (!isLoggingLevel(level)) {
        out.push({ path: at, message: "is not a log level" });
      }
    },
  })(value, path, issues);
};

const annotations = object({}, {
  audience: array(literal("user", "assistant")),
  priority: number,
  lastModified: string,
});

const resourceContents = (value: unknown, path: Path, issues: Issue[]) => {
  object({ uri: string }, {
    mimeType: string,
    _meta: metaObject,
    text: string,
    blob: string,
  })(value, path, issues);
  if (
    isPlainObject(value) &&
    (value.text === undefined) === (value.blob === undefined)
  ) {
    issues.push({ path, message: "must have exactly one of text or blob" });
  }
};

const resourceFields = {
  title: string,
  description: string,
  mimeType: string,
  annotations,
  size: number,
  icons: array(icon),
  _meta: metaObject,
};

/** A `ContentBlock`. */
export const contentBlock: Check = tagged("type", {
  text: object({ text: string }, { annotations, _meta: metaObject }),
  image: object({ data: string, mimeType: string }, {
    annotations,
    _meta: metaObject,
  }),
  audio: object({ data: string, mimeType: string }, {
    annotations,
    _meta: metaObject,
  }),
  resource_link: object({ uri: string, name: string }, resourceFields),
  resource: object({ resource: resourceContents }, {
    annotations,
    _meta: metaObject,
  }),
});

const samplingContent: Check = tagged("type", {
  text: object({ text: string }),
  image: object({ data: string, mimeType: string }),
  audio: object({ data: string, mimeType: string }),
  tool_use: object({ id: string, name: string, input: anyObject }),
  tool_result: object({ toolUseId: string, content: array(contentBlock) }, {
    isError: boolean,
  }),
});

const samplingMessage = object({
  role: literal("user", "assistant"),
  content: either(samplingContent, array(samplingContent), "sampling content"),
}, { _meta: metaObject });

/** A `Tool` definition. */
export const tool: Check = object({
  name: string,
  inputSchema: object({ type: literal("object") }),
}, {
  title: string,
  description: string,
  outputSchema: anyObject,
  annotations: object({}, {
    title: string,
    readOnlyHint: boolean,
    destructiveHint: boolean,
    idempotentHint: boolean,
    openWorldHint: boolean,
  }),
  icons: array(icon),
  _meta: metaObject,
});

/* Input requests and responses (MRTR) */

const primitiveSchema = tagged("type", {
  string: object({}, {
    title: string,
    description: string,
    minLength: integer,
    maxLength: integer,
    format: literal("email", "uri", "date", "date-time"),
    enum: array(string),
    oneOf: array(object({ const: string, title: string })),
    enumNames: array(string),
    default: string,
  }),
  number: object({}, {
    title: string,
    description: string,
    minimum: number,
    maximum: number,
    default: number,
  }),
  integer: object({}, {
    title: string,
    description: string,
    minimum: number,
    maximum: number,
    default: number,
  }),
  boolean: object({}, { title: string, description: string, default: boolean }),
  array: object({ items: anyObject }, {
    title: string,
    description: string,
    minItems: integer,
    maxItems: integer,
    default: array(string),
  }),
});

/** An elicitation's params, form or URL mode. */
export const elicitParams: Check = (value, path, issues) => {
  if (isPlainObject(value) && value.mode === "url") {
    object({ mode: literal("url"), message: string, url: string })(
      value,
      path,
      issues,
    );
    return;
  }
  object({
    message: string,
    requestedSchema: object({
      type: literal("object"),
      properties: record(primitiveSchema),
    }, { $schema: string, required: array(string) }),
  }, { mode: literal("form") })(value, path, issues);
};

/** A sampling request's params. */
export const createMessageParams: Check = object({
  messages: array(samplingMessage),
  maxTokens: integer,
}, {
  modelPreferences: anyObject,
  systemPrompt: string,
  includeContext: literal("none", "thisServer", "allServers"),
  temperature: number,
  stopSequences: array(string),
  metadata: anyObject,
  tools: array(tool),
  toolChoice: object({}, { mode: literal("auto", "required", "none") }),
});

/** One entry of `inputRequests`. */
export const inputRequest: Check = tagged("method", {
  "elicitation/create": object({ params: elicitParams }),
  "sampling/createMessage": object({ params: createMessageParams }),
  "roots/list": object({}, { params: object({}, { _meta: metaObject }) }),
});

/** An `ElicitResult`. */
export const elicitResult: Check = object({
  action: literal("accept", "decline", "cancel"),
}, {
  content: record(
    either(
      either(string, number, "a string or number"),
      either(boolean, array(string), "a boolean or string array"),
      "a string, number, boolean or string array",
    ),
  ),
});

/** A `CreateMessageResult`. */
export const createMessageResult: Check = (value, path, issues) => {
  samplingMessage(value, path, issues);
  object({ model: string }, { stopReason: string })(value, path, issues);
};

/** A `ListRootsResult`. */
export const listRootsResult: Check = object({
  roots: array(object({ uri: string }, { name: string, _meta: metaObject })),
});

/** The response check for each input request method. */
export const INPUT_RESPONSE: Readonly<Record<string, Check>> = {
  "elicitation/create": elicitResult,
  "sampling/createMessage": createMessageResult,
  "roots/list": listRootsResult,
};

/* Request params, per method */

const inputFields = {
  inputResponses: record(anyObject),
  requestState: string,
};

const paginated = object({ _meta: requestMeta }, { cursor: string });

/** The params check for each client request method. */
export const REQUEST_PARAMS: Readonly<Record<ClientRequestMethod, Check>> = {
  "server/discover": object({ _meta: requestMeta }),
  "tools/list": paginated,
  "prompts/list": paginated,
  "resources/list": paginated,
  "resources/templates/list": paginated,
  "tools/call": object({ _meta: requestMeta, name: string }, {
    arguments: anyObject,
    ...inputFields,
  }),
  "prompts/get": object({ _meta: requestMeta, name: string }, {
    arguments: record(string),
    ...inputFields,
  }),
  "resources/read": object({ _meta: requestMeta, uri: string }, inputFields),
  "completion/complete": object({
    _meta: requestMeta,
    ref: tagged("type", {
      "ref/prompt": object({ name: string }, { title: string }),
      "ref/resource": object({ uri: string }),
    }),
    argument: object({ name: string, value: string }),
  }, { context: object({}, { arguments: record(string) }) }),
  "subscriptions/listen": object({
    _meta: requestMeta,
    notifications: object({}, {
      toolsListChanged: boolean,
      promptsListChanged: boolean,
      resourcesListChanged: boolean,
      resourceSubscriptions: array(string),
      taskIds: array(nonEmptyString),
    }),
  }),
  "tasks/get": object({ _meta: requestMeta, taskId: nonEmptyString }),
  "tasks/update": object({
    _meta: requestMeta,
    taskId: nonEmptyString,
    inputResponses: record(anyObject),
  }),
  "tasks/cancel": object({ _meta: requestMeta, taskId: nonEmptyString }),
};

/** Whether `method` is a request method of this revision. */
export function isClientRequestMethod(
  method: string,
): method is ClientRequestMethod {
  return Object.hasOwn(REQUEST_PARAMS, method);
}

/* Results, per method */

const resultMeta = (value: unknown, path: Path, issues: Issue[]) => {
  metaObject(value, path, issues);
  if (isPlainObject(value) && value[META.serverInfo] !== undefined) {
    implementation(value[META.serverInfo], [...path, META.serverInfo], issues);
  }
};

const resultBase = { _meta: resultMeta, resultType: string };

const cacheable = {
  ttlMs: number,
  cacheScope: literal("public", "private"),
};

// Caching hints are required of 2026-07-28 servers but absent from earlier
// ones, whose results are otherwise valid; the client treats absence as
// ttlMs 0, as the caching page says.
const listResult = (field: string, item: Check) =>
  object({ [field]: array(item) }, {
    ...resultBase,
    ...cacheable,
    nextCursor: string,
  });

/* The tasks extension */

const taskFields = {
  taskId: nonEmptyString,
  status: literal(
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
  ),
  createdAt: string,
  lastUpdatedAt: string,
  ttlMs: either(integer, literal(null), "an integer or null"),
};

const taskOptional = {
  statusMessage: string,
  pollIntervalMs: integer,
  _meta: resultMeta,
  resultType: string,
};

/** A tasks-extension `Task`. */
export const task: Check = object(taskFields, taskOptional);

/** A `DetailedTask`: the variant its `status` names. */
export const detailedTask: Check = tagged("status", {
  working: task,
  input_required: object(
    { ...taskFields, inputRequests: record(inputRequest) },
    taskOptional,
  ),
  completed: object({ ...taskFields, result: anyObject }, taskOptional),
  failed: object({
    ...taskFields,
    error: object({ code: integer, message: string }, { data: anything }),
  }, taskOptional),
  cancelled: task,
});

/** A `CreateTaskResult`: a task with `resultType: "task"`. */
export const createTaskResult: Check = (value, path, issues) => {
  task(value, path, issues);
  if (isPlainObject(value)) {
    literal("task")(value.resultType, [...path, "resultType"], issues);
  }
};

/** The complete-result check for each client request method. */
export const RESULT: Readonly<Record<ClientRequestMethod, Check>> = {
  "server/discover": object({
    supportedVersions: array(string),
    capabilities: serverCapabilities,
  }, { ...resultBase, ...cacheable, instructions: string }),
  "tools/list": listResult("tools", tool),
  "prompts/list": listResult(
    "prompts",
    object({ name: string }, {
      title: string,
      description: string,
      icons: array(icon),
      arguments: array(
        object({ name: string }, {
          title: string,
          description: string,
          required: boolean,
        }),
      ),
      _meta: metaObject,
    }),
  ),
  "resources/list": listResult(
    "resources",
    object({ uri: string, name: string }, resourceFields),
  ),
  "resources/templates/list": listResult(
    "resourceTemplates",
    object({ uriTemplate: string, name: string }, resourceFields),
  ),
  "resources/read": object({ contents: array(resourceContents) }, {
    ...resultBase,
    ...cacheable,
  }),
  "tools/call": object({ content: array(contentBlock) }, {
    ...resultBase,
    isError: boolean,
  }),
  "prompts/get": object({
    messages: array(
      object({ role: literal("user", "assistant"), content: contentBlock }),
    ),
  }, { ...resultBase, description: string }),
  "completion/complete": object({
    completion: object({ values: array(string) }, {
      total: integer,
      hasMore: boolean,
    }),
  }, resultBase),
  "subscriptions/listen": object({}, resultBase),
  "tasks/get": detailedTask,
  "tasks/update": object({}, resultBase),
  "tasks/cancel": object({}, resultBase),
};

/** An `InputRequiredResult`: at least one of `inputRequests` and `requestState`. */
export const inputRequiredResult: Check = (value, path, issues) => {
  object({}, {
    ...resultBase,
    inputRequests: record(inputRequest),
    requestState: string,
  })(value, path, issues);
  if (
    isPlainObject(value) && value.inputRequests === undefined &&
    value.requestState === undefined
  ) {
    issues.push({
      path,
      message: "must have inputRequests or requestState",
    });
  }
};

/* Server notifications */

const notificationMeta = (value: unknown, path: Path, issues: Issue[]) => {
  metaObject(value, path, issues);
  if (
    isPlainObject(value) && value[META.subscriptionId] !== undefined
  ) {
    requestId(
      value[META.subscriptionId],
      [...path, META.subscriptionId],
      issues,
    );
  }
};

const filter = object({}, {
  toolsListChanged: boolean,
  promptsListChanged: boolean,
  resourcesListChanged: boolean,
  resourceSubscriptions: array(string),
  taskIds: array(nonEmptyString),
});

const listChanged = object({}, {
  params: object({}, { _meta: notificationMeta }),
});

/** The params check for each notification a server may send. */
export const NOTIFICATION: Readonly<Record<string, Check>> = {
  "notifications/progress": object({
    params: object({ progressToken, progress: number }, {
      total: number,
      message: string,
      _meta: notificationMeta,
    }),
  }),
  "notifications/message": object({
    params: object({
      level: (value, path, issues) => {
        if (!isLoggingLevel(value)) {
          issues.push({ path, message: "is not a log level" });
        }
      },
    }, { logger: string, data: anything, _meta: notificationMeta }),
  }),
  "notifications/resources/updated": object({
    params: object({ uri: string }, { _meta: notificationMeta }),
  }),
  "notifications/resources/list_changed": listChanged,
  "notifications/tools/list_changed": listChanged,
  "notifications/prompts/list_changed": listChanged,
  "notifications/subscriptions/acknowledged": object({
    params: object({ notifications: filter }, { _meta: notificationMeta }),
  }),
  "notifications/cancelled": object({
    params: object({ requestId }, { reason: string, _meta: notificationMeta }),
  }),
  "notifications/tasks": object({
    params: (value, path, issues) => {
      detailedTask(value, path, issues);
      if (isPlainObject(value) && value._meta !== undefined) {
        notificationMeta(value._meta, [...path, "_meta"], issues);
      }
    },
  }),
};

/* JSON-RPC framing */

/** A classified JSON-RPC message. */
export type Framed =
  | { readonly type: "request"; readonly message: JSONRPCRequest }
  | { readonly type: "notification"; readonly message: JSONRPCNotification }
  | {
    readonly type: "response";
    readonly message: JSONRPCResultResponse | JSONRPCErrorResponse;
  };

/**
 * Parses JSON text. Throws a -32700 McpError when it is not JSON.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw McpError.parseError();
  }
}

/**
 * Classifies a parsed JSON-RPC 2.0 message, strictly: `jsonrpc` is "2.0",
 * request ids are strings or integers (never null), `params` is an object,
 * and a response has exactly one of `result` and `error`. Batches (arrays)
 * are not part of MCP. Throws a -32600 McpError naming the problem.
 */
export function frame(value: unknown): Framed {
  if (Array.isArray(value)) {
    throw McpError.invalidRequest("Invalid request: batches are not supported");
  }
  const issues: Issue[] = [];
  if (!isPlainObject(value)) {
    expected("a JSON-RPC object", value, [], issues);
  } else {
    literal("2.0")(value.jsonrpc, ["jsonrpc"], issues);
    if (value.method !== undefined) {
      string(value.method, ["method"], issues);
      if (value.params !== undefined) {
        anyObject(value.params, ["params"], issues);
      }
      if ("id" in value) requestId(value.id, ["id"], issues);
      for (const key of ["result", "error"]) {
        if (key in value) {
          issues.push({ path: [key], message: "is not allowed on a request" });
        }
      }
    } else {
      const hasResult = "result" in value;
      const hasError = "error" in value;
      if (hasResult === hasError) {
        issues.push({
          path: [],
          message: "needs a method, or exactly one of result and error",
        });
      } else if (hasResult) {
        requestId(value.id, ["id"], issues);
        anyObject(value.result, ["result"], issues);
      } else {
        if (value.id !== undefined) requestId(value.id, ["id"], issues);
        object({ code: integer, message: string }, { data: anything })(
          value.error,
          ["error"],
          issues,
        );
      }
    }
  }
  if (issues.length > 0) {
    throw McpError.invalidRequest(`Invalid request: ${formatIssues(issues)}`);
  }
  const message = value as Record<string, unknown>;
  if (message.method !== undefined) {
    return "id" in message
      ? { type: "request", message: message as unknown as JSONRPCRequest }
      : {
        type: "notification",
        message: message as unknown as JSONRPCNotification,
      };
  }
  return {
    type: "response",
    message: message as unknown as
      | JSONRPCResultResponse
      | JSONRPCErrorResponse,
  };
}

/** Whether two request ids are the same id (`1` and `"1"` are not). */
export function sameId(a: RequestId | undefined, b: RequestId): boolean {
  return a === b;
}
