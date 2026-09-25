// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `McpServer`: a registry of tools, resources, resource templates and
 * prompts, and a transport-independent dispatcher for MCP 2026-07-28
 * requests. `http.ts` puts it behind a Streamable HTTP `fetch` handler; the
 * `./testing` subpath connects a client to it in process.
 *
 * Every request is handled on its own, as the protocol is stateless: its
 * `_meta` supplies the protocol version and client capabilities, both
 * checked per request. Handlers get a {@link HandlerContext} with the
 * request's details, an AbortSignal that fires when the client goes away,
 * progress and log reporting (sent only when the request asked), and the
 * multi round-trip helpers: `ctx.elicit(key, params)` returns the client's
 * answer if this retry carries one, and otherwise ends the round with an
 * `InputRequiredResult`; the handler runs again, from the top, on the retry.
 *
 * @module
 */

import type { Principal } from "@celld/router";
import type { AnySchema, Schema as SieveSchema } from "@celld/sieve";
import { isSchema } from "@celld/sieve/introspect";
import { toJSONSchema } from "@celld/sieve/json-schema";
import { McpError } from "./errors.ts";
import {
  compileSchema,
  type JsonSchema,
  type SchemaLimits,
} from "./jsonschema.ts";
import {
  formatIssues,
  fromBase64Url,
  isPlainObject,
  type Issue,
  toBase64,
  toBase64Url,
} from "./json.ts";
import { logLevelAtLeast, META } from "./meta.ts";
import {
  capabilityFor,
  InputRequired,
  listRoots as rootsRequest,
  missingCapabilities,
} from "./mrtr.ts";
import { type ParamHeader, paramHeaders } from "./headers.ts";
import { paramsDigest, StateSealer } from "./state.ts";
import type {
  ChangeEvent,
  ChangePublisher,
  ChangeSource,
} from "./subscriptions.ts";
import {
  detailedTaskOf,
  newTaskId,
  taskOf,
  type TaskOutcome,
  type TaskRecord,
  type TaskRunHooks,
  type TaskRunner,
  type TaskStore,
} from "./task_store.ts";
import { checkMs, TASKS_EXTENSION } from "./tasks.ts";
import {
  check,
  contentBlock,
  INPUT_RESPONSE,
  isClientRequestMethod,
  REQUEST_PARAMS,
  requestMeta,
} from "./validate.ts";
import {
  type Annotations,
  type BlobResourceContents,
  type CallToolResult,
  type ClientCapabilities,
  type ClientRequestMethod,
  type CompleteRequestParams,
  type ContentBlock,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type ElicitRequestParams,
  type ElicitResult,
  type GetPromptResult,
  type Icon,
  type Implementation,
  type InputRequest,
  type InputRequests,
  type InputResponse,
  type InputResponses,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONValue,
  LATEST_PROTOCOL_VERSION,
  type ListRootsResult,
  type LoggingLevel,
  type MetaObject,
  type ProgressToken,
  type Prompt,
  type PromptArgument,
  type PromptMessage,
  type RequestId,
  type RequestMetaObject,
  type Resource,
  type ResourceTemplate,
  type Result,
  type ServerCapabilities,
  type SubscriptionFilter,
  type TextResourceContents,
  type Tool,
  type ToolAnnotations,
} from "./types.ts";

/**
 * Who made a request: `@celld/router`'s principal, as the route's auth
 * scheme established it. Its `subject` binds sealed `requestState` and
 * owns tasks; handlers never see the credential itself.
 */
export type { Principal };

/** Cache hints for results the spec makes cacheable. */
export interface CacheHints {
  /** Freshness in milliseconds; >= 0. */
  readonly ttlMs?: number;
  /** `public` only when the result is the same for every caller. */
  readonly scope?: "public" | "private";
}

/** The facts of one request, as every handler and visibility check sees them. */
export interface RequestInfo {
  readonly requestId: RequestId;
  readonly method: ClientRequestMethod;
  readonly protocolVersion: string;
  readonly clientCapabilities: ClientCapabilities;
  /** Self-reported by the client; for display and logging only. */
  readonly clientInfo: Implementation | null;
  /** The request's whole `_meta`, including trace context. */
  readonly meta: RequestMetaObject;
  /** The authenticated caller, or null. */
  readonly principal: Principal | null;
  /** Fires when the client cancels (closes the stream) or the server gives up. */
  readonly signal: AbortSignal;
}

/** What a handler can do besides return. */
export interface HandlerContext extends RequestInfo {
  /**
   * Reports progress, if the request carried a progress token. Values must
   * increase; one that does not is dropped. No-op after the handler returns.
   */
  progress(
    progress: number,
    options?: { readonly total?: number; readonly message?: string },
  ): void;
  /**
   * Sends `notifications/message` on this request's stream, if the server
   * enables logging and the request asked for `level` or lower. Deprecated in
   * the spec (SEP-2577) but supported.
   */
  log(level: LoggingLevel, data: unknown, logger?: string): void;
  /** Throws -32021 unless the request declared these capabilities. */
  requireCapabilities(required: ClientCapabilities): void;

  /** The handler's own state from the previous round, or null. */
  readonly state: JSONValue | null;
  /** Sets the state sealed into the next `requestState`, if another round is needed. */
  setState(state: JSONValue | null): void;
  /** The verified answer to input request `key` from any earlier round. */
  input(key: string): InputResponse | undefined;
  /**
   * The client's answer to an elicitation, or (when there is none yet) ends
   * this round with an `InputRequiredResult` asking for it. Throws -32021 if
   * the client did not declare the needed elicitation mode.
   */
  elicit(key: string, params: ElicitRequestParams): ElicitResult;
  /**
   * The client's sampled message, asking for it first if needed.
   *
   * @deprecated Sampling is deprecated as of 2026-07-28 (SEP-2577).
   */
  sample(key: string, params: CreateMessageRequestParams): CreateMessageResult;
  /**
   * The client's roots, asking for them first if needed.
   *
   * @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577).
   */
  roots(key: string): ListRootsResult;
  /**
   * Answers to several input requests at once: returns them all when every
   * one is answered, and otherwise asks for the unanswered ones in one round.
   */
  ask(requests: InputRequests): InputResponses;
  /**
   * Ends this round with an `InputRequiredResult` now. With no `requests`
   * the client retries at once; with `state`, that is sealed for the retry.
   */
  inputRequired(
    options?: { readonly requests?: InputRequests; readonly state?: JSONValue },
  ): never;
  /**
   * Hands this `tools/call` to the tool's task body: the server stores a new
   * task and answers with a `CreateTaskResult`. Only for tools with a
   * `task`; throws -32021 if the request did not declare the tasks
   * extension. Resolve any multi round-trip input first, as the extension
   * advises.
   */
  task(options?: StartTaskOptions): never;
}

/** Options for {@link HandlerContext.task}. */
export interface StartTaskOptions {
  /** The body's initial state (`ctx.state` in {@link TaskContext}). */
  readonly state?: JSONValue;
  /** The initial status message. */
  readonly statusMessage?: string;
  /** Overrides the tool's TTL; null for unlimited. */
  readonly ttlMs?: number | null;
  /** Overrides the tool's poll interval. */
  readonly pollIntervalMs?: number;
}

/**
 * What a task body sees. The body runs from the top on every run (after
 * each round of input, after a yield, and again if the host crashed), so it
 * must be safe to repeat up to the point where it asks; `save` keeps
 * progress across runs.
 */
export interface TaskContext {
  readonly taskId: string;
  /** The tool's name. */
  readonly name: string;
  /** Who created the task. */
  readonly principal: Principal | null;
  /** The creating request's version, capabilities and client info. */
  readonly protocolVersion: string;
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo: Implementation | null;
  /** Fires when the task is cancelled or expires. */
  readonly signal: AbortSignal;
  /** Which run this is, from 1. */
  readonly run: number;
  /** The state saved by an earlier run (or passed to `ctx.task`). */
  readonly state: JSONValue | null;
  /** Saves state durably for later runs. */
  save(state: JSONValue | null): Promise<void>;
  /** Sets the task's status message (and poll interval) while it works. */
  status(
    message: string | null,
    options?: { readonly pollIntervalMs?: number },
  ): Promise<void>;
  /** Throws -32021 unless the creating request declared these capabilities. */
  requireCapabilities(required: ClientCapabilities): void;
  /** The client's answer to input request `key`, if delivered. */
  input(key: string): InputResponse | undefined;
  /**
   * The client's answer to an elicitation, or (when there is none yet) ends
   * this run: the task becomes `input_required` until `tasks/update`
   * answers, then runs again.
   */
  elicit(key: string, params: ElicitRequestParams): ElicitResult;
  /** @deprecated Sampling is deprecated as of 2026-07-28 (SEP-2577). */
  sample(key: string, params: CreateMessageRequestParams): CreateMessageResult;
  /** @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577). */
  roots(key: string): ListRootsResult;
  /** Answers to several input requests, asking for the missing ones in one round. */
  ask(requests: InputRequests): InputResponses;
  /**
   * Ends this run now. With requests, the task waits for them; without, it
   * yields and runs again after its poll interval (with `state`, if given).
   */
  inputRequired(
    options?: { readonly requests?: InputRequests; readonly state?: JSONValue },
  ): never;
}

/** A tool's asynchronous side, run as a task (the tasks extension). */
export interface TaskDefinition<I = Record<string, unknown>> {
  /** How long the task is kept after creation; default the server's; null for ever. */
  readonly ttlMs?: number | null;
  /** The polling interval suggested to clients; default the server's. */
  readonly pollIntervalMs?: number;
  /**
   * The work. Returns what a tool handler returns; the result becomes the
   * completed task's `result`. A thrown `ToolError` (or any non-JSON-RPC
   * failure) completes it with `isError: true`; a thrown JSON-RPC
   * `McpError` fails it.
   */
  run(args: I, ctx: TaskContext): ToolReturn | Promise<ToolReturn>;
}

/** Thrown by `ctx.task()`; the server turns it into a task. */
class TaskRequested extends Error {
  readonly options: StartTaskOptions;

  constructor(options: StartTaskOptions) {
    super("task requested");
    this.name = "TaskRequested";
    this.options = options;
  }
}

/** A tool execution error: becomes a result with `isError: true` and this message. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** What a tool handler returns: a text result, or result fields. */
export type ToolReturn =
  | string
  | {
    readonly content?: ContentBlock[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
    readonly _meta?: MetaObject;
  };

/** Display fields shared by definitions. */
interface Displayed {
  readonly title?: string;
  readonly description?: string;
  readonly icons?: Icon[];
  readonly _meta?: MetaObject;
  /** Whether this request may see the entry (lists and calls); default always. */
  readonly visible?: (info: RequestInfo) => boolean;
}

/**
 * A tool's argument or result schema: a `@celld/sieve` schema whose output
 * is `T`, or raw JSON Schema (then `T` is left to the caller).
 */
// deno-lint-ignore no-explicit-any
export type ToolSchema<T = unknown> = SieveSchema<T, any> | JsonSchema;

/** A tool. */
export interface ToolDefinition<I = Record<string, unknown>> extends Displayed {
  readonly name: string;
  readonly annotations?: ToolAnnotations;
  /**
   * The arguments' schema. A sieve object schema types the arguments: its
   * input form is the advertised `inputSchema` (`v.strictObject` for a
   * closed one, `v.looseObject` for an open one), arguments are parsed by
   * it, and the handler receives the parsed output. Raw JSON Schema with
   * `type: "object"` is validated as it is and the handler receives the
   * arguments unchanged. Default: no arguments.
   */
  readonly input?: ToolSchema<I>;
  /**
   * The schema of `structuredContent`; when set, the handler must return
   * conforming `structuredContent`. A sieve schema's output form is the
   * advertised `outputSchema`, and what the handler returns is parsed by
   * it before it is sent.
   */
  readonly output?: ToolSchema;
  /** Client capabilities the tool needs, checked (-32021) before it runs. */
  readonly requires?: ClientCapabilities;
  /**
   * The synchronous handler. It may call `ctx.task()` to continue as a
   * task. Without it, a tool with a `task` always runs as one (and a client
   * without the tasks extension gets -32021).
   */
  readonly run?: (
    args: I,
    ctx: HandlerContext,
  ) => ToolReturn | Promise<ToolReturn>;
  /** Runs the tool as a task; needs the server's `tasks` option. */
  readonly task?: TaskDefinition<I>;
  /**
   * OAuth scopes a caller needs to call the tool. The HTTP handler checks
   * them against the principal's and answers 403 `insufficient_scope`
   * naming them all.
   */
  readonly scopes?: readonly string[];
}

/** What a resource read returns: text, bytes, contents, or null for "no such resource". */
export type ResourceReturn =
  | string
  | Uint8Array
  | (TextResourceContents | BlobResourceContents)[]
  | {
    readonly contents: (TextResourceContents | BlobResourceContents)[];
    readonly ttlMs?: number;
    readonly cacheScope?: "public" | "private";
  }
  | null;

/** A completion function: candidate values for one argument. */
export type Completer = (
  value: string,
  context: { readonly arguments: Readonly<Record<string, string>> },
  info: RequestInfo,
) =>
  | string[]
  | { values: string[]; total?: number; hasMore?: boolean }
  | Promise<string[] | { values: string[]; total?: number; hasMore?: boolean }>;

/** A fixed resource. */
export interface ResourceDefinition extends Displayed {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly annotations?: Annotations;
  readonly size?: number;
  /** Cache hints for reads; default the server's. */
  readonly cache?: CacheHints;
  /** Client capabilities reading needs, checked (-32021) first. */
  readonly requires?: ClientCapabilities;
  read(ctx: HandlerContext): ResourceReturn | Promise<ResourceReturn>;
}

/**
 * A family of resources named by an RFC 6570 URI template. Supported
 * expressions: `{var}` (one segment, no `/`, `?` or `#`) and `{+var}` (any
 * characters). Values are percent-decoded.
 */
export interface ResourceTemplateDefinition extends Displayed {
  readonly uriTemplate: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly annotations?: Annotations;
  readonly cache?: CacheHints;
  readonly requires?: ClientCapabilities;
  /** Completions for template variables. */
  readonly complete?: Readonly<Record<string, Completer>>;
  read(
    uri: string,
    variables: Readonly<Record<string, string>>,
    ctx: HandlerContext,
  ): ResourceReturn | Promise<ResourceReturn>;
}

/** A prompt. */
export interface PromptDefinition extends Displayed {
  readonly name: string;
  readonly arguments?: PromptArgument[];
  /** Completions for arguments. */
  readonly complete?: Readonly<Record<string, Completer>>;
  readonly requires?: ClientCapabilities;
  get(
    args: Readonly<Record<string, string>>,
    ctx: HandlerContext,
  ):
    | PromptMessage[]
    | { description?: string; messages: PromptMessage[] }
    | Promise<
      PromptMessage[] | { description?: string; messages: PromptMessage[] }
    >;
}

/** Options for {@link McpServer}. */
export interface McpServerOptions {
  /** The server's name and version, sent in every result's `_meta`. */
  readonly info: Implementation;
  /** Guidance for models, returned by `server/discover`. */
  readonly instructions?: string;
  /** Protocol versions served; default just 2026-07-28. */
  readonly versions?: readonly string[];
  /**
   * The secret sealing `requestState` (at least 32 bytes). Required for any
   * handler that asks for input; every instance must share it.
   */
  readonly stateSecret?: string | Uint8Array;
  /** How long a sealed `requestState` stays valid; default 10 minutes. */
  readonly stateTtlMs?: number;
  /**
   * Where `subscriptions/listen` gets changes. Setting it advertises
   * `listChanged` (and resource `subscribe`).
   */
  readonly changes?: ChangeSource;
  /** Close listen streams gracefully after this long; default never. */
  readonly listenLifetimeMs?: number;
  /** Declare the (deprecated) `logging` capability and send `ctx.log` messages. */
  readonly logging?: boolean;
  /** Items per page of list results; default 100. */
  readonly pageSize?: number;
  /**
   * Cache hints for `server/discover`, list results and reads without their
   * own; default `{ ttlMs: 60000, scope: "private" }`.
   */
  readonly cache?: CacheHints;
  /** Extra capabilities to advertise. */
  readonly capabilities?: Pick<
    ServerCapabilities,
    "extensions" | "experimental"
  >;
  /** Bounds for tool schemas. */
  readonly schemaLimits?: SchemaLimits;
  /**
   * Enables the tasks extension: advertises it, serves `tasks/get`,
   * `tasks/update` and `tasks/cancel`, and lets tools run as tasks.
   */
  readonly tasks?: TaskOptions;
  /**
   * Told about unexpected handler failures (reported to the client as
   * -32603, or as a generic tool error). Default: `console.error`.
   */
  readonly onError?: (error: unknown, info: RequestInfo) => void;
  /** Milliseconds since the epoch; for tests. */
  readonly now?: () => number;
}

/** The server's task settings. */
export interface TaskOptions {
  /** Where tasks live: `MemoryTaskStore` or `durableTaskStore(...)`. */
  readonly store: TaskStore;
  /** Default time to live; default one hour; null for ever. */
  readonly ttlMs?: number | null;
  /** Default suggested polling interval; default 1000 ms. */
  readonly pollIntervalMs?: number;
}

/** A request whose framing, `_meta`, version, method and params are checked. */
export interface PreparedRequest {
  readonly id: RequestId;
  readonly method: ClientRequestMethod;
  readonly params: Record<string, unknown>;
  readonly meta: RequestMetaObject;
}

/** Hooks a transport runs during {@link McpServer.prepare}. */
export interface PrepareHooks {
  /** After `_meta` is valid, before the version check (header vs body version). */
  readonly afterMeta?: (meta: RequestMetaObject) => void;
  /** After the params are valid (the `Mcp-Param-*` check). */
  readonly afterParams?: (request: PreparedRequest) => void;
}

/** Options for {@link McpServer.execute}. */
export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly principal?: Principal | null;
  /**
   * Receives the request's notifications (progress, log, and the listen
   * stream). Without it none are produced.
   */
  readonly emit?: (notification: JSONRPCNotification) => void | Promise<void>;
}

/** A value checked against a tool schema: the parsed value, or the issues. */
type Checked =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/** A tool schema ready to use: its JSON Schema and its check. */
interface ToolSchemaEntry {
  readonly json: JsonSchema;
  check(value: unknown): Promise<Checked>;
}

interface ToolEntry {
  readonly definition: ToolDefinition<unknown>;
  readonly tool: Tool;
  readonly input: ToolSchemaEntry;
  readonly output: ToolSchemaEntry | null;
  readonly headers: ParamHeader[];
}

/**
 * A tool schema's JSON Schema and check: a sieve schema's `io` form, parsed
 * with `safeParseAsync`; raw JSON Schema compiled and validated as it is.
 */
function toolSchema(
  schema: ToolSchema,
  io: "input" | "output",
  limits: SchemaLimits | undefined,
): ToolSchemaEntry {
  if (isSchema(schema)) {
    const sieve = schema as AnySchema;
    return {
      json: toJSONSchema(sieve, { io, $schema: false }),
      async check(value) {
        const result = await sieve.safeParseAsync(value);
        return result.success ? { ok: true, value: result.data } : {
          ok: false,
          issues: result.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        };
      },
    };
  }
  if ("~standard" in schema) {
    throw new TypeError(
      "only @celld/sieve schemas and raw JSON Schema are supported",
    );
  }
  const compiled = compileSchema(schema, limits);
  return {
    json: schema,
    check(value) {
      const issues = compiled.validate(value);
      return Promise.resolve(
        issues.length === 0 ? { ok: true, value } : { ok: false, issues },
      );
    },
  };
}

interface TemplateEntry {
  readonly definition: ResourceTemplateDefinition;
  readonly pattern: RegExp;
  readonly variables: string[];
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Parses a URI template into a matcher, or throws for unsupported syntax. */
export function compileUriTemplate(
  template: string,
): { pattern: RegExp; variables: string[] } {
  const variables: string[] = [];
  let source = "^";
  let rest = template;
  while (rest.length > 0) {
    const open = rest.indexOf("{");
    const literal = open === -1 ? rest : rest.slice(0, open);
    if (literal.includes("}")) {
      throw new TypeError(`unbalanced } in URI template ${template}`);
    }
    source += literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (open === -1) break;
    const close = rest.indexOf("}", open);
    if (close === -1) {
      throw new TypeError(`unbalanced { in URI template ${template}`);
    }
    const expression = rest.slice(open + 1, close);
    const reserved = expression.startsWith("+");
    const name = reserved ? expression.slice(1) : expression;
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new TypeError(
        `unsupported URI template expression {${expression}}: only {var} and {+var}`,
      );
    }
    if (variables.includes(name)) {
      throw new TypeError(`variable ${name} appears twice in ${template}`);
    }
    variables.push(name);
    source += reserved ? "(.+?)" : "([^/?#]+)";
    rest = rest.slice(close + 1);
  }
  return { pattern: new RegExp(source + "$", "s"), variables };
}

function encodeCursor(after: string): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ a: after })));
}

function decodeCursor(cursor: string): string {
  try {
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(cursor)));
    if (isPlainObject(value) && typeof value.a === "string") return value.a;
  } catch {
    // Falls through to the error below.
  }
  throw McpError.invalidParams("Invalid cursor", { cursor });
}

function abortedPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** An MCP server: register features, then hand requests to a transport. */
export class McpServer {
  readonly info: Implementation;
  readonly versions: readonly string[];
  readonly #options: McpServerOptions;
  readonly #tools = new Map<string, ToolEntry>();
  readonly #resources = new Map<string, ResourceDefinition>();
  readonly #templates = new Map<string, TemplateEntry>();
  readonly #prompts = new Map<string, PromptDefinition>();
  readonly #sealer: StateSealer | null;
  readonly #now: () => number;
  readonly #taskRunner: TaskRunner;

  constructor(options: McpServerOptions) {
    this.#options = options;
    this.info = options.info;
    this.versions = options.versions ?? [LATEST_PROTOCOL_VERSION];
    this.#sealer = options.stateSecret === undefined
      ? null
      : new StateSealer(options.stateSecret);
    this.#now = options.now ?? (() => Date.now());
    const cache = options.cache;
    if (cache?.ttlMs !== undefined && !(cache.ttlMs >= 0)) {
      throw new RangeError("cache.ttlMs must be >= 0");
    }
    this.#taskRunner = {
      run: (record, hooks) => this.#runTask(record, hooks),
      changed: (taskId) => this.#taskChanged(taskId),
    };
    if (options.tasks !== undefined) {
      checkMs(options.tasks.ttlMs, "tasks.ttlMs", 1);
      checkMs(options.tasks.pollIntervalMs, "tasks.pollIntervalMs", 1);
      options.tasks.store.attach?.(this.#taskRunner);
    }
  }

  /**
   * Runs this server's task bodies; a store that runs them elsewhere (the
   * `McpTaskObject` Durable Object) builds the server there and uses this.
   */
  get taskRunner(): TaskRunner {
    return this.#taskRunner;
  }

  /* Registration */

  /**
   * Registers a tool. Throws if the name is taken or not a valid tool name,
   * a schema does not compile, or an `x-mcp-header` annotation is invalid.
   */
  tool<I>(definition: ToolDefinition<I>): this {
    const { name } = definition;
    if (!TOOL_NAME.test(name)) {
      throw new TypeError(
        `tool name ${JSON.stringify(name)} must be 1-128 of A-Z a-z 0-9 _ - .`,
      );
    }
    if (this.#tools.has(name)) throw new TypeError(`duplicate tool ${name}`);
    if (definition.run === undefined && definition.task === undefined) {
      throw new TypeError(`tool ${name} needs run, task, or both`);
    }
    if (definition.task !== undefined) {
      if (this.#options.tasks === undefined) {
        throw new TypeError(
          `tool ${name} runs as a task, but the server has no tasks option`,
        );
      }
      checkMs(definition.task.ttlMs, `tool ${name}: task.ttlMs`, 1);
      checkMs(
        definition.task.pollIntervalMs,
        `tool ${name}: task.pollIntervalMs`,
        1,
      );
    }
    const limits = this.#options.schemaLimits;
    let input: ToolSchemaEntry;
    let output: ToolSchemaEntry | null;
    try {
      input = toolSchema(
        definition.input ?? { type: "object", additionalProperties: false },
        "input",
        limits,
      );
      output = definition.output === undefined
        ? null
        : toolSchema(definition.output, "output", limits);
    } catch (error) {
      throw new TypeError(`tool ${name}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const rawInput = input.json;
    if (rawInput.type !== "object") {
      throw new TypeError(`tool ${name}: inputSchema must have type "object"`);
    }
    const rawOutput = output?.json;
    const headers = paramHeaders(rawInput);
    if (headers.issues.length > 0) {
      throw new TypeError(
        `tool ${name}: invalid x-mcp-header: ${formatIssues(headers.issues)}`,
      );
    }
    const tool: Tool = {
      name,
      inputSchema: rawInput as Tool["inputSchema"],
    };
    if (definition.title !== undefined) tool.title = definition.title;
    if (definition.description !== undefined) {
      tool.description = definition.description;
    }
    if (rawOutput !== undefined) tool.outputSchema = rawOutput;
    if (definition.annotations !== undefined) {
      tool.annotations = definition.annotations;
    }
    if (definition.icons !== undefined) tool.icons = definition.icons;
    if (definition._meta !== undefined) tool._meta = definition._meta;
    this.#tools.set(name, {
      definition: definition as ToolDefinition<unknown>,
      tool,
      input,
      output,
      headers: headers.headers,
    });
    return this;
  }

  /** Registers a fixed resource. */
  resource(definition: ResourceDefinition): this {
    if (this.#resources.has(definition.uri)) {
      throw new TypeError(`duplicate resource ${definition.uri}`);
    }
    this.#resources.set(definition.uri, definition);
    return this;
  }

  /** Registers a resource template. Throws on unsupported template syntax. */
  resourceTemplate(definition: ResourceTemplateDefinition): this {
    if (this.#templates.has(definition.uriTemplate)) {
      throw new TypeError(
        `duplicate resource template ${definition.uriTemplate}`,
      );
    }
    const { pattern, variables } = compileUriTemplate(definition.uriTemplate);
    this.#templates.set(definition.uriTemplate, {
      definition,
      pattern,
      variables,
    });
    return this;
  }

  /** Registers a prompt. */
  prompt(definition: PromptDefinition): this {
    if (this.#prompts.has(definition.name)) {
      throw new TypeError(`duplicate prompt ${definition.name}`);
    }
    this.#prompts.set(definition.name, definition);
    return this;
  }

  /**
   * The OAuth scopes a prepared request needs: a tool's `scopes`, for
   * `tools/call` of a tool this request may see. For transports.
   */
  requiredScopes(request: PreparedRequest): readonly string[] {
    if (request.method !== "tools/call") return [];
    return this.#tools.get(request.params.name as string)?.definition.scopes ??
      [];
  }

  /** The `x-mcp-header` annotations of a registered tool, for transports. */
  paramHeadersOf(name: string): readonly ParamHeader[] | null {
    return this.#tools.get(name)?.headers ?? null;
  }

  /** The capabilities `server/discover` advertises. */
  get capabilities(): ServerCapabilities {
    const live = this.#options.changes !== undefined;
    const caps: ServerCapabilities = {};
    if (this.#tools.size > 0) caps.tools = { listChanged: live };
    if (this.#prompts.size > 0) caps.prompts = { listChanged: live };
    if (this.#resources.size > 0 || this.#templates.size > 0) {
      caps.resources = { listChanged: live, subscribe: live };
    }
    const completes =
      [...this.#prompts.values()].some((p) => p.complete !== undefined) ||
      [...this.#templates.values()].some((t) =>
        t.definition.complete !== undefined
      );
    if (completes) caps.completions = {};
    if (this.#options.logging) caps.logging = {};
    const extensions = { ...this.#options.capabilities?.extensions };
    if (this.#options.tasks !== undefined) extensions[TASKS_EXTENSION] = {};
    if (Object.keys(extensions).length > 0) caps.extensions = extensions;
    if (this.#options.capabilities?.experimental !== undefined) {
      caps.experimental = this.#options.capabilities.experimental;
    }
    return caps;
  }

  /* Dispatch */

  /**
   * Checks a framed request, in this order: `_meta` (-32602), the
   * transport's header hook, the protocol version (-32022), the method
   * (-32601, also for features the server does not have), the params
   * (-32602), then the transport's params hook. Throws McpError.
   */
  prepare(request: JSONRPCRequest, hooks: PrepareHooks = {}): PreparedRequest {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const metaIssues = params._meta === undefined
      ? [{ path: ["params", "_meta"], message: "is required" }]
      : check(params._meta, requestMeta, ["params", "_meta"]);
    if (metaIssues.length > 0) {
      throw McpError.invalidParams(
        `Invalid request metadata: ${formatIssues(metaIssues)}`,
      );
    }
    const meta = params._meta as RequestMetaObject;
    hooks.afterMeta?.(meta);
    const version = meta[META.protocolVersion];
    if (!this.versions.includes(version)) {
      throw McpError.unsupportedVersion(this.versions, version);
    }
    const method = request.method;
    if (!isClientRequestMethod(method) || !this.#serves(method)) {
      throw McpError.methodNotFound(method);
    }
    const issues = check(params, REQUEST_PARAMS[method], ["params"]);
    if (issues.length > 0) {
      throw McpError.invalidParams(`Invalid params: ${formatIssues(issues)}`);
    }
    const prepared = { id: request.id, method, params, meta };
    hooks.afterParams?.(prepared);
    return prepared;
  }

  #serves(method: ClientRequestMethod): boolean {
    const caps = this.capabilities;
    switch (method) {
      case "tools/list":
      case "tools/call":
        return caps.tools !== undefined;
      case "prompts/list":
      case "prompts/get":
        return caps.prompts !== undefined;
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        return caps.resources !== undefined;
      case "completion/complete":
        return caps.completions !== undefined;
      case "tasks/get":
      case "tasks/update":
      case "tasks/cancel":
        return this.#options.tasks !== undefined;
      default:
        return true;
    }
  }

  /**
   * Runs a prepared request. Resolves to its response, or to null when the
   * signal aborted first (the client is gone, so nothing may be sent).
   */
  async execute(
    request: PreparedRequest,
    options: ExecuteOptions = {},
  ): Promise<JSONRPCResponse | null> {
    const signal = options.signal ?? new AbortController().signal;
    const meta = request.meta;
    const info: RequestInfo = {
      requestId: request.id,
      method: request.method,
      protocolVersion: meta[META.protocolVersion],
      clientCapabilities: meta[META.clientCapabilities],
      clientInfo: meta[META.clientInfo] ?? null,
      meta,
      principal: options.principal ?? null,
      signal,
    };
    let finished = false;
    const emit = (notification: JSONRPCNotification) => {
      if (finished || signal.aborted || options.emit === undefined) return;
      Promise.resolve(options.emit(notification)).catch(() => {});
    };
    try {
      const result = await this.#run(request, info, emit, options);
      if (signal.aborted) return null;
      return { jsonrpc: "2.0", id: request.id, result: this.#decorate(result) };
    } catch (error) {
      if (signal.aborted) return null;
      let failure: McpError;
      if (error instanceof McpError && error.kind === "rpc") failure = error;
      else {
        this.#report(error, info);
        failure = McpError.internal();
      }
      return { jsonrpc: "2.0", id: request.id, error: failure.toRpcError() };
    } finally {
      finished = true;
    }
  }

  /** Prepares and executes in one step, as a transport without headers would. */
  async handle(
    request: JSONRPCRequest,
    options: ExecuteOptions = {},
  ): Promise<JSONRPCResponse | null> {
    let prepared: PreparedRequest;
    try {
      prepared = this.prepare(request);
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      return { jsonrpc: "2.0", id: request.id, error: error.toRpcError() };
    }
    return await this.execute(prepared, options);
  }

  #report(error: unknown, info: RequestInfo): void {
    if (this.#options.onError !== undefined) this.#options.onError(error, info);
    else console.error(`mcp: ${info.method} failed:`, error);
  }

  #decorate(result: Record<string, unknown>): Result {
    const meta = isPlainObject(result._meta) ? result._meta : {};
    return {
      ...result,
      resultType: typeof result.resultType === "string"
        ? result.resultType
        : "complete",
      _meta: { ...meta, [META.serverInfo]: this.info },
    };
  }

  #hints(
    own?: CacheHints,
  ): { ttlMs: number; cacheScope: "public" | "private" } {
    const defaults = this.#options.cache;
    const ttlMs = own?.ttlMs ?? defaults?.ttlMs ?? 60_000;
    return {
      ttlMs: Math.max(0, Math.floor(ttlMs)),
      cacheScope: own?.scope ?? defaults?.scope ?? "private",
    };
  }

  async #run(
    request: PreparedRequest,
    info: RequestInfo,
    emit: (notification: JSONRPCNotification) => void,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    const params = request.params;
    switch (request.method) {
      case "server/discover": {
        const result: Record<string, unknown> = {
          supportedVersions: [...this.versions],
          capabilities: this.capabilities,
          ...this.#hints(),
        };
        if (this.#options.instructions !== undefined) {
          result.instructions = this.#options.instructions;
        }
        return result;
      }
      case "tools/list":
        return this.#page(
          "tools",
          [...this.#tools.values()].filter((entry) =>
            entry.definition.visible?.(info) ?? true
          ).map((entry) => [entry.tool.name, entry.tool]),
          params.cursor as string | undefined,
        );
      case "prompts/list":
        return this.#page(
          "prompts",
          [...this.#prompts.values()].filter((p) => p.visible?.(info) ?? true)
            .map((p) => [p.name, this.#promptOf(p)]),
          params.cursor as string | undefined,
        );
      case "resources/list":
        return this.#page(
          "resources",
          [...this.#resources.values()].filter((r) => r.visible?.(info) ?? true)
            .map((r) => [r.uri, this.#resourceOf(r)]),
          params.cursor as string | undefined,
        );
      case "resources/templates/list":
        return this.#page(
          "resourceTemplates",
          [...this.#templates.values()].filter((t) =>
            t.definition.visible?.(info) ?? true
          ).map((t) => [t.definition.uriTemplate, this.#templateOf(t)]),
          params.cursor as string | undefined,
        );
      case "tools/call":
        return await this.#withInput(
          request,
          info,
          emit,
          (ctx) => this.#callTool(params, ctx),
        );
      case "prompts/get":
        return await this.#withInput(
          request,
          info,
          emit,
          (ctx) => this.#getPrompt(params, ctx),
        );
      case "resources/read":
        return await this.#withInput(
          request,
          info,
          emit,
          (ctx) => this.#readResource(params.uri as string, ctx),
        );
      case "completion/complete":
        return await this.#complete(
          params as unknown as CompleteRequestParams,
          info,
        );
      case "subscriptions/listen":
        return await this.#listen(request, info, options);
      case "tasks/get":
      case "tasks/update":
      case "tasks/cancel":
        return await this.#taskRequest(request, info);
    }
  }

  /** `tasks/get`, `tasks/update` and `tasks/cancel`. */
  async #taskRequest(
    request: PreparedRequest,
    info: RequestInfo,
  ): Promise<Record<string, unknown>> {
    const store = this.#options.tasks!.store;
    this.#require(info, { extensions: { [TASKS_EXTENSION]: {} } });
    const owner = info.principal?.subject ?? null;
    const taskId = request.params.taskId as string;
    switch (request.method) {
      case "tasks/get":
        return detailedTaskOf(
          await store.get(taskId, owner),
        ) as unknown as Record<
          string,
          unknown
        >;
      case "tasks/update":
        await store.update(
          taskId,
          owner,
          request.params.inputResponses as InputResponses,
        );
        return {};
      default:
        await store.cancel(taskId, owner);
        return {};
    }
  }

  #page(
    field: string,
    entries: [string, unknown][],
    cursor: string | undefined,
  ): Record<string, unknown> {
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let start = 0;
    if (cursor !== undefined) {
      const after = decodeCursor(cursor);
      start = entries.findIndex(([key]) => key > after);
      if (start === -1) start = entries.length;
    }
    const size = this.#options.pageSize ?? 100;
    const page = entries.slice(start, start + size);
    const result: Record<string, unknown> = {
      [field]: page.map(([, item]) => item),
      ...this.#hints(),
    };
    if (start + size < entries.length) {
      result.nextCursor = encodeCursor(page[page.length - 1][0]);
    }
    return result;
  }

  #promptOf(definition: PromptDefinition): Prompt {
    const prompt: Prompt = { name: definition.name };
    if (definition.title !== undefined) prompt.title = definition.title;
    if (definition.description !== undefined) {
      prompt.description = definition.description;
    }
    if (definition.arguments !== undefined) {
      prompt.arguments = definition.arguments;
    }
    if (definition.icons !== undefined) prompt.icons = definition.icons;
    if (definition._meta !== undefined) prompt._meta = definition._meta;
    return prompt;
  }

  #resourceOf(definition: ResourceDefinition): Resource {
    const resource: Resource = { uri: definition.uri, name: definition.name };
    for (
      const key of [
        "title",
        "description",
        "mimeType",
        "annotations",
        "size",
        "icons",
        "_meta",
      ] as const
    ) {
      if (definition[key] !== undefined) {
        (resource as unknown as Record<string, unknown>)[key] = definition[key];
      }
    }
    return resource;
  }

  #templateOf(entry: TemplateEntry): ResourceTemplate {
    const definition = entry.definition;
    const template: ResourceTemplate = {
      uriTemplate: definition.uriTemplate,
      name: definition.name,
    };
    for (
      const key of [
        "title",
        "description",
        "mimeType",
        "annotations",
        "icons",
        "_meta",
      ] as const
    ) {
      if (definition[key] !== undefined) {
        (template as unknown as Record<string, unknown>)[key] = definition[key];
      }
    }
    return template;
  }

  #require(info: RequestInfo, required: ClientCapabilities | undefined): void {
    if (required === undefined) return;
    const missing = missingCapabilities(info.clientCapabilities, required);
    if (missing !== null) throw McpError.missingCapability(missing);
  }

  /**
   * Runs an MRTR-capable handler: opens the request's sealed state, merges
   * the retry's answers, runs the handler, and turns `InputRequired` into
   * an `InputRequiredResult` with freshly sealed state.
   */
  async #withInput(
    request: PreparedRequest,
    info: RequestInfo,
    emit: (notification: JSONRPCNotification) => void,
    handler: (ctx: HandlerContext) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const params = request.params;
    const digest = await paramsDigest(request.method, params);
    const principal = info.principal?.subject ?? null;
    let answers: InputResponses = {};
    let state: JSONValue | null = null;
    if (params.requestState !== undefined) {
      if (this.#sealer === null) {
        throw McpError.invalidParams("Invalid requestState");
      }
      const opened = await this.#sealer.open(params.requestState as string);
      if (
        opened === null || opened.method !== request.method ||
        opened.digest !== digest || opened.principal !== principal ||
        opened.expiresAt <= this.#now()
      ) {
        throw McpError.invalidParams(
          opened !== null && opened.expiresAt <= this.#now()
            ? "Expired requestState"
            : "Invalid requestState",
        );
      }
      answers = { ...opened.answers };
      state = opened.state;
      const responses = (params.inputResponses ?? {}) as Record<
        string,
        unknown
      >;
      for (const [key, method] of Object.entries(opened.asked)) {
        if (!Object.hasOwn(responses, key)) continue;
        const issues = check(responses[key], INPUT_RESPONSE[method], [
          "params",
          "inputResponses",
          key,
        ]);
        if (issues.length > 0) {
          throw McpError.invalidParams(
            `Invalid input response: ${formatIssues(issues)}`,
          );
        }
        answers[key] = responses[key] as InputResponse;
      }
    }
    // Without a sealed state, `inputResponses` answer nothing that was asked,
    // so they are ignored.

    const ctx = this.#context(info, emit, { state, answers, mrtr: true });
    try {
      return await handler(ctx);
    } catch (error) {
      if (!(error instanceof InputRequired)) throw error;
      if (this.#sealer === null) {
        throw new Error(
          "a handler asked for input, but the server has no stateSecret",
        );
      }
      const requests: Record<string, string> = {};
      for (const [key, value] of Object.entries(error.requests)) {
        this.#require(info, capabilityFor(value));
        requests[key] = value.method;
      }
      const sealed = await this.#sealer.seal({
        method: request.method,
        digest,
        principal,
        expiresAt: this.#now() + (this.#options.stateTtlMs ?? 600_000),
        asked: requests,
        answers,
        state: error.state,
      });
      const result: Record<string, unknown> = {
        resultType: "input_required",
        requestState: sealed,
      };
      if (Object.keys(error.requests).length > 0) {
        result.inputRequests = error.requests;
      }
      return result;
    }
  }

  #context(
    info: RequestInfo,
    emit: (notification: JSONRPCNotification) => void,
    input: {
      state: JSONValue | null;
      answers: InputResponses;
      mrtr: boolean;
    },
  ): HandlerContext {
    const meta = info.meta;
    const token = meta[META.progressToken] as ProgressToken | undefined;
    const threshold = meta[META.logLevel];
    let lastProgress = -Infinity;
    let state = input.state;
    const helpers = inputHelpers(info.clientCapabilities, input.answers, {
      get: () => state,
      set: (next) => {
        state = next;
      },
    }, (what) => {
      if (!input.mrtr) {
        throw new Error(
          `${what} is only available in tools/call, prompts/get and resources/read`,
        );
      }
    });
    const ctx: HandlerContext = {
      ...info,
      progress(progress, options = {}) {
        if (token === undefined || !(progress > lastProgress)) return;
        lastProgress = progress;
        const params: Record<string, unknown> = {
          progressToken: token,
          progress,
        };
        if (options.total !== undefined) params.total = options.total;
        if (options.message !== undefined) params.message = options.message;
        emit({ jsonrpc: "2.0", method: "notifications/progress", params });
      },
      log: (level, data, logger) => {
        if (
          !this.#options.logging || threshold === undefined ||
          !logLevelAtLeast(level, threshold)
        ) {
          return;
        }
        const params: Record<string, unknown> = { level, data };
        if (logger !== undefined) params.logger = logger;
        emit({ jsonrpc: "2.0", method: "notifications/message", params });
      },
      requireCapabilities: helpers.requireCapabilities,
      get state() {
        return state;
      },
      setState(next) {
        state = next;
      },
      input: helpers.input,
      elicit: helpers.elicit,
      sample: helpers.sample,
      roots: helpers.roots,
      ask: helpers.ask,
      inputRequired: helpers.inputRequired,
      task(options = {}) {
        if (info.method !== "tools/call") {
          throw new Error("ctx.task is only available in tools/call");
        }
        throw new TaskRequested(options);
      },
    };
    return ctx;
  }

  async #callTool(
    params: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<Record<string, unknown>> {
    const name = params.name as string;
    const entry = this.#tools.get(name);
    if (entry === undefined || !(entry.definition.visible?.(ctx) ?? true)) {
      throw McpError.invalidParams(`Unknown tool: ${name}`, { name });
    }
    this.#require(ctx, entry.definition.requires);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const checked = await entry.input.check(args);
    if (!checked.ok) {
      return {
        content: [{
          type: "text",
          text: `Invalid arguments for ${name}: ${
            formatIssues(checked.issues)
          }`,
        }],
        isError: true,
      };
    }
    let returned: ToolReturn;
    try {
      const run = entry.definition.run;
      if (run === undefined) throw new TaskRequested({});
      returned = await run(checked.value, ctx);
    } catch (error) {
      if (error instanceof TaskRequested) {
        return await this.#startTask(entry, args, ctx, error.options);
      }
      return this.#toolFailure(name, error, ctx);
    }
    return await this.#toolResult(entry, returned);
  }

  /**
   * A tool handler's failure as a tool result: a `ToolError` shows its
   * message, anything else a generic one (and goes to `onError`). Input
   * signals and JSON-RPC errors are rethrown, as is anything after the
   * request was cancelled.
   */
  #toolFailure(
    name: string,
    error: unknown,
    info: RequestInfo,
  ): Record<string, unknown> {
    if (error instanceof ToolError) {
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
    if (error instanceof InputRequired || error instanceof McpError) {
      throw error;
    }
    if (info.signal.aborted) throw error;
    this.#report(error, info);
    return {
      content: [{ type: "text", text: `Tool ${name} failed` }],
      isError: true,
    };
  }

  /**
   * A handler's return value as a `CallToolResult`, checked against the
   * protocol and the output schema (a sieve output schema's parsed value is
   * what is sent). A failed check is a server bug, thrown as a plain Error.
   */
  async #toolResult(
    entry: ToolEntry,
    returned: ToolReturn,
  ): Promise<Record<string, unknown>> {
    const name = entry.tool.name;
    const result: CallToolResult = typeof returned === "string"
      ? { resultType: "complete", content: [{ type: "text", text: returned }] }
      : {
        resultType: "complete",
        content: returned.content ??
          (returned.structuredContent !== undefined
            ? [{
              type: "text",
              text: JSON.stringify(returned.structuredContent),
            }]
            : []),
      };
    if (typeof returned !== "string") {
      if (returned.structuredContent !== undefined) {
        result.structuredContent = returned.structuredContent;
      }
      if (returned.isError !== undefined) result.isError = returned.isError;
      if (returned._meta !== undefined) result._meta = returned._meta;
    }
    const contentIssues = check(result.content, (value, path, out) => {
      if (!Array.isArray(value)) {
        out.push({ path, message: "content must be an array" });
      } else {value.forEach((item, index) =>
          contentBlock(item, [...path, index], out)
        );}
    }, ["content"]);
    if (contentIssues.length > 0) {
      throw new Error(`tool ${name} returned ${formatIssues(contentIssues)}`);
    }
    if (entry.output !== null && result.isError !== true) {
      if (result.structuredContent === undefined) {
        throw new Error(
          `tool ${name} has an outputSchema but returned no structuredContent`,
        );
      }
      const checked = await entry.output.check(result.structuredContent);
      if (!checked.ok) {
        throw new Error(
          `tool ${name} returned structuredContent that fails its outputSchema: ${
            formatIssues(checked.issues)
          }`,
        );
      }
      result.structuredContent = checked.value;
    }
    return result;
  }

  /** Stores a new task for a tool call and answers with its handle. */
  async #startTask(
    entry: ToolEntry,
    args: Record<string, unknown>,
    ctx: HandlerContext,
    options: StartTaskOptions,
  ): Promise<Record<string, unknown>> {
    const name = entry.tool.name;
    const definition = entry.definition.task;
    const tasks = this.#options.tasks;
    if (definition === undefined || tasks === undefined) {
      throw new Error(`tool ${name} called ctx.task() but has no task`);
    }
    // The spec: a request that can only be served as a task, from a client
    // without the extension, is -32021 naming it.
    this.#require(ctx, { extensions: { [TASKS_EXTENSION]: {} } });
    checkMs(options.ttlMs, "ttlMs", 1);
    checkMs(options.pollIntervalMs, "pollIntervalMs", 1);
    const now = this.#now();
    const ttlMs = options.ttlMs !== undefined
      ? options.ttlMs
      : definition.ttlMs !== undefined
      ? definition.ttlMs
      : tasks.ttlMs !== undefined
      ? tasks.ttlMs
      : 3_600_000;
    const record: TaskRecord = {
      version: 1,
      taskId: newTaskId(),
      owner: ctx.principal?.subject ?? null,
      principal: ctx.principal === null
        ? null
        : JSON.parse(JSON.stringify(ctx.principal)),
      method: "tools/call",
      name,
      arguments: args,
      protocolVersion: ctx.protocolVersion,
      clientCapabilities: ctx.clientCapabilities,
      clientInfo: ctx.clientInfo,
      status: "working",
      statusMessage: options.statusMessage ?? null,
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs,
      pollIntervalMs: options.pollIntervalMs ?? definition.pollIntervalMs ??
        tasks.pollIntervalMs ?? 1000,
      outstanding: {},
      asked: {},
      answers: {},
      state: options.state ?? null,
      result: null,
      error: null,
      runAt: now,
      runs: 0,
    };
    await tasks.store.create(record);
    return { ...taskOf(record), resultType: "task" };
  }

  /** Runs one round of a task body; see {@link TaskRunner}. */
  async #runTask(
    record: TaskRecord,
    hooks: TaskRunHooks,
  ): Promise<TaskOutcome> {
    const entry = this.#tools.get(record.name);
    const definition = entry?.definition.task;
    if (entry === undefined || definition === undefined) {
      return {
        type: "failed",
        error: {
          code: INVALID_PARAMS,
          message: `Unknown tool: ${record.name}`,
        },
      };
    }
    let state = record.state;
    const helpers = inputHelpers(record.clientCapabilities, record.answers, {
      get: () => state,
      set: (next) => {
        state = next;
      },
    }, () => {});
    const ctx: TaskContext = {
      taskId: record.taskId,
      name: record.name,
      principal: record.principal,
      protocolVersion: record.protocolVersion,
      clientCapabilities: record.clientCapabilities,
      clientInfo: record.clientInfo,
      signal: hooks.signal,
      run: record.runs,
      get state() {
        return state;
      },
      async save(next) {
        state = next;
        await hooks.save(next);
      },
      async status(message, options = {}) {
        checkMs(options.pollIntervalMs, "pollIntervalMs", 1);
        await hooks.status(message, options.pollIntervalMs);
      },
      requireCapabilities: helpers.requireCapabilities,
      input: helpers.input,
      elicit: helpers.elicit,
      sample: helpers.sample,
      roots: helpers.roots,
      ask: helpers.ask,
      inputRequired: helpers.inputRequired,
    };
    const info: RequestInfo = {
      requestId: record.taskId,
      method: "tools/call",
      protocolVersion: record.protocolVersion,
      clientCapabilities: record.clientCapabilities,
      clientInfo: record.clientInfo,
      meta: {} as RequestMetaObject,
      principal: record.principal,
      signal: hooks.signal,
    };
    // The record keeps the arguments as they were sent; each run parses them.
    const checked = await entry.input.check(record.arguments);
    if (!checked.ok) {
      return {
        type: "failed",
        error: {
          code: INVALID_PARAMS,
          message: `Invalid arguments for ${record.name}: ${
            formatIssues(checked.issues)
          }`,
        },
      };
    }
    let returned: ToolReturn;
    try {
      returned = await definition.run(checked.value, ctx);
    } catch (error) {
      if (error instanceof InputRequired) {
        return {
          type: "input_required",
          requests: error.requests,
          state: error.state,
        };
      }
      if (error instanceof McpError && error.kind === "rpc") {
        return { type: "failed", error: error.toRpcError() };
      }
      if (hooks.signal.aborted) {
        return {
          type: "failed",
          error: { code: INTERNAL_ERROR, message: "The task was stopped" },
        };
      }
      return {
        type: "completed",
        result: this.#toolFailure(record.name, error, info),
      };
    }
    try {
      return {
        type: "completed",
        result: await this.#toolResult(entry, returned),
      };
    } catch (error) {
      this.#report(error, info);
      return {
        type: "failed",
        error: { code: INTERNAL_ERROR, message: "Internal error" },
      };
    }
  }

  async #taskChanged(taskId: string): Promise<void> {
    const changes = this.#options.changes as
      | (ChangeSource & Partial<ChangePublisher>)
      | undefined;
    if (typeof changes?.publish !== "function") return;
    try {
      await changes.publish({ type: "task", taskId });
    } catch (error) {
      this.#report(error, {
        requestId: taskId,
        method: "tools/call",
        protocolVersion: LATEST_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: null,
        meta: {} as RequestMetaObject,
        principal: null,
        signal: new AbortController().signal,
      });
    }
  }

  async #getPrompt(
    params: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<Record<string, unknown>> {
    const name = params.name as string;
    const prompt = this.#prompts.get(name);
    if (prompt === undefined || !(prompt.visible?.(ctx) ?? true)) {
      throw McpError.invalidParams(`Unknown prompt: ${name}`, { name });
    }
    this.#require(ctx, prompt.requires);
    const args = (params.arguments ?? {}) as Record<string, string>;
    for (const argument of prompt.arguments ?? []) {
      if (argument.required && args[argument.name] === undefined) {
        throw McpError.invalidParams(
          `Missing required argument: ${argument.name}`,
          { name, argument: argument.name },
        );
      }
    }
    const returned = await prompt.get(args, ctx);
    const result: GetPromptResult = Array.isArray(returned)
      ? { resultType: "complete", messages: returned }
      : { resultType: "complete", ...returned };
    return result;
  }

  async #readResource(
    uri: string,
    ctx: HandlerContext,
  ): Promise<Record<string, unknown>> {
    const fixed = this.#resources.get(uri);
    if (fixed !== undefined && (fixed.visible?.(ctx) ?? true)) {
      this.#require(ctx, fixed.requires);
      return this.#contents(
        uri,
        fixed.mimeType,
        fixed.cache,
        await fixed.read(ctx),
      );
    }
    for (const entry of this.#templates.values()) {
      const match = entry.pattern.exec(uri);
      if (match === null || !(entry.definition.visible?.(ctx) ?? true)) {
        continue;
      }
      const variables: Record<string, string> = {};
      try {
        entry.variables.forEach((name, index) => {
          variables[name] = decodeURIComponent(match[index + 1]);
        });
      } catch {
        continue;
      }
      this.#require(ctx, entry.definition.requires);
      const returned = await entry.definition.read(uri, variables, ctx);
      if (returned === null) continue;
      return this.#contents(
        uri,
        entry.definition.mimeType,
        entry.definition.cache,
        returned,
      );
    }
    throw McpError.resourceNotFound(uri);
  }

  #contents(
    uri: string,
    mimeType: string | undefined,
    cache: CacheHints | undefined,
    returned: ResourceReturn,
  ): Record<string, unknown> {
    if (returned === null) throw McpError.resourceNotFound(uri);
    let contents: (TextResourceContents | BlobResourceContents)[];
    let hints = this.#hints(cache);
    if (typeof returned === "string") {
      contents = [{ uri, text: returned }];
    } else if (returned instanceof Uint8Array) {
      contents = [{ uri, blob: toBase64(returned) }];
    } else if (Array.isArray(returned)) {
      contents = returned;
    } else {
      contents = returned.contents;
      hints = this.#hints({
        ttlMs: returned.ttlMs ?? cache?.ttlMs,
        scope: returned.cacheScope ?? cache?.scope,
      });
    }
    if (mimeType !== undefined) {
      contents = contents.map((item) =>
        item.mimeType === undefined ? { ...item, mimeType } : item
      );
    }
    return { contents, ...hints };
  }

  async #complete(
    params: CompleteRequestParams,
    info: RequestInfo,
  ): Promise<Record<string, unknown>> {
    let completer: Completer | undefined;
    const ref = params.ref;
    if (ref.type === "ref/prompt") {
      const prompt = this.#prompts.get(ref.name);
      if (prompt === undefined || !(prompt.visible?.(info) ?? true)) {
        throw McpError.invalidParams(`Unknown prompt: ${ref.name}`);
      }
      completer = prompt.complete?.[params.argument.name];
    } else {
      const entry = this.#templates.get(ref.uri);
      if (entry === undefined || !(entry.definition.visible?.(info) ?? true)) {
        throw McpError.invalidParams(`Unknown resource template: ${ref.uri}`);
      }
      completer = entry.definition.complete?.[params.argument.name];
    }
    const found = completer === undefined ? [] : await completer(
      params.argument.value,
      { arguments: params.context?.arguments ?? {} },
      info,
    );
    const values = Array.isArray(found) ? found : found.values;
    const completion: Record<string, unknown> = {
      values: values.slice(0, 100),
    };
    const total = Array.isArray(found) ? values.length : found.total;
    if (total !== undefined) completion.total = total;
    const hasMore = Array.isArray(found)
      ? values.length > 100
      : found.hasMore ?? values.length > 100;
    if (hasMore) completion.hasMore = true;
    return { completion };
  }

  async #listen(
    request: PreparedRequest,
    info: RequestInfo,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>> {
    const requested = request.params.notifications as SubscriptionFilter;
    const caps = this.capabilities;
    const honored: SubscriptionFilter = {};
    if (requested.toolsListChanged && caps.tools?.listChanged) {
      honored.toolsListChanged = true;
    }
    if (requested.promptsListChanged && caps.prompts?.listChanged) {
      honored.promptsListChanged = true;
    }
    if (requested.resourcesListChanged && caps.resources?.listChanged) {
      honored.resourcesListChanged = true;
    }
    if (
      requested.resourceSubscriptions !== undefined &&
      caps.resources?.subscribe
    ) {
      honored.resourceSubscriptions = [
        ...new Set(requested.resourceSubscriptions),
      ];
    }
    const source = this.#options.changes;
    const tasks = this.#options.tasks;
    const owner = info.principal?.subject ?? null;
    if (requested.taskIds !== undefined) {
      // The tasks extension: asking for task notifications without it is -32021.
      this.#require(info, { extensions: { [TASKS_EXTENSION]: {} } });
      if (tasks !== undefined && source !== undefined) {
        // Only the caller's own, live tasks; others are silently left out.
        const own: string[] = [];
        for (const taskId of new Set(requested.taskIds)) {
          try {
            await tasks.store.get(taskId, owner);
            own.push(taskId);
          } catch (error) {
            if (!(error instanceof McpError)) throw error;
          }
        }
        if (own.length > 0) honored.taskIds = own;
      }
    }
    const id = request.id;
    const tagged = (method: string, params: Record<string, unknown> = {}) => ({
      jsonrpc: "2.0" as const,
      method,
      params: { ...params, _meta: { [META.subscriptionId]: id } },
    });
    const send = async (notification: JSONRPCNotification) => {
      if (!info.signal.aborted) await options.emit?.(notification);
    };
    const sendTask = async (taskId: string) => {
      let record: TaskRecord;
      try {
        record = await tasks!.store.get(taskId, owner);
      } catch (error) {
        if (error instanceof McpError) return; // Expired meanwhile.
        throw error;
      }
      await send(
        tagged(
          "notifications/tasks",
          detailedTaskOf(record) as unknown as Record<string, unknown>,
        ),
      );
    };
    const graceful = { _meta: { [META.subscriptionId]: id } };
    const watching = Object.keys(honored).length > 0 && source !== undefined;

    // A lifetime (or the client leaving) stops the source.
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    info.signal.addEventListener("abort", onAbort, { once: true });
    const lifetime = this.#options.listenLifetimeMs;
    const timer = watching && lifetime !== undefined && lifetime > 0
      ? setTimeout(() => stop.abort(), lifetime)
      : undefined;
    try {
      // Attach before acknowledging, so no change after the ack is missed.
      const events = watching ? await source.listen(stop.signal) : null;
      await send(tagged("notifications/subscriptions/acknowledged", {
        notifications: honored,
      }));
      if (events === null) return graceful;
      // Each watched task's current state first, so a change made before
      // the subscription is not missed.
      for (const taskId of honored.taskIds ?? []) await sendTask(taskId);
      const iterator = events[Symbol.asyncIterator]();
      const stopped = abortedPromise(stop.signal);
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === undefined || next.done) break;
          const event = next.value;
          for (const notification of expand(event, honored)) {
            await send(tagged(notification.method, notification.params));
          }
          if (
            event.type === "task" && honored.taskIds?.includes(event.taskId)
          ) {
            await sendTask(event.taskId);
          } else if (event.type === "reset") {
            for (const taskId of honored.taskIds ?? []) await sendTask(taskId);
          }
        }
      } finally {
        void iterator.return?.();
      }
      return graceful;
    } finally {
      clearTimeout(timer);
      info.signal.removeEventListener("abort", onAbort);
    }
  }
}

function answerMatches(method: string, answer: InputResponse): boolean {
  const shape = INPUT_RESPONSE[method];
  return shape !== undefined && check(answer, shape).length === 0;
}

/** The input-asking half of a handler or task context. */
interface InputHelpers {
  requireCapabilities(required: ClientCapabilities): void;
  input(key: string): InputResponse | undefined;
  elicit(key: string, params: ElicitRequestParams): ElicitResult;
  sample(key: string, params: CreateMessageRequestParams): CreateMessageResult;
  roots(key: string): ListRootsResult;
  ask(requests: InputRequests): InputResponses;
  inputRequired(
    options?: { readonly requests?: InputRequests; readonly state?: JSONValue },
  ): never;
}

/**
 * Input helpers over the answers delivered so far: each returns its answer
 * when there is one, and otherwise throws `InputRequired` for the missing
 * requests, carrying the current state. `guard` runs first in each.
 */
function inputHelpers(
  capabilities: ClientCapabilities,
  answers: InputResponses,
  state: { get(): JSONValue | null; set(value: JSONValue | null): void },
  guard: (what: string) => void,
): InputHelpers {
  const require = (required: ClientCapabilities) => {
    const missing = missingCapabilities(capabilities, required);
    if (missing !== null) throw McpError.missingCapability(missing);
  };
  const answered = (key: string, request: InputRequest) => {
    const answer = answers[key];
    if (answer === undefined || !answerMatches(request.method, answer)) {
      return undefined;
    }
    // A submitted form must match the schema it was asked with.
    if (
      request.method === "elicitation/create" &&
      request.params.mode !== "url" &&
      (answer as ElicitResult).action === "accept"
    ) {
      const issues = compileSchema(request.params.requestedSchema).validate(
        (answer as ElicitResult).content ?? {},
      );
      if (issues.length > 0) {
        throw McpError.invalidParams(
          `Input response ${key} does not match the requested schema: ${
            formatIssues(issues)
          }`,
        );
      }
    }
    return answer;
  };
  const one = (what: string, key: string, request: InputRequest) => {
    guard(what);
    require(capabilityFor(request));
    const answer = answered(key, request);
    if (answer !== undefined) return answer;
    throw new InputRequired({ [key]: request }, state.get());
  };
  return {
    requireCapabilities: require,
    input: (key) => answers[key],
    elicit: (key, params) =>
      one("elicit", key, {
        method: "elicitation/create",
        params,
      }) as ElicitResult,
    sample: (key, params) =>
      one("sample", key, {
        method: "sampling/createMessage",
        params,
      }) as CreateMessageResult,
    roots: (key) => one("roots", key, rootsRequest()) as ListRootsResult,
    ask(requests) {
      guard("ask");
      const missing: InputRequests = {};
      const out: InputResponses = {};
      for (const [key, request] of Object.entries(requests)) {
        require(capabilityFor(request));
        const answer = answered(key, request);
        if (answer === undefined) missing[key] = request;
        else out[key] = answer;
      }
      if (Object.keys(missing).length > 0) {
        throw new InputRequired(missing, state.get());
      }
      return out;
    },
    inputRequired(options = {}) {
      guard("inputRequired");
      for (const request of Object.values(options.requests ?? {})) {
        require(capabilityFor(request));
      }
      if (options.state !== undefined) state.set(options.state);
      throw new InputRequired(options.requests ?? {}, state.get());
    },
  };
}

/** The notifications a change becomes for a subscriber's filter. */
export function expand(
  event: ChangeEvent,
  filter: SubscriptionFilter,
): { method: string; params?: Record<string, unknown> }[] {
  const out: { method: string; params?: Record<string, unknown> }[] = [];
  const all = event.type === "reset";
  if ((all || event.type === "tools") && filter.toolsListChanged) {
    out.push({ method: "notifications/tools/list_changed" });
  }
  if ((all || event.type === "prompts") && filter.promptsListChanged) {
    out.push({ method: "notifications/prompts/list_changed" });
  }
  if ((all || event.type === "resources") && filter.resourcesListChanged) {
    out.push({ method: "notifications/resources/list_changed" });
  }
  const uris = filter.resourceSubscriptions ?? [];
  if (all) {
    for (const uri of uris) {
      out.push({ method: "notifications/resources/updated", params: { uri } });
    }
  } else if (event.type === "resource" && uris.includes(event.uri)) {
    out.push({
      method: "notifications/resources/updated",
      params: { uri: event.uri },
    });
  }
  return out;
}
